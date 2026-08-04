const PATTERNS = [
  { type: "メールアドレス", regex: /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g },
  // 市外局番は区切りあり、区切りなしは携帯電話番号に限定して数値データとの誤一致を抑える
  { type: "電話番号", regex: /(?:0(?:[789]0)\d{8}|0\d{1,4}[-－]\d{1,4}[-－]\d{3,4})/g },
  {
    type: "学籍番号候補",
    regex: /\b[A-Z]?\d{7,10}\b/g,
    validate(text, match) {
      // 英字付きIDは候補とする。数字だけの場合は「学籍番号」等の近傍に限り、
      // YYYYMMDD形式の日付や分析用の長い数値との誤一致を避ける。
      if (/^[A-Z]/.test(match[0])) return true;
      const context = text.slice(Math.max(0, match.index - 16), match.index + match[0].length + 16);
      return /(学籍(?:番号|No\.?|ID)|学生番号|student\s*(?:number|no\.?|id))/i.test(context);
    },
  },
];

function isValidMatch(text, pattern, match) {
  return !pattern.validate || pattern.validate(text, match);
}

export function findSensitiveText(document) {
  const findings = [];
  for (const paragraph of document.paragraphs) {
    for (const pattern of PATTERNS) {
      for (const match of paragraph.text.matchAll(pattern.regex)) {
        if (!isValidMatch(paragraph.text, pattern, match)) continue;
        findings.push({
          paragraphId: paragraph.id,
          type: pattern.type,
          value: match[0],
        });
      }
    }
  }
  return findings;
}

export function maskSensitiveText(text) {
  // 置換の判定は必ず元の文章に対して行う。途中結果を見てしまうと、
  // 先に置換されたパターンの影響で「学籍番号」等の手がかりが消え、
  // パターンの順序によって結果が変わってしまう
  const source = String(text ?? "");
  const replacements = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern.regex)) {
      if (!isValidMatch(source, pattern, match)) continue;
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        label: `[${pattern.type}]`,
      });
    }
  }
  if (!replacements.length) return source;

  replacements.sort((left, right) => left.start - right.start || right.end - left.end);
  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    // 範囲が重なる場合は先に採用したものを優先する
    if (replacement.start < cursor) continue;
    result += source.slice(cursor, replacement.start) + replacement.label;
    cursor = replacement.end;
  }
  return result + source.slice(cursor);
}

export function prepareAiPayload(document, selectedChecks) {
  const includeReferences = selectedChecks.includes("citations");
  return {
    checks: selectedChecks,
    sections: document.sections.map((section) => ({
      heading: section.heading,
      paragraphs: section.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: maskSensitiveText(paragraph.text),
      })),
    })),
    references: includeReferences
      ? document.references.map((reference) => ({
          id: reference.id,
          text: maskSensitiveText(reference.text),
        }))
      : [],
  };
}
