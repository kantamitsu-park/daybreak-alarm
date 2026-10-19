import type { AlarmRow } from "./types";
export function normalizeTimezone(value?: string): string {
  if (!value || value.length > 80) return "Asia/Tokyo";
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return "Asia/Tokyo";
  }
}
/** Return today's (or just before midnight's) scheduled minute, only within a 5 minute arrival window. */
export function scheduledOccurrence(
  alarm: AlarmRow,
  now: number,
): number | null {
  if (!alarm.enabled) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: normalizeTimezone(alarm.timezone),
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const localMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const [h, m] = alarm.time.split(":").map(Number);
  const alarmMinute = h * 60 + m;
  const elapsedMinutes = (localMinute - alarmMinute + 1440) % 1440;
  if (elapsedMinutes > 5) return null;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.weekday,
  );
  const occurredDay = (weekday - (alarmMinute > localMinute ? 1 : 0) + 7) % 7;
  const days: number[] = JSON.parse(alarm.days);
  if (days.length && !days.includes(occurredDay)) return null;
  return Math.floor(now / 60_000) * 60_000 - elapsedMinutes * 60_000;
}
