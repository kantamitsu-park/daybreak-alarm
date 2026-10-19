import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Alarm, HistoryEntry, User } from "../shared/types";
import { auth } from "./auth";
import { normalizeTimezone } from "./schedule";
import { cleanup, missions } from "./missions";
import {
  assertSameOrigin,
  configured,
  error,
  rateLimit,
  readJson,
  requireDatabase,
  SESSION_COOKIE,
  sha256,
} from "./security";
import type { AlarmRow, AppEnv, Env } from "./types";

export const alarmSchema = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    label: z.string().trim().max(60),
    days: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    enabled: z.boolean(),
    mission: z.enum(["water", "coffee", "pushups"]),
    duration: z.number().int().min(15).max(600),
    repetitions: z.number().int().min(1).max(20),
    snoozeMinutes: z.number().int().min(1).max(30),
  })
  .strict();
export function alarmView(row: AlarmRow): Alarm {
  return {
    id: row.id,
    time: row.time,
    label: row.label,
    days: JSON.parse(row.days),
    enabled: row.enabled === 1,
    mission: row.mission,
    duration: row.duration,
    repetitions: row.repetitions,
    snoozeMinutes: row.snooze_minutes,
  };
}
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=()",
  );
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (new URL(c.req.url).protocol === "https:")
    c.header("Strict-Transport-Security", "max-age=31536000");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method))
    assertSameOrigin(c.req.raw, c.env);
  await next();
});
app.get("/api/config", (c) =>
  c.json({
    googleClientId: configured(c.env) ? c.env.GOOGLE_CLIENT_ID! : null,
    aiConfigured: !!(c.env.AI && c.env.MEDIA),
    storageConfigured: !!c.env.DB,
  }),
);
app.route("/api/auth", auth);
app.use("/api/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return error(401, "Google でログインしてください。");
  const db = requireDatabase(c.env);
  const user = await db
    .prepare(
      "SELECT u.id, u.name, u.email, u.picture FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(await sha256(token), Date.now())
    .first<User>();
  if (!user) return error(401, "ログインの有効期限が切れました。");
  c.set("user", user);
  await next();
});
app.get("/api/me", (c) => c.json(c.get("user")));
app.get("/api/alarms", async (c) => {
  const result = await requireDatabase(c.env)
    .prepare("SELECT * FROM alarms WHERE user_id = ? ORDER BY time, id")
    .bind(c.get("user").id)
    .all<AlarmRow>();
  return c.json(result.results.map(alarmView));
});
app.post("/api/alarms", async (c) => {
  const parsed = alarmSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success)
    return error(400, "アラームの設定内容を確認してください。");
  const db = requireDatabase(c.env);
  const userId = c.get("user").id;
  await rateLimit(db, `alarm-write:${userId}`, 120);
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM alarms WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  if ((count?.count || 0) >= 100)
    return error(422, "アラームは100件まで設定できます。");
  const a = parsed.data;
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO alarms (id, user_id, time, label, days, enabled, mission, duration, repetitions, snooze_minutes, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      userId,
      a.time,
      a.label,
      JSON.stringify(a.days),
      a.enabled ? 1 : 0,
      a.mission,
      a.duration,
      a.repetitions,
      a.snoozeMinutes,
      normalizeTimezone(c.req.header("X-Time-Zone")),
    )
    .run();
  return c.json({ id, ...a }, 201);
});
app.patch("/api/alarms/:id", async (c) => {
  const parsed = alarmSchema.partial().safeParse(await readJson(c.req.raw));
  if (!parsed.success || !Object.keys(parsed.data).length)
    return error(400, "アラームの設定内容を確認してください。");
  const db = requireDatabase(c.env);
  const userId = c.get("user").id;
  await rateLimit(db, `alarm-write:${userId}`, 120);
  const existing = await db
    .prepare("SELECT * FROM alarms WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<AlarmRow>();
  if (!existing) return error(404, "アラームが見つかりません。");
  const a = { ...alarmView(existing), ...parsed.data };
  await db
    .prepare(
      "UPDATE alarms SET time = ?, label = ?, days = ?, enabled = ?, mission = ?, duration = ?, repetitions = ?, snooze_minutes = ?, timezone = ? WHERE id = ? AND user_id = ?",
    )
    .bind(
      a.time,
      a.label,
      JSON.stringify(a.days),
      a.enabled ? 1 : 0,
      a.mission,
      a.duration,
      a.repetitions,
      a.snoozeMinutes,
      normalizeTimezone(c.req.header("X-Time-Zone") || existing.timezone),
      a.id,
      userId,
    )
    .run();
  return c.json(a);
});
app.delete("/api/alarms/:id", async (c) => {
  const db = requireDatabase(c.env);
  const userId = c.get("user").id;
  await rateLimit(db, `alarm-write:${userId}`, 120);
  const result = await db
    .prepare("DELETE FROM alarms WHERE id = ? AND user_id = ? RETURNING id")
    .bind(c.req.param("id"), userId)
    .first();
  if (!result) return error(404, "アラームが見つかりません。");
  return c.json({ ok: true });
});
app.get("/api/history", async (c) => {
  const result = await requireDatabase(c.env)
    .prepare(
      "SELECT id, mission, resolved_at, status FROM missions WHERE user_id = ? AND status IN ('passed','failed','expired','stopped','snoozed') AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 100",
    )
    .bind(c.get("user").id)
    .all<{
      id: string;
      mission: HistoryEntry["mission"];
      resolved_at: number;
      status: HistoryEntry["status"] | "expired";
    }>();
  return c.json(
    result.results.map((row): HistoryEntry => ({
      id: row.id,
      mission: row.mission,
      completedAt: row.resolved_at,
      status: row.status === "expired" ? "failed" : row.status,
    })),
  );
});
app.route("/api/missions", missions);
app.all("/api/*", (c) => c.json({ error: "API が見つかりません。" }, 404));
app.get("*", (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Daybreak", 200),
);
app.onError((cause, c) => {
  if (cause instanceof HTTPException)
    return c.json({ error: cause.message }, cause.status);
  // Do not log request bodies, cookies, tokens, or user evidence.
  console.error("Request failed", {
    path: c.req.path,
    error: cause instanceof Error ? cause.name : "unknown",
  });
  return c.json(
    { error: "サービスを利用できません。しばらくしてからお試しください。" },
    503,
  );
});
export { app };
export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env));
  },
};
