import { findSensitiveText } from "./privacy.js";

function result({ category, severity = "warning", location, title, original, suggestion, reason }) {
  return {
    id: crypto.randomUUID(),
    category,
    severity,
    location,
    title,
    original,
    suggestion,
    reason,
  };
}

function buildSectionMap(document) {
  const map = new Map();
  for (const section of document.sections ?? []) {
    if (section.heading === "本文") continue;
    for (const paragraph of section.paragraphs) {
      map.set(paragraph.id, section.heading);
    }
  }
  return map;
}

function paragraphLocation(paragraph, sectionMap) {
  const base = `本文 ${paragraph.index}段落`;
  const heading = sectionMap?.get(paragraph.id);
  return heading ? `${heading} ＞ ${base}` : base;
}

function splitSentences(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
    return [...segmenter.segment(text)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
  }
  return text.match(/[^。！？!?]+[。！？!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function textForLengthCheck(sentence) {
  return sentence
    .replace(/「[^」]*」/g, "")
    .replace(/『[^』]*』/g, "")
    .replace(/（[^）]*(?:19|20)\d{2}[^）]*）/g, "")
    .replace(/\([^)]*(?:19|20)\d{2}[^)]*\)/g, "")
    .replace(/\s+/g, "");
}

function isStructurallyLong(sentence) {
  const effectiveText = textForLengthCheck(sentence);
  const statisticalPattern =
    /尺度|適合度|信頼性係数|妥当性|因子負荷|相関係数|回帰係数|平均値|標準偏差|媒介分析|間接効果|信頼区間|RMSEA|CFI|TLI|SRMR|AIC|BIC|Cronbach|χ[²2]?|カイ二乗|CI|p\s*[<=>]|[bβrtrF]\s*(?:\([^)]*\))?\s*=|α\s*=/i;
  const scaleDescriptionPattern =
    /調査に用いる変数|用いる変数|採用した|尺度|下位尺度|構成概念|因子モデル|ブランド経験|ブランド態度|ロイヤルティ|適合度/i;
  const numericExpressions =
    effectiveText.match(/(?:\d+(?:\.\d+)?%?|[αβχ²]|b|r|p|CI|RMSEA|CFI|TLI|SRMR)\s*[=<>]?\s*-?\d*(?:\.\d+)?/gi) ??
    [];
  if (statisticalPattern.test(effectiveText) && numericExpressions.length >= 3) {
    return false;
  }
  const parentheticalTermCount = (sentence.match(/[（(][A-Za-z][^）)]{1,40}[）)]/g) ?? [])
    .length;
  const citationCount = (sentence.match(/(?:19|20)\d{2}/g) ?? []).length;
  if (
    scaleDescriptionPattern.test(sentence) &&
    (parentheticalTermCount >= 2 || citationCount >= 2 || numericExpressions.length >= 2)
  ) {
    return false;
  }
  const punctuationCount = (effectiveText.match(/[、，,；;]/g) ?? []).length;
  const connectiveCount = (
    effectiveText.match(/ため|ので|しかし|一方|また|さらに|および|ならびに|ことから|ことにより/g) ?? []
  ).length;

  return (
    effectiveText.length >= 180 ||
    (effectiveText.length >= 145 && punctuationCount >= 4) ||
    (effectiveText.length >= 135 && punctuationCount >= 3 && connectiveCount >= 2)
  );
}

function hasJapaneseAsciiComma(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々],|,[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]/u.test(
    text,
  );
}

function isBulletLikeParagraph(text) {
  return /^\s*[・●■◆\-－]/.test(text);
}

const POLITE_SENTENCE = /(です|ます|でした|ました|ません|でしょう)(?:ね|よ)?[。！？!?」）)]*$/;

function isPoliteSentence(sentence) {
  return POLITE_SENTENCE.test(sentence.trim());
}

// 「」内の引用文は文体判定から除外する
function withoutQuotes(text) {
  return text.replace(/「[^」]*」/g, "").replace(/『[^』]*』/g, "");
}

function checkStyleMixture(document, sectionMap) {
  const politeHits = [];
  const plainHits = [];
  for (const paragraph of document.paragraphs) {
    if (!paragraph.text || paragraph.isHeading || isBulletLikeParagraph(paragraph.text)) continue;
    for (const sentence of splitSentences(withoutQuotes(paragraph.text))) {
      if (sentence.length < 8) continue;
      (isPoliteSentence(sentence) ? politeHits : plainHits).push({ paragraph, sentence });
    }
  }
  if (politeHits.length < 3 || plainHits.length < 3) return [];

  const minority = politeHits.length <= plainHits.length ? politeHits : plainHits;
  const minorityLabel = minority === politeHits ? "です・ます調" : "である調";
  return minority.slice(0, 5).map(({ paragraph, sentence }) =>
    result({
      category: "誤字脱字・文章表現",
      location: paragraphLocation(paragraph, sectionMap),
      title: "文体の混在（です・ます／である）",
      original: sentence,
      suggestion: `文書内で「です・ます調」${politeHits.length}文と「である調」${plainHits.length}文が混在しています。研究室の指定に合わせてどちらかへ統一してください。`,
      reason: `少数派の${minorityLabel}の文を最大5件表示しています。どちらかに統一されている場合、この指摘は表示されません。`,
    }),
  );
}

// 同一文書内に両方の表記が現れた場合だけ指摘するペア
const VARIANT_PAIRS = [
  ["行う", "行なう"],
  ["表す", "表わす"],
  ["現れる", "現われる"],
  ["サーバー", "サーバ"],
  ["コンピューター", "コンピュータ"],
  ["ユーザー", "ユーザ"],
  ["ブラウザー", "ブラウザ"],
  ["インタビュー", "インタヴュー"],
  ["問い合わせ", "問合せ"],
  ["取り組み", "取組み"],
  ["および", "及び"],
  ["ならびに", "並びに"],
  ["さらに", "更に"],
  ["ただし", "但し"],
  ["すなわち", "即ち"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countVariant(text, word, sibling) {
  // 「サーバ」のように相手表記の前方部分と重なる語は、後続の文字を除外して数える
  const pattern = sibling.startsWith(word)
    ? new RegExp(`${escapeRegExp(word)}(?!${escapeRegExp(sibling.slice(word.length, word.length + 1))})`, "g")
    : new RegExp(escapeRegExp(word), "g");
  return (text.match(pattern) ?? []).length;
}

function checkVariantSpelling(fullText) {
  const findings = [];
  for (const [first, second] of VARIANT_PAIRS) {
    const firstCount = countVariant(fullText, first, second);
    const secondCount = countVariant(fullText, second, first);
    if (firstCount > 0 && secondCount > 0) {
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          severity: "info",
          location: "文書全体",
          title: `表記ゆれ：「${first}」と「${second}」`,
          original: `「${first}」${firstCount}回、「${second}」${secondCount}回が同じ文書内で使われています。`,
          suggestion: "どちらかの表記に統一してください。WordのCtrl+Hですべて置換できます。",
          reason: "同じ語の表記が揺れていると、推敲不足の印象を与えます。どちらが正しいかは研究室の指定に従ってください。",
        }),
      );
    }
  }
  return findings.slice(0, 5);
}

function checkWriting(document, sectionMap) {
  const findings = [];
  const fullText = document.paragraphs.map((paragraph) => paragraph.text).join("\n");
  let asciiCommaFindings = 0;
  let duplicateFindings = 0;
  let fullwidthFindings = 0;
  const hasHalfwidthAlnum = /[0-9A-Za-z]/.test(fullText);
  const rules = [
    {
      regex: /(私は|自分は|筆者は).{0,20}(思う|感じる)/,
      title: "主観的な表現",
      suggestion: "根拠から導かれる客観的な表現へ変更してください。",
      reason: "論文では個人的な感想ではなく、資料や分析結果に基づいて記述します。",
    },
    {
      regex: /と思う|と思います/,
      title: "「思う」の使用",
      suggestion: "「考えられる」「示唆される」など、根拠に応じた表現を検討してください。",
      reason: "「思う」は感想として読まれやすい表現です。",
    },
  ];

  for (const paragraph of document.paragraphs) {
    if (!paragraph.text || paragraph.isHeading) continue;
    for (const rule of rules) {
      if (rule.regex.test(paragraph.text)) {
        findings.push(
          result({
            category: "誤字脱字・文章表現",
            location: paragraphLocation(paragraph, sectionMap),
            title: rule.title,
            original: paragraph.text,
            suggestion: rule.suggestion,
            reason: rule.reason,
          }),
        );
      }
    }
    const duplicateMatch = paragraph.text.match(/([のにをがへで])\1(?![ぁ-ん])|、、|。。/);
    if (duplicateFindings < 5 && duplicateMatch) {
      duplicateFindings += 1;
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          location: paragraphLocation(paragraph, sectionMap),
          title: `助詞・句読点の重複の可能性（「${duplicateMatch[0]}」）`,
          original: paragraph.text,
          suggestion: `「${duplicateMatch[0]}」の前後を読み直し、書き損じであれば削除してください。`,
          reason: "編集の途中で助詞や句読点が二重に残ることがよくあります。意図的な表記であれば無視してください。",
        }),
      );
    }
    if (
      fullwidthFindings < 3 &&
      hasHalfwidthAlnum &&
      /[０-９Ａ-Ｚａ-ｚ]/.test(paragraph.text)
    ) {
      fullwidthFindings += 1;
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          severity: "info",
          location: paragraphLocation(paragraph, sectionMap),
          title: "全角の英数字が混在しています",
          original: paragraph.text,
          suggestion: "文書内で半角英数字と全角英数字が混在しています。研究室の指定に合わせてどちらかへ統一してください。",
          reason: "英数字の全角・半角が混在していると、書式の統一に関する指摘を受けやすくなります。",
        }),
      );
    }
    if (asciiCommaFindings < 3 && hasJapaneseAsciiComma(paragraph.text)) {
      asciiCommaFindings += 1;
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          severity: "info",
          location: paragraphLocation(paragraph, sectionMap),
          title: "日本語文中の半角カンマを確認",
          original: paragraph.text,
          suggestion:
            "日本語の本文では、研究室・提出先の指定に応じて「，」や「、」へ統一してください。英語文献名やURL内のカンマは除外して考えてかまいません。",
          reason:
            "教員コメントでは、日本語本文中のカンマを全角に統一する指摘が複数見られました。",
        }),
      );
    }
    const longSentences = splitSentences(paragraph.text).filter(isStructurallyLong);
    for (const sentence of longSentences) {
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          location: paragraphLocation(paragraph, sectionMap),
          title: "一文の構造が複雑な可能性",
          original: sentence,
          suggestion:
            "引用表記や直接引用は保ったまま、主張・根拠・補足を分けられるか確認してください。",
          reason:
            "引用部分と（筆者，年）の表記を除いた長さに加え、読点や接続表現が多い文だけを抽出しています。尺度説明や適合度指標など、数値・統計記号を伴う報告文は原則として除外します。長いこと自体が誤りではありません。",
        }),
      );
    }
  }
  findings.push(...checkStyleMixture(document, sectionMap));
  findings.push(...checkVariantSpelling(fullText));
  return findings;
}

function checkFormat(document) {
  const findings = [];
  if (document.headings.length === 0 && document.stats.paragraphs >= 5) {
    findings.push(
      result({
        category: "書式・提出形式",
        severity: "important",
        location: "文書全体",
        title: "見出しスタイルが見つかりません",
        original: "見出し1・見出し2として認識された段落がありません。",
        suggestion: "章・節タイトルにWordの見出しスタイルを設定してください。",
        reason: "見出しスタイルは目次生成や文書構造の確認に必要です。",
      }),
    );
  }
  let levelJumpFindings = 0;
  let previousLevel = null;
  for (const heading of document.headings) {
    const level = heading.headingLevel ?? 1;
    if (previousLevel !== null && level - previousLevel >= 2 && levelJumpFindings < 3) {
      levelJumpFindings += 1;
      findings.push(
        result({
          category: "書式・提出形式",
          location: `本文 ${heading.index}段落`,
          title: `見出しレベルの飛び（見出し${previousLevel} → 見出し${level}）`,
          original: heading.text,
          suggestion: `直前の見出しレベル${previousLevel}から見出し${level}へ飛んでいます。間のレベルを使うか、見出しスタイルの設定を確認してください。`,
          reason: "見出しレベルが飛ぶと、目次の階層や章・節の構造が崩れて見えます。",
        }),
      );
    }
    previousLevel = level;
  }
  return findings;
}

function checkLogic(document) {
  const findings = [];
  const fullText = document.paragraphs.map((paragraph) => paragraph.text).join("\n");
  if (!/(目的|研究課題|問い)/.test(fullText)) {
    findings.push(
      result({
        category: "構成・論理展開",
        severity: "important",
        location: "文書全体",
        title: "研究目的を確認できません",
        original: "「目的」「研究課題」などの記述が検出されませんでした。",
        suggestion: "序論で研究目的または研究上の問いを明確にしてください。",
        reason: "研究目的は分析・考察・結論を結び付ける基準になります。",
      }),
    );
  }
  if (!/(結論|まとめ|おわりに|考察)/.test(fullText)) {
    findings.push(
      result({
        category: "構成・論理展開",
        location: "文書全体",
        title: "結論・考察の構成を要確認",
        original: "結論や考察に該当する語を検出できませんでした。",
        suggestion: "研究目的への回答を示す章・節があるか確認してください。",
        reason: "研究目的と結論の対応を学生自身が確認する必要があります。",
      }),
    );
  }
  return findings;
}

function checkCompletionReadiness(document, sectionMap) {
  const findings = [];
  const fullText = document.paragraphs.map((paragraph) => paragraph.text).join("\n");
  const bodyParagraphs = document.paragraphs.filter(
    (paragraph) => paragraph.text && !paragraph.isHeading,
  );
  const hasResearchReview = /(先行研究|既存研究|レビュー|理論|概念|定義)/.test(fullText);
  const hasSurveyOrInterview = /(調査|アンケート|インタビュー|質問紙|分析)/.test(fullText);
  const hasDesignDetails =
    /(調査対象|対象者|調査日|調査期間|選定理由|質問項目|分析方法|分析ソフト|使用ソフト|ソフト名|バージョン|サンプル|回答者|手続き|有効回答|回収|尺度|因子分析|回帰分析|相関分析|共分散|SPSS|Excel|R|Python|AMOS|KH Coder|jamovi|SmartPLS)/i.test(
      fullText,
    );
  const hasResultSection = /(結果|分析結果)/.test(fullText);
  const hasDiscussionLanguage = /(考察|示唆|解釈|要因|理由|比較|明らかになった|と考えられる)/.test(
    fullText,
  );
  const hasFigureOrTableMention = /(?:図|表)\s*[0-9０-９]+/.test(fullText);
  const hasSourceLabel = /(出典|出所|作成|参考|引用)/.test(fullText);
  const bulletLikeParagraphs = bodyParagraphs.filter((paragraph) =>
    isBulletLikeParagraph(paragraph.text),
  );

  if (hasSurveyOrInterview && !hasResearchReview) {
    findings.push(
      result({
        category: "完成度・教員コメント観点",
        severity: "info",
        location: "調査・分析の前後",
        title: "先行研究から調査へつながっているか確認",
        original: "調査・分析に関する語は見つかりましたが、先行研究や概念整理の語が少ない可能性があります。",
        suggestion:
          "調査に入る前に、既存研究で何が分かっていて、何が不足しているため自分の調査が必要なのかを説明してください。",
        reason:
          "教員コメントでは、レビューを踏まえて調査目的や方法を位置づける修正が多く見られました。",
      }),
    );
  }

  if (hasSurveyOrInterview && !hasDesignDetails) {
    findings.push(
      result({
        category: "完成度・教員コメント観点",
        severity: "info",
        location: "調査方法",
        title: "調査設計の具体性を確認",
        original: "調査や分析への言及があります。",
        suggestion:
          "調査対象、選定理由、調査日・期間、質問項目、分析方法、使用ソフトなどを方法の章で説明しているか確認してください。",
        reason:
          "初稿へのコメントでは、結果だけでなく調査設計を具体的に書くよう求める指摘が目立ちました。",
      }),
    );
  }

  if (bulletLikeParagraphs.length >= 3) {
    findings.push(
      result({
        category: "完成度・教員コメント観点",
        severity: "info",
        location: "文書全体",
        title: "箇条書きのまま残っていないか確認",
        original: `箇条書きのような段落を${bulletLikeParagraphs.length}件検出しました。`,
        suggestion:
          "方法、結果、考察の本文では、必要に応じて箇条書きを文章に直し、前後の説明を補ってください。チェックリストや質問項目として必要な箇条書きは残してかまいません。",
        reason:
          "教員コメントでは、メモ的な箇条書きを論文本文の説明文へ整える指摘が繰り返し見られました。",
      }),
    );
  }

  for (const paragraph of bodyParagraphs) {
    if (/(自分の経験|私の経験|個人的な経験|体験談|私自身|自分自身)/.test(paragraph.text)) {
      findings.push(
        result({
          category: "完成度・教員コメント観点",
          severity: "warning",
          location: paragraphLocation(paragraph, sectionMap),
          title: "個人的経験が根拠になっていないか確認",
          original: paragraph.text,
          suggestion:
            "個人的な経験は研究動機として整理し、主張の根拠には資料・データ・先行研究・調査結果を示してください。",
          reason:
            "教員コメントでは、個人的エピソードを根拠として使わず、確認できる資料へ置き換える指摘がありました。",
        }),
      );
      break;
    }
  }

  if (hasFigureOrTableMention && !hasSourceLabel) {
    findings.push(
      result({
        category: "完成度・教員コメント観点",
        severity: "info",
        location: "図表",
        title: "図表の出典・自作表記を確認",
        original: "本文中に図表番号が見つかりました。",
        suggestion:
          "図表ごとに、出典、自作・筆者作成、加工の有無を示しているか確認してください。詳細な文献情報は参考文献欄に置きます。",
        reason:
          "完成版に向けた修正では、図表の出典、脚注、参考文献欄の使い分けがよく指摘されていました。",
      }),
    );
  }

  if (hasResultSection && !hasDiscussionLanguage) {
    findings.push(
      result({
        category: "完成度・教員コメント観点",
        severity: "info",
        location: "結果・考察",
        title: "結果を解釈・考察まで進めているか確認",
        original: "結果や分析結果への言及があります。",
        suggestion:
          "結果を示すだけで終わらず、なぜその結果になったのか、先行研究と比べて何が言えるのか、研究目的にどう答えるのかを書いてください。",
        reason:
          "教員コメントでは、結果の説明から考察・示唆へつなげる修正が複数見られました。",
      }),
    );
  }

  return findings;
}

function toHalfwidthNumber(value) {
  return Number(value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)));
}

function missingNumberFindings(fullText, kind) {
  // 「図1-2」のような章別番号を使う文書では欠番判定をしない
  if (new RegExp(`${kind}\\s*[0-9０-９]+\\s*[-－.．][0-9０-９]`).test(fullText)) return [];
  const numbers = [
    ...new Set(
      [...fullText.matchAll(new RegExp(`${kind}\\s*([0-9０-９]+)`, "g"))].map((match) =>
        toHalfwidthNumber(match[1]),
      ),
    ),
  ].sort((left, right) => left - right);
  if (numbers.length < 2) return [];
  const missing = [];
  for (let expected = 1; expected <= numbers[numbers.length - 1]; expected += 1) {
    if (!numbers.includes(expected)) missing.push(expected);
  }
  if (missing.length === 0 || missing.length > 5) return [];
  return [
    result({
      category: "図表",
      location: "文書全体",
      title: `${kind}番号に欠番の可能性（${missing.map((number) => `${kind}${number}`).join("・")}）`,
      original: `本文中で参照されている${kind}番号：${numbers.map((number) => `${kind}${number}`).join("、")}`,
      suggestion: `${missing.map((number) => `${kind}${number}`).join("・")}が本文で参照されていません。番号の振り直し忘れ、または${kind}の削除に伴う参照の消し忘れがないか確認してください。`,
      reason: `${kind}番号は1から順に連続させるのが原則です。意図的な構成であれば無視してください。`,
    }),
  ];
}

function checkFigures(document) {
  const findings = [];
  const fullText = document.paragraphs.map((paragraph) => paragraph.text).join("\n");
  const tableMentions = fullText.match(/表\s*[0-9０-９]+/g) ?? [];
  const figureMentions = fullText.match(/図\s*[0-9０-９]+/g) ?? [];
  if (document.tables.length > 0 && tableMentions.length === 0) {
    findings.push(
      result({
        category: "図表",
        location: `表 ${document.tables.length}件`,
        title: "表番号または本文からの参照を確認",
        original: `${document.tables.length}件の表を検出しましたが、「表1」などの参照を検出できませんでした。`,
        suggestion: "各表に番号・タイトル・出典を付け、本文から参照してください。",
        reason: "図表は本文の説明と対応させる必要があります。",
      }),
    );
  }
  if ((document.stats.figures ?? 0) > 0 && figureMentions.length === 0) {
    findings.push(
      result({
        category: "図表",
        location: `図 ${document.stats.figures}件`,
        title: "図番号または本文からの参照を確認",
        original: `${document.stats.figures}件の図（画像）を検出しましたが、「図1」などの参照を検出できませんでした。`,
        suggestion: "各図に番号・タイトル・出典を付け、本文から参照してください。",
        reason: "図表は本文の説明と対応させる必要があります。",
      }),
    );
  }
  findings.push(...missingNumberFindings(fullText, "図"));
  findings.push(...missingNumberFindings(fullText, "表"));
  return findings;
}

function checkCitations(document) {
  const findings = [];
  if (document.references.length === 0) {
    findings.push(
      result({
        category: "引用・参考文献",
        severity: "important",
        location: "文書末尾",
        title: "参考文献一覧を認識できません",
        original: "「参考文献」などの見出し以降に文献情報が見つかりませんでした。",
        suggestion: "参考文献一覧の見出しと記載位置を確認してください。",
        reason: "本文中の引用と参考文献一覧を照合するために必要です。",
      }),
    );
    return findings;
  }

  for (const reference of document.references) {
    const hasYear = /(?:19|20)\d{2}|n\.d\./i.test(reference.text);
    if (!hasYear) {
      findings.push(
        result({
          category: "引用・参考文献",
          location: `参考文献 ${reference.id.replace("ref", "")}`,
          title: "発行年が不足している可能性",
          original: reference.text,
          suggestion: "発行年、不明の場合は指定形式の「n.d.」が必要か確認してください。",
          reason: "文献の特定と引用形式の統一に必要です。",
        }),
      );
    }
  }
  return findings;
}

function checkEthics(document, sectionMap) {
  return findSensitiveText(document).map((finding) =>
    result({
      category: "研究倫理・個人情報",
      severity: "important",
      location:
        (sectionMap?.get(finding.paragraphId) ? `${sectionMap.get(finding.paragraphId)} ＞ ` : "") +
        finding.paragraphId.replace("p", "本文 ") +
        "段落",
      title: `${finding.type}の可能性`,
      original: finding.value,
      suggestion: "匿名化、削除、または掲載同意の有無を確認してください。",
      reason: "AIへ送信する場合、この値は自動的にマスクする対象です。",
    }),
  );
}

export function runLocalChecks(document, selectedChecks) {
  const sectionMap = buildSectionMap(document);
  const checks = {
    format: checkFormat,
    writing: checkWriting,
    logic: checkLogic,
    completion: checkCompletionReadiness,
    figures: checkFigures,
    citations: checkCitations,
    ethics: checkEthics,
  };
  return selectedChecks.flatMap((id) => checks[id]?.(document, sectionMap) ?? []);
}
