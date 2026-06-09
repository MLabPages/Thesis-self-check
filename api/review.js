const MAX_PAYLOAD_CHARS = 120_000;

function responseJson(response) {
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return response.output_text ?? "";
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return response.status(503).json({ error: "AI review is not configured" });
  }

  const payloadText = JSON.stringify(request.body ?? {});
  if (payloadText.length > MAX_PAYLOAD_CHARS) {
    return response.status(413).json({ error: "Document payload is too large" });
  }

  const prompt = [
    "あなたは日本語の卒業論文を提出前に確認する校閲者です。",
    "断定できない内容は必ず「要確認」とし、研究内容の正しさや文献の実在性を推測しないでください。",
    "返答はJSONオブジェクトのみとし、findings配列を含めてください。",
    "各findingは id, category, severity, location, title, original, suggestion, reason を持ちます。",
    "severityは important, warning, info のいずれかです。",
    "原文全体を書き直さず、具体的で短い指摘だけを返してください。",
    `入力データ: ${payloadText}`,
  ].join("\n");

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      store: false,
      input: prompt,
      max_output_tokens: 6000,
    }),
  });

  if (!apiResponse.ok) {
    return response.status(502).json({ error: "AI review request failed" });
  }

  const apiResult = await apiResponse.json();
  try {
    const jsonText = responseJson(apiResult)
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonText);
    return response.status(200).json({
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    });
  } catch {
    return response.status(502).json({ error: "AI returned an invalid result" });
  }
}
