const PATTERNS = [
  { type: "メールアドレス", regex: /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g },
  { type: "電話番号", regex: /(?:0\d{1,4}-?\d{1,4}-?\d{3,4})/g },
  { type: "学籍番号候補", regex: /\b[A-Z]?\d{7,10}\b/g },
];

export function findSensitiveText(document) {
  const findings = [];
  for (const paragraph of document.paragraphs) {
    for (const pattern of PATTERNS) {
      for (const match of paragraph.text.matchAll(pattern.regex)) {
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
  return PATTERNS.reduce(
    (masked, pattern) => masked.replace(pattern.regex, `[${pattern.type}]`),
    text,
  );
}

export function prepareAiPayload(document, selectedChecks) {
  return {
    checks: selectedChecks,
    sections: document.sections.map((section) => ({
      heading: section.heading,
      paragraphs: section.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: maskSensitiveText(paragraph.text),
      })),
    })),
    references: document.references.map((reference) => ({
      id: reference.id,
      text: maskSensitiveText(reference.text),
    })),
  };
}
