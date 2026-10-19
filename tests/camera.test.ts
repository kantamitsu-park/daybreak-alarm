import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_PERMISSION_TIMEOUT_MS,
  startMissionCapture,
} from "../src/lib/camera";

class FakeTrack extends EventTarget {
  readyState = "live";
  muted = false;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) {
    return type === "video/webm";
  }
  state = "inactive";
  mimeType = "video/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["valid recorded bytes"], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

let track: FakeTrack;
let doc: EventTarget & {
  visibilityState: string;
  createElement: ReturnType<typeof vi.fn>;
};
let video: HTMLVideoElement;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  FakeRecorder.instances = [];
  track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    })),
  });
  vi.stubGlobal("document", doc);
  video = Object.assign(new EventTarget(), {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    muted: false,
    playsInline: false,
  }) as unknown as HTMLVideoElement;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live mission capture integrity", () => {
  it("captures six sequential frames, original video, elapsed duration, and releases all tracks", async () => {
    const onFrame = vi.fn(async () => {});
    const capture = await startMissionCapture({ video, onFrame });
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await capture.stop();
    expect(result.durationMs).toBe(8_000);
    expect(result.endedAt - result.startedAt).toBe(8_000);
    expect(result.video.size).toBeGreaterThan(0);
    expect(result.frames).toHaveLength(6);
    expect(onFrame.mock.calls.map((call) => call[1])).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({ facingMode: { ideal: "user" } }),
      }),
    );
    expect(await capture.stop()).toBe(result);
  });

  it("never overlaps frame uploads when upload latency is longer than the sample interval", async () => {
    let uploads = 0;
    let concurrent = 0;
    const capture = await startMissionCapture({
      video,
      onFrame: async () => {
        uploads++;
        concurrent = Math.max(concurrent, uploads);
        await new Promise<void>((resolve) => setTimeout(resolve, 1_700));
        uploads--;
      },
    });
    await vi.advanceTimersByTimeAsync(10_500);
    const done = capture.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await done).frames.length).toBeGreaterThanOrEqual(6);
    expect(concurrent).toBe(1);
  });

  it("rejects short clips and still releases the camera", async () => {
    const capture = await startMissionCapture({ video, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(7_999);
    await expect(capture.stop()).rejects.toMatchObject({ code: "too-short" });
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it.each(["ended", "mute"])(
    "invalidates interrupted tracks (%s)",
    async (event) => {
      const onInterruption = vi.fn();
      const capture = await startMissionCapture({
        video,
        onFrame: () => {},
        onInterruption,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      track.dispatchEvent(new Event(event));
      expect(onInterruption).toHaveBeenCalledWith(
        expect.objectContaining({ code: "interrupted" }),
      );
      await expect(capture.stop()).rejects.toMatchObject({
        code: "interrupted",
      });
      expect(track.stop).toHaveBeenCalled();
    },
  );

  it("invalidates a recording immediately when the page becomes hidden", async () => {
    const capture = await startMissionCapture({ video, onFrame: () => {} });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(track.stop).toHaveBeenCalled();
    await expect(capture.stop()).rejects.toMatchObject({ code: "hidden" });
  });

  it("does not open the camera from a hidden page", async () => {
    doc.visibilityState = "hidden";
    await expect(
      startMissionCapture({ video, onFrame: () => {} }),
    ).rejects.toMatchObject({ code: "hidden" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("rejects upload failures instead of silently producing gaps", async () => {
    const onInterruption = vi.fn();
    const capture = await startMissionCapture({
      video,
      onInterruption,
      onFrame: async () => {
        throw new Error("network");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onInterruption).toHaveBeenCalledWith(
      expect.objectContaining({ code: "frame-failed" }),
    );
    await expect(capture.stop()).rejects.toMatchObject({
      code: "frame-failed",
    });
    expect(track.stop).toHaveBeenCalled();
  });

  it("rejects excessive frame delays", async () => {
    const capture = await startMissionCapture({
      video,
      onFrame: () => new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    });
    await vi.advanceTimersByTimeAsync(5_010);
    await expect(capture.stop()).rejects.toMatchObject({ code: "interrupted" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("handles cancellation during camera permission setup without leaking a track", async () => {
    const controller = new AbortController();
    getUserMedia.mockImplementation(async () => {
      controller.abort();
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    });
    await expect(
      startMissionCapture({
        video,
        onFrame: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("cancels an unanswered permission request immediately and releases a late camera grant", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let grant!: (stream: MediaStream) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const opening = startMissionCapture({
      video,
      onFrame: () => {},
      signal: controller.signal,
    });
    const cancelled = expect(opening).rejects.toMatchObject({
      code: "cancelled",
    });
    controller.abort();
    await cancelled;
    expect(video.play).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    const secondTrack = new FakeTrack();
    grant({
      getTracks: () => [track, secondTrack],
      getVideoTracks: () => [track],
    } as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).toHaveBeenCalledExactlyOnceWith();
    expect(secondTrack.stop).toHaveBeenCalledExactlyOnceWith();
    expect(FakeRecorder.instances).toHaveLength(0);
    removeListener.mockRestore();
  });

  it("times out an unanswered permission request after fifteen seconds and discards a later grant", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let grant!: (stream: MediaStream) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const opening = startMissionCapture({
      video,
      onFrame: () => {},
      signal: controller.signal,
    });
    let settled = false;
    void opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const timedOut = expect(opening).rejects.toMatchObject({
      code: "permission-timeout",
    });
    await vi.advanceTimersByTimeAsync(CAMERA_PERMISSION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    grant({
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(track.stop).toHaveBeenCalledExactlyOnceWith();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    removeListener.mockRestore();
  });

  it("handles a late permission denial after cancellation without an unhandled rejection", async () => {
    const controller = new AbortController();
    let deny!: (error: unknown) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((_, reject) => {
          deny = reject;
        }),
    );
    const opening = startMissionCapture({
      video,
      onFrame: () => {},
      signal: controller.signal,
    });
    const cancelled = expect(opening).rejects.toMatchObject({
      code: "cancelled",
    });
    controller.abort();
    await cancelled;
    deny(new DOMException("denied", "NotAllowedError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("clears the permission timeout once capture starts successfully", async () => {
    const capture = await startMissionCapture({ video, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(CAMERA_PERMISSION_TIMEOUT_MS + 1);
    expect((await capture.stop()).durationMs).toBe(
      CAMERA_PERMISSION_TIMEOUT_MS + 1,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels active capture and cleans the video preview", async () => {
    const controller = new AbortController();
    const capture = await startMissionCapture({
      video,
      onFrame: () => {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(capture.stop()).rejects.toMatchObject({ code: "cancelled" });
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("reports permission denial clearly", async () => {
    getUserMedia.mockRejectedValue(
      new DOMException("denied", "NotAllowedError"),
    );
    await expect(
      startMissionCapture({ video, onFrame: () => {} }),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("releases camera resources if video playback cannot start", async () => {
    vi.mocked(video.play).mockRejectedValue(new Error("cannot play"));
    await expect(
      startMissionCapture({ video, onFrame: () => {} }),
    ).rejects.toMatchObject({ code: "camera-unavailable" });
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("releases camera resources when MediaRecorder fails", async () => {
    const capture = await startMissionCapture({ video, onFrame: () => {} });
    FakeRecorder.instances[0].onerror?.();
    await expect(capture.stop()).rejects.toMatchObject({
      code: "recording-failed",
    });
    expect(track.stop).toHaveBeenCalled();
  });
});
