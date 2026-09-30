import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { Agent, EnvHttpProxyAgent, request } from "undici";
import ipaddr from "ipaddr.js";

const HTML_LIMIT = 2 * 1024 * 1024;
const PDF_LIMIT = 10 * 1024 * 1024;

export class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function isPublicAddress(address) {
  try {
    // IPv4にマップされたIPv6もIPv4の分類で確認する。
    return ipaddr.process(address).range() === "unicast";
  } catch { return false; }
}

export async function validateSourceUrl(value, resolve = lookup) {
  let url;
  try { url = new URL(value); } catch { throw new SourceError("blocked_url"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host)) throw new SourceError("blocked_url");
  let addresses;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true }); }
  catch { throw new SourceError("connection_failed"); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new SourceError("blocked_url");
  url.hash = "";
  return { url, addresses };
}

// 各転送先も検証する。接続時の名前解決は検証したIPへ固定し、DNS再解決を防ぐ。
// 環境管理者が指定したプロキシがある場合だけ、そのプロキシを経由する。
async function openSource(url, addresses, signal) {
  const dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    ? new EnvHttpProxyAgent()
    : new Agent({ connect: { lookup(_host, options, callback) {
      const address = addresses.find((item) => item.family === 4) ?? addresses[0];
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    } } });
  try {
    const response = await request(url, {
      dispatcher, signal, maxRedirections: 0, headersTimeout: 10_000, bodyTimeout: 10_000,
      headers: { "user-agent": "ThesisSelfCheck/1.0", accept: "text/html,application/pdf", "accept-encoding": "identity" },
    });
    return { ...response, close: () => dispatcher.destroy() };
  } catch (error) { await dispatcher.destroy(); throw error; }
}

export async function readSourceBody(body, limit, signal) {
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    signal?.throwIfAborted();
    length += chunk.length;
    if (length > limit) { body.destroy?.(); throw new SourceError("too_large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchSource(value, { resolve = lookup, open = openSource, timeoutMs = 15_000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let next = value;
  try {
    for (let hop = 0; hop <= 3; hop += 1) {
      const { url, addresses } = await Promise.race([
        validateSourceUrl(next, resolve),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new SourceError("timeout")), { once: true })),
      ]);
      signal.throwIfAborted();
      const response = await open(url, addresses, signal);
      // 未読の転送・エラー本文を破棄した際のストリームエラーも回収する。
      // 読取り中のエラーは下のasync iteratorから呼出元へ伝わる。
      response.body.on?.("error", () => {});
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.body.destroy?.();
          if (hop === 3 || !response.headers.location) throw new SourceError("redirect_failed");
          next = new URL(response.headers.location, url).href;
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) throw new SourceError(`http_${response.statusCode}`);
        const contentType = String(response.headers["content-type"] ?? "");
        const pdfHint = /application\/pdf/i.test(contentType) || /\.pdf$/i.test(url.pathname);
        const limit = pdfHint ? PDF_LIMIT : HTML_LIMIT;
        if (Number(response.headers["content-length"]) > limit) throw new SourceError("too_large");
        let bytes = await readSourceBody(response.body, limit, signal);
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
        const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
        if (decompress) bytes = decompress(bytes, { maxOutputLength: limit });
        else if (encoding && encoding !== "identity") throw new SourceError("unsupported_format");
        const isPdf = bytes.subarray(0, 5).toString() === "%PDF-";
        if (!isPdf && (!/text\/html|application\/xhtml\+xml/i.test(contentType) && !/^\s*<!doctype html|^\s*<html/i.test(bytes.subarray(0, 512).toString()))) throw new SourceError("unsupported_format");
        return { bytes, contentType, url: url.href, format: isPdf ? "pdf" : "html" };
      } finally { response.body.destroy?.(); await response.close(); }
    }
  } catch (error) {
    if (signal.aborted) throw new SourceError("timeout");
    throw error instanceof SourceError ? error : new SourceError("connection_failed");
  }
}
