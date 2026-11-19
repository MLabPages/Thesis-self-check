import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractReferenceFields } from "./api/bibliography.js";
import { apaJournalReference } from "./src/lib/apaReference.js";

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
  assert.equal(result.status, "mismatch", "題名内の括弧を読み取り、副題の省略を知らせる");
  assert.deepEqual(result.differences.map(({ field }) => field), ["題名（副題）"]);
  assert.equal(result.bestMatch.url, article.link["@id"]);
  assert.ok(queries.includes(fullTitle), "入れ子の括弧で題名が途中で切れない");
  assert.ok(queries.some((query) => query.length <= 16), "短い題名の検索へフォールバックする");
  assert.ok(result.checkedFields.includes("著者"));
  assert.ok(result.checkedFields.includes("発行年"));

  const alwaysArticle = async (input) => new URL(input).hostname === "api.crossref.org"
    ? Response.json({ message: { items: [] } }) : Response.json({ items: [article] });
  const confirmed = `伴・東山（2020）「${article.title}」『北海道大学農経論叢』, 74, 109-117.`;
  assert.equal((await lookup(confirmed, alwaysArticle)).status, "verified", "副題まで記載済みなら差異なし");
  assert.equal((await lookup(`別人（2020）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`, alwaysArticle)).status, "not_found", "題名が近くても著者が違えば確定しない");
  assert.equal((await lookup(`伴・東山（2019）「${fullTitle}」『北海道大学農経論叢』, 74, 109-117.`, alwaysArticle)).status, "not_found", "題名が近くても年が違えば確定しない");
  const ambiguous = await lookup(`伴・東山（2020）「${fullTitle}」『北海道大学農経論叢』`, async (input) =>
    new URL(input).hostname === "api.crossref.org" ? Response.json({ message: { items: [] } })
      : Response.json({ items: [article, { ...article, title: `${fullTitle} : 別の事例調査` }] }));
  assert.equal(ambiguous.status, "unconfirmed", "主題・著者・年が同じ別候補があれば副題を確定しない");

  const thesisTitle = "サブスクリプション・サービスの継続理由の探索";
  const thesis = await lookup(`武藤史子（2019）「${thesisTitle}」 慶應義塾大学 総合政策学部 / 政策・メディア研究科.`, async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.crossref.org") return Response.json({ message: { items: [] } });
    assert.equal(url.pathname, "/opensearch/all");
    return Response.json({ items: [{
      title: `${thesisTitle} : 衣料品レンタルの利用者調査に基づく研究`,
      "dc:creator": ["武藤, 史子", "谷口, 尚子"], "dc:type": "OtherWorks",
      "dc:publisher": "慶應義塾大学大学院システムデザイン・マネジメント研究科", "prism:publicationDate": "2019",
    }] });
  });
  assert.equal(thesis.status, "mismatch");
  assert.deepEqual(thesis.differences.map(({ field }) => field), ["題名（副題）", "発行元"]);

  const english = await lookup("Arkes, H. R., & Blumer, C. (1985). The Psychology of Sunk Cost. Organizational Behavior and Human Decision Processes, 35(1), 124-140.", async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.crossref.org") {
      assert.match(url.searchParams.get("query.bibliographic"), /The Psychology of Sunk Cost.*Arkes.*1985/);
      return Response.json({ message: { items: [] } });
    }
    assert.equal(url.searchParams.get("title"), "The Psychology of Sunk Cost");
    assert.equal(url.searchParams.get("creator"), "Arkes");
    return Response.json({ items: [{
      title: "The psychology of sunk cost", "dc:creator": ["Hal R Arkes", "Catherine Blumer"],
      "prism:publicationName": "Organizational Behavior and Human Decision Processes", "prism:publicationDate": "1985-02",
      "prism:volume": "35", "prism:number": "1", "prism:startingPage": "124", "prism:endingPage": "140",
      "dc:identifier": [{ "@type": "cir:DOI", "@value": "10.1016/0749-5978(85)90049-4" }],
    }] });
  });
  assert.equal(english.status, "verified");
  assert.equal(english.doiAvailable, true, "文献が一致した場合に取得できたDOIを案内する");
  assert.equal(english.links.doi, "https://doi.org/10.1016/0749-5978(85)90049-4");
  assert.equal(english.bestMatch.pages, "124–140");
  assert.equal(english.pagesAvailable, false, "記載済みのページは追記候補にしない");

  const arkesDoi = "10.1016/0749-5978(85)90049-4";
  const arkesTitle = "The psychology of sunk cost";
  const arkesJournal = "Organizational Behavior and Human Decision Processes";
  const arkesRecord = {
    DOI: arkesDoi, type: "journal-article", title: [arkesTitle], "container-title": [arkesJournal], volume: "35", issue: "1",
    author: [{ family: "Arkes", given: "Hal R." }, { family: "Blumer", given: "Catherine" }], issued: { "date-parts": [[1985]] },
  };
  const noPages = `Arkes, H. R., & Blumer, C. (1985). ${arkesTitle}. ${arkesJournal}, 35(1). https://doi.org/${arkesDoi}`;
  const supplemented = await lookup(noPages, async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.crossref.org") return Response.json({ message: arkesRecord });
    assert.equal(url.searchParams.get("doi"), arkesDoi);
    return Response.json({ items: [{
      title: arkesTitle, "prism:startingPage": "124", "prism:endingPage": "140",
      "dc:identifier": [{ "@type": "cir:DOI", "@value": arkesDoi }],
    }] });
  });
  assert.equal(supplemented.status, "verified");
  assert.equal(supplemented.pagesAvailable, true, "同一DOIを持つ別の照合先から掲載ページを取得する");
  assert.equal(supplemented.bestMatch.pagingProvider, "CiNii Research");
  assert.equal(apaJournalReference(supplemented.bestMatch).text,
    `Arkes, H. R., & Blumer, C. (1985). ${arkesTitle}. ${arkesJournal}, 35(1), 124–140. https://doi.org/${arkesDoi}`);

  const electronic = await lookup(noPages, async (input) => new URL(input).hostname === "api.crossref.org"
    ? Response.json({ message: { ...arkesRecord, page: "e23456", "article-number": "e23456" } })
    : Response.json({ items: [] }));
  assert.equal(electronic.pagesAvailable, false, "記事番号は掲載ページ数として表示しない");
  assert.equal(apaJournalReference(electronic.bestMatch).tail, "(1), Article e23456.");
  assert.equal(apaJournalReference({ ...electronic.bestMatch, articleNumber: null }).paginationUnknown, true);
  assert.equal(apaJournalReference({ ...electronic.bestMatch, publicationType: "book-chapter" }), null);

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
  const recoveryReference = confirmed;
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
  assert.equal(doi.doiAvailable, false, "記載済みDOIを追記候補にしない");
  console.log("Bibliography verification passed");
} finally {
  globalThis.fetch = originalFetch;
  if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
  else process.env.ALLOWED_ORIGIN = previousOrigin;
}
