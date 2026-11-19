function apaAuthor({ family, given, name, suffix }) {
  if (name && !family) return name;
  if (!family || !given || /[^\p{Script=Latin}\s.'’\p{Pd}]/u.test(`${family} ${given}`)) return null;
  const initials = given.match(/\p{L}+(?:[-‐‑]\p{L}+)*/gu)
    ?.map((part) => part.split(/[-‐‑]/).map((word) => `${word[0].toUpperCase()}.`).join("-"))
    .join(" ");
  return initials ? [family, initials, suffix].filter(Boolean).join(", ") : null;
}

export function apaJournalReference(match) {
  if (match?.publicationType !== "journal-article" || !match.title || !match.journal || !match.year || !match.authorNames?.length) return null;
  const names = match.authorNames.map(apaAuthor);
  if (names.some((name) => !name)) return null;
  const authors = names.length > 20
    ? `${names.slice(0, 19).join(", ")}, … ${names.at(-1)}`
    : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  const title = match.title.replace(/(^|:\s+)(\p{Ll})/gu, (_, prefix, letter) => prefix + letter.toUpperCase());
  const prefix = `${authors} (${match.year}). ${title}${/[.!?]$/.test(title) ? "" : "."} `;
  const journal = [match.journal, match.volume].filter(Boolean).join(", ");
  const issue = match.issue ? `(${match.issue})` : "";
  const pages = match.pages ?? (match.articleNumber ? `Article ${String(match.articleNumber).replace(/^article\s+/i, "")}` : "");
  const tail = `${issue}${pages ? `, ${pages}` : ""}.`;
  const doi = match.doi ? `https://doi.org/${encodeURI(match.doi)}` : null;
  return { prefix, journal, tail, doi, text: `${prefix}${journal}${tail}${doi ? ` ${doi}` : ""}`, paginationUnknown: !pages };
}
