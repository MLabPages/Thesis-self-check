function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』（）()[\]{}.,，。、:：;；・\-–—]/g, "");
}

function bigrams(value) {
  const normalized = normalize(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set([...Array(normalized.length - 1)].map((_, index) => normalized.slice(index, index + 2)));
}

function diceSimilarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const item of leftSet) if (rightSet.has(item)) overlap += 1;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function matchConfidence(reference, match) {
  const normalizedReference = normalize(reference);
  const normalizedTitle = normalize(match.title);
  const titleScore =
    normalizedTitle.length >= 6 && normalizedReference.includes(normalizedTitle)
      ? 1
      : diceSimilarity(reference, match.title);
  const yearScore = match.year && reference.includes(String(match.year)) ? 1 : 0;
  const authorParts = normalize(match.authors)
    .split(/[,、]/)
    .filter((part) => part.length >= 2);
  const authorScore = authorParts.some((part) => normalizedReference.includes(part)) ? 1 : 0;
  return Math.round((titleScore * 0.6 + yearScore * 0.3 + authorScore * 0.1) * 100) / 100;
}

function toMatch(item, reference, confidenceOverride = null) {
  const match = {
    doi: item.DOI ?? null,
    title: item.title?.[0] ?? "",
    authors: (item.author ?? [])
      .map((author) => [author.family, author.given].filter(Boolean).join(" "))
      .join(", "),
    journal: item["container-title"]?.[0] ?? "",
    year: item.published?.["date-parts"]?.[0]?.[0] ?? null,
    url: item.URL ?? null,
    score: item.score ?? 0,
  };
  return {
    ...match,
    confidence:
      confidenceOverride === null ? matchConfidence(reference, match) : confidenceOverride,
  };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const reference = String(request.body?.reference ?? "").trim().slice(0, 1000);
  if (!reference) return response.status(400).json({ error: "Reference is required" });

  const doi = reference.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]?.replace(/[.,;)\]]+$/, "");
  const headers = {
    "User-Agent": process.env.CROSSREF_MAILTO
      ? `ThesisSelfCheck/1.0 (mailto:${process.env.CROSSREF_MAILTO})`
      : "ThesisSelfCheck/1.0",
  };

  if (doi) {
    const directResponse = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { headers },
    );
    if (directResponse.ok) {
      const directData = await directResponse.json();
      const bestMatch = toMatch(directData.message, reference, 1);
      return response.status(200).json({
        status: "verified",
        bestMatch,
        matches: [bestMatch],
      });
    }
  }

  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", reference);
  url.searchParams.set("rows", "3");
  url.searchParams.set("select", "DOI,title,author,published,container-title,URL,score");
  if (process.env.CROSSREF_MAILTO) {
    url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
  }

  const crossrefResponse = await fetch(url, {
    headers,
  });
  if (!crossrefResponse.ok) {
    return response.status(502).json({ error: "Bibliography lookup failed" });
  }

  const data = await crossrefResponse.json();
  const matches = (data.message?.items ?? [])
    .map((item) => toMatch(item, reference))
    .sort((left, right) => right.confidence - left.confidence);

  const bestMatch = matches[0] ?? null;
  const status = !bestMatch
    ? "not_found"
    : bestMatch.confidence >= 0.78
      ? "verified"
      : bestMatch.confidence >= 0.45
        ? "possible"
        : "not_found";

  return response.status(200).json({ status, bestMatch, matches });
}
