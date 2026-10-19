import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import type { Alarm, MissionKind } from "../../shared/types";
import { Modal } from "./Modal";
import { MISSIONS, MissionIcon } from "./icons";
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
export default function AlarmEditor({
  alarm,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  alarm: Alarm;
  isNew: boolean;
  onClose: () => void;
  onSave: (alarm: Alarm) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(alarm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isNew ? "新しいアラーム" : "アラームを編集"}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => onSave(draft));
        }}
      >
        <div className="time-input-wrap">
          <input
            type="time"
            aria-label="アラーム時刻"
            required
            value={draft.time}
            onInput={(e) => setDraft({ ...draft, time: e.currentTarget.value })}
            onChange={(e) => setDraft({ ...draft, time: e.target.value })}
          />
        </div>
        <label className="field-label">
          名前
          <input
            className="text-input"
            maxLength={32}
            value={draft.label}
            placeholder="アラーム"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <fieldset>
          <legend>繰り返し</legend>
          <div className="weekdays">
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                type="button"
                className={draft.days.includes(day) ? "selected" : ""}
                aria-pressed={draft.days.includes(day)}
                aria-label={`${DAYS[day]}曜日`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    days: draft.days.includes(day)
                      ? draft.days.filter((d) => d !== day)
                      : [...draft.days, day],
                  })
                }
              >
                {DAYS[day]}
              </button>
            ))}
          </div>
          <p className="field-note">選択しない場合は毎日</p>
        </fieldset>
        <fieldset>
          <legend>ミッション</legend>
          <div className="mission-picker">
            {(Object.keys(MISSIONS) as MissionKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`mission-option ${draft.mission === kind ? "selected" : ""}`}
                aria-pressed={draft.mission === kind}
                onClick={() =>
                  setDraft({
                    ...draft,
                    mission: kind,
                    duration: MISSIONS[kind].defaultDuration,
                    repetitions: kind === "pushups" ? 5 : 1,
                  })
                }
              >
                <span className={`mission-icon ${MISSIONS[kind].color}`}>
                  <MissionIcon kind={kind} />
                </span>
                <span>{MISSIONS[kind].short}</span>
                {draft.mission === kind && (
                  <Check className="choice-check" size={14} />
                )}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="form-pair">
          <label className="field-label">
            制限時間
            <select
              value={draft.duration}
              onChange={(e) =>
                setDraft({ ...draft, duration: Number(e.target.value) })
              }
            >
              {[30, 60, 90, 120, 180, 300].map((s) => (
                <option value={s} key={s}>
                  {s < 60 ? `${s}秒` : `${s / 60}分`}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {draft.mission === "pushups" ? "回数" : "杯数"}
            <select
              value={draft.repetitions}
              onChange={(e) =>
                setDraft({ ...draft, repetitions: Number(e.target.value) })
              }
            >
              {(draft.mission === "pushups" ? [3, 5, 10, 15, 20] : [1]).map(
                (n) => (
                  <option value={n} key={n}>
                    {n}
                    {MISSIONS[draft.mission].unit}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <label className="settings-row">
          <span>
            スヌーズ
            <span className="subtext">ミッション達成後に使用できます</span>
          </span>
          <select
            aria-label="スヌーズ時間"
            value={draft.snoozeMinutes}
            onChange={(e) =>
              setDraft({ ...draft, snoozeMinutes: Number(e.target.value) })
            }
          >
            {[1, 3, 5, 10, 15].map((n) => (
              <option key={n} value={n}>
                {n}分
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-actions">
          {!isNew && (
            <button
              type="button"
              className="delete-button"
              aria-label="アラームを削除"
              disabled={busy}
              onClick={() => void run(() => onDelete(draft.id))}
            >
              <Trash2 size={20} />
            </button>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存する"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
