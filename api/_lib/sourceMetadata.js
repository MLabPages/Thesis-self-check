import { loadBuffer } from "cheerio";

function clean(value) { return String(value ?? "").replace(/[\s\u200b]+/g, " ").trim().slice(0, 500); }
function compact(values) { return [...new Set(values.map(clean).filter(Boolean))]; }
function normalize(value) { return clean(value).normalize("NFKC").toLowerCase().replace(/[\s「」『』“”"'（）()[\]{}.,，。、:：;；・\-–—]/g, ""); }

export function publicationYear(value) {
  const text = clean(value).normalize("NFKC");
  const western = text.match(/\b((?:18|19|20)\d{2})(?:年|[-/.]|\b)/);
  if (western) return western[1];
  const era = text.match(/(明治|大正|昭和|平成|令和)\s*(元|\d{1,2})\s*年/);
  return era ? String({ 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 }[era[1]] + (era[2] === "元" ? 1 : Number(era[2]))) : null;
}

function names(value) {
  if (Array.isArray(value)) return value.flatMap(names);
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return [value.name, value.legalName, ...names(value.alternateName)];
}

export function extractHtmlMetadata(bytes, contentType = "", sourceUrl = "") {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const $ = loadBuffer(bytes, { encoding: { transportLayerEncodingLabel: charset } });
  const meta = (key) => $('meta').toArray().filter((el) => ($(el).attr("property") ?? $(el).attr("name"))?.toLowerCase() === key).map((el) => $(el).attr("content"));
  const nodes = [];
  function collect(value, depth = 0) {
    if (!value || depth > 4 || nodes.length >= 100) return;
    if (Array.isArray(value)) value.forEach((item) => collect(item, depth + 1));
    else if (typeof value === "object") { nodes.push(value); collect(value["@graph"], depth + 1); }
  }
  $('script[type="application/ld+json"]').slice(0, 20).each((_i, el) => {
    const text = $(el).text();
    if (text.length > 100_000) return;
    try { collect(JSON.parse(text)); } catch { /* 壊れた構造化データは使わない */ }
  });
  const hasType = (node, types) => [node["@type"]].flat().some((type) => types.includes(type));
  const pageNodes = nodes.filter((node) => hasType(node, ["Article", "NewsArticle", "BlogPosting", "Report", "WebPage"]));
  const samePage = (value) => {
    try { const u = new URL(value, sourceUrl); const s = new URL(sourceUrl); return u.origin === s.origin && u.pathname.replace(/\/$/, "") === s.pathname.replace(/\/$/, ""); }
    catch { return false; }
  };
  // 関連記事のdatePublishedを引用中のページの年にしない。
  const primary = pageNodes.find((node) => samePage(node.url ?? node.mainEntityOfPage?.["@id"] ?? node.mainEntityOfPage ?? node["@id"]))
    ?? (pageNodes.length === 1 && !pageNodes[0].url && !pageNodes[0].mainEntityOfPage && !pageNodes[0]["@id"] ? pageNodes[0] : null);
  const pageTitle = clean($('title').text());
  if (/^(?:Just a moment|Access Denied|Attention Required|Robot Check|Security verification)/i.test(pageTitle)) {
    const error = new Error("access_restricted");
    error.code = "access_restricted";
    throw error;
  }
  const titleParts = pageTitle.split(/\s*[|｜]\s*|\s+[–—-]\s+/).filter(Boolean);
  const headings = $('main h1, article h1, h1').toArray().filter((el) => !$(el).closest('header,footer,nav').length).slice(0, 8).map((el) => $(el).text());
  const titles = compact([primary?.headline, primary?.name, ...meta("citation_title"), ...headings, ...meta("og:title"), pageTitle, titleParts[0]]);
  const publishers = compact([
    ...names(primary?.author), ...names(primary?.publisher), ...meta("citation_author"), ...meta("author"),
    ...nodes.filter((node) => hasType(node, ["Organization", "WebSite"])).flatMap(names),
    ...meta("og:site_name").flatMap((name) => String(name).split(/[|｜]/)),
    ...(titleParts.length > 1 ? [titleParts.at(-1)] : []),
    ...$('header h1').toArray().flatMap((el) => $(el).text().split(/\n/)),
  ]);
  const explicitDates = [primary?.datePublished, ...meta("article:published_time"), ...meta("citation_publication_date"), ...meta("datepublished"), ...meta("dc.date.issued")];
  const articles = $('article');
  const scope = articles.length === 1 ? articles : $('main');
  const dateElements = scope.find('[itemprop="datePublished"],time:not(.updated),.entry-date:not(.updated),.post-date,.news-date').toArray()
    .filter((el) => !$(el).closest('footer,nav,aside').length && !/更新|modified|updated/i.test(`${$(el).attr('class') ?? ''} ${$(el).text()}`));
  // 一覧ページの複数日付は採用しない。
  if (dateElements.length === 1) explicitDates.push($(dateElements[0]).attr('datetime') ?? $(dateElements[0]).attr('content') ?? $(dateElements[0]).text());
  const dated = explicitDates.map((date) => ({ year: publicationYear(date), evidence: clean(date) })).filter((item) => item.year);
  const years = compact(dated.map((item) => item.year));
  return { format: "html", titles, publishers, year: years.length === 1 ? years[0] : null,
    yearEvidence: years.length === 1 ? dated[0].evidence : null,
    notes: years.length > 1 ? ["公開年の候補が複数あり、確定できませんでした。"] : [] };
}

export function extractPdfTextMetadata(pages, info = {}) {
  const cover = pages.slice(0, 2).map((page) => page.text).join("\n").slice(0, 6000);
  const lines = cover.split(/\n/).map(clean).filter(Boolean);
  const title = clean(info.Title);
  const titles = compact([
    title && !/untitled|\.docx?$|\.pdf$|microsoft word/i.test(title) ? title : null,
    ...lines.slice(0, 20),
    lines.slice(0, 12).join(" "),
  ]);
  const publisherLines = pages.flatMap((page, index) => (index < 2 ? page.text.slice(0, 2000) : page.text.slice(-1500)).split(/\n/))
    .map((line) => clean(line).replace(/^(?:発行(?:者|元)?|編集|作成)[:：\s]*/, ""))
    .filter((line) => /株式会社|有限会社|大学|研究所|研究センター|公庫|独立行政法人|公益|一般社団|一般財団|省|庁|協会|機構/.test(line) && line.length < 100 && !/。|、|「|」|:\/\/|について|公庫が|ご案内|しています|ている|設立|取り組/.test(line));
  const publishers = compact([info.Author, ...publisherLines]);
  const dates = [];
  for (const { text } of pages) {
    const normalized = text.normalize("NFKC");
    for (const line of normalized.split(/\n/)) {
      // 調査年度・引用文献中の年・PDFファイルの作成日時は発行年にしない。
      if (/発行|刊行|発刊|公表|published/i.test(line) && !/予定|再版|参考文献/.test(line)) dates.push(line);
      else if (/^\s*(?:(?:18|19|20)\d{2}年\s*\d{1,2}月|(?:明治|大正|昭和|平成|令和)\s*(?:元|\d{1,2})年\s*\d{1,2}月)(?:\s*\d{1,2}日)?\s*$/.test(line)) dates.push(line);
    }
  }
  const dated = dates.map((date) => ({ year: publicationYear(date), evidence: clean(date) })).filter((item) => item.year);
  const years = compact(dated.map((item) => item.year));
  return { format: "pdf", titles, publishers, year: years.length === 1 ? years[0] : null, yearEvidence: years.length === 1 ? dated[0].evidence : null,
    notes: ["PDFの表紙付近と末尾の抽出テキストを確認しています。", ...(cover.trim().length < 30 ? ["PDFから十分なテキストを取得できませんでした。画像の文字は自動で読み取っていません。"] : []), ...(years.length > 1 ? ["発行年の候補が複数あり、確定できませんでした。"] : [])] };
}

export async function extractPdfMetadata(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // workerを明示的に読み込み、サーバーレスのファイル追跡にも含める。
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  globalThis.pdfjsWorker = worker;
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: true });
  const timer = setTimeout(() => { void task.destroy(); }, 8_000);
  try {
    const document = await task.promise;
    const { info } = await document.getMetadata();
    const indexes = [...new Set([1, 2, 3, document.numPages - 1, document.numPages].filter((page) => page > 0 && page <= document.numPages))];
    const pages = [];
    for (const index of indexes) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      let text = "";
      let previousY = null;
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5];
        if (previousY !== null && Math.abs(y - previousY) > 3 && !text.endsWith("\n")) text += "\n";
        text += `${item.str}${item.hasEOL ? "\n" : " "}`;
        previousY = y;
        if (text.length > 20_000) break;
      }
      pages.push({ index, text });
      page.cleanup();
    }
    return extractPdfTextMetadata(pages, info);
  } finally { clearTimeout(timer); await task.destroy(); }
}

function overlap(left, right) {
  const a = new Set([...normalize(left)].map((_, i, all) => all.slice(i, i + 2).join("")));
  const b = new Set([...normalize(right)].map((_, i, all) => all.slice(i, i + 2).join("")));
  return a.size && b.size ? [...a].filter((value) => b.has(value)).length * 2 / (a.size + b.size) : 0;
}

export function compareSourceMetadata(fields, metadata) {
  const rows = [];
  const title = fields.title;
  const matchingTitle = metadata.titles.find((candidate) => normalize(candidate) === normalize(title))
    ?? (metadata.format === "pdf" && normalize(title).length >= 8 ? metadata.titles.find((candidate) => normalize(candidate).includes(normalize(title))) : null);
  const bestTitle = matchingTitle ?? [...metadata.titles].sort((a, b) => overlap(title, b) - overlap(title, a))[0];
  rows.push({ field: "題名", provided: title || "記載を読み取れませんでした", source: bestTitle || "取得できませんでした", state: !title || !bestTitle ? "unknown" : matchingTitle ? "match" : "different" });
  const author = clean(fields.authorArea).replace(/[（(.,]+$/, "").replace(/(?:HP|ホームページ|ウェブサイト|website)\s*$/i, "").trim();
  const publisherName = (value) => normalize(value).replace(/【公式】|公式|株式会社|有限会社|公益社団法人|公益財団法人|一般社団法人|一般財団法人/g, "");
  const matchingPublisher = metadata.publishers.find((candidate) => normalize(candidate) === normalize(author) && normalize(author).length > 0)
    ?? metadata.publishers.find((candidate) => publisherName(candidate) === publisherName(author) && publisherName(author).length >= 3)
    ?? (metadata.format === "pdf" && publisherName(author).length >= 4 ? metadata.publishers.find((candidate) => {
      const referenceName = publisherName(author);
      const candidateName = publisherName(candidate);
      return candidateName.startsWith(referenceName) && /^(?:農林水産|経済|情報|事業|学部|大学院|研究|調査|政策|総務|企画|出版|広報).*(?:部|課|局|事業)$/.test(candidateName.slice(referenceName.length));
    }) : null);
  const bestPublisher = matchingPublisher ?? [...metadata.publishers].sort((a, b) => overlap(author, b) - overlap(author, a))[0];
  rows.push({ field: "作成者・発行元", provided: author || "記載を読み取れませんでした", source: bestPublisher || "取得できませんでした", state: !author || !bestPublisher ? "unknown" : matchingPublisher ? "match" : "different" });
  rows.push({ field: metadata.format === "pdf" ? "発行年" : "公開年", provided: fields.dateState === "nd" ? "n.d." : fields.year || "記載を読み取れませんでした", source: metadata.year || "取得した情報に公開・発行年の記載なし", state: !metadata.year || fields.dateState === "missing" ? "unknown" : fields.year === metadata.year ? "match" : "different", evidence: metadata.yearEvidence });
  const differences = rows.filter((row) => row.state === "different").map((row) => ({ field: row.field, provided: row.provided, database: row.source }));
  return { status: differences.length ? "source_mismatch" : rows.every((row) => row.state === "match") ? "source_verified" : "source_partial", comparisons: rows, differences, checkedFields: rows.filter((row) => row.state === "match").map((row) => row.field) };
}
