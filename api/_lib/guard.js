// APIの不正利用を抑えるための簡易ガード。
// レート制限はサーバーレスインスタンスのメモリ上で数えるため、
// インスタンスの再起動やスケールアウトでリセットされる限定的な防御です。
// 厳密な制限が必要な場合はVercel FirewallやKVベースの制限を検討してください。

const WINDOW_MS = 60_000;
const buckets = new Map();
const globalRequests = [];

export function checkOrigin(request) {
  const source = request.headers.origin ?? request.headers.referer ?? "";
  const allowed = process.env.ALLOWED_ORIGIN;
  // 公開APIは許可するサイトを明示して初めて稼働させる。未設定時の推測による
  // 許可は、デプロイ設定の漏れで外部クライアントにAPIを開放してしまうため行わない
  if (!allowed) return false;
  // OriginもRefererもないリクエストは拒否する。ブラウザからの通常の呼び出しでは
  // どちらかが必ず付くため、素通りするのはcurl等の直接呼び出しだけになる
  if (!source) return false;
  try {
    return new URL(source).origin === new URL(allowed).origin;
  } catch {
    return false;
  }
}

// クライアントが任意に送れるX-Forwarded-Forは使わない。Vercel Edgeが付与する
// x-vercel-forwarded-forだけを優先し、ローカル開発時だけ接続元アドレスへ戻す
export function clientIdentity(request) {
  return (
    String(request.headers["x-vercel-forwarded-for"] ?? "").trim() ||
    request.socket?.remoteAddress ||
    "unknown"
  );
}

export function isRateLimited(request, limit) {
  const ip = clientIdentity(request);
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

// 利用者ごとの制限をすり抜けた場合でも費用が青天井にならないよう、
// インスタンス全体の1分あたり呼び出し回数にも上限を設ける
export function isGloballyRateLimited(limit) {
  const now = Date.now();
  while (globalRequests.length && now - globalRequests[0] >= WINDOW_MS) {
    globalRequests.shift();
  }
  if (globalRequests.length >= limit) return true;
  globalRequests.push(now);
  return false;
}
