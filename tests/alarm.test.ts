import { describe, expect, it, vi } from "vitest";
import type { Alarm } from "../shared/types";
import {
  ALARM_STORAGE_KEY,
  DEFAULT_ALARMS,
  createDueAlarmResolver,
  formatWeekdays,
  getNextAlarm,
  loadAlarms,
  nextOccurrence,
  saveAlarms,
  validateAlarm,
} from "../src/lib/alarm";

const monday = (hour = 6, minute = 59, second = 0) =>
  new Date(2026, 9, 19, hour, minute, second);
const water = (changes: Partial<Alarm> = {}): Alarm => ({
  ...DEFAULT_ALARMS[0],
  days: [...DEFAULT_ALARMS[0].days],
  ...changes,
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("alarm scheduling", () => {
  it("selects the next enabled weekday occurrence", () => {
    expect(nextOccurrence(water(), monday())?.getTime()).toBe(
      monday(7, 0).getTime(),
    );
    expect(nextOccurrence(water(), monday(7, 0))?.getTime()).toBe(
      monday(7, 0).getTime(),
    );
    expect(nextOccurrence(water(), monday(7, 0, 1))?.getTime()).toBe(
      new Date(2026, 9, 20, 7).getTime(),
    );
  });

  it("crosses week and month boundaries without fixed 24-hour arithmetic", () => {
    expect(nextOccurrence(water(), new Date(2026, 9, 30, 8))?.getTime()).toBe(
      new Date(2026, 10, 2, 7).getTime(),
    );
    expect(
      nextOccurrence(
        water({ time: "00:00", days: [] }),
        monday(23, 59),
      )?.getTime(),
    ).toBe(new Date(2026, 9, 20).getTime());
  });

  it("returns no occurrence for disabled or invalid alarms", () => {
    expect(nextOccurrence(water({ enabled: false }), monday())).toBeNull();
    expect(nextOccurrence(water({ time: "25:10" }), monday())).toBeNull();
    expect(nextOccurrence(water(), new Date("invalid"))).toBeNull();
  });

  it("skips a nonexistent DST time and finds the following valid week", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const alarm = water({ time: "02:30", days: [0] });
      expect(nextOccurrence(alarm, new Date(2026, 2, 7, 12))?.getTime()).toBe(
        new Date(2026, 2, 15, 2, 30).getTime(),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("chooses the closest alarm and ignores disabled alarms", () => {
    expect(getNextAlarm(DEFAULT_ALARMS, monday(6, 0))?.alarm.id).toBe(
      "morning-water",
    );
    expect(
      getNextAlarm(DEFAULT_ALARMS, new Date(2026, 9, 24, 7))?.alarm.id,
    ).toBe("weekend-coffee");
    expect(getNextAlarm([], monday())).toBeNull();
  });

  it("catches a late tick once, with no repeated firing on the same minute", () => {
    const resolve = createDueAlarmResolver(monday());
    expect(
      resolve([water()], monday(7, 0, 3)).map((v) => v.at.getTime()),
    ).toEqual([monday(7, 0).getTime()]);
    expect(resolve([water()], monday(7, 0, 3))).toEqual([]);
    expect(resolve([water()], monday(7, 0, 59))).toEqual([]);
  });

  it("never rings occurrences more than five minutes old", () => {
    expect(
      createDueAlarmResolver(monday())([water()], monday(7, 5)),
    ).toHaveLength(1);
    expect(
      createDueAlarmResolver(monday())([water()], monday(7, 5, 1)),
    ).toEqual([]);
    expect(createDueAlarmResolver(monday())([water()], monday(10, 0))).toEqual(
      [],
    );
  });

  it("does not catch alarms that were already missed before the resolver was created", () => {
    const resolve = createDueAlarmResolver(monday(7, 1));
    expect(resolve([water()], monday(7, 2))).toEqual([]);
  });

  it("survives clock rollback without replaying the same occurrence", () => {
    const resolve = createDueAlarmResolver(monday());
    expect(resolve([water()], monday(7, 0))).toHaveLength(1);
    expect(resolve([water()], monday(6, 58))).toEqual([]);
    expect(resolve([water()], monday(7, 1))).toEqual([]);
    expect(resolve([water()], new Date(2026, 9, 20, 7))).toHaveLength(1);
  });

  it("returns simultaneous alarms and disabled alarms correctly", () => {
    const alarms = [
      water(),
      water({ id: "second", time: "07:01" }),
      water({ id: "off", enabled: false }),
    ];
    expect(
      createDueAlarmResolver(monday())(alarms, monday(7, 2)).map(
        (v) => v.alarm.id,
      ),
    ).toEqual(["morning-water", "second"]);
  });
});

describe("validated local drafts", () => {
  it("normalizes without mutating the input", () => {
    const original = water({ label: "  水  ", days: [5, 1, 3] });
    expect(validateAlarm(original)).toMatchObject({
      label: "水",
      days: [1, 3, 5],
    });
    expect(original.days).toEqual([5, 1, 3]);
  });

  it.each([
    { time: "7:00" },
    { time: "07:00\n" },
    { time: "24:00" },
    { time: "12:60" },
    { mission: "skip" },
    { days: [1, 1] },
    { days: [7] },
    { days: [1.5] },
    { duration: 14 },
    { duration: 601 },
    { repetitions: 0 },
    { repetitions: 21 },
    { snoozeMinutes: 0 },
    { snoozeMinutes: 31 },
    { enabled: "true" },
    { label: "x".repeat(61) },
  ])("rejects invalid alarm data %j", (changes) => {
    expect(validateAlarm({ ...water(), ...changes })).toBeNull();
  });

  it("round-trips valid drafts, including a deliberately empty list", () => {
    const target = storage();
    expect(saveAlarms([water()], target)).toBe(true);
    expect(loadAlarms(target)).toEqual([water()]);
    expect(saveAlarms([], target)).toBe(true);
    expect(loadAlarms(target)).toEqual([]);
  });

  it("recovers from malformed, obsolete, invalid, or duplicate stored data", () => {
    const target = storage();
    for (const raw of [
      "{broken",
      JSON.stringify({ version: 2, alarms: [] }),
      JSON.stringify({ version: 1, alarms: [water({ time: "99:99" })] }),
      JSON.stringify({ version: 1, alarms: [water(), water()] }),
    ]) {
      target.setItem(ALARM_STORAGE_KEY, raw);
      expect(loadAlarms(target)).toEqual(DEFAULT_ALARMS);
    }
  });

  it("reports storage errors and never overwrites a valid draft with invalid data", () => {
    const target = storage();
    saveAlarms([water()], target);
    expect(saveAlarms([water({ time: "bad" })], target)).toBe(false);
    expect(loadAlarms(target)).toEqual([water()]);
    const unavailable = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadAlarms(unavailable)).toEqual(DEFAULT_ALARMS);
    expect(saveAlarms([water()], unavailable)).toBe(false);
  });

  it("returns detached defaults so editing a draft cannot mutate future resets", () => {
    const initial = loadAlarms(storage());
    initial[0].days.push(0);
    initial[0].enabled = false;
    expect(loadAlarms(storage())).toEqual(DEFAULT_ALARMS);
  });

  it("formats repeat days in Japanese", () => {
    expect(formatWeekdays([1, 2, 3, 4, 5])).toBe("平日");
    expect(formatWeekdays([0, 6])).toBe("週末");
    expect(formatWeekdays([])).toBe("毎日");
    expect(formatWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe("毎日");
    expect(formatWeekdays([5, 1, 3])).toBe("月・水・金");
  });
});
