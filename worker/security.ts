import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

export const SESSION_COOKIE = "__Host-daybreak_session";
export const OAUTH_COOKIE = "__Host-daybreak_oauth";
export const SESSION_AGE = 60 * 60 * 24 * 30;
export const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
export const MAX_FRAME_BYTES = 150 * 1024;
export const error = (
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
export function randomToken(length = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  );
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function configured(env: Env): boolean {
  return !!(
    env.DB &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    validOrigin(env.APP_ORIGIN)
  );
}
export function validOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)))
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
export function requireDatabase(env: Env): D1Database {
  if (!env.DB) error(503, "データベースの設定が完了していません。");
  return env.DB!;
}
export function requireServices(env: Env) {
  if (!env.AI || !env.MEDIA || (!env.EVIDENCE && !env.DB))
    error(503, "動画判定サービスの設定が完了していません。");
}
export function assertSameOrigin(request: Request, env: Env) {
  const origin = validOrigin(env.APP_ORIGIN);
  if (!origin) error(503, "アプリの公開先が設定されていません。");
  if (
    request.headers.get("Origin") !== origin ||
    new URL(request.url).origin !== origin
  )
    error(403, "この操作の送信元を確認できません。");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    error(403, "この操作の送信元を確認できません。");
}
export async function readBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit)
    error(413, "ファイルが大きすぎます。");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        error(413, "ファイルが大きすぎます。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function readJson(
  request: Request,
  limit = 8192,
): Promise<unknown> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    error(415, "JSON 形式で送信してください。");
  try {
    return JSON.parse(
      new TextDecoder().decode(await readBytes(request, limit)),
    );
  } catch (cause) {
    if (cause instanceof HTTPException) throw cause;
    return error(400, "入力データを読み取れません。");
  }
}
export function decodeFrame(image: string): Uint8Array {
  const prefix = "data:image/jpeg;base64,";
  if (
    !image.startsWith(prefix) ||
    image.length > prefix.length + Math.ceil(MAX_FRAME_BYTES / 3) * 4
  )
    error(413, "画像の形式またはサイズが正しくありません。");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(image.slice(prefix.length)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return error(400, "画像を読み取れません。");
  }
  if (
    bytes.length < 64 ||
    bytes.length > MAX_FRAME_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    error(400, "JPEG 画像を送信してください。");
  return bytes;
}
export function assertVideo(bytes: Uint8Array, contentType: string): void {
  const webm =
    contentType === "video/webm" &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;
  const mp4 =
    contentType === "video/mp4" &&
    new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
  if (bytes.length < 1024 || (!webm && !mp4))
    error(415, "WebM または MP4 の動画を送信してください。");
}
export async function rateLimit(
  db: D1Database,
  identity: string,
  limit: number,
  periodMs = 60 * 60 * 1000,
) {
  const window = Math.floor(Date.now() / periodMs) * periodMs;
  const key = await sha256(identity);
  const result = await db
    .prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(key, window)
    .first<{ count: number }>();
  if (!result || result.count > limit)
    error(429, "操作回数が上限に達しました。時間をおいて再度お試しください。");
}
