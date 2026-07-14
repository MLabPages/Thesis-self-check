import { prepareAiPayload } from "./privacy.js";

const SEVERITIES = new Set(["important", "warning", "info"]);
const MAX_AI_PAYLOAD_CHARS = 120_000;

// AIの応答は形式が保証されないため、表示前に必ず整形する
function sanitizeFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = (value, fallback = "") =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  const title = text(raw.title);
  const suggestion = text(raw.suggestion);
  if (!title && !suggestion) return null;
  return {
    id: crypto.randomUUID(),
    category: "AI詳細チェック",
    severity: SEVERITIES.has(raw.severity) ? raw.severity : "info",
    location: text(raw.location, "文書全体"),
    title: title || "AIからの指摘",
    original: text(raw.original, "（該当箇所の引用はありません）"),
    suggestion: suggestion || "指摘内容を確認してください。",
    reason: text(raw.reason, "AI詳細チェックによる指摘です。最終判断は本人と指導教員が行ってください。"),
  };
}

export async function requestAiReview(document, selectedChecks, signal) {
  const payload = JSON.stringify(prepareAiPayload(document, selectedChecks));
  if (payload.length > MAX_AI_PAYLOAD_CHARS) {
    throw new Error(
      "文書がAI詳細チェックの上限を超えています。基本チェックは利用できます。AIを使う場合は章ごとに分けて確認してください。",
    );
  }
  const response = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal,
  });
  if (!response.ok) {
    throw new Error("AI詳細チェックを利用できませんでした。");
  }
  const data = await response.json();
  return {
    findings: (Array.isArray(data.findings) ? data.findings : [])
      .map(sanitizeFinding)
      .filter(Boolean),
  };
}
