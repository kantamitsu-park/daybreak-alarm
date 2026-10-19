import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "./types";
import {
  configured,
  error,
  OAUTH_COOKIE,
  randomToken,
  rateLimit,
  requireDatabase,
  SESSION_AGE,
  SESSION_COOKIE,
  sha256,
} from "./security";

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/",
};
export const auth = new Hono<AppEnv>();

auth.get("/google", async (c) => {
  if (!configured(c.env))
    return error(503, "Google ログインの設定が完了していません。");
  const db = requireDatabase(c.env);
  await rateLimit(
    db,
    `oauth:${c.req.header("CF-Connecting-IP") || "unknown"}`,
    30,
  );
  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  await db
    .prepare(
      "INSERT INTO oauth_flows (state_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256(state), verifier, nonce, Date.now() + 600_000)
    .run();
  setCookie(c, OAUTH_COOKIE, state, { ...cookieOptions, maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${c.env.APP_ORIGIN}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString(), 302);
});

auth.get("/google/callback", async (c) => {
  if (!configured(c.env))
    return error(503, "Google ログインの設定が完了していません。");
  const state = c.req.query("state");
  const code = c.req.query("code");
  const cookie = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, cookieOptions);
  if (
    !state ||
    state.length > 100 ||
    state !== cookie ||
    !code ||
    code.length > 4096
  )
    return error(
      400,
      "ログインを確認できませんでした。もう一度お試しください。",
    );
  const db = requireDatabase(c.env);
  const flow = await db
    .prepare(
      "DELETE FROM oauth_flows WHERE state_hash = ? AND expires_at > ? RETURNING verifier, nonce",
    )
    .bind(await sha256(state), Date.now())
    .first<{ verifier: string; nonce: string }>();
  if (!flow)
    return error(
      400,
      "ログインの有効期限が切れました。もう一度お試しください。",
    );
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${c.env.APP_ORIGIN}/api/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok) return c.redirect("/?auth=error");
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) return c.redirect("/?auth=error");
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: c.env.GOOGLE_CLIENT_ID!,
      algorithms: ["RS256"],
      maxTokenAge: "10 minutes",
    });
    if (
      payload.nonce !== flow.nonce ||
      typeof payload.sub !== "string" ||
      payload.email_verified !== true ||
      typeof payload.email !== "string"
    )
      return c.redirect("/?auth=error");
    const name =
      typeof payload.name === "string"
        ? payload.name.slice(0, 100)
        : payload.email.split("@")[0];
    // Google serves profile photos from these hosts; no arbitrary URL is stored.
    let picture: string | null = null;
    if (typeof payload.picture === "string") {
      try {
        const p = new URL(payload.picture);
        if (
          p.protocol === "https:" &&
          p.hostname.endsWith(".googleusercontent.com")
        )
          picture = p.href;
      } catch {
        /* no picture */
      }
    }
    const id = crypto.randomUUID();
    const user = await db
      .prepare(
        "INSERT INTO users (id, google_sub, name, email, picture, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET name = excluded.name, email = excluded.email, picture = excluded.picture RETURNING id",
      )
      .bind(id, payload.sub, name, payload.email, picture, Date.now())
      .first<{ id: string }>();
    if (!user) return error(500, "ログイン情報を保存できませんでした。");
    const token = randomToken();
    await db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      )
      .bind(await sha256(token), user.id, Date.now() + SESSION_AGE * 1000)
      .run();
    setCookie(c, SESSION_COOKIE, token, {
      ...cookieOptions,
      maxAge: SESSION_AGE,
    });
    return c.redirect("/");
  } catch {
    return c.redirect("/?auth=error");
  }
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token && c.env.DB)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  deleteCookie(c, SESSION_COOKIE, cookieOptions);
  return c.json({ ok: true });
});
