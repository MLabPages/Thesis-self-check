import { prepareAiPayload } from "./privacy";

export async function requestAiReview(document, selectedChecks, signal) {
  const response = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prepareAiPayload(document, selectedChecks)),
    signal,
  });
  if (!response.ok) {
    throw new Error("AI詳細チェックを利用できませんでした。");
  }
  return response.json();
}
