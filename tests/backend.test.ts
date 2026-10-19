// Integration tests use real SQLite statements, with test-only Cloudflare service doubles.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { app, alarmSchema } from "../worker/index";
import { cleanup } from "../worker/missions";
import { evidence } from "../worker/evidence";
import {
  decodeFrame,
  MAX_VIDEO_BYTES,
  randomToken,
  readBytes,
  SESSION_COOKIE,
  sha256,
} from "../worker/security";
import {
  parseVerdict,
  passes,
  validateEvidenceTiming,
} from "../worker/verification";
import type { Env, FrameRow, MissionRow } from "../worker/types";

const origin = "https://daybreak.example";
const alarm = {
  time: "07:00",
  label: "朝",
  days: [1, 2, 3, 4, 5],
  enabled: true,
  mission: "water",
  duration: 120,
  repetitions: 5,
  snoozeMinutes: 5,
};
const good = {
  passed: true,
  challengeMatched: true,
  continuous: true,
  replayDetected: false,
  repetitions: 5,
  confidence: 0.97,
  reason: "確認できました。",
};
class SqliteD1 {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(
      readFileSync(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    this.sqlite.exec(
      readFileSync(
        new URL("../migrations/0002_ephemeral_evidence.sql", import.meta.url),
        "utf8",
      ),
    );
    this.sqlite.exec(
      readFileSync(
        new URL(
          "../migrations/0003_occurrence_and_snooze.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  prepare(query: string) {
    let args: (string | number | null)[] = [];
    const sql = this.sqlite.prepare(query);
    const statement = {
      bind(...values: (string | number | null)[]) {
        args = values;
        return statement;
      },
      async first(column?: string) {
        const row = sql.get(...args);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      async all() {
        return {
          results: sql.all(...args).map((r) => ({ ...r })),
          success: true,
        };
      },
      async run() {
        const result = sql.run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try {
      const result = [];
      for (const s of statements) result.push(await s.run());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
}
class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  async put(key: string, bytes: Uint8Array) {
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      uploaded: new Date(),
    });
  }
  async get(key: string) {
    const item = this.objects.get(key);
    return item
      ? {
          body: new Blob([item.bytes]).stream(),
          arrayBuffer: async () => new Uint8Array(item.bytes).buffer,
        }
      : null;
  }
  async delete(keys: string | string[]) {
    for (const key of typeof keys === "string" ? [keys] : keys)
      this.objects.delete(key);
  }
  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, uploaded: value.uploaded })),
      truncated: false,
    };
  }
}
let db: SqliteD1;
let bucket: MemoryBucket;
let env: Env;
let token: string;
let otherToken: string;
const aiRun = vi.fn();
const mediaResponse = vi.fn();
function jpeg(seed = 0) {
  const result = new Uint8Array(100).fill(seed);
  result.set([0xff, 0xd8, 0xff]);
  result.set([0xff, 0xd9], result.length - 2);
  return result;
}
function image(seed: number) {
  return `data:image/jpeg;base64,${Buffer.from(jpeg(seed)).toString("base64")}`;
}
function request(
  path: string,
  method = "GET",
  data?: unknown,
  auth = token,
  headers: Record<string, string> = {},
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(auth ? { Cookie: `${SESSION_COOKIE}=${auth}` } : {}),
        ...(method !== "GET" ? { Origin: origin } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    },
    env,
  );
}
async function newAlarm() {
  const response = await request("/api/alarms", "POST", alarm);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}
async function newMission() {
  const a = await newAlarm();
  const response = await request("/api/missions", "POST", { alarmId: a.id });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    deadline: number;
    challengeFingers: number;
  };
}
async function recordingFixture() {
  const m = await newMission();
  const start = Date.now() - 9000;
  for (let n = 0; n < 6; n++) {
    const key = `missions/${m.id}/frame-${n}.jpg`;
    await bucket.put(key, jpeg(n));
    await db
      .prepare(
        "INSERT INTO frames (mission_id, sequence, hash, received_at, object_key) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(m.id, n, await sha256(jpeg(n)), start + n * 1500, key)
      .run();
  }
  const videoKey = `missions/${m.id}/recording.webm`;
  await bucket.put(videoKey, new Uint8Array(2048));
  await db
    .prepare(
      "UPDATE missions SET status = 'recording', next_sequence = 6, first_frame_at = ?, last_frame_at = ?, video_key = ?, video_duration = 8000 WHERE id = ?",
    )
    .bind(start, start + 7500, videoKey, m.id)
    .run();
  return m;
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T07:00:00+09:00"));
  db = new SqliteD1();
  bucket = new MemoryBucket();
  token = randomToken();
  otherToken = randomToken();
  aiRun.mockReset().mockResolvedValue({ response: JSON.stringify(good) });
  mediaResponse
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(jpeg(), { headers: { "Content-Type": "image/jpeg" } }),
    );
  env = {
    DB: db as unknown as D1Database,
    EVIDENCE: bucket as unknown as R2Bucket,
    AI: { run: aiRun },
    MEDIA: {
      input: () => ({
        transform: () => ({ output: () => ({ response: mediaResponse }) }),
      }),
    },
    APP_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "test-secret-not-production",
  };
  for (const [id, session] of [
    ["u1", token],
    ["u2", otherToken],
  ]) {
    await db
      .prepare(
        "INSERT INTO users (id, google_sub, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, id, id, `${id}@example.com`, Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      )
      .bind(await sha256(session), id, Date.now() + 86_400_000)
      .run();
  }
});
afterEach(() => {
  db.sqlite.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("authentication and API security", () => {
  it("always exposes truthful configuration without requiring a session", async () => {
    env = {};
    const response = await request("/api/config", "GET", undefined, "");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      googleClientId: null,
      aiConfigured: false,
      storageConfigured: false,
    });
  });
  it("rejects anonymous and forged sessions", async () => {
    expect((await request("/api/me", "GET", undefined, "")).status).toBe(401);
    expect(
      (await request("/api/me", "GET", undefined, randomToken())).status,
    ).toBe(401);
  });
  it("loads only the user associated with the hashed session", async () => {
    expect(await (await request("/api/me")).json()).toMatchObject({ id: "u1" });
    expect(
      await (await request("/api/me", "GET", undefined, otherToken)).json(),
    ).toMatchObject({ id: "u2" });
  });
  it("rejects expired sessions", async () => {
    await db.prepare("UPDATE sessions SET expires_at = 0").run();
    expect((await request("/api/me")).status).toBe(401);
  });
  it("blocks cross-origin and missing-origin mutations", async () => {
    expect(
      (
        await request("/api/alarms", "POST", alarm, token, {
          Origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/alarms", "POST", alarm, token, { Origin: "" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request("/api/alarms", "POST", alarm, token, {
          "Sec-Fetch-Site": "cross-site",
        })
      ).status,
    ).toBe(403);
  });
  it("sets protective headers and no-store", async () => {
    const response = await request("/api/config");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
  it("refuses OAuth when credentials are missing", async () => {
    delete env.GOOGLE_CLIENT_SECRET;
    expect(
      (await request("/api/auth/google", "GET", undefined, "")).status,
    ).toBe(503);
  });
  it("starts Google-only OAuth with PKCE, nonce, state and Secure HttpOnly cookie", async () => {
    const response = await request("/api/auth/google", "GET", undefined, "");
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.origin).toBe("https://accounts.google.com");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/google/callback`,
    );
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("nonce")!.length).toBeGreaterThan(30);
    expect(response.headers.get("Set-Cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("Set-Cookie")).toMatch(/Secure/);
    expect(response.headers.get("Set-Cookie")).toMatch(/SameSite=Lax/);
    const flow = (await db.prepare("SELECT * FROM oauth_flows").first()) as {
      verifier: string;
      state_hash: string;
    };
    expect(await sha256(flow.verifier)).toBe(
      redirect.searchParams.get("code_challenge"),
    );
    expect(flow.state_hash).not.toBe(redirect.searchParams.get("state"));
  });
  it("rejects mismatched OAuth state without token exchange", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    expect(
      (await request("/api/auth/google/callback?state=forged&code=test"))
        .status,
    ).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });
  it("invalidates the server session on logout", async () => {
    expect((await request("/api/auth/logout", "POST")).status).toBe(200);
    expect((await request("/api/me")).status).toBe(401);
  });
});
describe("alarm ownership and validation", () => {
  it("creates, updates and deletes owned alarms", async () => {
    const a = await newAlarm();
    expect(
      await (
        await request(`/api/alarms/${a.id}`, "PATCH", { enabled: false })
      ).json(),
    ).toMatchObject({ id: a.id, enabled: false });
    expect((await request(`/api/alarms/${a.id}`, "DELETE")).status).toBe(200);
    expect(await (await request("/api/alarms")).json()).toEqual([]);
  });
  it("does not expose or mutate another user’s alarms", async () => {
    const a = await newAlarm();
    expect(
      await (await request("/api/alarms", "GET", undefined, otherToken)).json(),
    ).toEqual([]);
    expect(
      (
        await request(
          `/api/alarms/${a.id}`,
          "PATCH",
          { enabled: false },
          otherToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(`/api/alarms/${a.id}`, "DELETE", undefined, otherToken))
        .status,
    ).toBe(404);
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id }, otherToken))
        .status,
    ).toBe(404);
  });
  it.each([
    { time: "24:00" },
    { days: [1, 1] },
    { duration: 0 },
    { duration: 601 },
    { repetitions: 0 },
    { snoozeMinutes: 31 },
    { mission: "skip" },
    { id: "injected" },
  ])("rejects invalid alarm %j", async (bad) => {
    expect(
      (await request("/api/alarms", "POST", { ...alarm, ...bad })).status,
    ).toBe(400);
  });
  it("supports documented ranges and daily alarm days", () => {
    expect(
      alarmSchema.safeParse({
        ...alarm,
        duration: 600,
        repetitions: 20,
        days: [],
      }).success,
    ).toBe(true);
  });
});
describe("mission enforcement", () => {
  it("creates an unpredictable challenge with a server deadline and recovers it", async () => {
    const m = await newMission();
    expect(m.challengeFingers).toBeGreaterThanOrEqual(1);
    expect(m.challengeFingers).toBeLessThanOrEqual(4);
    expect(m.deadline - Date.now()).toBeGreaterThan(119_000);
    expect(await (await request("/api/missions/active")).json()).toMatchObject({
      id: m.id,
      status: "pending",
    });
  });
  it("reuses an active challenge and never replaces an unresolved passed session", async () => {
    const a = await newAlarm();
    const m = (await (
      await request("/api/missions", "POST", { alarmId: a.id })
    ).json()) as { id: string };
    await db
      .prepare(
        "UPDATE missions SET status = 'passed', resolved_at = ? WHERE id = ?",
      )
      .bind(Date.now(), m.id)
      .run();
    expect(
      await (await request("/api/missions", "POST", { alarmId: a.id })).json(),
    ).toMatchObject({ id: m.id, status: "passed" });
    const a2 = await newAlarm();
    expect(
      (await request("/api/missions", "POST", { alarmId: a2.id })).status,
    ).toBe(409);
  });
  it("requires configured video services before starting", async () => {
    const a = await newAlarm();
    delete env.MEDIA;
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id })).status,
    ).toBe(503);
  });
  it("rejects stop and snooze before server-confirmed success", async () => {
    const m = await newMission();
    for (const action of ["stop", "snooze"])
      expect(
        (await request(`/api/missions/${m.id}/resolve`, "POST", { action }))
          .status,
      ).toBe(403);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
          passed: true,
        })
      ).status,
    ).toBe(400);
  });
  it("rejects evidence from another user", async () => {
    const m = await newMission();
    expect(
      (
        await request(
          `/api/missions/${m.id}/frames`,
          "POST",
          { sequence: 0, image: image(1) },
          otherToken,
        )
      ).status,
    ).toBe(404);
  });
  it("enforces frame sequence, receiving time and exact replay detection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = await newMission();
    const frame = (sequence: number, seed: number) =>
      request(`/api/missions/${m.id}/frames`, "POST", {
        sequence,
        image: image(seed),
      });
    expect((await frame(1, 1)).status).toBe(409);
    expect((await frame(0, 1)).status).toBe(200);
    expect((await frame(1, 2)).status).toBe(409);
    vi.setSystemTime(Date.now() + 1500);
    expect((await frame(1, 1)).status).toBe(409);
    expect((await frame(1, 2)).status).toBe(200);
  });
  it("rejects frames after the server deadline", async () => {
    const m = await newMission();
    await db
      .prepare("UPDATE missions SET deadline = 0 WHERE id = ?")
      .bind(m.id)
      .run();
    expect(
      (
        await request(`/api/missions/${m.id}/frames`, "POST", {
          sequence: 0,
          image: image(1),
        })
      ).status,
    ).toBe(422);
  });
  it("does not accept fake image data or oversized bodies", async () => {
    expect(() => decodeFrame("data:image/jpeg;base64,AAAA")).toThrow();
    await expect(
      readBytes(
        new Request(origin, {
          method: "POST",
          headers: { "Content-Length": String(MAX_VIDEO_BYTES + 1) },
          body: "x",
        }),
        MAX_VIDEO_BYTES,
      ),
    ).rejects.toThrow();
    await expect(
      readBytes(
        new Request(origin, { method: "POST", body: new Uint8Array(20) }),
        10,
      ),
    ).rejects.toThrow();
  });
  it("cannot verify without the original recording", async () => {
    const m = await newMission();
    expect((await request(`/api/missions/${m.id}/verify`, "POST")).status).toBe(
      409,
    );
    expect(aiRun).not.toHaveBeenCalled();
  });
  it("verifies server-decoded video and deletes evidence before allowing one-use stop", async () => {
    const m = await recordingFixture();
    expect(
      await (await request(`/api/missions/${m.id}/verify`, "POST")).json(),
    ).toMatchObject({ status: "passed" });
    expect(mediaResponse).toHaveBeenCalledTimes(8);
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      expect.any(Object),
    );
    expect(bucket.objects.size).toBe(0);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "snooze",
        })
      ).status,
    ).toBe(403);
  });
  it("does not run AI twice for the same challenge", async () => {
    const m = await recordingFixture();
    await request(`/api/missions/${m.id}/verify`, "POST");
    expect((await request(`/api/missions/${m.id}/verify`, "POST")).status).toBe(
      409,
    );
    expect(aiRun).toHaveBeenCalledTimes(1);
  });
  it("fails closed when AI output is malformed or omits liveness criteria", async () => {
    const m = await recordingFixture();
    aiRun.mockResolvedValue({ response: '{"passed":true}' });
    expect(
      await (await request(`/api/missions/${m.id}/verify`, "POST")).json(),
    ).toMatchObject({ status: "failed" });
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });
  it("fails closed and deletes evidence when AI is unavailable", async () => {
    const m = await recordingFixture();
    aiRun.mockRejectedValue(new Error("unavailable"));
    expect((await request(`/api/missions/${m.id}/verify`, "POST")).status).toBe(
      503,
    );
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });
  it("only permits snooze after success and returns server-computed time", async () => {
    const m = await recordingFixture();
    expect(
      await (await request(`/api/missions/${m.id}`)).json(),
    ).not.toHaveProperty("snoozeUntil");
    await request(`/api/missions/${m.id}/verify`, "POST");
    const response = (await (
      await request(`/api/missions/${m.id}/resolve`, "POST", {
        action: "snooze",
      })
    ).json()) as { status: string; snoozeUntil: number };
    expect(response.status).toBe("snoozed");
    expect(response.snoozeUntil - Date.now()).toBeGreaterThan(299_000);
    expect(await (await request(`/api/missions/${m.id}`)).json()).toMatchObject(
      {
        status: "snoozed",
        snoozeUntil: response.snoozeUntil,
      },
    );
    expect(await (await request("/api/history")).json()).toEqual([
      expect.objectContaining({ id: m.id, status: "snoozed" }),
    ]);
  });
  it("cleans abandoned evidence and expired secrets on scheduled maintenance", async () => {
    await bucket.put("missions/old/recording.webm", new Uint8Array(2));
    bucket.objects.get("missions/old/recording.webm")!.uploaded = new Date(
      Date.now() - 1_000_000,
    );
    await db
      .prepare(
        "INSERT INTO oauth_flows (state_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind("old", "v", "n", 0)
      .run();
    await cleanup(env);
    expect(bucket.objects.size).toBe(0);
    expect(await db.prepare("SELECT * FROM oauth_flows").first()).toBeNull();
  });
});
describe("AI verdict contract", () => {
  it.each([
    { challengeMatched: false },
    { continuous: false },
    { replayDetected: true },
    { confidence: 0.89 },
    { passed: false },
  ])("rejects %j despite otherwise positive output", (patch) => {
    expect(
      passes({ ...good, ...patch }, { mission: "water", repetitions: 1 }),
    ).toBe(false);
  });
  it("requires all instructed push-up repetitions", () => {
    expect(passes(good, { mission: "pushups", repetitions: 6 })).toBe(false);
    expect(passes(good, { mission: "pushups", repetitions: 5 })).toBe(true);
  });
  it("rejects markdown, extra fields and fabricated non-JSON responses", () => {
    expect(
      parseVerdict({
        response: `\u0060\u0060\u0060json\n${JSON.stringify(good)}\n\u0060\u0060\u0060`,
      }),
    ).toBeNull();
    expect(
      parseVerdict({ response: JSON.stringify({ ...good, grantStop: true }) }),
    ).toBeNull();
    expect(parseVerdict({ passed: true })).toBeNull();
  });
});

describe("private D1 evidence fallback", () => {
  it("round-trips multi-chunk binary data and deletes chunks atomically", async () => {
    delete env.EVIDENCE;
    const bytes = new Uint8Array(1_400_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const store = evidence(env);
    await store.put("missions/test/video.webm", bytes);
    expect(
      (
        (await db
          .prepare("SELECT COUNT(*) AS n FROM evidence_chunks")
          .first()) as { n: number }
      ).n,
    ).toBe(2);
    expect(
      await sha256(
        new Uint8Array(
          await (await store.get("missions/test/video.webm"))!.arrayBuffer(),
        ),
      ),
    ).toBe(await sha256(bytes));
    const page = await store.list({ prefix: "missions/test/", limit: 5 });
    expect(page.objects.map((o) => o.key)).toEqual([
      "missions/test/video.webm",
    ]);
    await store.delete("missions/test/video.webm");
    expect(await store.get("missions/test/video.webm")).toBeNull();
    expect(
      (
        (await db
          .prepare("SELECT COUNT(*) AS n FROM evidence_chunks")
          .first()) as { n: number }
      ).n,
    ).toBe(0);
  });
  it("streams the same bytes without a public download endpoint", async () => {
    delete env.EVIDENCE;
    const store = evidence(env);
    await store.put("missions/test/frame.jpg", jpeg(4));
    const object = await store.get("missions/test/frame.jpg");
    expect(
      new Uint8Array(await new Response(object!.body).arrayBuffer()),
    ).toEqual(jpeg(4));
    expect(
      (await request("/api/evidence/missions/test/frame.jpg")).status,
    ).toBe(404);
  });
  it("cleans abandoned D1 BLOBs and reports storage configured", async () => {
    delete env.EVIDENCE;
    const store = evidence(env);
    await store.put("missions/test/old.jpg", jpeg());
    await db.prepare("UPDATE evidence_objects SET created_at = 0").run();
    await cleanup(env);
    expect(await store.get("missions/test/old.jpg")).toBeNull();
    expect(await (await request("/api/config")).json()).toMatchObject({
      storageConfigured: true,
    });
  });
  it("aborts incomplete evidence into failure and permits a fresh challenge only", async () => {
    const m = await newMission();
    await request(`/api/missions/${m.id}/frames`, "POST", {
      sequence: 0,
      image: image(9),
    });
    expect((await request(`/api/missions/${m.id}/abort`, "POST")).status).toBe(
      200,
    );
    expect(bucket.objects.size).toBe(0);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(403);
    expect(await (await request("/api/missions/active")).json()).toBeNull();
  });
  it("cannot abort a passed challenge to avoid resolving it", async () => {
    const m = await newMission();
    await db
      .prepare(
        "UPDATE missions SET status = 'passed', resolved_at = ? WHERE id = ?",
      )
      .bind(Date.now(), m.id)
      .run();
    expect((await request(`/api/missions/${m.id}/abort`, "POST")).status).toBe(
      409,
    );
    expect(await (await request("/api/missions/active")).json()).toMatchObject({
      id: m.id,
      status: "passed",
    });
  });
});

describe("scheduled occurrences and expiration", () => {
  it("rejects attempting to pre-complete a future alarm", async () => {
    const a = await newAlarm();
    await request(`/api/alarms/${a.id}`, "PATCH", { time: "07:05" });
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id })).status,
    ).toBe(403);
  });
  it("rejects disabled alarms and weekdays that are not scheduled", async () => {
    const a = await newAlarm();
    await request(`/api/alarms/${a.id}`, "PATCH", { days: [2] });
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id })).status,
    ).toBe(403);
    await request(`/api/alarms/${a.id}`, "PATCH", { days: [], enabled: false });
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id })).status,
    ).toBe(403);
  });
  it("uses the original scheduled deadline for interrupted retries", async () => {
    const a = await newAlarm();
    const first = (await (
      await request("/api/missions", "POST", { alarmId: a.id })
    ).json()) as { id: string; deadline: number };
    expect(
      (await request(`/api/missions/${first.id}/abort`, "POST")).status,
    ).toBe(200);
    expect(
      (await request(`/api/missions/${first.id}/abort`, "POST")).status,
    ).toBe(200);
    vi.setSystemTime(Date.now() + 30_000);
    const second = (await (
      await request("/api/missions", "POST", { alarmId: a.id })
    ).json()) as { id: string; deadline: number };
    expect(second.id).not.toBe(first.id);
    expect(second.deadline).toBe(first.deadline);
  });
  it("does not extend the time limit when starting late", async () => {
    const a = await newAlarm();
    vi.setSystemTime(Date.now() + 121_000);
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id })).status,
    ).toBe(422);
  });
  it("invalidates passed grants after two minutes", async () => {
    const m = await recordingFixture();
    await request(`/api/missions/${m.id}/verify`, "POST");
    vi.setSystemTime(Date.now() + 121_000);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(403);
    expect(await (await request(`/api/missions/${m.id}`)).json()).toMatchObject(
      { status: "expired" },
    );
  });
  it("persists snoozes and requires a new challenge at the actual snooze time", async () => {
    const m = await recordingFixture();
    await request(`/api/missions/${m.id}/verify`, "POST");
    const snooze = (await (
      await request(`/api/missions/${m.id}/resolve`, "POST", {
        action: "snooze",
      })
    ).json()) as { snoozeUntil: number };
    const row = (await db
      .prepare("SELECT alarm_id FROM missions WHERE id = ?")
      .bind(m.id)
      .first()) as { alarm_id: string };
    expect(await (await request("/api/missions/snoozes")).json()).toEqual([
      { alarmId: row.alarm_id, snoozeUntil: snooze.snoozeUntil },
    ]);
    expect(
      (await request("/api/missions", "POST", { alarmId: row.alarm_id }))
        .status,
    ).toBe(409);
    vi.setSystemTime(snooze.snoozeUntil);
    const next = (await (
      await request("/api/missions", "POST", { alarmId: row.alarm_id })
    ).json()) as { id: string; deadline: number };
    expect(next.id).not.toBe(m.id);
    expect(next.deadline).toBe(snooze.snoozeUntil + 120_000);
    expect(await (await request("/api/missions/snoozes")).json()).toEqual([]);
  });
  it("processes actual live frame uploads and an original video through D1", async () => {
    delete env.EVIDENCE;
    const m = await newMission();
    for (let sequence = 0; sequence < 6; sequence++) {
      expect(
        (
          await request(`/api/missions/${m.id}/frames`, "POST", {
            sequence,
            image: image(sequence + 30),
          })
        ).status,
      ).toBe(200);
      vi.setSystemTime(Date.now() + 1500);
    }
    const bytes = new Uint8Array(2048);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    const upload = await app.request(
      `${origin}/api/missions/${m.id}/video`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: `${SESSION_COOKIE}=${token}`,
          "Content-Type": "video/webm",
          "X-Recording-Duration": "9000",
        },
        body: bytes,
      },
      env,
    );
    expect(upload.status).toBe(200);
    expect(
      await (await request(`/api/missions/${m.id}/verify`, "POST")).json(),
    ).toMatchObject({ status: "passed" });
    expect(
      (
        (await db
          .prepare("SELECT COUNT(*) AS n FROM evidence_chunks")
          .first()) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        await request(`/api/missions/${m.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(200);
  });
});

describe("explicit fresh attempts after timeout", () => {
  it("keeps the unresolved occurrence but grants a fresh recording deadline", async () => {
    const first = await newMission();
    const original = (await db
      .prepare("SELECT alarm_id, occurrence_at FROM missions WHERE id = ?")
      .bind(first.id)
      .first()) as { alarm_id: string; occurrence_at: number };
    vi.setSystemTime(first.deadline + 10_000);
    expect(
      (await request("/api/missions", "POST", { alarmId: original.alarm_id }))
        .status,
    ).toBe(422);
    const response = await request("/api/missions", "POST", {
      alarmId: original.alarm_id,
      retry: true,
    });
    expect(response.status).toBe(201);
    const second = (await response.json()) as { id: string; deadline: number };
    expect(second.id).not.toBe(first.id);
    expect(second.deadline).toBe(Date.now() + 120_000);
    expect(
      await db
        .prepare("SELECT occurrence_at FROM missions WHERE id = ?")
        .bind(second.id)
        .first(),
    ).toMatchObject({ occurrence_at: original.occurrence_at });
    expect(
      (
        await request(`/api/missions/${second.id}/resolve`, "POST", {
          action: "stop",
        })
      ).status,
    ).toBe(403);
    const reused = (await (
      await request("/api/missions", "POST", {
        alarmId: original.alarm_id,
        retry: true,
      })
    ).json()) as { id: string; deadline: number };
    expect(reused).toMatchObject({ id: second.id, deadline: second.deadline });
  });
  it("cannot use retry to pre-complete a future alarm or restart a completed occurrence", async () => {
    const a = await newAlarm();
    await request(`/api/alarms/${a.id}`, "PATCH", { time: "08:00" });
    expect(
      (await request("/api/missions", "POST", { alarmId: a.id, retry: true }))
        .status,
    ).toBe(409);
    await request(`/api/alarms/${a.id}`, "DELETE");
    const m = await recordingFixture();
    await request(`/api/missions/${m.id}/verify`, "POST");
    await request(`/api/missions/${m.id}/resolve`, "POST", { action: "stop" });
    const row = (await db
      .prepare("SELECT alarm_id FROM missions WHERE id = ?")
      .bind(m.id)
      .first()) as { alarm_id: string };
    expect(
      (
        await request("/api/missions", "POST", {
          alarmId: row.alarm_id,
          retry: true,
        })
      ).status,
    ).toBe(409);
  });
});

describe("Workers AI real JSON-mode response shape", () => {
  it("validates an object response with the same strict contract as a JSON string", () => {
    expect(parseVerdict({ response: good })).toEqual(good);
    expect(parseVerdict({ response: { ...good, passed: "true" } })).toBeNull();
    expect(parseVerdict({ response: { passed: true } })).toBeNull();
    expect(
      parseVerdict({ response: { ...good, unexpected: "grant" } }),
    ).toBeNull();
  });
});

describe("D1 upload publication", () => {
  it("never reads unpublished chunks", async () => {
    delete env.EVIDENCE;
    await db
      .prepare(
        "INSERT INTO evidence_objects (object_key, content_type, size, created_at) VALUES (?, '', ?, ?)",
      )
      .bind("missions/test/incomplete", 100, Date.now())
      .run();
    expect(await evidence(env).get("missions/test/incomplete")).toBeNull();
  });
  it("removes all partial chunks if a subsequent insert fails", async () => {
    delete env.EVIDENCE;
    db.sqlite.exec(
      "CREATE TRIGGER reject_chunk BEFORE INSERT ON evidence_chunks WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(FAIL, 'simulated chunk failure'); END;",
    );
    await expect(
      evidence(env).put("missions/test/partial", new Uint8Array(1_400_000)),
    ).rejects.toThrow("simulated chunk failure");
    expect(await evidence(env).get("missions/test/partial")).toBeNull();
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM evidence_chunks").first(),
    ).toMatchObject({ count: 0 });
  });
});
