// 閲覧日・URL・題名中の年を発行年として扱わない。
export function referenceDate(reference) {
  const prefix = String(reference).normalize("NFKC").split(/[「『“"]|https?:\/\//i)[0];
  const parenthesized = [...prefix.matchAll(/\(\s*((?:18|19|20)\d{2}[a-z]?|n\s*\.\s*d\s*\.)[^)]{0,35}\)/gi)]
    .find((match) => !/閲覧|確認|アクセス|accessed|retrieved/i.test(match[0]));
  const bare = prefix.match(/(?:18|19|20)\d{2}[a-z]?|n\s*\.\s*d\s*\./i);
  const match = parenthesized ?? (bare && !/閲覧|確認|アクセス|accessed|retrieved/i.test(prefix) ? bare : null);
  if (!match) return { year: null, dateState: "missing", start: -1, end: -1 };
  const value = parenthesized ? match[1] : match[0];
  const noDate = /^n/i.test(value);
  return { year: noDate ? null : value.slice(0, 4), dateState: noDate ? "nd" : "provided", start: match.index, end: match.index + match[0].length };
}
