import { checkOrigin, isRateLimited } from "./_lib/guard.js";

// 書誌照合は1文献ごとに呼ばれるため、レビューAPIより高い上限にする
const REQUESTS_PER_MINUTE = 60;

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
  return compact([
    source,
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

function extractReferenceFields(reference) {
  const year = reference.match(/(?:19|20)\d{2}/)?.[0] ?? null;
  const doi =
    reference
      .match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]
      ?.replace(/[.,;)\]]+$/, "") ?? null;
  const quotedTitle = reference.match(/「([^」]{3,})」/)?.[1] ?? null;
  const bookTitle = reference.match(/『([^』]{3,})』/)?.[1] ?? null;
  // 「」がなく『』だけの日本語文献は書籍とみなす（『』は書名であり掲載誌名ではない）
  const isJapaneseBook = !quotedTitle && Boolean(bookTitle);
  const japaneseTitle =
    quotedTitle ??
    bookTitle ??
    reference.match(/[“"]([^”"]{5,})[”"]/)?.[1] ??
    null;
  const afterYear = year
    ? reference
        .slice(reference.search(new RegExp(`\\(?${year}\\)?`)))
        .replace(new RegExp(`^\\(?${year}\\)?[).．。\\s]*`), "")
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
  const hasVolumeOrPages = /\d+\s*\(\d+\)|\d+\s*[–\-−]\s*\d+/.test(reference);
  // 巻号の代わりに記事番号を使う雑誌論文（例: 12, e123456）を書籍扱いしない
  const hasArticleNumber = /\b\d+\s*,\s*(?:e?\d{4,})\b/i.test(reference);
  const isEnglishBook =
    !japaneseTitle && !doi && !hasVolumeOrPages && !hasArticleNumber && englishParts.length >= 2;
  const isBook = isJapaneseBook || isEnglishBook;
  const journal = isBook
    ? null
    : reference.match(/『([^』]{2,})』/)?.[1] ?? englishJournal;
  const authorArea = reference.split(/(?:19|20)\d{2}/)[0] ?? "";
  return { year, doi, title, journal, authorArea, isJapaneseBook, isBook };
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
    return normalize(fields.doi) === normalize(match.doi);
  }
  if (!fields.title || scores.titleScore < 0.82) return false;
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

function compareFields(fields, match) {
  const differences = [];
  const checkedFields = [];

  if (fields.title && match.title) {
    checkedFields.push("題名");
    if (!titleMatches(fields.title, match.title)) {
      differences.push({
        field: "題名",
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
    crossrefYear(item, "created"),
  ]);
  const match = {
    provider: "Crossref",
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
    year: yearCandidates[0] ?? null,
    yearCandidates,
    url: item.URL ?? null,
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
    doi,
    title: decodeHtmlEntities(item.title ?? ""),
    authors: decodeHtmlEntities(orderedCreators.join(", ")),
    journal: decodeHtmlEntities(item["prism:publicationName"] ?? ""),
    year: String(publicationDate).match(/(?:19|20)\d{2}/)?.[0] ?? null,
    url: item.link?.["@id"] ?? item["@id"] ?? null,
  };
  return {
    ...match,
    confidence: matchConfidence(reference, fields, match),
  };
}

async function searchCrossref(reference, fields, headers) {
  if (fields.doi) {
    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(fields.doi)}`,
      { headers },
    );
    if (response.ok) {
      const data = await response.json();
      return [crossrefMatch(data.message, reference, fields, 1)];
    }
  }

  const matches = [];
  for (const query of queryVariants(fields.title || reference).slice(0, 3)) {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", query);
    url.searchParams.set("rows", "5");
    url.searchParams.set(
      "select",
      "DOI,title,author,published,published-print,published-online,issued,created,container-title,URL",
    );
    if (process.env.CROSSREF_MAILTO) {
      url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
    }
    const response = await fetch(url, { headers });
    if (!response.ok) continue;
    const data = await response.json();
    matches.push(
      ...(data.message?.items ?? []).map((item) =>
        crossrefMatch(item, reference, fields),
      ),
    );
  }
  return matches;
}

async function searchCinii(reference, fields) {
  const matches = [];
  const queries = queryVariants(fields.title || reference).slice(0, 3);
  for (const [index, query] of queries.entries()) {
    if (index > 0) await wait(650);
    // 書籍は論文検索に載らないため、書籍らしい文献は横断検索（all）を使う
    const endpoint = fields.isBook ? "all" : "articles";
    const url = new URL(`https://cir.nii.ac.jp/opensearch/${endpoint}`);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    url.searchParams.set("start", "1");
    url.searchParams.set("lang", "ja");
    url.searchParams.set("format", "json");
    if (process.env.CINII_APP_ID) {
      url.searchParams.set("appid", process.env.CINII_APP_ID);
    }
    const response = await fetch(url);
    if (!response.ok) continue;
    const data = await response.json();
    const batch = (data.items ?? []).map((item) => ciniiMatch(item, reference, fields));
    matches.push(...batch);
    if (batch.some((match) => isReliableMatch(reference, fields, match))) break;
  }
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

  const reference = String(request.body?.reference ?? "").trim().slice(0, 1000);
  if (!reference) {
    return response.status(400).json({ error: "Reference is required" });
  }

  const fields = extractReferenceFields(reference);
  const headers = {
    "User-Agent": process.env.CROSSREF_MAILTO
      ? `ThesisSelfCheck/1.0 (mailto:${process.env.CROSSREF_MAILTO})`
      : "ThesisSelfCheck/1.0",
  };
  const results = await Promise.allSettled([
    searchCrossref(reference, fields, headers),
    searchCinii(reference, fields),
  ]);
  const matches = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((left, right) => right.confidence - left.confidence);
  const bestMatch = matches.find((match) => isReliableMatch(reference, fields, match)) ?? null;

  if (!bestMatch || bestMatch.confidence < 0.43) {
    return response.status(200).json({
      status: "not_found",
      bookLike: Boolean(fields.isBook),
      bestMatch: null,
      differences: [],
      checkedFields: [],
      providers: ["Crossref", "CiNii Research"],
      links: {
        cinii: `https://cir.nii.ac.jp/all?q=${encodeURIComponent(fields.title || reference)}`,
        scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(fields.title || reference)}`,
      },
    });
  }

  const comparison = compareFields(fields, bestMatch);
  const doiConfirmed =
    fields.doi && bestMatch.doi && normalize(fields.doi) === normalize(bestMatch.doi);
  const titleDiffers = comparison.differences.some(
    (difference) => difference.field === "題名",
  );
  const links = {
    source: bestMatch.url,
    cinii: `https://cir.nii.ac.jp/all?q=${encodeURIComponent(fields.title || reference)}`,
    scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(fields.title || reference)}`,
  };

  // 題名自体が一致しない候補は「同名に近い別文献」を掴んだ可能性が高いので、
  // 記載ミスとしての差異報告はせず、確認保留として返す（DOIが一致する場合を除く）
  if (titleDiffers && !doiConfirmed) {
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
    bestMatch,
    differences: comparison.differences,
    checkedFields: comparison.checkedFields,
    providers: [...new Set(matches.map((match) => match.provider))],
    links,
  });
}
