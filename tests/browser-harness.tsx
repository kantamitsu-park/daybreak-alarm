import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { FlickControl } from "../src/components/MissionScreen";
import { Modal } from "../src/components/Modal";
import "@fontsource-variable/dm-sans";
import "../src/styles.css";

/** A Vite-development-only component fixture. It never calls mission APIs. */
function BrowserHarness() {
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<"stop" | "snooze" | null>(null);
  const [count, setCount] = useState(0);
  const [modal, setModal] = useState(false);
  return (
    <main
      style={{
        maxWidth: 480,
        margin: "0 auto",
        minHeight: "100dvh",
        padding: "44px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 28,
      }}
    >
      <header>
        <h1 style={{ fontSize: 26, marginBottom: 12 }}>開発用操作テスト</h1>
        <p style={{ fontSize: 14, lineHeight: 1.7 }}>
          実際のフリック部品を使用するローカル開発用画面です。
          アラームの達成状態や本番データは変更しません。
        </p>
      </header>
      <div style={{ display: "grid", gap: 12 }}>
        <button
          type="button"
          className="secondary-button"
          aria-pressed={unlocked}
          onClick={() => setUnlocked((value) => !value)}
        >
          {unlocked ? "ロックする" : "ロックを解除"}
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-pressed={busy}
          onClick={() => setBusy((value) => !value)}
        >
          {busy ? "処理中を解除" : "処理中にする"}
        </button>
      </div>
      <FlickControl
        unlocked={unlocked}
        busy={busy}
        onResolve={(action) => {
          setLast(action);
          setCount((value) => value + 1);
        }}
      />
      <output
        role="status"
        aria-live="polite"
        aria-label="フリックの結果"
        className="glass"
        style={{ padding: 20, borderRadius: 20, fontSize: 18 }}
      >
        結果: <strong>{last ?? "未操作"}</strong> / 回数: {count}
      </output>
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          setLast(null);
          setCount(0);
        }}
      >
        結果をリセット
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => setModal(true)}
      >
        フォーカステストを開く
      </button>
      {modal && (
        <Modal title="フォーカスの循環" onClose={() => setModal(false)}>
          <div style={{ display: "grid", gap: 18 }}>
            <label className="field-label">
              入力欄
              <input className="text-input" defaultValue="テスト" />
            </label>
            <label className="field-label">
              選択欄
              <select defaultValue="one">
                <option value="one">選択肢 1</option>
                <option value="two">選択肢 2</option>
              </select>
            </label>
            <button
              type="button"
              className="primary-button"
              onClick={() => setModal(false)}
            >
              最後のボタン
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

const target = document.getElementById("root")!;
if (import.meta.env.DEV) {
  createRoot(target).render(
    <MotionConfig reducedMotion="user">
      <BrowserHarness />
    </MotionConfig>,
  );
} else {
  target.textContent = "この画面はローカル開発環境専用です。";
}
