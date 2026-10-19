import { Hono } from "hono";
import { z } from "zod";
import type { MissionSession } from "../shared/types";
import type { AlarmRow, AppEnv, Env, FrameRow, MissionRow } from "./types";
import {
  assertVideo,
  decodeFrame,
  error,
  MAX_VIDEO_BYTES,
  rateLimit,
  readBytes,
  readJson,
  requireDatabase,
  requireServices,
  sha256,
} from "./security";
import { evidence } from "./evidence";
import { scheduledOccurrence } from "./schedule";
import {
  passes,
  validateEvidenceTiming,
  verifyRecording,
} from "./verification";

export const missions = new Hono<AppEnv>();
export function missionView(row: MissionRow): MissionSession {
  return {
    id: row.id,
    alarmId: row.alarm_id,
    mission: row.mission,
    deadline: row.deadline,
    challenge: row.challenge,
    challengeFingers: row.challenge_fingers,
    status: row.status,
    ...(row.status === "snoozed" && row.snooze_until !== null
      ? { snoozeUntil: row.snooze_until }
      : {}),
  };
}
async function owned(
  env: Env,
  id: string,
  userId: string,
): Promise<MissionRow> {
  const row = await requireDatabase(env)
    .prepare("SELECT * FROM missions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<MissionRow>();
  if (!row) return error(404, "ミッションが見つかりません。");
  return row;
}
export async function deleteEvidence(env: Env, id: string) {
  if (!env.EVIDENCE && !env.DB) return;
  const store = evidence(env);
  let cursor: string | undefined;
  do {
    const page = await store.list({
      prefix: `missions/${id}/`,
      cursor,
      limit: 500,
    });
    if (page.objects.length)
      await store.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (env.DB)
    await env.DB.prepare("UPDATE missions SET video_key = NULL WHERE id = ?")
      .bind(id)
      .run();
}
async function active(env: Env, userId: string): Promise<MissionRow | null> {
  const db = requireDatabase(env);
  await db
    .prepare(
      "UPDATE missions SET status = 'expired', verdict = '制限時間が終了しました。', resolved_at = ? WHERE user_id = ? AND status IN ('pending','recording') AND deadline < ?",
    )
    .bind(Date.now(), userId, Date.now())
    .run();
  await db
    .prepare(
      "UPDATE missions SET status = 'expired', verdict = '判定の有効期限が切れました。', resolved_at = ? WHERE user_id = ? AND status = 'verifying' AND deadline < ?",
    )
    .bind(Date.now(), userId, Date.now() - 300_000)
    .run();
  await db
    .prepare(
      "UPDATE missions SET status = 'expired', verdict = '停止操作の有効期限が切れました。' WHERE user_id = ? AND status = 'passed' AND (resolved_at IS NULL OR resolved_at < ? OR deadline < ?)",
    )
    .bind(userId, Date.now() - 120_000, Date.now() - 300_000)
    .run();
  return db
    .prepare(
      "SELECT * FROM missions WHERE user_id = ? AND status IN ('pending','recording','verifying','passed') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(userId)
    .first<MissionRow>();
}
missions.get("/active", async (c) => {
  const row = await active(c.env, c.get("user").id);
  return c.json(row ? missionView(row) : null);
});
missions.get("/snoozes", async (c) => {
  const result = await requireDatabase(c.env)
    .prepare(
      "SELECT m.alarm_id AS alarmId, m.snooze_until AS snoozeUntil FROM missions m WHERE m.user_id = ? AND m.status = 'snoozed' AND m.snooze_until > ? AND NOT EXISTS (SELECT 1 FROM missions n WHERE n.user_id = m.user_id AND n.alarm_id = m.alarm_id AND n.occurrence_at = m.snooze_until AND n.status IN ('pending','recording','verifying','passed','stopped','snoozed')) ORDER BY m.snooze_until",
    )
    .bind(c.get("user").id, Date.now() - 300_000)
    .all();
  return c.json(result.results);
});
missions.get("/:id", async (c) => {
  await active(c.env, c.get("user").id);
  const row = await owned(c.env, c.req.param("id"), c.get("user").id);
  return c.json({ ...missionView(row), reason: row.verdict });
});
missions.post("/", async (c) => {
  requireServices(c.env);
  const parsed = z
    .object({
      alarmId: z.string().min(1).max(100),
      retry: z.boolean().optional(),
    })
    .strict()
    .safeParse(await readJson(c.req.raw));
  if (!parsed.success) return error(400, "アラームを指定してください。");
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const alarm = await db
    .prepare("SELECT * FROM alarms WHERE id = ? AND user_id = ?")
    .bind(parsed.data.alarmId, user.id)
    .first<AlarmRow>();
  if (!alarm) return error(404, "アラームが見つかりません。");
  const existing = await active(c.env, user.id);
  if (existing) {
    if (existing.alarm_id !== alarm.id)
      return error(409, "進行中のミッションを先に完了してください。");
    return c.json(missionView(existing));
  }
  const now = Date.now();
  const retry = parsed.data.retry
    ? await db
        .prepare(
          "SELECT m.* FROM missions m WHERE m.user_id = ? AND m.alarm_id = ? AND m.status IN ('failed','expired') AND m.occurrence_at > ? AND NOT EXISTS (SELECT 1 FROM missions done WHERE done.user_id = m.user_id AND done.alarm_id = m.alarm_id AND done.occurrence_at = m.occurrence_at AND done.status IN ('stopped','snoozed')) ORDER BY m.created_at DESC LIMIT 1",
        )
        .bind(user.id, alarm.id, now - 86_400_000)
        .first<MissionRow>()
    : null;
  if (parsed.data.retry && !retry)
    return error(409, "再試行できる未完了のミッションがありません。");
  const snooze = await db
    .prepare(
      "SELECT snooze_until FROM missions WHERE user_id = ? AND alarm_id = ? AND status = 'snoozed' AND snooze_until <= ? AND snooze_until > ? ORDER BY snooze_until DESC LIMIT 1",
    )
    .bind(user.id, alarm.id, now, now - 300_000)
    .first<{ snooze_until: number }>();
  const scheduled = scheduledOccurrence(alarm, now);
  const occurrence =
    retry?.occurrence_at ?? Math.max(scheduled ?? 0, snooze?.snooze_until ?? 0);
  if (!occurrence || !alarm.enabled)
    return error(403, "アラームの設定時刻になってから開始できます。");
  const deadline = (retry ? now : occurrence) + alarm.duration * 1000;
  if (now > deadline)
    return error(422, "このアラームの制限時間が終了しました。");
  const completed = await db
    .prepare(
      "SELECT id FROM missions WHERE user_id = ? AND alarm_id = ? AND occurrence_at = ? AND status IN ('stopped','snoozed') LIMIT 1",
    )
    .bind(user.id, alarm.id, occurrence)
    .first();
  if (completed) return error(409, "このアラームは既に完了しています。");
  await rateLimit(db, `mission:${user.id}`, 20);
  const id = crypto.randomUUID();
  const fingers = (crypto.getRandomValues(new Uint8Array(1))[0] % 4) + 1;
  const challenge = `最初に指を${fingers}本見せ、ミッションを行い、最後に手のひらを見せてください。`;
  // The partial unique index makes simultaneous creates return a single active challenge.
  const created = await db
    .prepare(
      "INSERT OR IGNORE INTO missions (id, user_id, alarm_id, mission, repetitions, created_at, deadline, challenge_fingers, challenge, status, snooze_minutes, occurrence_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *",
    )
    .bind(
      id,
      user.id,
      alarm.id,
      alarm.mission,
      alarm.repetitions,
      now,
      deadline,
      fingers,
      challenge,
      alarm.snooze_minutes,
      occurrence,
    )
    .first<MissionRow>();
  if (!created) {
    const concurrent = await active(c.env, user.id);
    if (concurrent?.alarm_id === alarm.id)
      return c.json(missionView(concurrent));
    return error(409, "進行中のミッションがあります。");
  }
  return c.json(missionView(created), 201);
});
missions.post("/:id/frames", async (c) => {
  requireServices(c.env);
  const parsed = z
    .object({
      sequence: z.number().int().min(0).max(449),
      image: z.string().max(206_000),
    })
    .strict()
    .safeParse(await readJson(c.req.raw, 210_000));
  if (!parsed.success) return error(400, "撮影データが正しくありません。");
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const mission = await owned(c.env, c.req.param("id"), user.id);
  const now = Date.now();
  if (!["pending", "recording"].includes(mission.status) || mission.video_key)
    return error(409, "このミッションには撮影データを追加できません。");
  if (now > mission.deadline) return error(422, "制限時間が終了しました。");
  if (
    parsed.data.sequence !== mission.next_sequence ||
    (mission.last_frame_at !== null && now - mission.last_frame_at < 350)
  )
    return error(409, "撮影の順序または間隔を確認できません。");
  const bytes = decodeFrame(parsed.data.image);
  const hash = await sha256(bytes);
  if (
    await db
      .prepare("SELECT hash FROM frames WHERE hash = ?")
      .bind(hash)
      .first()
  )
    return error(409, "同じ画像は再利用できません。");
  const key = `missions/${mission.id}/frame-${parsed.data.sequence}.jpg`;
  const reserved = await db
    .prepare(
      "UPDATE missions SET next_sequence = next_sequence + 1, first_frame_at = COALESCE(first_frame_at, ?), last_frame_at = ?, status = 'recording' WHERE id = ? AND user_id = ? AND next_sequence = ? AND status IN ('pending','recording') AND video_key IS NULL AND deadline >= ? AND (last_frame_at IS NULL OR last_frame_at <= ?) RETURNING id",
    )
    .bind(now, now, mission.id, user.id, parsed.data.sequence, now, now - 350)
    .first();
  if (!reserved) return error(409, "撮影の順序を確認できません。");
  try {
    await evidence(c.env).put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { createdAt: String(now) },
    });
    await db
      .prepare(
        "INSERT INTO frames (mission_id, sequence, hash, received_at, object_key) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(mission.id, parsed.data.sequence, hash, now, key)
      .run();
  } catch {
    await db
      .prepare(
        "UPDATE missions SET status = 'failed', resolved_at = ?, verdict = '撮影データを保存できませんでした。' WHERE id = ?",
      )
      .bind(now, mission.id)
      .run();
    await deleteEvidence(c.env, mission.id);
    return error(503, "撮影データを保存できませんでした。再撮影してください。");
  }
  return c.json({ accepted: true, sequence: parsed.data.sequence });
});
missions.post("/:id/video", async (c) => {
  requireServices(c.env);
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const mission = await owned(c.env, c.req.param("id"), user.id);
  const now = Date.now();
  const duration = Number(c.req.header("X-Recording-Duration"));
  if (
    mission.status !== "recording" ||
    mission.video_key ||
    mission.next_sequence < 6
  )
    return error(409, "連続した撮影データが必要です。");
  if (
    now > mission.deadline + 30_000 ||
    mission.last_frame_at! > mission.deadline
  )
    return error(422, "動画の送信期限が切れました。");
  const span = mission.last_frame_at! - mission.first_frame_at!;
  if (
    !Number.isFinite(duration) ||
    duration < 6000 ||
    duration > 600_000 ||
    span < 5000 ||
    Math.abs(duration - span) > 4000
  )
    return error(422, "動画の撮影時間を確認できません。");
  const type = (c.req.header("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const bytes = await readBytes(c.req.raw, MAX_VIDEO_BYTES);
  assertVideo(bytes, type);
  const hash = await sha256(bytes);
  const used = await db
    .prepare(
      "INSERT OR IGNORE INTO used_videos (hash, created_at) VALUES (?, ?) RETURNING hash",
    )
    .bind(hash, now)
    .first();
  if (!used) return error(409, "以前の動画は再利用できません。");
  const key = `missions/${mission.id}/recording.${type === "video/mp4" ? "mp4" : "webm"}`;
  const reserved = await db
    .prepare(
      "UPDATE missions SET video_key = ?, video_duration = ?, video_hash = ? WHERE id = ? AND user_id = ? AND status = 'recording' AND video_key IS NULL AND next_sequence = ? RETURNING id",
    )
    .bind(
      key,
      Math.round(duration),
      hash,
      mission.id,
      user.id,
      mission.next_sequence,
    )
    .first();
  if (!reserved) return error(409, "動画は一度だけ送信できます。");
  try {
    await evidence(c.env).put(key, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { createdAt: String(now) },
    });
  } catch {
    await db
      .prepare(
        "UPDATE missions SET status = 'failed', resolved_at = ?, verdict = '動画を保存できませんでした。' WHERE id = ?",
      )
      .bind(now, mission.id)
      .run();
    await deleteEvidence(c.env, mission.id);
    return error(503, "動画を保存できませんでした。再撮影してください。");
  }
  return c.json({ accepted: true });
});
missions.post("/:id/verify", async (c) => {
  requireServices(c.env);
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const mission = await owned(c.env, c.req.param("id"), user.id);
  if (mission.status !== "recording" || !mission.video_key)
    return error(409, "撮影と動画の送信を完了してください。");
  const frames = (
    await db
      .prepare("SELECT * FROM frames WHERE mission_id = ? ORDER BY sequence")
      .bind(mission.id)
      .all<FrameRow>()
  ).results;
  if (!validateEvidenceTiming(mission, frames, Date.now()))
    return error(422, "撮影の連続性または制限時間を確認できません。");
  await rateLimit(db, `verify:${user.id}`, 20);
  const reserved = await db
    .prepare(
      "UPDATE missions SET status = 'verifying' WHERE id = ? AND user_id = ? AND status = 'recording' RETURNING id",
    )
    .bind(mission.id, user.id)
    .first();
  if (!reserved) return error(409, "この動画は既に判定されています。");
  try {
    const verdict = await verifyRecording(c.env, mission, frames);
    const passed = passes(verdict, mission);
    const reason = passed
      ? "ミッション達成を確認しました。"
      : verdict?.reason ||
        "ミッション達成を確認できませんでした。再撮影してください。";
    const status = passed ? "passed" : "failed";
    const result = await db
      .prepare(
        "UPDATE missions SET status = ?, verdict = ?, resolved_at = ? WHERE id = ? AND status = 'verifying' RETURNING id",
      )
      .bind(status, reason, Date.now(), mission.id)
      .first();
    if (!result)
      return error(409, "判定の有効期限が切れました。再撮影してください。");
    return c.json({ status, reason });
  } catch {
    await db
      .prepare(
        "UPDATE missions SET status = 'failed', verdict = '動画判定に接続できませんでした。', resolved_at = ? WHERE id = ? AND status = 'verifying'",
      )
      .bind(Date.now(), mission.id)
      .run();
    return error(503, "動画判定に接続できませんでした。再撮影してください。");
  } finally {
    await deleteEvidence(c.env, mission.id);
  }
});
missions.post("/:id/abort", async (c) => {
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const mission = await owned(c.env, c.req.param("id"), user.id);
  if (["failed", "expired"].includes(mission.status)) {
    await deleteEvidence(c.env, mission.id);
    return c.json({ status: mission.status });
  }
  const result = await db
    .prepare(
      "UPDATE missions SET status = 'failed', resolved_at = ?, verdict = '撮影が中断されました。' WHERE id = ? AND user_id = ? AND status IN ('pending','recording') RETURNING id",
    )
    .bind(Date.now(), mission.id, user.id)
    .first();
  if (!result) return error(409, "このミッションの撮影は中断できません。");
  await deleteEvidence(c.env, mission.id);
  return c.json({ status: "failed" });
});
missions.post("/:id/resolve", async (c) => {
  const parsed = z
    .object({ action: z.enum(["stop", "snooze"]) })
    .strict()
    .safeParse(await readJson(c.req.raw));
  if (!parsed.success)
    return error(400, "停止またはスヌーズを指定してください。");
  const user = c.get("user");
  const db = requireDatabase(c.env);
  const mission = await owned(c.env, c.req.param("id"), user.id);
  if (mission.status !== "passed")
    return error(403, "ミッション達成後に操作できます。");
  if (
    mission.resolved_at === null ||
    Date.now() - mission.resolved_at > 120_000 ||
    Date.now() > mission.deadline + 300_000
  ) {
    await db
      .prepare(
        "UPDATE missions SET status = 'expired' WHERE id = ? AND status = 'passed'",
      )
      .bind(mission.id)
      .run();
    return error(403, "停止操作の有効期限が切れました。再撮影してください。");
  }
  const status = parsed.data.action === "stop" ? "stopped" : "snoozed";
  const now = Date.now();
  const result = await db
    .prepare(
      "UPDATE missions SET status = ?, resolved_at = ?, snooze_until = ? WHERE id = ? AND user_id = ? AND status = 'passed' AND resolved_at >= ? AND deadline >= ? RETURNING snooze_minutes",
    )
    .bind(
      status,
      now,
      status === "snoozed" ? now + mission.snooze_minutes * 60_000 : null,
      mission.id,
      user.id,
      now - 120_000,
      now - 300_000,
    )
    .first<{ snooze_minutes: number }>();
  if (!result) return error(409, "この操作は既に完了しています。");
  return c.json({
    status,
    ...(status === "snoozed"
      ? { snoozeUntil: now + result.snooze_minutes * 60_000 }
      : {}),
  });
});

export async function cleanup(env: Env) {
  const now = Date.now();
  if (env.DB) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_flows WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(
        now - 86_400_000,
      ),
      env.DB.prepare("DELETE FROM frames WHERE received_at < ?").bind(
        now - 86_400_000,
      ),
      env.DB.prepare("DELETE FROM used_videos WHERE created_at < ?").bind(
        now - 86_400_000,
      ),
      env.DB.prepare(
        "UPDATE missions SET status = 'expired', resolved_at = ?, verdict = '制限時間が終了しました。' WHERE status IN ('pending','recording','verifying') AND deadline < ?",
      ).bind(now, now - 600_000),
    ]);
  }
  if (env.EVIDENCE || env.DB) {
    const store = evidence(env);
    let cursor: string | undefined;
    do {
      const page = await store.list({
        prefix: "missions/",
        cursor,
        limit: 500,
      });
      const old = page.objects
        .filter((object) => object.uploaded.getTime() < now - 900_000)
        .map((object) => object.key);
      if (old.length) await store.delete(old);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
