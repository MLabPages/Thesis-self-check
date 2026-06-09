export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const reference = String(request.body?.reference ?? "").trim().slice(0, 1000);
  if (!reference) return response.status(400).json({ error: "Reference is required" });

  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", reference);
  url.searchParams.set("rows", "3");
  url.searchParams.set("select", "DOI,title,author,published,container-title,URL,score");
  if (process.env.CROSSREF_MAILTO) {
    url.searchParams.set("mailto", process.env.CROSSREF_MAILTO);
  }

  const crossrefResponse = await fetch(url, {
    headers: {
      "User-Agent": process.env.CROSSREF_MAILTO
        ? `ThesisSelfCheck/1.0 (mailto:${process.env.CROSSREF_MAILTO})`
        : "ThesisSelfCheck/1.0",
    },
  });
  if (!crossrefResponse.ok) {
    return response.status(502).json({ error: "Bibliography lookup failed" });
  }

  const data = await crossrefResponse.json();
  const matches = (data.message?.items ?? []).map((item) => ({
    doi: item.DOI ?? null,
    title: item.title?.[0] ?? "",
    authors: (item.author ?? [])
      .map((author) => [author.family, author.given].filter(Boolean).join(" "))
      .join(", "),
    journal: item["container-title"]?.[0] ?? "",
    year: item.published?.["date-parts"]?.[0]?.[0] ?? null,
    url: item.URL ?? null,
    score: item.score ?? 0,
  }));
  return response.status(200).json({ matches });
}
