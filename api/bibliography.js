import { checkOrigin, isGloballyRateLimited, isRateLimited } from "./_lib/guard.js";
import { referenceDate } from "../src/lib/referenceDate.js";
import { fetchSource } from "./_lib/sourceFetch.js";
import { compareSourceMetadata, extractHtmlMetadata, extractPdfMetadata } from "./_lib/sourceMetadata.js";

// 書誌照合は1文献ごとに呼ばれるため、レビューAPIより高い上限にする
const REQUESTS_PER_MINUTE = 120;
// インスタンス全体の上限。外部データベースへの過剰なアクセスを防ぐ
const GLOBAL_REQUESTS_PER_MINUTE = Number(process.env.BIBLIOGRAPHY_GLOBAL_LIMIT ?? 300);
const LOOKUP_CACHE_TTL_MS = 10 * 60_000;
const LOOKUP_CACHE_MAX_ENTRIES = 500;
const UPSTREAM_TIMEOUT_MS = 8_000;
const lookupCache = new Map();

// 外部データベースが返すURLをそのままリンク先にしないよう、
// 通常のWebページを指す形式だけを通す
function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

function cachedLookup(key, load) {
  const now = Date.now();
  const cached = lookupCache.get(key);
  if (cached && now - cached.createdAt < LOOKUP_CACHE_TTL_MS) return cached.value;

  const value = Promise.resolve().then(load).then((result) => {
    // 接続障害を10分間固定せず、再実行時にデータベースへ再照会する。
    if (result.providerErrors?.length && lookupCache.get(key)?.value === value) lookupCache.delete(key);
    return result;
  }, (error) => {
    if (lookupCache.get(key)?.value === value) lookupCache.delete(key);
    throw error;
  });
  lookupCache.set(key, { createdAt: now, value });
  if (lookupCache.size > LOOKUP_CACHE_MAX_ENTRIES) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
  return value;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』（）()[\]{}.,，。、:：;；・\-–—]/g, "");
}

function bigrams(value) {
  const normalized = normalize(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(
    [...Array(normalized.length - 1)].map((_, index) =>
      normalized.slice(index, index + 2),
    ),
  );
}

function similarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const item of leftSet) if (rightSet.has(item)) overlap += 1;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function compact(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

// Crossrefのデータには「Psychology &amp; Marketing」のように
// HTMLエスケープされた文字が残っていることがある
function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function crossrefYear(item, key) {
  return item[key]?.["date-parts"]?.[0]?.[0] ?? null;
}

const pageRangePattern = /[a-z]?\d+(?:\s*[-–—−]\s*[a-z]?\d+)?/i;

function normalizePages(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  return text.match(pageRangePattern)?.[0] === text && text
    ? text.replace(/\s*[-–—−]\s*/g, "–") : null;
}

function pageRange(first, last) {
  if (!first || !last) return null;
  return normalizePages(String(first) === String(last) ? first : `${first}–${last}`);
}

function doiKey(value) {
  return String(value ?? "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryVariants(value) {
  const source = String(value ?? "").trim();
  if (!source) return [];
  const withoutParentheses = source.replace(/[（(][^）)]{2,}[）)]/g, " ").trim();
  const beforeSubtitle = source.split(/[：:－\-―–]/)[0]?.trim();
  const japaneseOnly =
    source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]+/gu)?.join(" ") ??
    "";
  const withoutQuotes = source.replace(/[「」『』“”"']/g, "");
  // CiNiiの検索は題名の括弧や副題の違いで0件になり得る。
  // 短い検索語で候補を広げても、一致判定には元の題名・著者・年を使う。
  const japanesePrefix = hasJapanese(source) && withoutQuotes.length > 20
    ? withoutQuotes.slice(0, 16)
    : null;
  return compact([
    source,
    withoutQuotes,
    japanesePrefix,
    withoutParentheses,
    beforeSubtitle,
    japaneseOnly.length >= 6 ? japaneseOnly : null,
  ]).filter((query) => query.length >= 4);
}

function hasJapanese(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    String(value ?? ""),
  );
}

function authorSimilarity(referenceAuthors, candidateAuthors) {
  const reference = normalize(referenceAuthors);
  const candidate = normalize(candidateAuthors);
  if (!reference || !candidate) return 0;
  if (reference.includes(candidate.slice(0, 4))) return 1;
  const candidateParts = String(candidateAuthors)
    .split(/[,，、;&]|\band\b|・/i)
    .map((part) => normalize(part))
    .filter((part) => part.length >= 2);
  if (candidateParts.some((part) => reference.includes(part) || part.includes(reference))) {
    return 1;
  }
  const partScore = candidateParts.length
    ? Math.max(...candidateParts.map((part) => similarity(reference, part)))
    : 0;
  return Math.max(similarity(referenceAuthors, candidateAuthors), partScore);
}

function authorsCorroborated(referenceAuthors, candidateAuthors) {
  if (hasJapanese(referenceAuthors)) return authorSimilarity(referenceAuthors, candidateAuthors) === 1;
  const words = (value) => String(value ?? "").toLowerCase().match(/\p{L}{2,}/gu) ?? [];
  const provided = words(referenceAuthors).filter((word) => word !== "and");
  const candidates = new Set(words(candidateAuthors));
  return provided.length > 0 && provided.every((word) => candidates.has(word));
}

function quotedText(reference, opening, closing) {
  const start = reference.indexOf(opening);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < reference.length; index += 1) {
    if (reference[index] === opening) depth += 1;
    else if (reference[index] === closing && --depth === 0) {
      const text = reference.slice(start + 1, index);
      return text.length >= 3 ? text : null;
    }
  }
  return null;
}

function extractSourceUrl(reference) {
  let raw = reference.match(/https?:\/\/[^\s<>"「」『』（）]+/i)?.[0];
  if (!raw) return null;
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "(") depth += 1;
    else if (raw[index] === ")") {
      if (depth === 0) { raw = raw.slice(0, index); break; }
      depth -= 1;
    }
  }
  return safeHttpUrl(raw.replace(/[,.;、。]+$/, ""));
}

export function extractReferenceFields(reference) {
  const sourceUrl = extractSourceUrl(reference);
  reference = reference.normalize("NFKC");
  const date = referenceDate(reference);
  const { year, dateState } = date;
  const doi =
    reference
      .match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]
      ?.replace(/[.,;)\]]+$/, "") ?? null;
  const quotedTitle = quotedText(reference, "「", "」");
  const bookTitle = quotedText(reference, "『", "』");
  // 「」がなく『』だけの日本語文献は書籍とみなす（『』は書名であり掲載誌名ではない）
  const isJapaneseBook = !quotedTitle && Boolean(bookTitle);
  const japaneseTitle =
    quotedTitle ??
    bookTitle ??
    reference.match(/[“"]([^”"]{5,})[”"]/)?.[1] ??
    null;
  const afterYear = date.end >= 0
    ? reference
        .slice(date.end)
        .replace(/^[).．。\s,]+/, "")
        .replace(/https?:\/\/\S+/g, "")
        .trim()
    : "";
  // 「vs.」「et al.」などの略語のピリオドで題名が切れないよう保護してから分割する
  const englishParts = afterYear
    .replace(/\b(vs|et al|e\.g|i\.e|cf|Vol|No|pp|ed|eds|Jr|St)\./gi, (abbrev) =>
      abbrev.replace(/\.$/, "\u0001"),
    )
    .split(/\.\s+/)
    .map((part) => part.replace(/\u0001/g, ".").trim().replace(/[.。]+$/, ""))
    .filter((part) => part.length >= 5);
  const title = japaneseTitle ?? englishParts[0] ?? null;
  // 英語文献の掲載誌は「Journal, 23(11), 927-959」のように巻号が続くため誌名だけ残す
  const englishJournal = englishParts[1]?.split(/,\s*\d/)[0]?.trim() ?? null;
  // 巻号・ページ表記がない英語文献は書籍とみなす（2番目の要素は出版社名なので掲載誌にしない）
  const referenceWithoutUrls = reference.replace(/https?:\/\/[^\s「」『』（）]+/gi, "");
  const hasVolumeOrPages = /\d+\s*\(\d+\)|\d+\s*[–\-−]\s*\d+/.test(referenceWithoutUrls)
    || /,\s*\d+$/.test(englishParts[1] ?? "");
  // 巻号の代わりに記事番号を使う雑誌論文（例: 12, e123456）を書籍扱いしない
  const hasArticleNumber = /\b\d+\s*,\s*(?:e?\d{4,})\b/i.test(referenceWithoutUrls);
  const isEnglishBook =
    !japaneseTitle && !doi && !hasVolumeOrPages && !hasArticleNumber && englishParts.length >= 2;
  const isBook = isJapaneseBook || isEnglishBook;
  const journal = isBook
    ? null
    : reference.match(/『([^』]{2,})』/)?.[1] ?? englishJournal;
  const authorArea = date.start >= 0 ? reference.slice(0, date.start) : reference.split(/[「『“"]|https?:\/\//i)[0];
  const academicUrl = sourceUrl && ["doi.org", "dx.doi.org", "cir.nii.ac.jp", "jstage.jst.go.jp", "www.jstage.jst.go.jp", "hdl.handle.net", "pubmed.ncbi.nlm.nih.gov"].includes(new URL(sourceUrl).hostname);
  const webCue = /(?:HP|ホームページ|ウェブサイト|閲覧|確認|アクセス|retrieved|accessed|website)/i.test(reference);
  const isWebSource = Boolean(sourceUrl && !doi && !hasVolumeOrPages && !hasArticleNumber && !academicUrl && !isJapaneseBook && (webCue || (!journal && !isBook)));
  const referenceType = isWebSource
    ? (/\.pdf(?:[?#]|$)/i.test(sourceUrl) || /報告書|白書|調査報告|レポート/.test(reference) ? "report" : "web")
    : isBook ? "book" : "article";
  const afterQuotedTitle = quotedTitle && !journal
    ? reference.slice(reference.indexOf(`「${quotedTitle}」`) + quotedTitle.length + 2)
        .replace(/https?:\/\/\S+/g, "").replace(/^[.,、。\s]+|[.,、。\s]+$/g, "")
    : "";
  const institution = /大学|研究科|大学院/.test(afterQuotedTitle) ? afterQuotedTitle : null;
  const ending = afterYear.replace(/\s*(?:doi:\s*)?10\.\d{4,9}\/\S+\s*$/i, "").replace(/[.。\s]+$/, "");
  const pages = normalizePages(ending.match(/(?:^|[\s,])([a-z]?\d+\s*[-–—−]\s*[a-z]?\d+)$/i)?.[1]
    ?? ending.match(/(?:(?:,|』)\s*\d+(?:\s*\(\d+\))?\s*,|\bpp?\.)\s*(\d+)$/i)?.[1]);
  const hasPageOrArticleCue = Boolean(pages || /(?:\bArticle\s+[\w-]+|\be\d{3,}|ページ|\bpp?\.)/i.test(ending));
  return { year, dateState, doi, title, journal, authorArea, isJapaneseBook, isBook, referenceType, sourceUrl, institution, pages, hasPageOrArticleCue };
}

function scoreMatch(reference, fields, match) {
  const titleScore = fields.title
    ? similarity(fields.title, match.title)
    : similarity(reference, match.title);
  const yearCandidates = match.yearCandidates?.length
    ? match.yearCandidates
    : compact([match.year]);
  const yearScore = fields.year && yearCandidates.length
    ? yearCandidates.includes(String(fields.year))
      ? 1
      : 0
    : 0.5;
  const authorScore = authorSimilarity(fields.authorArea, match.authors);
  const doiScore = fields.doi
    ? normalize(fields.doi) === normalize(match.doi)
      ? 1
      : 0
    : 0.5;
  const confidence = Math.round(
    (titleScore * 0.5 + yearScore * 0.25 + authorScore * 0.15 + doiScore * 0.1) *
      100,
  ) / 100;
  return { titleScore, yearScore, authorScore, doiScore, confidence };
}

function matchConfidence(reference, fields, match) {
  const { confidence } = scoreMatch(reference, fields, match);
  return confidence;
}

function isReliableMatch(reference, fields, match) {
  const scores = scoreMatch(reference, fields, match);
  if (fields.doi) {
    return doiKey(fields.doi) === doiKey(match.doi);
  }
  if (!fields.title || (scores.titleScore < 0.82 && !titleMatches(fields.title, match.title))) return false;
  if (fields.authorArea && match.authors && scores.authorScore < 0.48) {
    return false;
  }
  if (fields.year && (match.yearCandidates?.length || match.year) && scores.yearScore === 0) {
    return false;
  }
  return Math.round(
    scores.confidence * 100,
  ) / 100 >= 0.58;
}

// データベース側の誌名は「ジュリスト = Monthly jurist / 有斐閣 [編]」のように
// 欧文併記や編者が付くことが多いため、片方がもう片方に含まれていれば一致とみなす
function journalMatches(provided, database) {
  const left = normalize(provided);
  const right = normalize(database);
  if (left.length >= 3 && right.length >= 3 && (right.includes(left) || left.includes(right))) {
    return true;
  }
  return similarity(provided, database) >= 0.72;
}

// データベースが副題を持たない場合があるため、一方が他方の先頭部分（十分な長さ）で
// あれば同じ題名とみなす。前方一致に限定し、「視点 ○○」のような別記事は除外する
function titleMatches(provided, database) {
  if (similarity(provided, database) >= 0.86) return true;
  const left = normalize(provided);
  const right = normalize(database);
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 12 && longer.startsWith(shorter);
}

function subtitleOmitted(provided, database) {
  const main = normalize(provided);
  const parts = String(database ?? "").normalize("NFKC").split(/\s*:\s*|\s+[–—―-]\s+/);
  return main.length >= 12 && parts.length > 1 && normalize(parts[0]) === main && Boolean(normalize(parts[1]));
}

function compareFields(fields, match, missingSubtitle) {
  const differences = [];
  const checkedFields = [];

  if (fields.title && match.title) {
    checkedFields.push("題名");
    if (missingSubtitle || !titleMatches(fields.title, match.title)) {
      differences.push({
        field: missingSubtitle ? "題名（副題）" : "題名",
        provided: fields.title,
        database: match.title,
      });
    }
  }
  if (fields.authorArea && match.authors) {
    checkedFields.push("著者");
    if (authorSimilarity(fields.authorArea, match.authors) < 0.48) {
      differences.push({
        field: "著者",
        provided: fields.authorArea.trim(),
        database: match.authors,
      });
    }
  }
  const yearCandidates = match.yearCandidates?.length
    ? match.yearCandidates
    : compact([match.year]);
  if (fields.year && yearCandidates.length) {
    checkedFields.push("発行年");
    if (!yearCandidates.includes(String(fields.year))) {
      differences.push({
        field: "発行年",
        provided: String(fields.year),
        database: yearCandidates.join(" / "),
      });
    }
  }
  if (fields.journal && match.journal) {
    checkedFields.push("掲載誌");
    if (!journalMatches(fields.journal, match.journal)) {
      differences.push({
        field: "掲載誌",
        provided: fields.journal,
        database: match.journal,
      });
    }
  }
  if (fields.institution && match.isRepositoryRecord && match.publisher) {
    checkedFields.push("発行元");
    if (normalize(fields.institution) !== normalize(match.publisher)) {
      differences.push({ field: "発行元", provided: fields.institution, database: match.publisher });
    }
  }
  if (fields.doi && match.doi) {
    checkedFields.push("DOI");
    if (normalize(fields.doi) !== normalize(match.doi)) {
      differences.push({
        field: "DOI",
        provided: fields.doi,
        database: match.doi,
      });
    }
  }
  return { differences, checkedFields };
}

function crossrefMatch(item, reference, fields, confidenceOverride = null) {
  const yearCandidates = compact([
    crossrefYear(item, "published-print"),
    crossrefYear(item, "published"),
    crossrefYear(item, "issued"),
    crossrefYear(item, "published-online"),
  ]);
  const match = {
    provider: "Crossref",
    publicationType: item.type,
    doi: item.DOI ?? null,
    // Crossrefは副題（subtitle）を別フィールドで持つため、結合して比較する
    title: decodeHtmlEntities(
      [item.title?.[0], item.subtitle?.[0]].filter(Boolean).join(": "),
    ),
    authors: decodeHtmlEntities(
      (item.author ?? [])
        .map((author) => [author.family, author.given].filter(Boolean).join(" "))
        .join(", "),
    ),
    journal: decodeHtmlEntities(item["container-title"]?.[0] ?? ""),
    authorNames: (item.author ?? []).map(({ family, given, name, suffix }) => ({ family, given, name, suffix })),
    volume: item.volume,
    issue: item.issue,
    pages: item["article-number"] && String(item.page) === String(item["article-number"]) ? null : normalizePages(item.page),
    articleNumber: item["article-number"] ?? null,
    publisher: decodeHtmlEntities(item.publisher),
    year: yearCandidates[0] ?? null,
    yearCandidates,
    url: safeHttpUrl(item.URL),
  };
  return {
    ...match,
    confidence:
      confidenceOverride === null
        ? matchConfidence(reference, fields, match)
        : confidenceOverride,
  };
}

function ciniiMatch(item, reference, fields) {
  const identifiers = Array.isArray(item["dc:identifier"])
    ? item["dc:identifier"]
    : item["dc:identifier"]
      ? [item["dc:identifier"]]
      : [];
  const doi =
    identifiers.find((identifier) => /DOI$/i.test(identifier?.["@type"] ?? ""))?.[
      "@value"
    ] ?? null;
  const publicationDate = item["prism:publicationDate"] ?? "";
  const isRepositoryRecord = item["dc:type"] === "OtherWorks";
  const creators = Array.isArray(item["dc:creator"])
    ? item["dc:creator"]
    : item["dc:creator"]
      ? [item["dc:creator"]]
      : [];
  const orderedCreators = [
    ...creators.filter(hasJapanese),
    ...creators.filter((creator) => !hasJapanese(creator)),
  ];
  const match = {
    provider: "CiNii Research",
    publicationType: item["dc:type"] === "Article" ? "journal-article" : null,
    doi,
    title: decodeHtmlEntities(item.title ?? ""),
    authors: decodeHtmlEntities(orderedCreators.join(", ")),
    journal: decodeHtmlEntities(item["prism:publicationName"] ?? ""),
    volume: item["prism:volume"],
    issue: item["prism:number"],
    pages: normalizePages(item["prism:pageRange"]) ?? pageRange(item["prism:startingPage"], item["prism:endingPage"]),
    publisher: decodeHtmlEntities(item["dc:publisher"]),
    year: String(publicationDate).match(/(?:19|20)\d{2}/)?.[0] ?? null,
    url: safeHttpUrl(item.link?.["@id"] ?? item["@id"]),
    isRepositoryRecord,
    repositoryUrl: isRepositoryRecord && safeHttpUrl(item["dc:source"]?.[0]?.["@id"]),
  };
  return {
    ...match,
    confidence: matchConfidence(reference, fields, match),
  };
}

async function repositoryMetadata(match) {
  try {
    const source = await fetchSource(match.repositoryUrl, { timeoutMs: 4_000 });
    if (source.format !== "html") return null;
    const metadata = extractHtmlMetadata(source.bytes, source.contentType, source.url);
    if (normalize(metadata.citationTitle) !== normalize(match.title)) return null;
    return { year: metadata.year, publisher: metadata.citationPublisher, originalUrl: source.url };
  } catch {
    return null;
  }
}

async function publisherPages(doi) {
  try {
    const source = await fetchSource(`https://doi.org/${encodeURI(doi)}`, { timeoutMs: 4_000 });
    if (source.format !== "html") return null;
    const metadata = extractHtmlMetadata(source.bytes, source.contentType, source.url);
    if (doiKey(metadata.citationDoi) !== doiKey(doi)) return null;
    const pages = pageRange(metadata.citationFirstPage, metadata.citationLastPage);
    return pages ? { pages, pagingProvider: "出版社の原典ページ", originalUrl: source.url } : null;
  } catch {
    return null;
  }
}

async function searchCrossref(reference, fields, headers) {
  if (fields.doi) {
    const response = await fetchWithTimeout(
      `https://api.crossref.org/works/${encodeURIComponent(fields.doi)}`,
      { headers },
    );
    if (response.ok) {
      const data = await response.json();
      return [crossrefMatch(data.message, reference, fields, 1)];
    }
  }

  const matches = [];
  let successfulResponses = 0;
  const title = fields.title || reference;
  const detailedQuery = fields.title && [fields.title, fields.authorArea.trim(), fields.year, fields.journal].filter(Boolean).join(" ");
  for (const query of compact([detailedQuery, ...queryVariants(title)]).slice(0, 2)) {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", query);
    url.searchParams.set("rows", "5");
    url.searchParams.set(
      "select",
      "DOI,type,title,subtitle,author,published,published-print,published-online,issued,container-title,volume,issue,page,article-number,publisher,URL",
    );
    if (process.env.CROSSREF_MAILTO) {
      url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
    }
    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) continue;
    const data = await response.json();
    successfulResponses += 1;
    const batch = (data.message?.items ?? []).map((item) => crossrefMatch(item, reference, fields));
    matches.push(...batch);
    if (batch.some((match) => isReliableMatch(reference, fields, match))) break;
  }
  if (!successfulResponses) throw new Error("Crossref lookup unavailable");
  return matches;
}

async function searchCinii(reference, fields) {
  const matches = [];
  let successfulResponses = 0;
  const title = fields.title || reference;
  const creator = fields.title && !hasJapanese(title)
    ? fields.authorArea.trim().match(/^[\p{L}][\p{L}'’-]+/u)?.[0] : null;
  const queries = [
    ...(fields.doi ? [{ doi: fields.doi }] : []),
    ...(creator ? [{ title, creator }] : []),
    ...queryVariants(title).map((q) => ({ q })),
  ].slice(0, 3);
  // 大学リポジトリの修士論文などは論文検索の対象外となる場合がある。
  const endpoint = fields.isBook || (hasJapanese(title) && !fields.journal) ? "all" : "articles";
  for (const [index, query] of queries.entries()) {
    if (index > 0) await wait(650);
    const url = new URL(`https://cir.nii.ac.jp/opensearch/${endpoint}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set("count", "10");
    url.searchParams.set("start", "1");
    url.searchParams.set("lang", "ja");
    url.searchParams.set("format", "json");
    if (process.env.CINII_APP_ID) {
      url.searchParams.set("appid", process.env.CINII_APP_ID);
    }
    const response = await fetchWithTimeout(url);
    if (!response.ok) continue;
    const data = await response.json();
    successfulResponses += 1;
    const batch = (data.items ?? []).map((item) => ciniiMatch(item, reference, fields));
    matches.push(...batch);
    if (batch.some((match) => isReliableMatch(reference, fields, match) && (fields.doi || normalize(fields.title) === normalize(match.title) || subtitleOmitted(fields.title, match.title)))) break;
  }
  if (!successfulResponses) throw new Error("CiNii lookup unavailable");
  return matches;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!checkOrigin(request)) {
    return response.status(403).json({ error: "Forbidden" });
  }
  if (isRateLimited(request, REQUESTS_PER_MINUTE)) {
    return response.status(429).json({ error: "Too many requests" });
  }
  if (isGloballyRateLimited(GLOBAL_REQUESTS_PER_MINUTE)) {
    return response.status(429).json({ error: "Too many requests" });
  }

  const reference = String(request.body?.reference ?? "").trim().slice(0, 1000);
  if (!reference) {
    return response.status(400).json({ error: "Reference is required" });
  }

  const fields = extractReferenceFields(reference);
  if (fields.referenceType === "web" || fields.referenceType === "report") {
    try {
      // URLの大文字・小文字やクエリを保持し、別ページの結果を混同しない。
      const source = await cachedLookup(`source:${reference}`, async () => {
        const fetched = await fetchSource(fields.sourceUrl);
        const metadata = fetched.format === "pdf"
          ? await extractPdfMetadata(fetched.bytes)
          : extractHtmlMetadata(fetched.bytes, fetched.contentType, fetched.url);
        return { ...compareSourceMetadata(fields, metadata), metadata, sourceUrl: fetched.url };
      });
      return response.status(200).json({
        ...source,
        referenceType: source.metadata.format === "pdf" ? "report" : fields.referenceType,
        bestMatch: null, providers: [], dateState: fields.dateState,
        links: { source: fields.sourceUrl },
      });
    } catch (error) {
      return response.status(200).json({
        status: "source_unavailable", sourceError: error.code ?? "parse_failed",
        referenceType: fields.referenceType, bestMatch: null, differences: [],
        checkedFields: [], providers: [], links: { source: fields.sourceUrl },
      });
    }
  }
  const headers = {
    "User-Agent": process.env.CROSSREF_MAILTO
      ? `ThesisSelfCheck/1.0 (mailto:${process.env.CROSSREF_MAILTO})`
      : "ThesisSelfCheck/1.0",
  };
  const { matches, providerErrors } = await cachedLookup(normalize(reference), async () => {
    const results = await Promise.allSettled([
      searchCrossref(reference, fields, headers),
      searchCinii(reference, fields),
    ]);
    const matches = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .sort((left, right) => right.confidence - left.confidence);
    const providerErrors = results.flatMap((result, index) => result.status === "rejected"
      ? [["Crossref", "CiNii Research"][index]] : []);
    return { matches, providerErrors };
  });
  const reliableMatches = matches.filter((match) => isReliableMatch(reference, fields, match));
  const best = reliableMatches[0];
  const needsRepository = best?.repositoryUrl && (!best.year || !best.publisher)
    && authorsCorroborated(fields.authorArea, best.authors)
    && (normalize(fields.title) === normalize(best.title) || subtitleOmitted(fields.title, best.title));
  const repository = needsRepository
    ? await cachedLookup(`repository:${best.repositoryUrl}:${best.title}`, async () => {
        const metadata = await repositoryMetadata(best);
        return metadata ? { metadata } : { providerErrors: ["repository"] };
      })
    : null;
  let bestMatch = repository?.metadata
    ? { ...best, originalUrl: repository.metadata.originalUrl,
        year: best.year ?? repository.metadata.year, publisher: best.publisher || repository.metadata.publisher }
    : best;
  const manualLinks = {
    doi: fields.doi ? `https://doi.org/${encodeURI(fields.doi)}` : null,
    cinii: `https://cir.nii.ac.jp/all?q=${encodeURIComponent(fields.title || reference)}`,
    scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(fields.title || reference)}`,
  };

  if (!bestMatch || bestMatch.confidence < 0.43 || !isReliableMatch(reference, fields, bestMatch)) {
    return response.status(200).json({
      status: providerErrors.length ? "lookup_incomplete" : fields.doi ? "doi_unconfirmed" : "not_found",
      providerErrors,
      bookLike: Boolean(fields.isBook),
      bestMatch: null,
      differences: [],
      checkedFields: [],
      providers: ["Crossref", "CiNii Research"],
      links: manualLinks,
    });
  }

  const doiConfirmed =
    fields.doi && bestMatch.doi && doiKey(fields.doi) === doiKey(bestMatch.doi);
  const sameAuthorAndYear = fields.year && scoreMatch(reference, fields, bestMatch).yearScore === 1
    && authorsCorroborated(fields.authorArea, bestMatch.authors);
  const missingSubtitle = subtitleOmitted(fields.title, bestMatch.title);
  const ambiguousSubtitle = missingSubtitle && reliableMatches.some((match) =>
    subtitleOmitted(fields.title, match.title) && normalize(match.title) !== normalize(bestMatch.title));
  const subtitleConfirmed = missingSubtitle && (doiConfirmed || (sameAuthorAndYear && !ambiguousSubtitle));
  const doiAvailable = !fields.doi && Boolean(bestMatch.doi) && normalize(fields.title) === normalize(bestMatch.title)
    && sameAuthorAndYear
    && (!fields.journal || (bestMatch.journal && journalMatches(fields.journal, bestMatch.journal)));
  if (bestMatch.journal && (doiConfirmed || doiAvailable)) {
    const related = matches.filter((match) => match !== best && doiKey(match.doi) === doiKey(bestMatch.doi));
    const pagination = related.find((match) => match.articleNumber || match.pages);
    const names = related.find((match) => match.authorNames?.length)?.authorNames;
    if (!bestMatch.pages && !bestMatch.articleNumber && pagination) {
      bestMatch = { ...bestMatch, pages: pagination.pages, articleNumber: pagination.articleNumber, pagingProvider: pagination.provider };
    }
    if (!bestMatch.authorNames?.length && names) bestMatch = { ...bestMatch, authorNames: names };
    if (!bestMatch.pages && !bestMatch.articleNumber && !fields.hasPageOrArticleCue && /^10\.\d{4,9}\/\S+$/.test(bestMatch.doi)) {
      const doi = bestMatch.doi;
      const { metadata } = await cachedLookup(`pages:${doiKey(doi)}`, async () => {
        const metadata = await publisherPages(doi);
        return metadata ? { metadata } : { providerErrors: ["publisher"] };
      });
      if (metadata) bestMatch = { ...bestMatch, ...metadata };
    }
  }
  const pagesAvailable = Boolean(bestMatch.journal && bestMatch.pages && !fields.hasPageOrArticleCue
    && (doiConfirmed || (sameAuthorAndYear && normalize(fields.title) === normalize(bestMatch.title)
      && fields.journal && journalMatches(fields.journal, bestMatch.journal))));
  const comparison = compareFields(fields, bestMatch, subtitleConfirmed);
  const titleDiffers = comparison.differences.some(
    (difference) => difference.field === "題名",
  );
  const links = {
    ...manualLinks,
    source: bestMatch.originalUrl ?? bestMatch.url,
    doi: manualLinks.doi ?? (doiAvailable ? `https://doi.org/${encodeURI(bestMatch.doi)}` : null),
  };

  // 題名自体が一致しない候補は「同名に近い別文献」を掴んだ可能性が高いので、
  // 記載ミスとしての差異報告はせず、確認保留として返す（DOIが一致する場合を除く）
  if ((titleDiffers && !doiConfirmed) || (missingSubtitle && !subtitleConfirmed)) {
    return response.status(200).json({
      status: "unconfirmed",
      bookLike: Boolean(fields.isBook),
      bestMatch,
      differences: [],
      checkedFields: comparison.checkedFields,
      providers: [...new Set(matches.map((match) => match.provider))],
      links,
    });
  }

  return response.status(200).json({
    status: comparison.differences.length ? "mismatch" : "verified",
    doiAvailable: Boolean(doiAvailable),
    pagesAvailable,
    citationConfirmed: Boolean(doiConfirmed || doiAvailable || (sameAuthorAndYear
      && normalize(fields.title) === normalize(bestMatch.title) && fields.journal && journalMatches(fields.journal, bestMatch.journal))),
    bestMatch,
    differences: comparison.differences,
    checkedFields: comparison.checkedFields,
    providers: [...new Set(matches.map((match) => match.provider))],
    links,
  });
}
