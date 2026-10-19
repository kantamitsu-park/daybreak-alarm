// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Alarm, MissionSession } from "../shared/types";
import AlarmEditor from "../src/components/AlarmEditor";
import MissionScreen, { FlickControl } from "../src/components/MissionScreen";
import App from "../src/App";
import { api } from "../src/lib/api";
import { DEFAULT_ALARMS } from "../src/lib/alarm";
import { AlarmAudio } from "../src/lib/audio";
import { startMissionCapture } from "../src/lib/camera";

// Keep real Motion components. Accessible-name queries over animated SVG trees
// are slower in jsdom than browsers, especially while other build workers run.
vi.setConfig({ testTimeout: 15_000 });

vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...actual,
    api: Object.fromEntries(
      [
        "config",
        "me",
        "alarms",
        "history",
        "active",
        "status",
        "snoozes",
        "saveAlarm",
        "removeAlarm",
        "logout",
        "start",
        "frame",
        "video",
        "verify",
        "resolve",
        "abort",
      ].map((name) => [name, vi.fn()]),
    ),
  };
});
vi.mock("../src/lib/camera", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/camera")>();
  return { ...actual, startMissionCapture: vi.fn() };
});

const alarm = (): Alarm => ({
  ...DEFAULT_ALARMS[0],
  days: [...DEFAULT_ALARMS[0].days],
});
const session = (): MissionSession => ({
  id: "session-1",
  alarmId: DEFAULT_ALARMS[0].id,
  mission: "water",
  deadline: Date.now() + 60_000,
  challenge: "最初に指を2本、最後に手のひら",
  challengeFingers: 2,
  status: "pending",
});
function editor(
  options: Partial<React.ComponentProps<typeof AlarmEditor>> = {},
) {
  const props = {
    alarm: alarm(),
    isNew: false,
    onSave: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...options,
  };
  const view = render(<AlarmEditor {...props} />);
  return { ...view, ...props };
}
function mission(
  options: Partial<React.ComponentProps<typeof MissionScreen>> = {},
) {
  const props = {
    alarm: alarm(),
    preview: false,
    onClose: vi.fn(),
    onResolved: vi.fn(),
    onVolume: vi.fn(),
    ...options,
  };
  const view = render(<MissionScreen {...props} />);
  return { ...view, ...props };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Node 25's experimental localStorage shadows jsdom's Storage on globalThis.
  const draftStorage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => draftStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      draftStorage.set(key, String(value));
    },
    removeItem: (key: string) => {
      draftStorage.delete(key);
    },
    clear: () => draftStorage.clear(),
    key: (index: number) => [...draftStorage.keys()][index] ?? null,
    get length() {
      return draftStorage.size;
    },
  });
  vi.mocked(api.config).mockResolvedValue({
    googleClientId: null,
    aiConfigured: false,
    storageConfigured: false,
  });
  vi.mocked(api.me).mockRejectedValue(new Error("ログインしていません"));
  vi.mocked(api.alarms).mockResolvedValue(DEFAULT_ALARMS);
  vi.mocked(api.history).mockResolvedValue([]);
  vi.mocked(api.active).mockResolvedValue(null);
  vi.mocked(api.status).mockImplementation(async () => session());
  vi.mocked(api.snoozes).mockResolvedValue([]);
  vi.mocked(api.abort).mockResolvedValue({});
  vi.mocked(api.start).mockImplementation(async () => session());
  vi.mocked(api.frame).mockResolvedValue({});
  vi.mocked(api.video).mockResolvedValue({});
  vi.mocked(api.verify).mockResolvedValue({
    status: "failed",
    reason: "動作を確認できませんでした",
  });
  vi.mocked(api.resolve).mockResolvedValue({ status: "stopped" });
  vi.spyOn(AlarmAudio.prototype, "arm").mockResolvedValue();
  vi.spyOn(AlarmAudio.prototype, "start").mockImplementation(() => {});
  vi.spyOn(AlarmAudio.prototype, "stop").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("alarm editor", () => {
  it("saves a changed time, label, repeat days, mission, duration, repetitions and snooze", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const props = editor();
    fireEvent.change(screen.getByLabelText("アラーム時刻"), {
      target: { value: "08:45" },
    });
    await user.clear(screen.getByRole("textbox", { name: "名前" }));
    await user.type(screen.getByRole("textbox", { name: "名前" }), "朝の運動");
    await user.click(screen.getByRole("button", { name: "月曜日" }));
    await user.click(screen.getByRole("button", { name: "土曜日" }));
    await user.click(screen.getByRole("button", { name: "腕立て伏せ" }));
    expect((screen.getByLabelText("制限時間") as HTMLSelectElement).value).toBe(
      "90",
    );
    await user.selectOptions(screen.getByLabelText("制限時間"), "180");
    await user.selectOptions(screen.getByLabelText("回数"), "10");
    await user.selectOptions(screen.getByLabelText("スヌーズ時間"), "3");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        time: "08:45",
        label: "朝の運動",
        days: [2, 3, 4, 5, 6],
        mission: "pushups",
        duration: 180,
        repetitions: 10,
        snoozeMinutes: 3,
      }),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.alarm.time).toBe("07:00");
    expect(props.alarm.days).toEqual([1, 2, 3, 4, 5]);
  });

  it("resets mission-specific repetitions when changing from exercise to coffee", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const props = editor({
      alarm: { ...alarm(), mission: "pushups", repetitions: 20, duration: 90 },
    });
    await user.click(screen.getByRole("button", { name: "コーヒー" }));
    expect((screen.getByLabelText("制限時間") as HTMLSelectElement).value).toBe(
      "120",
    );
    expect((screen.getByLabelText("杯数") as HTMLSelectElement).value).toBe(
      "1",
    );
    expect(screen.queryByLabelText("回数")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        mission: "coffee",
        repetitions: 1,
        duration: 120,
      }),
    );
  });

  it("supports every-day repeat through an empty day selection", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const props = editor();
    for (const day of ["月", "火", "水", "木", "金"])
      await user.click(screen.getByRole("button", { name: `${day}曜日` }));
    expect(screen.getByText("選択しない場合は毎日")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ days: [] }),
    );
  });

  it("rejects an empty time through native form validation", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const props = editor();
    const time = screen.getByLabelText("アラーム時刻") as HTMLInputElement;
    fireEvent.change(time, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(time.validity.valid).toBe(false);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("deletes an existing alarm by its stable id", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const props = editor();
    await user.click(screen.getByRole("button", { name: "アラームを削除" }));
    expect(props.onDelete).toHaveBeenCalledExactlyOnceWith(props.alarm.id);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer deletion for a new draft", () => {
    editor({ isNew: true });
    expect(screen.getByRole("dialog", { name: "新しいアラーム" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "アラームを削除" })).toBeNull();
  });

  it("keeps a failed save editable and reports the failure", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const onSave = vi
      .fn()
      .mockRejectedValue(new Error("保存できません。接続を確認してください。"));
    const props = editor({ onSave });
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("alert").textContent).toContain("保存できません");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "保存する" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    onSave.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss or submit twice while a save is pending", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    let complete!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const props = editor({ onSave });
    await user.click(screen.getByRole("button", { name: "保存する" }));
    const save = screen.getByRole("button", {
      name: "保存中…",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      complete();
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus and page scrolling after closing the editor", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open editor";
    document.body.append(trigger);
    trigger.focus();
    const props = editor();
    const close = screen.getByRole("button", { name: "閉じる" });
    close.focus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(close, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    props.unmount();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
    trigger.remove();
  });
});

describe("mission-gated flick controls", () => {
  it("never resolves a locked mission through click or either arrow", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const onResolve = vi.fn();
    render(
      <FlickControl unlocked={false} busy={false} onResolve={onResolve} />,
    );
    const thumb = screen.getByRole("button", {
      name: "フリック操作",
    }) as HTMLButtonElement;
    expect(thumb.disabled).toBe(true);
    expect(thumb.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await user.click(thumb);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowLeft", "snooze"],
    ["ArrowRight", "stop"],
  ])("maps %s to %s after verification", async (key, action) => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const onResolve = vi.fn();
    render(<FlickControl unlocked busy={false} onResolve={onResolve} />);
    const thumb = screen.getByRole("button", {
      name: "フリック操作",
    }) as HTMLButtonElement;
    expect(thumb.disabled).toBe(false);
    thumb.focus();
    await user.keyboard(`{${key}}`);
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("requires a directional action instead of an ordinary click, Enter, or Space", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const onResolve = vi.fn();
    render(<FlickControl unlocked busy={false} onResolve={onResolve} />);
    const thumb = screen.getByRole("button", { name: "フリック操作" });
    await user.click(thumb);
    await user.keyboard("{Enter} {ArrowUp}{ArrowDown}");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("blocks additional actions while resolution is pending", () => {
    const onResolve = vi.fn();
    render(<FlickControl unlocked busy onResolve={onResolve} />);
    const thumb = screen.getByRole("button", {
      name: "フリック操作",
    }) as HTMLButtonElement;
    expect(thumb.disabled).toBe(true);
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByText("処理中…")).toBeTruthy();
  });
});

describe("mission screen failure handling", () => {
  it("retries an initial start failure without demanding a nonexistent prior attempt", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    vi.mocked(api.start).mockRejectedValueOnce(new Error("通信できません"));
    vi.mocked(startMissionCapture).mockResolvedValue({
      startedAt: Date.now(),
      mimeType: "video/webm",
      stop: vi.fn(),
      cancel: vi.fn(),
    });
    mission();
    await act(async () => {});
    await user.click(screen.getByRole("button", { name: "もう一度撮影" }));
    expect(api.start).toHaveBeenNthCalledWith(2, DEFAULT_ALARMS[0].id, false);
    expect(api.abort).not.toHaveBeenCalled();
    expect(startMissionCapture).toHaveBeenCalledOnce();
  });

  it.each(["passed", "verifying", "recording"] as const)(
    "recovers an existing %s attempt after losing the initial response without starting another recording",
    async (status) => {
      const user = userEvent.setup({
        delay: null,
        pointerEventsCheck: 0,
        skipHover: true,
      });
      vi.mocked(api.start)
        .mockRejectedValueOnce(new Error("通信できません"))
        .mockResolvedValueOnce({ ...session(), status });
      mission();
      await act(async () => {});
      await user.click(screen.getByRole("button", { name: "もう一度撮影" }));
      expect(api.start).toHaveBeenNthCalledWith(2, DEFAULT_ALARMS[0].id, false);
      expect(api.abort).not.toHaveBeenCalled();
      expect(startMissionCapture).not.toHaveBeenCalled();
      expect(
        (
          screen.getByRole("button", {
            name: "フリック操作",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(status !== "passed");
      if (status === "verifying")
        expect(screen.getByRole("status").textContent).toContain(
          "判定しています",
        );
      if (status === "recording")
        expect(
          screen.getByRole("button", { name: "もう一度撮影" }),
        ).toBeTruthy();
    },
  );

  it("starts the server deadline immediately without waiting for camera permission", async () => {
    vi.mocked(api.start).mockResolvedValue({
      ...session(),
      deadline: Date.now() + 30_000,
    });
    mission();
    await act(async () => {});
    expect(api.start).toHaveBeenCalledExactlyOnceWith(DEFAULT_ALARMS[0].id);
    expect(screen.getByLabelText("残り30秒")).toBeTruthy();
    expect(screen.getByText("指を2本")).toBeTruthy();
    expect(startMissionCapture).not.toHaveBeenCalled();
  });

  it("shows the selected mission immediately and keeps stop locked", () => {
    mission({ preview: true });
    expect(screen.getByRole("heading", { name: "水を飲む" })).toBeTruthy();
    expect(screen.getByLabelText("残り60秒")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "フリック操作",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(startMissionCapture).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("reports denied camera access without unlocking the alarm", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    vi.mocked(startMissionCapture).mockRejectedValue(
      new Error("カメラを許可してください"),
    );
    const props = mission({ preview: true });
    await user.click(
      screen.getByRole("button", { name: "カメラでミッションを開始" }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "カメラを許可してください",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "フリック操作",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(props.onResolved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "もう一度撮影" })).toBeTruthy();
  });

  it("cancels a recording and releases the capture when the screen unmounts", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    const cancel = vi.fn();
    vi.mocked(startMissionCapture).mockResolvedValue({
      startedAt: Date.now(),
      mimeType: "video/webm",
      stop: vi.fn(),
      cancel,
    });
    const props = mission({ preview: true });
    await user.click(
      screen.getByRole("button", { name: "カメラでミッションを開始" }),
    );
    expect(props.onVolume).toHaveBeenCalledWith(0.18);
    props.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("never offers a close button on a real ringing alarm", async () => {
    mission();
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "プレビューを閉じる" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
  });

  it("requires the server to acknowledge a verified stop before dismissing the alarm", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    let finish!: (value: { status: "stopped" }) => void;
    vi.mocked(api.resolve).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const verified = { ...session(), status: "passed" as const };
    const props = mission({ initialSession: verified });
    expect(api.start).not.toHaveBeenCalled();
    const thumb = screen.getByRole("button", {
      name: "フリック操作",
    }) as HTMLButtonElement;
    thumb.focus();
    await user.keyboard("{ArrowRight}");
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith(verified.id, "stop");
    expect(props.onResolved).not.toHaveBeenCalled();
    expect(thumb.disabled).toBe(true);
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    expect(api.resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ status: "stopped" });
    });
    expect(props.onResolved).toHaveBeenCalledExactlyOnceWith("stop", undefined);
  });

  it("keeps the alarm active when the server refuses a resolution", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    vi.mocked(api.resolve).mockRejectedValue(
      new Error("達成状態を確認できません。もう一度お試しください。"),
    );
    vi.mocked(api.status).mockRejectedValue(new Error("通信できません"));
    const props = mission({
      initialSession: { ...session(), status: "passed" },
    });
    screen.getByRole("button", { name: "フリック操作" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("alert").textContent).toContain(
      "達成状態を確認できません",
    );
    expect(props.onResolved).not.toHaveBeenCalled();
    expect(api.status).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(
      (
        screen.getByRole("button", {
          name: "フリック操作",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "もう一度撮影" })).toBeNull();
  });

  it.each(["expired", "failed"] as const)(
    "locks a rejected grant and permits an explicit fresh attempt when the server reports %s",
    async (status) => {
      const user = userEvent.setup({
        delay: null,
        pointerEventsCheck: 0,
        skipHover: true,
      });
      const verified = { ...session(), status: "passed" as const };
      vi.mocked(api.resolve).mockRejectedValue(
        new Error("停止操作の有効期限が切れました。再撮影してください。"),
      );
      vi.mocked(api.status).mockResolvedValue({
        ...verified,
        status,
        reason: "判定の有効期限が切れました。",
      });
      vi.mocked(startMissionCapture).mockResolvedValue({
        startedAt: Date.now(),
        mimeType: "video/webm",
        stop: vi.fn(),
        cancel: vi.fn(),
      });
      const props = mission({ initialSession: verified });
      screen.getByRole("button", { name: "フリック操作" }).focus();
      await user.keyboard("{ArrowRight}");
      expect(api.status).toHaveBeenCalledExactlyOnceWith(verified.id);
      expect(
        (
          screen.getByRole("button", {
            name: "フリック操作",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(props.onResolved).not.toHaveBeenCalled();
      expect(api.start).not.toHaveBeenCalled();
      expect(startMissionCapture).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "もう一度撮影" }));
      expect(api.abort).toHaveBeenCalledExactlyOnceWith(verified.id);
      expect(api.start).toHaveBeenCalledExactlyOnceWith(verified.alarmId, true);
      expect(startMissionCapture).toHaveBeenCalledOnce();
    },
  );

  it.each(["stopped", "snoozed"] as const)(
    "recovers a committed %s action from the server when the resolution response is lost",
    async (status) => {
      const user = userEvent.setup({
        delay: null,
        pointerEventsCheck: 0,
        skipHover: true,
      });
      const verified = { ...session(), status: "passed" as const };
      const snoozeUntil = Date.now() + 300_000;
      vi.mocked(api.resolve).mockRejectedValue(new Error("通信できません"));
      vi.mocked(api.status).mockResolvedValue({
        ...verified,
        status,
        ...(status === "snoozed" ? { snoozeUntil } : {}),
      });
      const props = mission({ initialSession: verified });
      screen.getByRole("button", { name: "フリック操作" }).focus();
      await user.keyboard(
        status === "snoozed" ? "{ArrowLeft}" : "{ArrowRight}",
      );
      expect(api.status).toHaveBeenCalledExactlyOnceWith(verified.id);
      if (status === "snoozed")
        expect(props.onResolved).toHaveBeenCalledExactlyOnceWith(
          "snooze",
          snoozeUntil,
        );
      else expect(props.onResolved).toHaveBeenCalledExactlyOnceWith("stop");
      expect(api.start).not.toHaveBeenCalled();
      expect(startMissionCapture).not.toHaveBeenCalled();
    },
  );

  it.each(["passed", "failed"] as const)(
    "unlocks only after an actual %s verification response",
    async (verdict) => {
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
      const recording = new Blob(["captured-video"], { type: "video/webm" });
      const stop = vi.fn(async () => ({
        video: recording,
        frames: [],
        durationMs: 8_000,
        startedAt: Date.now() - 8_000,
        endedAt: Date.now(),
      }));
      const cancel = vi.fn();
      vi.mocked(startMissionCapture).mockResolvedValue({
        startedAt: Date.now(),
        mimeType: "video/webm",
        stop,
        cancel,
      });
      let verify!: (value: {
        status: "passed" | "failed";
        reason: string;
      }) => void;
      vi.mocked(api.verify).mockImplementation(
        () =>
          new Promise((resolve) => {
            verify = resolve;
          }),
      );
      mission();
      await act(async () => {});
      fireEvent.click(
        screen.getByRole("button", { name: "カメラでミッションを開始" }),
      );
      await act(async () => {});
      const shortClip = screen.getByRole("button", {
        name: "あと8秒撮影",
      }) as HTMLButtonElement;
      expect(shortClip.disabled).toBe(true);
      fireEvent.click(shortClip);
      expect(stop).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      fireEvent.click(
        screen.getByRole("button", { name: "撮影を終了して判定" }),
      );
      await act(async () => {});
      expect(api.video).toHaveBeenCalledExactlyOnceWith(
        "session-1",
        recording,
        8_000,
      );
      expect(api.verify).toHaveBeenCalledExactlyOnceWith("session-1");
      expect(screen.getByRole("status").textContent).toContain(
        "判定しています",
      );
      expect(
        (
          screen.getByRole("button", {
            name: "フリック操作",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await act(async () => {
        verify({
          status: verdict,
          reason: verdict === "failed" ? "動作が不足しています" : "",
        });
      });
      expect(
        (
          screen.getByRole("button", {
            name: "フリック操作",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(verdict !== "passed");
      if (verdict === "failed")
        expect(screen.getByRole("alert").textContent).toContain(
          "動作が不足しています",
        );
      else
        expect(
          screen.getByRole("heading", { name: "ミッション達成" }),
        ).toBeTruthy();
    },
  );
});

describe("application loading and account states", () => {
  it("presents a full-screen skeleton and an inert app until initial requests settle", async () => {
    render(<App />);
    expect(
      screen
        .getByRole("status", { name: "読み込み中" })
        .classList.contains("skeleton-screen"),
    ).toBe(true);
    const main = document.querySelector("main")!;
    expect(main.hasAttribute("inert")).toBe(true);
    expect(main.getAttribute("aria-hidden")).toBe("true");
    await waitFor(() => expect(main.hasAttribute("inert")).toBe(false), {
      timeout: 2_000,
    });
    expect(
      screen.getByRole("heading", { name: "アラーム", level: 1 }),
    ).toBeTruthy();
    expect(api.config).toHaveBeenCalledTimes(1);
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it("makes Google the only login route and disables it when unconfigured", async () => {
    const user = userEvent.setup({
      delay: null,
      pointerEventsCheck: 0,
      skipHover: true,
    });
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "アラーム", level: 1 },
      { timeout: 2_000 },
    );
    await user.click(screen.getByRole("button", { name: "Googleでログイン" }));
    const dialog = screen.getByRole("dialog", { name: "Googleでログイン" });
    const google = within(dialog).getByRole("button", {
      name: "Googleで続ける",
    }) as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(
      within(dialog).getByText("ログイン方法はGoogleのみです"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Google認証の接続設定を準備中/),
    ).toBeTruthy();
  });

  it("shows server load failures without treating them as successful account data", async () => {
    vi.mocked(api.me).mockResolvedValue({
      id: "u1",
      name: "Test User",
      email: "test@example.com",
    });
    vi.mocked(api.alarms).mockRejectedValue(new Error("network unavailable"));
    render(<App />);
    await screen.findByRole(
      "heading",
      { name: "アラーム", level: 1 },
      { timeout: 2_000 },
    );
    expect(
      screen.getByText(
        "アラームを取得できませんでした。ページを再読み込みしてください。",
      ),
    ).toBeTruthy();
    expect(api.history).toHaveBeenCalledTimes(1);
    expect(api.saveAlarm).not.toHaveBeenCalled();
  });
});
