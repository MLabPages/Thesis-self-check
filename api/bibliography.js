function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』（）()[\]{}.,，。、:：;；・\-–—]/g, "");
}

function bigrams(value) {
  const normalized = normalize(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(
    [...Array(normalized.length - 1)].map((_, index) =>
      normalized.slice(index, index + 2),
    ),
  );
}

function similarity(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const item of leftSet) if (rightSet.has(item)) overlap += 1;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function compact(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function crossrefYear(item, key) {
  return item[key]?.["date-parts"]?.[0]?.[0] ?? null;
}

function extractReferenceFields(reference) {
  const year = reference.match(/(?:19|20)\d{2}/)?.[0] ?? null;
  const doi =
    reference
      .match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]
      ?.replace(/[.,;)\]]+$/, "") ?? null;
  const title =
    reference.match(/「([^」]{3,})」/)?.[1] ??
    reference.match(/『([^』]{3,})』/)?.[1] ??
    reference.match(/[“"]([^”"]{5,})[”"]/)?.[1] ??
    null;
  const journal = reference.match(/『([^』]{2,})』/)?.[1] ?? null;
  const authorArea = reference.split(/(?:19|20)\d{2}/)[0] ?? "";
  return { year, doi, title, journal, authorArea };
}

function matchConfidence(reference, fields, match) {
  const titleScore = fields.title
    ? similarity(fields.title, match.title)
    : similarity(reference, match.title);
  const yearCandidates = match.yearCandidates?.length
    ? match.yearCandidates
    : compact([match.year]);
  const yearScore = fields.year && yearCandidates.length
    ? yearCandidates.includes(String(fields.year))
      ? 1
      : 0
    : 0.5;
  const authorScore =
    match.authors &&
    normalize(fields.authorArea).includes(normalize(match.authors).slice(0, 4))
      ? 1
      : similarity(fields.authorArea, match.authors);
  const doiScore = fields.doi
    ? normalize(fields.doi) === normalize(match.doi)
      ? 1
      : 0
    : 0.5;
  return Math.round(
    (titleScore * 0.5 + yearScore * 0.25 + authorScore * 0.15 + doiScore * 0.1) *
      100,
  ) / 100;
}

function compareFields(fields, match) {
  const differences = [];
  const checkedFields = [];

  if (fields.title && match.title) {
    checkedFields.push("題名");
    if (similarity(fields.title, match.title) < 0.86) {
      differences.push({
        field: "題名",
        provided: fields.title,
        database: match.title,
      });
    }
  }
  if (fields.authorArea && match.authors) {
    checkedFields.push("著者");
    if (similarity(fields.authorArea, match.authors) < 0.42) {
      differences.push({
        field: "著者",
        provided: fields.authorArea.trim(),
        database: match.authors,
      });
    }
  }
  const yearCandidates = match.yearCandidates?.length
    ? match.yearCandidates
    : compact([match.year]);
  if (fields.year && yearCandidates.length) {
    checkedFields.push("発行年");
    if (!yearCandidates.includes(String(fields.year))) {
      differences.push({
        field: "発行年",
        provided: String(fields.year),
        database: yearCandidates.join(" / "),
      });
    }
  }
  if (fields.journal && match.journal) {
    checkedFields.push("掲載誌");
    if (similarity(fields.journal, match.journal) < 0.72) {
      differences.push({
        field: "掲載誌",
        provided: fields.journal,
        database: match.journal,
      });
    }
  }
  if (fields.doi && match.doi) {
    checkedFields.push("DOI");
    if (normalize(fields.doi) !== normalize(match.doi)) {
      differences.push({
        field: "DOI",
        provided: fields.doi,
        database: match.doi,
      });
    }
  }
  return { differences, checkedFields };
}

function crossrefMatch(item, reference, fields, confidenceOverride = null) {
  const yearCandidates = compact([
    crossrefYear(item, "published-print"),
    crossrefYear(item, "published"),
    crossrefYear(item, "issued"),
    crossrefYear(item, "published-online"),
    crossrefYear(item, "created"),
  ]);
  const match = {
    provider: "Crossref",
    doi: item.DOI ?? null,
    title: item.title?.[0] ?? "",
    authors: (item.author ?? [])
      .map((author) => [author.family, author.given].filter(Boolean).join(" "))
      .join(", "),
    journal: item["container-title"]?.[0] ?? "",
    year: yearCandidates[0] ?? null,
    yearCandidates,
    url: item.URL ?? null,
  };
  return {
    ...match,
    confidence:
      confidenceOverride === null
        ? matchConfidence(reference, fields, match)
        : confidenceOverride,
  };
}

function ciniiMatch(item, reference, fields) {
  const identifiers = Array.isArray(item["dc:identifier"])
    ? item["dc:identifier"]
    : item["dc:identifier"]
      ? [item["dc:identifier"]]
      : [];
  const doi =
    identifiers.find((identifier) => /DOI$/i.test(identifier?.["@type"] ?? ""))?.[
      "@value"
    ] ?? null;
  const publicationDate = item["prism:publicationDate"] ?? "";
  const match = {
    provider: "CiNii Research",
    doi,
    title: item.title ?? "",
    authors: Array.isArray(item["dc:creator"])
      ? item["dc:creator"].join(", ")
      : item["dc:creator"] ?? "",
    journal: item["prism:publicationName"] ?? "",
    year: String(publicationDate).match(/(?:19|20)\d{2}/)?.[0] ?? null,
    url: item.link?.["@id"] ?? item["@id"] ?? null,
  };
  return {
    ...match,
    confidence: matchConfidence(reference, fields, match),
  };
}

async function searchCrossref(reference, fields, headers) {
  if (fields.doi) {
    const response = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(fields.doi)}`,
      { headers },
    );
    if (response.ok) {
      const data = await response.json();
      return [crossrefMatch(data.message, reference, fields, 1)];
    }
  }

  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", fields.title || reference);
  url.searchParams.set("rows", "5");
  url.searchParams.set(
    "select",
    "DOI,title,author,published,published-print,published-online,issued,created,container-title,URL",
  );
  if (process.env.CROSSREF_MAILTO) {
    url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
  }
  const response = await fetch(url, { headers });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.message?.items ?? []).map((item) =>
    crossrefMatch(item, reference, fields),
  );
}

async function searchCinii(reference, fields) {
  const url = new URL("https://cir.nii.ac.jp/opensearch/articles");
  const titleQuery =
    fields.title && fields.title.length > 10
      ? fields.title.slice(0, Math.ceil(fields.title.length * 0.65))
      : fields.title;
  url.searchParams.set("q", titleQuery || reference);
  url.searchParams.set("count", "5");
  url.searchParams.set("start", "1");
  url.searchParams.set("lang", "ja");
  url.searchParams.set("format", "json");
  if (process.env.CINII_APP_ID) {
    url.searchParams.set("appid", process.env.CINII_APP_ID);
  }
  const response = await fetch(url);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.items ?? []).map((item) => ciniiMatch(item, reference, fields));
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const reference = String(request.body?.reference ?? "").trim().slice(0, 1000);
  if (!reference) {
    return response.status(400).json({ error: "Reference is required" });
  }

  const fields = extractReferenceFields(reference);
  const headers = {
    "User-Agent": process.env.CROSSREF_MAILTO
      ? `ThesisSelfCheck/1.0 (mailto:${process.env.CROSSREF_MAILTO})`
      : "ThesisSelfCheck/1.0",
  };
  const results = await Promise.allSettled([
    searchCrossref(reference, fields, headers),
    searchCinii(reference, fields),
  ]);
  const matches = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((left, right) => right.confidence - left.confidence);
  const bestMatch = matches[0] ?? null;

  if (!bestMatch || bestMatch.confidence < 0.43) {
    return response.status(200).json({
      status: "not_found",
      bestMatch: null,
      differences: [],
      checkedFields: [],
      providers: ["Crossref", "CiNii Research"],
      links: {
        cinii: `https://cir.nii.ac.jp/all?q=${encodeURIComponent(fields.title || reference)}`,
        scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(fields.title || reference)}`,
      },
    });
  }

  const comparison = compareFields(fields, bestMatch);
  return response.status(200).json({
    status: comparison.differences.length ? "mismatch" : "verified",
    bestMatch,
    differences: comparison.differences,
    checkedFields: comparison.checkedFields,
    providers: [...new Set(matches.map((match) => match.provider))],
    links: {
      source: bestMatch.url,
      cinii: `https://cir.nii.ac.jp/all?q=${encodeURIComponent(fields.title || reference)}`,
      scholar: `https://scholar.google.com/scholar?q=${encodeURIComponent(fields.title || reference)}`,
    },
  });
}
