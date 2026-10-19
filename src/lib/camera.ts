export const MIN_CAPTURE_DURATION_MS = 8_000;
export const DEFAULT_FRAME_INTERVAL_MS = 1_500;
export const MAX_CAPTURE_BYTES = 24 * 1_024 * 1_024;
export const CAMERA_PERMISSION_TIMEOUT_MS = 15_000;

export type CaptureErrorCode =
  | "unsupported"
  | "permission-denied"
  | "permission-timeout"
  | "camera-unavailable"
  | "interrupted"
  | "hidden"
  | "too-short"
  | "frame-failed"
  | "recording-failed"
  | "too-large"
  | "cancelled";

export class CaptureError extends Error {
  constructor(
    public readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface CaptureOptions {
  video: HTMLVideoElement;
  onFrame: (
    blob: Blob,
    index: number,
    capturedAt: number,
  ) => Promise<void> | void;
  onInterruption?: (error: CaptureError) => void;
  frameIntervalMs?: number;
  minDurationMs?: number;
  signal?: AbortSignal;
}

export interface CaptureResult {
  video: Blob;
  frames: Blob[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface MissionCapture {
  startedAt: number;
  mimeType: string;
  stop: () => Promise<CaptureResult>;
  cancel: () => void;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(
            new CaptureError(
              "frame-failed",
              "映像フレームを読み取れませんでした。",
            ),
          );
    reader.onerror = () =>
      reject(
        new CaptureError(
          "frame-failed",
          "映像フレームを読み取れませんでした。",
        ),
      );
    reader.readAsDataURL(blob);
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
function pageHidden(): boolean {
  return document.visibilityState === "hidden";
}

/** getUserMedia cannot be cancelled natively, so late grants must be discarded. */
function openCamera(signal?: AbortSignal): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new CaptureError("cancelled", "撮影をキャンセルしました。"));
    const timer = setTimeout(
      () =>
        fail(
          new CaptureError(
            "permission-timeout",
            "カメラの許可を確認できませんでした。ブラウザ設定でカメラを許可し、もう一度お試しください。",
          ),
        ),
      CAMERA_PERMISSION_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      navigator.mediaDevices
        .getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 15, max: 24 },
          },
        })
        .then((stream) => {
          if (settled) {
            stopStream(stream);
            return;
          }
          settled = true;
          cleanup();
          resolve(stream);
        }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

async function waitForVideo(
  video: HTMLVideoElement,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    throw new CaptureError("cancelled", "撮影をキャンセルしました。");
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        new CaptureError(
          "camera-unavailable",
          "カメラの映像を取得できませんでした。",
        ),
      );
    };
    const aborted = () => {
      cleanup();
      reject(new CaptureError("cancelled", "撮影をキャンセルしました。"));
    };
    const timer = setTimeout(failed, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
  if (!video.videoWidth || !video.videoHeight)
    throw new CaptureError(
      "camera-unavailable",
      "カメラの映像を取得できませんでした。",
    );
}

/**
 * Records the live front camera, without microphone access. Sampling and uploads
 * run sequentially. Any visibility/camera interruption invalidates the recording.
 * These checks improve honest-client integrity; only the server can approve a mission.
 */
export async function startMissionCapture(
  options: CaptureOptions,
): Promise<MissionCapture> {
  const { video, onFrame, onInterruption, signal } = options;
  const frameIntervalMs = Math.max(
    500,
    options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
  );
  const minDurationMs = Math.max(
    MIN_CAPTURE_DURATION_MS,
    options.minDurationMs ?? MIN_CAPTURE_DURATION_MS,
  );
  if (
    !globalThis.navigator?.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  )
    throw new CaptureError(
      "unsupported",
      "このブラウザは動画撮影に対応していません。",
    );
  if (pageHidden())
    throw new CaptureError("hidden", "画面を開いたまま撮影してください。");
  if (signal?.aborted)
    throw new CaptureError("cancelled", "撮影をキャンセルしました。");

  let stream: MediaStream;
  try {
    stream = await openCamera(signal);
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    const denied =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    throw new CaptureError(
      denied ? "permission-denied" : "camera-unavailable",
      denied
        ? "カメラを許可して、もう一度お試しください。"
        : "カメラを使用できません。他のアプリを閉じてお試しください。",
    );
  }

  let setupHidden = false;
  const watchSetup = () => {
    if (pageHidden()) setupHidden = true;
  };
  document.addEventListener("visibilitychange", watchSetup);
  let recorder: MediaRecorder;
  try {
    if (signal?.aborted)
      throw new CaptureError("cancelled", "撮影をキャンセルしました。");
    if (pageHidden())
      throw new CaptureError("hidden", "画面を開いたまま撮影してください。");
    if (
      !stream.getVideoTracks().length ||
      stream.getVideoTracks().some((t) => t.readyState !== "live" || t.muted)
    )
      throw new CaptureError(
        "camera-unavailable",
        "カメラの映像を取得できませんでした。",
      );
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await waitForVideo(video, signal);
    if (setupHidden || pageHidden())
      throw new CaptureError("hidden", "撮影中に別の画面へ移動できません。");
    if (signal?.aborted)
      throw new CaptureError("cancelled", "撮影をキャンセルしました。");
    const preferred = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    const mimeType = preferred.find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    // Keeps even a ten-minute capture within the server's upload size limit.
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 256_000,
    });
  } catch (error) {
    stopStream(stream);
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(
      "camera-unavailable",
      "カメラの起動に失敗しました。もう一度お試しください。",
    );
  } finally {
    document.removeEventListener("visibilitychange", watchSetup);
  }

  const startedAt = Date.now();
  const startedMono = performance.now();
  const mimeType = recorder.mimeType || "video/webm";
  const chunks: Blob[] = [];
  const frames: Blob[] = [];
  let bytes = 0;
  let active = true;
  let failure: CaptureError | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastFrameAt: number | null = null;
  let stopPromise: Promise<CaptureResult> | null = null;
  let recorderStopped!: () => void;
  const recorderDone = new Promise<void>((resolve) => {
    recorderStopped = resolve;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(640, video.videoWidth);
  canvas.height = Math.round(
    (canvas.width * video.videoHeight) / video.videoWidth,
  );
  const context = canvas.getContext("2d");

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisibility);
    signal?.removeEventListener("abort", onAbort);
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", onTrackInterrupted);
      track.removeEventListener("mute", onTrackInterrupted);
    }
    stopStream(stream);
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
  };
  const stopRecorder = () => {
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        recorderStopped();
      }
    } else recorderStopped();
  };
  const fail = (error: CaptureError) => {
    if (failure) return;
    failure = error;
    active = false;
    stopRecorder();
    cleanup();
    try {
      onInterruption?.(error);
    } catch {
      /* UI callbacks cannot prevent track cleanup. */
    }
  };
  const onVisibility = () => {
    if (pageHidden())
      fail(
        new CaptureError(
          "hidden",
          "撮影中に別の画面へ移動したため、撮り直しが必要です。",
        ),
      );
  };
  const onTrackInterrupted = () =>
    fail(
      new CaptureError(
        "interrupted",
        "カメラの映像が途切れたため、撮り直しが必要です。",
      ),
    );
  const onAbort = () =>
    fail(new CaptureError("cancelled", "撮影をキャンセルしました。"));

  recorder.ondataavailable = (event) => {
    if (event.data.size) {
      bytes += event.data.size;
      chunks.push(event.data);
    }
    if (bytes > MAX_CAPTURE_BYTES)
      fail(
        new CaptureError(
          "too-large",
          "録画サイズの上限に達しました。短い動画で撮り直してください。",
        ),
      );
  };
  recorder.onstop = () => {
    recorderStopped();
    if (active)
      fail(
        new CaptureError(
          "interrupted",
          "録画が途中で停止したため、撮り直しが必要です。",
        ),
      );
  };
  recorder.onerror = () =>
    fail(
      new CaptureError(
        "recording-failed",
        "動画の録画に失敗しました。もう一度お試しください。",
      ),
    );
  document.addEventListener("visibilitychange", onVisibility);
  signal?.addEventListener("abort", onAbort, { once: true });
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", onTrackInterrupted);
    track.addEventListener("mute", onTrackInterrupted);
  }

  const sample = async () => {
    if (!active) return;
    try {
      if (pageHidden())
        throw new CaptureError("hidden", "画面を開いたまま撮影してください。");
      if (
        stream.getVideoTracks().some((t) => t.readyState !== "live" || t.muted)
      )
        throw new CaptureError("interrupted", "カメラの映像が途切れました。");
      const mono = performance.now();
      if (
        lastFrameAt !== null &&
        mono - lastFrameAt > Math.max(4_500, frameIntervalMs * 3)
      )
        throw new CaptureError(
          "interrupted",
          "撮影に空白が生じたため、撮り直しが必要です。",
        );
      if (!context || !video.videoWidth || !video.videoHeight)
        throw new CaptureError(
          "frame-failed",
          "映像フレームを取得できませんでした。",
        );
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(
                  new CaptureError(
                    "frame-failed",
                    "映像フレームを取得できませんでした。",
                  ),
                ),
          "image/jpeg",
          0.78,
        ),
      );
      if (!active) return;
      const capturedAt = startedAt + Math.round(mono - startedMono);
      lastFrameAt = mono;
      const index = frames.length;
      frames.push(blob);
      await onFrame(blob, index, capturedAt);
      if (active)
        timer = setTimeout(
          () => {
            inFlight = sample();
          },
          Math.max(0, frameIntervalMs - (performance.now() - mono)),
        );
    } catch (error) {
      fail(
        error instanceof CaptureError
          ? error
          : new CaptureError(
              "frame-failed",
              "映像フレームを送信できませんでした。接続を確認して撮り直してください。",
            ),
      );
    }
  };

  try {
    if (!context)
      throw new CaptureError(
        "unsupported",
        "このブラウザは映像の処理に対応していません。",
      );
    recorder.start(1_000);
    inFlight = sample();
  } catch (error) {
    fail(
      error instanceof CaptureError
        ? error
        : new CaptureError(
            "recording-failed",
            "動画の録画を開始できませんでした。",
          ),
    );
    throw failure;
  }

  return {
    startedAt,
    mimeType,
    cancel: onAbort,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const durationMs = Math.round(performance.now() - startedMono);
        const endedAt = startedAt + durationMs;
        active = false;
        if (timer !== null) clearTimeout(timer);
        stopRecorder();
        // Never leave the camera light on while network uploads are finishing.
        cleanup();
        await Promise.all([recorderDone, inFlight]);
        if (failure) throw failure;
        if (durationMs < minDurationMs || frames.length < 6)
          throw new CaptureError(
            "too-short",
            "8秒以上、動作の最初から最後まで続けて撮影してください。",
          );
        const recording = new Blob(chunks, { type: mimeType });
        if (!recording.size)
          throw new CaptureError(
            "recording-failed",
            "動画を保存できませんでした。もう一度お試しください。",
          );
        return {
          video: recording,
          frames: [...frames],
          startedAt,
          endedAt,
          durationMs,
        };
      })();
      return stopPromise;
    },
  };
}
