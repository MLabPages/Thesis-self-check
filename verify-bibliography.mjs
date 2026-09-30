import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractReferenceFields } from "./api/bibliography.js";

// CiNii OpenSearchの実データから必要な書誌情報だけ保存（2026-09-30取得）。
const article = JSON.parse(await readFile(new URL("./tests/fixtures/cinii-value-creation.json", import.meta.url)));
const previousOrigin = process.env.ALLOWED_ORIGIN;
const originalFetch = globalThis.fetch;
let run = 0;
const fullTitle = "小規模農業者による六次産業化の取り組みと顧客への新たな「価値創造」";
async function lookup(reference, fetchImpl, moduleKey = run++) {
  const { default: handler } = await import(`./api/bibliography.js?regression=${moduleKey}`);
  globalThis.fetch = fetchImpl;
  let status;
  let body;
  await handler(
    { method: "POST", headers: { origin: "https://bibliography-test.example" }, body: { reference }, socket: { remoteAddress: "bibliography-regression" } },
    { status(code) { status = code; return this; }, json(value) { body = value; return this; }, setHeader() {} },
  );
  assert.equal(status, 200);
  return body;
}
try {
  process.env.ALLOWED_ORIGIN = "https://bibliography-test.example";
  const queries = [];
  const successfulFetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.crossref.org") return Response.json({ message: { items: [] } });
    assert.equal(url.hostname, "cir.nii.ac.jp");
    const query = url.searchParams.get("q");
    queries.push(query);
    // 元の題名では0件、短縮検索では副題を含む実際の論文が返る状況を再現。
    return Response.json({ items: query.length <= 16 ? [article] : [] });
  };
  const result = await lookup(`伴・東山（2020）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`, successfulFetch);
  assert.equal(result.status, "verified", "題名内の括弧、著者の省略、副題付きメタデータを照合できる");
  assert.equal(result.bestMatch.url, article.link["@id"]);
  assert.ok(queries.includes(fullTitle), "入れ子の括弧で題名が途中で切れない");
  assert.ok(queries.some((query) => query.length <= 16), "短い題名の検索へフォールバックする");
  assert.ok(result.checkedFields.includes("著者"));
  assert.ok(result.checkedFields.includes("発行年"));

  const alwaysArticle = async (input) => new URL(input).hostname === "api.crossref.org"
    ? Response.json({ message: { items: [] } }) : Response.json({ items: [article] });
  assert.equal((await lookup(`別人（2020）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`, alwaysArticle)).status, "not_found", "題名が近くても著者が違えば確定しない");
  assert.equal((await lookup(`伴・東山（2019）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`, alwaysArticle)).status, "not_found", "題名が近くても年が違えば確定しない");

  for (const [reference, url, type] of [
    ['萩むつみ豚HP（2026）「令和3年度6次産業アワード農林水産大臣官房局長賞を受賞」, (https://www.mutsumibuta.com/news/258/), (2026年1月14日確認)', "https://www.mutsumibuta.com/news/258/", "web"],
    ['尾鷲物産株式会社HP（2016b）「事業紹介」(https://www.owasebussan.net/business)(2026年1月14日確認)', "https://www.owasebussan.net/business", "web"],
    ['瀬戸内ジャムズガーデンHP（2026）「お知らせ, ジャム屋日記」(https://www.jams-garden.com/gift), (2026年1月14日確認)', "https://www.jams-garden.com/gift", "web"],
    ['日本政策金融公庫（2012）「平成24年度農業の六次産業化等に関する調査」, 2013年3月 (https://www.jfc.go.jp/n/findings/pdf/report.pdf)', "https://www.jfc.go.jp/n/findings/pdf/report.pdf", "report"],
  ]) {
    const web = extractReferenceFields(reference);
    assert.equal(web.referenceType, type);
    assert.equal(web.sourceUrl, url);
  }
  const blocked = await lookup('企業HP（n.d.）「説明」 http://127.0.0.1/private', () => { throw new Error("Web資料を論文データベースに送信しない"); });
  assert.equal(blocked.status, "source_unavailable");
  assert.equal(blocked.sourceError, "blocked_url");
  const unavailable = await lookup(`伴・東山（2020）「${fullTitle}」`, async () => Response.json({ error: "unavailable" }, { status: 503 }));
  assert.equal(unavailable.status, "lookup_incomplete", "サービス停止を文献未発見と区別する");
  assert.deepEqual(unavailable.providerErrors, ["Crossref", "CiNii Research"]);
  const recoveryReference = `伴・東山（2020）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`;
  await lookup(recoveryReference, async () => Response.json({}, { status: 503 }), "recovery");
  assert.equal((await lookup(recoveryReference, alwaysArticle, "recovery")).status, "verified", "接続障害をキャッシュせず、再実行で回復する");
  const balancedUrl = extractReferenceFields("企業HP（2020）「説明」 https://example.com/article_(details)");
  assert.equal(balancedUrl.sourceUrl, "https://example.com/article_(details)", "URL内の括弧は保持する");
  const datedUrl = extractReferenceFields("企業HP（2020）「説明」 https://example.com/2020-05-15/news");
  assert.equal(datedUrl.referenceType, "web", "URL内の数字を巻号・ページと誤認しない");
  const doi = await lookup("Author (2020) Article. https://doi.org/10.1234/test", async (input) => {
    if (new URL(input).hostname === "api.crossref.org") return Response.json({ message: { DOI: "10.1234/test", title: ["Article"], author: [{ family: "Author" }], issued: { "date-parts": [[2020]] } } });
    return Response.json({ items: [] });
  });
  assert.equal(doi.status, "verified", "DOI付き論文をWeb資料に分類しない");
  console.log("Bibliography verification passed");
} finally {
  globalThis.fetch = originalFetch;
  if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
  else process.env.ALLOWED_ORIGIN = previousOrigin;
}
