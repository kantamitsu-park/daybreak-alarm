import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  Hand,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import type { Alarm, MissionSession } from "../../shared/types";
import { api } from "../lib/api";
import { startMissionCapture, type MissionCapture } from "../lib/camera";
import { MISSIONS, MissionIcon } from "./icons";
type Phase = "ready" | "recording" | "verifying" | "passed" | "failed";
export function FlickControl({
  unlocked,
  busy,
  onResolve,
}: {
  unlocked: boolean;
  busy: boolean;
  onResolve: (action: "stop" | "snooze") => void;
}) {
  const x = useMotionValue(0);
  const scale = useTransform(x, [-110, 0, 110], [0.95, 1, 0.95]);
  return (
    <div className={`flick-wrap ${unlocked ? "unlocked" : ""}`}>
      <div className="flick-labels">
        <span>
          <ArrowLeft size={14} /> スヌーズ
        </span>
        <span>
          停止 <ArrowRight size={14} />
        </span>
      </div>
      <div
        className="flick-track"
        aria-label={
          unlocked
            ? "左にフリックでスヌーズ、右で停止"
            : "ミッション達成まで停止とスヌーズはロック中"
        }
      >
        <span className="flick-hint">
          {busy
            ? "処理中…"
            : unlocked
              ? "左右にフリック"
              : "ミッションを達成して解除"}
        </span>
        <motion.button
          type="button"
          className="flick-thumb"
          aria-label="フリック操作"
          aria-disabled={!unlocked || busy}
          disabled={!unlocked || busy}
          style={{ x, scale }}
          drag={unlocked && !busy ? "x" : false}
          dragConstraints={{ left: -110, right: 110 }}
          dragElastic={0.08}
          dragSnapToOrigin
          onDragEnd={(_, info) => {
            if (
              Math.abs(info.offset.x) > 82 ||
              (Math.abs(info.velocity.x) > 500 && Math.abs(info.offset.x) > 35)
            )
              onResolve(info.offset.x > 0 ? "stop" : "snooze");
          }}
          onKeyDown={(e) => {
            if (!unlocked || busy) return;
            if (e.key === "ArrowRight") {
              e.preventDefault();
              onResolve("stop");
            }
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              onResolve("snooze");
            }
          }}
        >
          {unlocked ? <Check size={23} /> : <LockKeyhole size={19} />}
        </motion.button>
      </div>
      {unlocked && (
        <span className="keyboard-hint">
          キーボードの ← / → でも操作できます
        </span>
      )}
    </div>
  );
}
export default function MissionScreen({
  alarm,
  preview,
  initialSession,
  onClose,
  onResolved,
  onVolume,
}: {
  alarm: Alarm;
  preview: boolean;
  initialSession?: MissionSession;
  onClose: () => void;
  onResolved: (action: "stop" | "snooze", until?: number) => void;
  onVolume: (v: number) => void;
}) {
  const [session, setSession] = useState<MissionSession | null>(
    initialSession ?? null,
  );
  const [phase, setPhase] = useState<Phase>(
    initialSession?.status === "passed"
      ? "passed"
      : initialSession?.status === "verifying"
        ? "verifying"
        : initialSession?.status === "recording"
          ? "failed"
          : "ready",
  );
  const [error, setError] = useState(
    initialSession?.status === "recording"
      ? "撮影が中断されました。もう一度撮影してください。"
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [recordStart, setRecordStart] = useState(0);
  const [deadline, setDeadline] = useState(
    initialSession?.deadline ?? Date.now() + alarm.duration * 1000,
  );
  const video = useRef<HTMLVideoElement>(null);
  const capture = useRef<MissionCapture | null>(null);
  const alive = useRef(true);
  const starting = useRef(false);
  const captureAbort = useRef<AbortController | null>(null);
  const descriptor = MISSIONS[alarm.mission];
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const remaining = Math.min(
    alarm.duration,
    Math.max(0, Math.ceil((deadline - now) / 1000)),
  );
  const elapsed = Math.max(0, Math.floor((now - recordStart) / 1000));
  useEffect(() => {
    alive.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      alive.current = false;
      document.body.style.overflow = overflow;
      clearInterval(tick);
      captureAbort.current?.abort();
      capture.current?.cancel();
    };
  }, []);
  useEffect(() => {
    if (preview || initialSession) return;
    let cancelled = false;
    setBusy(true);
    api
      .start(alarm.id)
      .then((created) => {
        if (!cancelled) {
          setSession(created);
          setDeadline(created.deadline);
          if (created.status === "passed") setPhase("passed");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message);
          setPhase("failed");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [alarm.id, preview, initialSession]);
  useEffect(() => {
    if (phase !== "verifying" || !session || preview) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api.status(session.id);
        if (cancelled) return;
        if (result.status === "passed") setPhase("passed");
        else if (["failed", "expired"].includes(result.status)) {
          setPhase("failed");
          setError(
            result.reason || "判定できませんでした。もう一度撮影してください。",
          );
        }
      } catch {
        /* Keep controls locked until server confirms. */
      }
    };
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, session, preview]);
  useEffect(() => {
    if (remaining === 0 && phase !== "passed" && phase !== "verifying") {
      captureAbort.current?.abort();
      capture.current?.cancel();
      capture.current = null;
      setPhase("failed");
      setError("制限時間になりました。もう一度ミッションを開始してください。");
      onVolume(1);
    }
  }, [remaining, phase, onVolume]);
  async function begin() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError("");
    try {
      let active = session;
      if (!active || phase === "failed") {
        const retry = !!active && phase === "failed";
        if (active && !preview) await api.abort(active.id);
        active = preview
          ? {
              id: "preview",
              alarmId: alarm.id,
              mission: alarm.mission,
              deadline: Date.now() + alarm.duration * 1000,
              challengeFingers: 2,
              challenge:
                "最初に指を2本見せて、最後に手のひらを見せてください。",
              status: "pending",
            }
          : await api.start(alarm.id, retry);
        setSession(active);
        setDeadline(active.deadline);
        // A previous request may have succeeded before its response was lost.
        // Recover that session without appending new video to an existing attempt.
        if (active.status !== "pending") {
          if (active.status === "passed") setPhase("passed");
          else if (active.status === "verifying") setPhase("verifying");
          else {
            setPhase("failed");
            setError("撮影が中断されました。もう一度撮影してください。");
          }
          return;
        }
        setPhase("ready");
      }
      const id = active.id;
      captureAbort.current = new AbortController();
      const recording = await startMissionCapture({
        signal: captureAbort.current.signal,
        video: video.current!,
        frameIntervalMs: 1500,
        minDurationMs: 8000,
        onFrame: async (blob, sequence) => {
          if (!preview) await api.frame(id, blob, sequence);
        },
        onInterruption: () => {
          if (alive.current) {
            if (!preview && sessionRef.current)
              void api.abort(sessionRef.current.id).catch(() => {});
            setPhase("failed");
            setError(
              "撮影が中断されました。画面を開いたまま、もう一度撮影してください。",
            );
            onVolume(1);
          }
        },
      });
      if (!alive.current || Date.now() >= active.deadline) {
        recording.cancel();
        return;
      }
      capture.current = recording;
      setRecordStart(Date.now());
      setNow(Date.now());
      setPhase("recording");
      onVolume(0.18);
    } catch (e) {
      setError(
        (e as Error).message ||
          "カメラを使用できません。ブラウザ設定でカメラを許可してください。",
      );
      setPhase("failed");
    } finally {
      setBusy(false);
      starting.current = false;
    }
  }
  async function finish() {
    if (!capture.current || !session) return;
    setBusy(true);
    setError("");
    try {
      const clip = await capture.current.stop();
      capture.current = null;
      setPhase("verifying");
      if (preview) {
        setPhase("ready");
        setError(
          "撮影を確認しました。プレビューでは達成判定とアラーム解除は行いません。",
        );
        setDeadline(Date.now() + alarm.duration * 1000);
        return;
      }
      await api.video(session.id, clip.video, clip.durationMs);
      const verdict = await api.verify(session.id);
      if (!alive.current) return;
      setPhase(verdict.status === "passed" ? "passed" : "failed");
      if (verdict.status === "failed")
        setError(
          verdict.reason ||
            "動作を確認できませんでした。もう一度撮影してください。",
        );
    } catch (e) {
      setError((e as Error).message);
      setPhase("failed");
    } finally {
      setBusy(false);
      onVolume(1);
    }
  }
  async function resolve(action: "stop" | "snooze") {
    if (phase !== "passed" || !session || busy || preview) return;
    setBusy(true);
    try {
      const result = await api.resolve(session.id, action);
      onResolved(action, result.snoozeUntil);
    } catch (e) {
      setError((e as Error).message);
      try {
        const current = await api.status(session.id);
        if (!alive.current) return;
        if (current.status === "stopped") {
          onResolved("stop");
        } else if (
          current.status === "snoozed" &&
          Number.isFinite(current.snoozeUntil)
        ) {
          onResolved("snooze", current.snoozeUntil);
        } else if (
          current.status === "expired" ||
          current.status === "failed"
        ) {
          setSession(current);
          setPhase("failed");
          setError(
            current.reason ||
              "停止操作の有効期限が切れました。もう一度撮影してください。",
          );
        }
      } catch {
        // A failed status read does not invalidate a confirmed success grant.
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <motion.section
      className="mission-screen"
      initial={{ opacity: 0, scale: 1.025 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="アラームのミッション"
    >
      <div className="mission-screen-inner">
        <header className="mission-top">
          <span className="live-status">
            <i />
            {preview ? "プレビュー" : "アラーム起動中"}
          </span>
          <span className="mission-alarm-time">{alarm.time}</span>
          {preview && (
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="プレビューを閉じる"
            >
              <X size={20} />
            </button>
          )}
        </header>
        <div className="mission-title">
          <span className={`mission-icon ${descriptor.color}`}>
            <MissionIcon kind={alarm.mission} size={25} />
          </span>
          <h1>{descriptor.name}</h1>
          <p>
            {alarm.repetitions}
            {descriptor.unit} <span>・</span> {alarm.duration}秒以内
          </p>
        </div>
        <div
          className={`camera-stage ${phase === "recording" ? "recording" : ""} ${phase === "passed" ? "verified" : ""}`}
        >
          <video
            ref={video}
            aria-hidden={phase !== "recording"}
            muted
            autoPlay
            playsInline
            className={phase === "recording" ? "visible" : ""}
          />
          {phase === "recording" ? (
            <>
              <div className="recording-indicator">
                <i />
                録画中 {elapsed}秒
              </div>
              <div className="viewfinder" />
              <span className="camera-guidance">
                顔と{alarm.mission === "pushups" ? "全身" : "手元"}
                をフレームに入れてください
              </span>
            </>
          ) : phase === "verifying" ? (
            <div className="camera-placeholder">
              <div className="scan-orbit">
                <ShieldCheck size={38} />
              </div>
              <h3>ミッションを確認中</h3>
              <p>動画の動作を照合しています</p>
            </div>
          ) : phase === "passed" ? (
            <div className="camera-placeholder">
              <motion.div
                className="success-orbit"
                initial={{ scale: 0.5 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring" }}
              >
                <Check size={45} />
              </motion.div>
              <h3>ミッション達成</h3>
              <p>フリックでアラームを操作できます</p>
            </div>
          ) : (
            <div className="camera-placeholder">
              <div className="camera-orbit">
                <Camera size={34} strokeWidth={1.3} />
              </div>
              <p>{descriptor.detail}</p>
              <span>動画は判定後に通常の保存領域から削除</span>
            </div>
          )}
          {phase !== "passed" && phase !== "verifying" && (
            <div
              className={`countdown ${remaining < 15 ? "urgent" : ""}`}
              aria-label={`残り${remaining}秒`}
            >
              <svg viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="21" />
                <circle
                  className="countdown-progress"
                  cx="24"
                  cy="24"
                  r="21"
                  strokeDasharray="132"
                  strokeDashoffset={132 * (1 - remaining / alarm.duration)}
                />
              </svg>
              <span>{remaining}</span>
            </div>
          )}
        </div>
        {phase !== "passed" && (
          <div className="challenge-box">
            <Hand size={20} />
            <p>
              {session ? (
                <>
                  最初に<strong>指を{session.challengeFingers}本</strong>
                  見せてください。
                  <br />
                  ミッションの後に手のひらを見せて終了。
                </>
              ) : (
                <>
                  撮影開始時に動作の指示が表示されます。
                  <br />
                  画面を開いたまま撮影してください。
                </>
              )}
            </p>
          </div>
        )}
        {error && (
          <p
            className={`inline-error ${preview && phase === "ready" ? "info" : ""}`}
            role="alert"
          >
            {error}
          </p>
        )}
        {phase === "recording" ? (
          <button
            className="primary-button camera-button"
            disabled={busy || elapsed < 8}
            onClick={() => void finish()}
          >
            <Square size={17} />
            {elapsed < 8 ? `あと${8 - elapsed}秒撮影` : "撮影を終了して判定"}
          </button>
        ) : phase === "verifying" ? (
          <div className="verifying-bar" role="status">
            <span />
            判定しています…
          </div>
        ) : phase !== "passed" ? (
          <button
            className="primary-button camera-button"
            disabled={busy}
            onClick={() => void begin()}
          >
            {phase === "failed" ? (
              <RotateCcw size={18} />
            ) : (
              <Camera size={19} />
            )}{" "}
            {busy
              ? "準備中…"
              : phase === "failed"
                ? "もう一度撮影"
                : "カメラでミッションを開始"}
            <ChevronRight size={17} />
          </button>
        ) : null}
        <FlickControl
          unlocked={phase === "passed"}
          busy={busy}
          onResolve={(a) => void resolve(a)}
        />
        <p className="mission-security">
          <ShieldCheck size={13} />
          動画と、その場の動作で確認
        </p>
      </div>
    </motion.section>
  );
}
