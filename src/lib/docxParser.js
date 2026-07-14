import JSZip from "jszip";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function parseXml(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const error = xml.querySelector("parsererror");
  if (error) throw new Error("Word文書のXMLを読み取れませんでした。");
  return xml;
}

function descendants(node, localName) {
  if (!node) return [];
  return [...node.getElementsByTagNameNS(WORD_NS, localName)];
}

function first(node, localName) {
  if (!node) return null;
  return node.getElementsByTagNameNS(WORD_NS, localName)[0] ?? null;
}

function attr(node, name) {
  return node?.getAttributeNS(WORD_NS, name) ?? node?.getAttribute(`w:${name}`) ?? "";
}

function nodeText(node) {
  const chunks = [];
  for (const child of node.getElementsByTagNameNS(WORD_NS, "*")) {
    if (child.localName === "t") chunks.push(child.textContent ?? "");
    if (child.localName === "tab") chunks.push("\t");
    if (child.localName === "br" || child.localName === "cr") chunks.push("\n");
  }
  return chunks.join("").trim();
}

function buildStyleMap(stylesXml) {
  if (!stylesXml) return new Map();
  const xml = parseXml(stylesXml);
  const styles = new Map();
  for (const style of descendants(xml, "style")) {
    const id = attr(style, "styleId");
    const name = attr(first(style, "name"), "val");
    if (id) styles.set(id, name || id);
  }
  return styles;
}

export function isDocumentTitleStyle(styleId, styleName) {
  return [styleId, styleName].some((value) =>
    /^(title|タイトル)$/i.test(String(value).trim()),
  );
}

function paragraphInfo(node, index, styleMap) {
  const styleId = attr(first(first(node, "pPr"), "pStyle"), "val");
  const styleName = styleMap.get(styleId) || styleId || "";
  const outlineValue = attr(first(first(node, "pPr"), "outlineLvl"), "val");
  const outlineLevel = outlineValue === "" ? null : Number(outlineValue);
  // Word の「タイトル」スタイルは表紙用であることが多く、章見出しとは区別する
  const isDocumentTitle = isDocumentTitleStyle(styleId, styleName);
  const isHeading =
    !isDocumentTitle &&
    (/heading|見出し/i.test(`${styleId} ${styleName}`) ||
      (outlineLevel !== null &&
        Number.isFinite(outlineLevel) &&
        outlineLevel >= 0 &&
        outlineLevel <= 8));
  const levelMatch = `${styleId} ${styleName}`.match(/(?:heading|見出し)\s*([1-9])/i);

  return {
    id: `p${index + 1}`,
    index: index + 1,
    text: nodeText(node),
    styleId,
    styleName,
    isHeading,
    headingLevel: levelMatch
      ? Number(levelMatch[1])
      : isHeading
        ? outlineLevel === null
          ? 1
          : outlineLevel + 1
        : null,
  };
}

function tableInfo(node, index) {
  const rows = [...node.children]
    .filter((child) => child.localName === "tr")
    .map((row) =>
      [...row.children]
        .filter((child) => child.localName === "tc")
        .map((cell) => nodeText(cell)),
    );
  return {
    id: `table${index + 1}`,
    index: index + 1,
    rows,
    text: rows.map((row) => row.join(" | ")).join("\n"),
  };
}

function extractFootnotes(xmlText) {
  if (!xmlText) return [];
  const xml = parseXml(xmlText);
  return descendants(xml, "footnote")
    .filter((node) => {
      const type = attr(node, "type");
      return !type || type === "normal";
    })
    .map((node, index) => ({
      id: attr(node, "id") || String(index + 1),
      text: nodeText(node),
    }))
    .filter((item) => item.text);
}

const REFERENCE_HEADING =
  /^\s*(?:第\s*[0-9０-９一二三四五六七八九十]{1,3}\s*[章節]|[0-9０-９]{1,2}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+)?\s*[．.，,、:：]?\s*(?:参考・引用文献|参考文献|引用文献|文献一覧|参考資料|references|bibliography)\s*(?:一覧)?\s*$/i;

// 参考文献の後に置かれる付録や謝辞まで文献として数えない
const REFERENCE_END_HEADING =
  /^\s*(?:第\s*[0-9０-９一二三四五六七八九十]{1,3}\s*[章節]|[0-9０-９]{1,2}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+)?\s*[．.，,、:：]?\s*(?:付録|補遺|謝辞|あとがき|索引|用語集|appendix|acknowledg(?:e)?ments?)\s*$/i;
const NAMED_APPENDIX_HEADING =
  /^\s*(?:付録|補遺|appendix)\s*[A-ZＡ-Ｚ0-9０-９一二三四五六七八九十]?\s*(?:[.．:：\-－]\s*)?(?:\S.{0,48})?$/i;

export function isReferenceEndParagraph(paragraph) {
  const text = paragraph.text.trim();
  if (REFERENCE_END_HEADING.test(text)) return true;
  if (!NAMED_APPENDIX_HEADING.test(text)) return false;
  // 文献名が偶然 Appendix で始まるケースを避け、短い見出しらしい段落だけを対象にする
  return paragraph.isHeading || !/(?:19|20)\d{2}|https?:|doi\b/i.test(text);
}

function splitReferences(paragraphs) {
  const start = paragraphs.findIndex((paragraph) =>
    REFERENCE_HEADING.test(paragraph.text),
  );
  if (start < 0) return { bodyParagraphs: paragraphs, references: [] };

  const endOffset = paragraphs
    .slice(start + 1)
    .findIndex(isReferenceEndParagraph);
  const referenceParagraphs =
    endOffset < 0 ? paragraphs.slice(start + 1) : paragraphs.slice(start + 1, start + 1 + endOffset);
  const paragraphsAfterReferences =
    endOffset < 0 ? [] : paragraphs.slice(start + 1 + endOffset);

  return {
    bodyParagraphs: [...paragraphs.slice(0, start), ...paragraphsAfterReferences],
    references: referenceParagraphs
      .filter((paragraph) => paragraph.text)
      .map((paragraph, index) => ({
        id: `ref${index + 1}`,
        paragraphId: paragraph.id,
        text: paragraph.text,
      })),
  };
}

function collectBlocks(node, paragraphs, tables, styleMap) {
  for (const child of node.children) {
    if (child.localName === "p") {
      paragraphs.push(paragraphInfo(child, paragraphs.length, styleMap));
    } else if (child.localName === "tbl") {
      tables.push(tableInfo(child, tables.length));
    } else if (child.localName === "sdt" || child.localName === "sdtContent") {
      // 目次などのコンテンツコントロール内の段落も本文として扱う
      collectBlocks(child, paragraphs, tables, styleMap);
    }
  }
}

function createSections(paragraphs) {
  const sections = [];
  let current = { id: "section-0", heading: "本文", level: 0, paragraphs: [] };
  sections.push(current);

  for (const paragraph of paragraphs) {
    if (paragraph.isHeading && paragraph.text) {
      current = {
        id: `section-${sections.length}`,
        heading: paragraph.text,
        level: paragraph.headingLevel || 1,
        paragraphs: [],
      };
      sections.push(current);
    } else if (paragraph.text) {
      current.paragraphs.push(paragraph);
    }
  }
  return sections.filter((section) => section.heading !== "本文" || section.paragraphs.length);
}

export async function parseDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("有効なWord文書ではありません。");

  const [documentXml, stylesXml, footnotesXml] = await Promise.all([
    documentEntry.async("text"),
    zip.file("word/styles.xml")?.async("text"),
    zip.file("word/footnotes.xml")?.async("text"),
  ]);

  const styleMap = buildStyleMap(stylesXml);
  const xml = parseXml(documentXml);
  const body = first(xml, "body");
  if (!body) throw new Error("Word文書の本文を読み取れませんでした。");

  const paragraphs = [];
  const tables = [];
  collectBlocks(body, paragraphs, tables, styleMap);
  const figureCount =
    descendants(body, "drawing").length + descendants(body, "pict").length;

  const { bodyParagraphs, references } = splitReferences(paragraphs);
  const footnotes = extractFootnotes(footnotesXml);
  const sections = createSections(bodyParagraphs);

  return {
    fileName: file.name,
    paragraphs: bodyParagraphs,
    sections,
    headings: bodyParagraphs.filter((paragraph) => paragraph.isHeading && paragraph.text),
    tables,
    footnotes,
    references,
    stats: {
      characters: bodyParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      paragraphs: bodyParagraphs.filter((paragraph) => paragraph.text).length,
      headings: bodyParagraphs.filter((paragraph) => paragraph.isHeading && paragraph.text).length,
      tables: tables.length,
      figures: figureCount,
      footnotes: footnotes.length,
      references: references.length,
    },
  };
}
