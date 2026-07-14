import assert from "node:assert/strict";

import { checkOrigin } from "./api/_lib/guard.js";
import reviewHandler from "./api/review.js";
import { isDocumentTitleStyle, isReferenceEndParagraph } from "./src/lib/docxParser.js";
import { runLocalChecks } from "./src/lib/localChecks.js";
import { findSensitiveText, prepareAiPayload } from "./src/lib/privacy.js";

function makeDocument(texts, overrides = {}) {
  const paragraphs = texts.map((text, index) => ({
    id: `p${index + 1}`,
    index: index + 1,
    text,
    styleId: "",
    styleName: "",
    isHeading: false,
    headingLevel: null,
  }));
  return {
    paragraphs,
    sections: [{ id: "section-0", heading: "本文", level: 0, paragraphs }],
    headings: [],
    tables: [],
    footnotes: [],
    references: [],
    stats: {
      characters: texts.join("").length,
      paragraphs: paragraphs.length,
      headings: 0,
      tables: 0,
      figures: 0,
      footnotes: 0,
      references: 0,
    },
    ...overrides,
  };
}

const previousAllowedOrigin = process.env.ALLOWED_ORIGIN;
process.env.ALLOWED_ORIGIN = "https://example.com";
assert.equal(
  checkOrigin({ headers: { origin: "https://example.com.evil.test" } }),
  false,
  "許可URLに似た別オリジンを拒否する",
);
assert.equal(
  checkOrigin({ headers: { referer: "https://example.com/check" } }),
  true,
  "許可URL内のRefererを許可する",
);
if (previousAllowedOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
else process.env.ALLOWED_ORIGIN = previousAllowedOrigin;

const previousAiEnabled = process.env.AI_REVIEW_ENABLED;
delete process.env.AI_REVIEW_ENABLED;
let reviewStatus = null;
let reviewBody = null;
await reviewHandler(
  { method: "POST", headers: {}, body: {}, socket: { remoteAddress: "test-review-disabled" } },
  {
    status(code) {
      reviewStatus = code;
      return this;
    },
    json(body) {
      reviewBody = body;
      return this;
    },
    setHeader() {},
  },
);
assert.equal(reviewStatus, 503, "AIレビューAPIは既定で無効にする");
assert.equal(reviewBody?.error, "AI review is disabled");
if (previousAiEnabled === undefined) delete process.env.AI_REVIEW_ENABLED;
else process.env.AI_REVIEW_ENABLED = previousAiEnabled;

assert.equal(isDocumentTitleStyle("ChapterTitle", "Chapter Title"), false);
assert.equal(isDocumentTitleStyle("Title", "Title"), true);
assert.equal(
  isReferenceEndParagraph({ text: "付録A 調査票", isHeading: true }),
  true,
  "名前付き付録を参考文献の終了見出しとして認識する",
);

const dateDocument = makeDocument(["調査日は 20250101 である。"]);
assert.equal(findSensitiveText(dateDocument).length, 0, "日付を学籍番号候補にしない");
assert.equal(prepareAiPayload(dateDocument, ["writing"]).sections[0].paragraphs[0].text.includes("20250101"), true);
const studentDocument = makeDocument(["学籍番号 20250101"]);
assert.equal(findSensitiveText(studentDocument)[0]?.type, "学籍番号候補");
assert.match(prepareAiPayload(studentDocument, ["writing"]).sections[0].paragraphs[0].text, /学籍番号候補/);

const quoteDocument = makeDocument(["参加者は「重要だと思う」と回答した。"]);
assert.equal(
  runLocalChecks(quoteDocument, ["writing"]).some((finding) => finding.title === "「思う」の使用"),
  false,
  "直接引用内の「思う」を指摘しない",
);

const widthDocument = makeDocument(["ブランド経験を４つに分け、4つ目を説明した。"]);
const widthFinding = runLocalChecks(widthDocument, ["writing"]).find((finding) =>
  finding.title.startsWith("全角英数字を確認"),
);
assert.deepEqual(widthFinding?.ranges, [[7, 8]], "全角文字だけを強調する");

const decorativeDocument = makeDocument(["表紙"], {
  tables: [{ id: "table1", rows: [["氏名"]], text: "氏名" }],
  stats: {
    characters: 2,
    paragraphs: 1,
    headings: 0,
    tables: 1,
    figures: 1,
    footnotes: 0,
    references: 0,
  },
});
assert.equal(runLocalChecks(decorativeDocument, ["figures"]).length, 0, "ロゴやレイアウト表だけでは警告しない");

const captionDocument = makeDocument(["先行研究を参考にした。", "図1 概念モデル"]);
assert.equal(
  runLocalChecks(captionDocument, ["figures"]).some(
    (finding) => finding.title === "図表の出典・自作表記を確認",
  ),
  true,
  "無関係な「参考」の語で図表出典確認を抑止しない",
);

const payloadDocument = makeDocument(["本文 user@example.com"], {
  references: [{ id: "ref1", text: "文献 author@example.com" }],
});
assert.equal(prepareAiPayload(payloadDocument, ["writing"]).references.length, 0);
assert.equal(prepareAiPayload(payloadDocument, ["citations"]).references.length, 1);
assert.match(prepareAiPayload(payloadDocument, ["writing"]).sections[0].paragraphs[0].text, /メールアドレス/);

console.log("Rule verification passed");
