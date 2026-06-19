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

function paragraphLocation(paragraph) {
  return `本文 ${paragraph.index}段落`;
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

function checkWriting(document) {
  const findings = [];
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
    {
      regex: /です。|ます。/,
      title: "文体の混在候補",
      suggestion: "大学・研究室の指定に応じて「である」調へ統一してください。",
      reason: "論文内で「です・ます」調と「である」調が混在していないか確認が必要です。",
    },
  ];

  for (const paragraph of document.paragraphs) {
    if (!paragraph.text || paragraph.isHeading) continue;
    for (const rule of rules) {
      if (rule.regex.test(paragraph.text)) {
        findings.push(
          result({
            category: "誤字脱字・文章表現",
            location: paragraphLocation(paragraph),
            title: rule.title,
            original: paragraph.text,
            suggestion: rule.suggestion,
            reason: rule.reason,
          }),
        );
      }
    }
    const longSentences = splitSentences(paragraph.text).filter(isStructurallyLong);
    for (const sentence of longSentences) {
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          location: paragraphLocation(paragraph),
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

function checkFigures(document) {
  const findings = [];
  const fullText = document.paragraphs.map((paragraph) => paragraph.text).join("\n");
  const figureMentions = fullText.match(/(?:図|表)\s*[0-9０-９]+/g) ?? [];
  if (document.tables.length > 0 && figureMentions.length === 0) {
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

function checkEthics(document) {
  return findSensitiveText(document).map((finding) =>
    result({
      category: "研究倫理・個人情報",
      severity: "important",
      location: finding.paragraphId.replace("p", "本文 ") + "段落",
      title: `${finding.type}の可能性`,
      original: finding.value,
      suggestion: "匿名化、削除、または掲載同意の有無を確認してください。",
      reason: "AIへ送信する場合、この値は自動的にマスクする対象です。",
    }),
  );
}

export function runLocalChecks(document, selectedChecks) {
  const checks = {
    format: checkFormat,
    writing: checkWriting,
    logic: checkLogic,
    figures: checkFigures,
    citations: checkCitations,
    ethics: checkEthics,
  };
  return selectedChecks.flatMap((id) => checks[id]?.(document) ?? []);
}
