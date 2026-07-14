// APIの不正利用を抑えるための簡易ガード。
// レート制限はサーバーレスインスタンスのメモリ上で数えるため、
// インスタンスの再起動やスケールアウトでリセットされる限定的な防御です。
// 厳密な制限が必要な場合はVercel FirewallやKVベースの制限を検討してください。

const WINDOW_MS = 60_000;
const buckets = new Map();

export function checkOrigin(request) {
  const source = request.headers.origin ?? request.headers.referer ?? "";
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed) {
    if (!source) return false;
    try {
      return new URL(source).origin === new URL(allowed).origin;
    } catch {
      return false;
    }
  }
  // ALLOWED_ORIGIN未設定時は、Originが送られてきた場合のみ同一ホストか確認する
  // （curl等のOriginなしリクエストはレート制限側で抑える）
  if (!source) return true;
  try {
    return new URL(source).host === request.headers.host;
  } catch {
    return false;
  }
}

export function isRateLimited(request, limit) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "");
  const ip = forwarded.split(",")[0].trim() || request.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (buckets.get(ip) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  buckets.set(ip, recent);
  if (buckets.size > 10_000) buckets.clear();
  return false;
}
