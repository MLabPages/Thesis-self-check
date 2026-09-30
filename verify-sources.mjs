import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { referenceDate } from "./src/lib/referenceDate.js";
import { extractReferenceFields } from "./api/bibliography.js";
import { runLocalChecks } from "./src/lib/localChecks.js";
import { fetchSource, isPublicAddress, validateSourceUrl } from "./api/_lib/sourceFetch.js";
import { compareSourceMetadata, extractHtmlMetadata, extractPdfMetadata, extractPdfTextMetadata } from "./api/_lib/sourceMetadata.js";

for (const reference of [
  '企業HP（n.d.）「事業紹介」 https://example.com/2016 (2026年1月14日確認)',
  '企業HP（Ｎ．Ｄ．）「事業紹介」 https://example.com/2016',
  'Company (n. d.). About us. https://example.com/2016 (retrieved 2026)',
]) {
  assert.equal(referenceDate(reference).dateState, "nd");
  assert.equal(extractReferenceFields(reference).year, null, "URLや閲覧年でn.d.を上書きしない");
}
assert.equal(referenceDate('企業HP「2020年の事業紹介」 https://example.com/2016 (2026年1月14日確認)').dateState, "missing");
assert.equal(referenceDate('企業HP（2016b）「事業紹介」 (2026年確認)').year, "2016");
const citations = (text) => runLocalChecks({ paragraphs: [], headings: [], tables: [], sections: [], footnotes: [], references: [{ id: "ref1", text }] }, ["citations"]);
assert.equal(citations('企業HP（n.d.）「事業紹介」').length, 0, "n.d.を発行年不足として警告しない");
assert.ok(citations('企業HP「事業紹介」 https://example.com/2020 (2026年確認)').some((item) => item.title.includes("発行年")), "閲覧年だけの記載を発行年ありにしない");

const html = (text) => extractHtmlMetadata(Buffer.from(text), "text/html; charset=utf-8", "https://example.com/about");
const homepage = html('<title>事業紹介｜尾鷲物産株式会社</title><meta property="og:site_name" content="尾鷲物産株式会社"><main><h1>事業紹介</h1><p>2016年創業</p></main><footer>Copyright 2026</footer><meta property="article:modified_time" content="2025-01-01">');
assert.equal(homepage.year, null, "創業年・著作権年・更新年を公開年にしない");
const fields = extractReferenceFields('尾鷲物産株式会社HP（n.d.）「事業紹介」 https://example.com/about (2026年確認)');
const partial = compareSourceMetadata(fields, homepage);
assert.equal(partial.status, "source_partial", "取得できない年を含めて完全一致としない");
assert.deepEqual(partial.checkedFields, ["題名", "作成者・発行元"]);
assert.deepEqual(partial.differences, [], "公開年なしのn.d.を差異としない");
const article = html('<title>調査結果｜研究所</title><main><h1>調査結果</h1></main><script type="application/ld+json">{"@type":"Article","headline":"調査結果","datePublished":"2021-03-10","dateModified":"2026-01-01","publisher":{"name":"研究所"}}</script>');
const citation = extractReferenceFields('研究所（2021）「調査結果」 https://example.com/about');
assert.equal(compareSourceMetadata(citation, article).status, "source_verified");
assert.equal(compareSourceMetadata({ ...citation, year: "2026" }, article).status, "source_mismatch");
assert.equal(compareSourceMetadata({ ...citation, year: null, dateState: "nd" }, article).status, "source_mismatch", "明示された公開年があればn.d.との差を表示する");
assert.equal(html('<title>会社情報</title><script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/other","datePublished":"2020-01-01"}</script>').year, null, "別ページの構造化データを使わない");
assert.equal(html('<main><article><h1>記事</h1><time datetime="2021-01-01">2021年1月1日</time><p>本文</p></article></main>').year, "2021");
assert.equal(html('<main><article><time datetime="2021-01-01"></time></article><article><time datetime="2022-01-01"></time></article></main>').year, null, "一覧の複数日付を公開年にしない");
assert.equal(html('<script type="application/ld+json">{broken}</script><h1>ページ</h1>').titles[0], "ページ");
assert.throws(() => html('<title>Just a moment...</title>'), (error) => error.code === "access_restricted", "接続制限ページを題名不一致として表示しない");

const pdf = extractPdfTextMetadata([{ index: 1, text: '平成24年度\n農業の六次産業化等に関する調査\n平成25年3月\n日本政策金融公庫\n' }], { CreationDate: 'D:20260101000000' });
assert.equal(pdf.year, "2013", "調査年度2012ではなく、表紙の発行年月2013を採用する");
assert.equal(compareSourceMetadata(extractReferenceFields('日本政策金融公庫（2012）「農業の六次産業化等に関する調査」 https://example.com/report.pdf'), pdf).status, "source_mismatch");
const scanned = extractPdfTextMetadata([{ index: 1, text: "" }], { CreationDate: "D:20260101000000" });
assert.equal(scanned.year, null);
assert.equal(compareSourceMetadata(fields, scanned).status, "source_partial");
assert.ok(scanned.notes.some((note) => note.includes("画像")));

// 小さな有効PDFを構築し、実際のPDFパーサーとサーバーレスworkerの読込みを通す。
function textPdf() {
  const content = 'BT /F1 18 Tf 60 700 Td (Survey report) Tj 0 -30 Td (Published 2021) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
assert.equal((await extractPdfMetadata(textPdf())).year, "2021");

for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(address), false, address);
assert.equal(isPublicAddress("8.8.8.8"), true);
const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
for (const url of ["file:///etc/passwd", "http://127.1", "http://2130706433", "http://[::1]", "http://user:pass@example.com", "https://example.com:8443", "http://localhost"]) await assert.rejects(() => validateSourceUrl(url, resolve), (error) => error.code === "blocked_url");
await assert.rejects(() => validateSourceUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]), (error) => error.code === "blocked_url");
let opens = 0;
const response = (statusCode, headers, content = "") => {
  const body = Readable.from([Buffer.from(content)]);
  // 未読の本文を破棄するとエラーが出るHTTPクライアントの動作を再現する。
  body._destroy = function(error, callback) { callback(error ?? (!this.readableEnded ? new Error("Request aborted") : null)); };
  return { statusCode, headers, body, close: async () => {} };
};
await assert.rejects(() => fetchSource("https://example.com", { resolve, open: async () => { opens++; return response(302, { location: "http://169.254.169.254/private" }); } }), (error) => error.code === "blocked_url");
assert.equal(opens, 1, "転送された内部URLへは接続しない");
const redirected = await fetchSource("https://example.com/old", { resolve, open: async (url, addresses) => {
  assert.equal(addresses[0].address, "8.8.8.8");
  return url.pathname === "/old" ? response(301, { location: "/about" }) : response(200, { "content-type": "text/html" }, "<html><h1>About us</h1></html>");
} });
assert.equal(redirected.url, "https://example.com/about");
await assert.rejects(() => fetchSource("https://example.com", { resolve, open: async () => response(404, {}) }), (error) => error.code === "http_404");
await assert.rejects(() => fetchSource("https://example.com", { resolve, open: async () => response(200, { "content-type": "text/html" }, "x".repeat(2 * 1024 * 1024 + 1)) }), (error) => error.code === "too_large");
await assert.rejects(() => fetchSource("https://example.com", { resolve: () => new Promise((resolve) => setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 50)), timeoutMs: 10 }), (error) => error.code === "timeout");
console.log("Source metadata and retrieval verification passed");
