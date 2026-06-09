import { findSensitiveText } from "./privacy";

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
    const sentences = paragraph.text.split(/[。！？]/).filter(Boolean);
    if (sentences.some((sentence) => sentence.length >= 120)) {
      findings.push(
        result({
          category: "誤字脱字・文章表現",
          location: paragraphLocation(paragraph),
          title: "一文が長すぎる可能性",
          original: paragraph.text,
          suggestion: "主語と述語の対応を確認し、複数の文に分けることを検討してください。",
          reason: "長い文は論理関係が読み取りにくくなることがあります。",
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
    const hasLocator = /doi\.org|10\.\d{4,9}\/[-._;()/:A-Z0-9]+|https?:\/\//i.test(reference.text);
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
    if (!hasLocator) {
      findings.push(
        result({
          category: "引用・参考文献",
          severity: "info",
          location: `参考文献 ${reference.id.replace("ref", "")}`,
          title: "文献の実在性を外部照合する候補",
          original: reference.text,
          suggestion: "論文名・著者・掲載誌をCrossrefまたはCiNii Researchで照合します。",
          reason: "DOIやURLがない文献は、題名などを使った書誌検索が必要です。",
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
