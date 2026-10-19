import type { Alarm } from "../../shared/types";

export const ALARM_STORAGE_KEY = "daybreak.alarms.v1";
export const MAX_MISSED_ALARM_MS = 5 * 60 * 1_000;

export const DEFAULT_ALARMS: Alarm[] = [
  {
    id: "morning-water",
    time: "07:00",
    label: "朝の水分補給",
    days: [1, 2, 3, 4, 5],
    enabled: true,
    mission: "water",
    duration: 60,
    repetitions: 1,
    snoozeMinutes: 5,
  },
  {
    id: "weekend-coffee",
    time: "08:30",
    label: "週末のコーヒー",
    days: [0, 6],
    enabled: true,
    mission: "coffee",
    duration: 120,
    repetitions: 1,
    snoozeMinutes: 5,
  },
  {
    id: "early-pushups",
    time: "06:30",
    label: "朝のトレーニング",
    days: [1, 2, 3, 4, 5],
    enabled: false,
    mission: "pushups",
    duration: 90,
    repetitions: 5,
    snoozeMinutes: 5,
  },
];

type StorageLike = Pick<Storage, "getItem" | "setItem">;
export interface ScheduledAlarm {
  alarm: Alarm;
  at: Date;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Returns a fresh, normalized value; no untrusted fields are persisted. */
export function validateAlarm(value: unknown): Alarm | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    a.id.trim().length < 1 ||
    a.id.length > 100 ||
    typeof a.time !== "string" ||
    a.time.length !== 5 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time) ||
    typeof a.label !== "string" ||
    a.label.trim().length > 60 ||
    !Array.isArray(a.days) ||
    a.days.length > 7 ||
    !a.days.every((day) => integerIn(day, 0, 6)) ||
    new Set(a.days).size !== a.days.length ||
    typeof a.enabled !== "boolean" ||
    typeof a.mission !== "string" ||
    !["water", "coffee", "pushups"].includes(a.mission) ||
    !integerIn(a.duration, 15, 600) ||
    !integerIn(a.repetitions, 1, 20) ||
    !integerIn(a.snoozeMinutes, 1, 30)
  )
    return null;
  return {
    id: a.id,
    time: a.time,
    label: a.label.trim(),
    days: [...a.days].sort((x, y) => x - y),
    enabled: a.enabled,
    mission: a.mission as Alarm["mission"],
    duration: a.duration,
    repetitions: a.repetitions,
    snoozeMinutes: a.snoozeMinutes,
  };
}

function defaults(): Alarm[] {
  return DEFAULT_ALARMS.map((a) => ({ ...a, days: [...a.days] }));
}

/** Corrupt, obsolete or unavailable browser storage never prevents opening the app. */
export function loadAlarms(storage?: StorageLike): Alarm[] {
  try {
    const source = storage ?? globalThis.localStorage;
    const raw = source?.getItem(ALARM_STORAGE_KEY);
    if (!raw) return defaults();
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("alarms" in data) ||
      !Array.isArray(data.alarms) ||
      data.alarms.length > 100
    )
      return defaults();
    const alarms = data.alarms.map(validateAlarm);
    if (alarms.some((a) => !a)) return defaults();
    const valid = alarms as Alarm[];
    if (new Set(valid.map((a) => a.id)).size !== valid.length)
      return defaults();
    return valid;
  } catch {
    return defaults();
  }
}

/** Returns false on full/private storage; caller can surface that edits were not saved. */
export function saveAlarms(alarms: Alarm[], storage?: StorageLike): boolean {
  try {
    if (alarms.length > 100) return false;
    const valid = alarms.map(validateAlarm);
    if (
      valid.some((a) => !a) ||
      new Set(valid.map((a) => a!.id)).size !== valid.length
    )
      return false;
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(
      ALARM_STORAGE_KEY,
      JSON.stringify({ version: 1, alarms: valid }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock scheduling follows the device timezone, including DST transitions. */
export function nextOccurrence(alarm: Alarm, from = new Date()): Date | null {
  if (
    !alarm.enabled ||
    !validateAlarm(alarm) ||
    !Number.isFinite(from.getTime())
  )
    return null;
  const [hours, minutes] = alarm.time.split(":").map(Number);
  // Two weeks allow skipping this week's nonexistent spring-forward wall time.
  for (let offset = 0; offset <= 14; offset++) {
    const at = new Date(from);
    at.setDate(at.getDate() + offset);
    at.setHours(hours, minutes, 0, 0);
    // A nonexistent DST wall time is skipped instead of silently moving the alarm.
    if (at.getHours() !== hours || at.getMinutes() !== minutes) continue;
    if (at.getTime() < from.getTime()) continue;
    if (alarm.days.length && !alarm.days.includes(at.getDay())) continue;
    return at;
  }
  return null;
}

export function getNextAlarm(
  alarms: Alarm[],
  from = new Date(),
): ScheduledAlarm | null {
  let next: ScheduledAlarm | null = null;
  for (const alarm of alarms) {
    const at = nextOccurrence(alarm, from);
    if (at && (!next || at.getTime() < next.at.getTime())) next = { alarm, at };
  }
  return next;
}

/**
 * Stateful foreground scheduler. Includes intervals missed by throttled timers, but
 * never starts an occurrence more than five minutes late or rings one twice.
 */
export function createDueAlarmResolver(initialTime = new Date()) {
  let lastTick = initialTime.getTime();
  const fired = new Map<string, number>();
  return (alarms: Alarm[], now = new Date()): ScheduledAlarm[] => {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return [];
    const lower = Math.max(
      Number.isFinite(lastTick) ? lastTick : nowMs,
      nowMs - MAX_MISSED_ALARM_MS,
    );
    lastTick = nowMs;
    // Keep the deduplication set bounded, retaining an extra day for a clock rollback.
    for (const [key, at] of fired)
      if (at < nowMs - 2 * 86_400_000) fired.delete(key);
    if (lower > nowMs) return [];
    const due: ScheduledAlarm[] = [];
    for (const alarm of alarms) {
      const at = nextOccurrence(alarm, new Date(lower));
      if (!at || at.getTime() > nowMs) continue;
      const key = `${alarm.id}:${at.getTime()}`;
      if (fired.has(key)) continue;
      fired.set(key, at.getTime());
      due.push({ alarm, at });
    }
    return due.sort((a, b) => a.at.getTime() - b.at.getTime());
  };
}

export function formatWeekdays(days: number[]): string {
  const unique = [...new Set(days)]
    .filter((d) => integerIn(d, 0, 6))
    .sort((a, b) => a - b);
  if (!unique.length || unique.length === 7) return "毎日";
  if (unique.join(",") === "1,2,3,4,5") return "平日";
  if (unique.join(",") === "0,6") return "週末";
  const names = ["日", "月", "火", "水", "木", "金", "土"];
  return unique.map((day) => names[day]).join("・");
}
