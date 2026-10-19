import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlarmClock,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  History,
  LogOut,
  Moon,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import type {
  Alarm,
  AppConfig,
  HistoryEntry,
  MissionKind,
  MissionSession,
  User,
} from "../shared/types";
import { api, ApiError } from "./lib/api";
import {
  DEFAULT_ALARMS,
  createDueAlarmResolver,
  formatWeekdays,
  getNextAlarm,
  loadAlarms,
  saveAlarms,
} from "./lib/alarm";
import { AlarmAudio } from "./lib/audio";
import AlarmEditor from "./components/AlarmEditor";
import MissionScreen from "./components/MissionScreen";
import { Modal } from "./components/Modal";
import { MISSIONS, MissionIcon } from "./components/icons";
type Tab = "alarms" | "missions" | "history" | "settings";
const TABS = [
  { id: "alarms", title: "アラーム", icon: AlarmClock },
  { id: "missions", title: "ミッション", icon: Sparkles },
  { id: "history", title: "記録", icon: History },
  { id: "settings", title: "設定", icon: SlidersHorizontal },
] as const;
function Skeleton() {
  return (
    <div className="skeleton-screen" role="status" aria-label="読み込み中">
      <div className="skeleton-header">
        <div className="skeleton sk-logo" />
        <div className="skeleton sk-avatar" />
      </div>
      <div className="skeleton sk-heading" />
      <div className="skeleton-grid">
        <div className="skeleton sk-hero" />
        <div className="skeleton-stack">
          {[1, 2, 3].map((n) => (
            <div key={n} className="skeleton sk-row" />
          ))}
        </div>
      </div>
      <div className="skeleton sk-nav" />
      <span className="sr-only">アラームを読み込んでいます</span>
    </div>
  );
}
function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.4 3-7.4Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 5-1 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.9A6 6 0 0 1 6 12c0-.7.1-1.3.4-1.9V7.5H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.5l3.3-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.8A9.5 9.5 0 0 0 12 2a10 10 0 0 0-8.9 5.5l3.3 2.6C7.2 7.7 9.4 5.9 12 5.9Z"
      />
    </svg>
  );
}
export default function App() {
  const [loaded, setLoaded] = useState(false),
    [alarms, setAlarms] = useState<Alarm[]>(() => loadAlarms()),
    [tab, setTab] = useState<Tab>("alarms"),
    [user, setUser] = useState<User | null>(null),
    [config, setConfig] = useState<AppConfig | null>(null),
    [editor, setEditor] = useState<{ alarm: Alarm; isNew: boolean } | null>(
      null,
    ),
    [login, setLogin] = useState(false),
    [help, setHelp] = useState(false),
    [toast, setToast] = useState(""),
    [history, setHistory] = useState<HistoryEntry[]>([]),
    [sleeping, setSleeping] = useState(false),
    [wakeLocked, setWakeLocked] = useState(false),
    [active, setActive] = useState<{
      alarm: Alarm;
      preview: boolean;
      session?: MissionSession;
    } | null>(null),
    [now, setNow] = useState(new Date()),
    [volume, setVolume] = useState(0.65),
    [pendingIds, setPendingIds] = useState<string[]>([]);
  const audio = useRef<AlarmAudio | null>(null),
    alarmsRef = useRef(alarms),
    activeRef = useRef(active),
    armed = useRef(false),
    snoozes = useRef<Map<string, number>>(new Map()),
    queue = useRef<{ alarm: Alarm; at: Date }[]>([]),
    lock = useRef<WakeLockSentinel | null>(null),
    due = useRef(createDueAlarmResolver());
  alarmsRef.current = alarms;
  activeRef.current = active;
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    let stopped = false;
    const boot = async () => {
      const minimum = new Promise((r) => setTimeout(r, 650));
      const [settings, account] = await Promise.allSettled([
        api.config(),
        api.me(),
      ]);
      if (stopped) return;
      if (settings.status === "fulfilled") setConfig(settings.value);
      if (account.status === "fulfilled") {
        setUser(account.value);
        const [saved, records] = await Promise.allSettled([
          api.alarms(),
          api.history(),
        ]);
        if (stopped) return;
        if (saved.status === "fulfilled") setAlarms(saved.value);
        else
          notify(
            "アラームを取得できませんでした。ページを再読み込みしてください。",
          );
        if (records.status === "fulfilled") setHistory(records.value);
        if (saved.status === "fulfilled") {
          try {
            const savedSnoozes = await api.snoozes();
            for (const item of savedSnoozes)
              snoozes.current.set(item.alarmId, item.snoozeUntil);
            const mission = await api.active();
            const alarm =
              mission && saved.value.find((a) => a.id === mission.alarmId);
            if (mission && alarm && !stopped)
              setActive({ alarm, preview: false, session: mission });
          } catch {
            /* Keep saved alarms available when recovery cannot connect. */
          }
        }
      }
      await minimum;
      if (!stopped) setLoaded(true);
    };
    void boot();
    return () => {
      stopped = true;
    };
  }, [notify]);

  useEffect(() => {
    audio.current = new AlarmAudio();
    return () => {
      void audio.current?.dispose();
      lock.current?.release();
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const date = new Date();
      setNow(date);
      if (!armed.current || activeRef.current) return;
      queue.current.push(...due.current(alarmsRef.current, date));
      for (const [id, at] of snoozes.current) {
        if (at <= date.getTime()) {
          const alarm = alarmsRef.current.find((a) => a.id === id);
          if (alarm && date.getTime() - at < 300000)
            queue.current.push({ alarm, at: new Date(at) });
          snoozes.current.delete(id);
        }
      }
      queue.current = queue.current.filter(
        (item) => date.getTime() - item.at.getTime() < 300000,
      );
      const trigger = queue.current.shift()?.alarm;
      if (trigger) {
        setSleeping(false);
        setActive({ alarm: trigger, preview: false });
        try {
          audio.current?.start(volume);
        } catch {
          notify(
            "音声が停止されています。画面をタップして音声を有効にしてください。",
          );
        }
        navigator.vibrate?.([200, 100, 200]);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [volume]);
  const setAlarmVolume = useCallback(
    (n: number) => audio.current?.setVolume(n * volume),
    [volume],
  );
  const next = getNextAlarm(alarms, now);
  const nextAlarm = next?.alarm;
  const nextLabel = next
    ? `${next.at.getDate() === now.getDate() ? "今日" : next.at.getDate() === new Date(now.getTime() + 86400000).getDate() ? "明日" : next.at.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} ${formatWeekdays(next.alarm.days)}`
    : "アラームを追加";
  const delay = next
    ? Math.max(0, Math.round((next.at.getTime() - now.getTime()) / 60000))
    : 0;
  function addAlarm(kind: MissionKind = "water") {
    setEditor({
      isNew: true,
      alarm: {
        id: crypto.randomUUID(),
        time: "07:00",
        label: "",
        days: [1, 2, 3, 4, 5],
        mission: kind,
        enabled: true,
        duration: MISSIONS[kind].defaultDuration,
        repetitions: kind === "pushups" ? 5 : 1,
        snoozeMinutes: 5,
      },
    });
  }
  async function save(alarm: Alarm, isNew: boolean) {
    const value = user ? await api.saveAlarm(alarm, isNew) : alarm;
    const updated = isNew
      ? [...alarmsRef.current, value]
      : alarmsRef.current.map((a) => (a.id === value.id ? value : a));
    if (!user && !saveAlarms(updated))
      throw new Error(
        "この端末に保存できません。ブラウザの保存領域を確認してください。",
      );
    setAlarms(updated);
    notify(user ? "アラームを保存しました" : "この端末に保存しました");
  }
  async function toggle(alarm: Alarm) {
    if (pendingIds.includes(alarm.id)) return;
    setPendingIds((ids) => [...ids, alarm.id]);
    try {
      await save({ ...alarm, enabled: !alarm.enabled }, false);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPendingIds((ids) => ids.filter((id) => id !== alarm.id));
    }
  }
  async function remove(id: string) {
    if (user) await api.removeAlarm(id);
    const updated = alarmsRef.current.filter((a) => a.id !== id);
    if (!user && !saveAlarms(updated))
      throw new Error("この端末に保存できません。");
    setAlarms(updated);
    notify("アラームを削除しました");
  }
  async function sleep() {
    if (!next) {
      notify("有効なアラームを追加してください");
      return;
    }
    if (!user) {
      setLogin(true);
      return;
    }
    if (!config?.aiConfigured || !config.storageConfigured) {
      notify(
        "動画判定の接続設定が完了していません。設定画面を確認してください。",
      );
      return;
    }
    try {
      await audio.current?.arm();
      armed.current = true;
      due.current = createDueAlarmResolver();
      if ("wakeLock" in navigator) {
        try {
          lock.current = await navigator.wakeLock.request("screen");
          setWakeLocked(true);
          lock.current.addEventListener("release", () => setWakeLocked(false));
        } catch {
          setWakeLocked(false);
        }
      }
      setSleeping(true);
    } catch {
      notify("音声を開始できませんでした。もう一度操作してください。");
    }
  }
  function leaveSleep() {
    setSleeping(false);
    armed.current = false;
    void lock.current?.release();
    setWakeLocked(false);
  }
  async function preview(alarm: Alarm) {
    await audio.current?.arm().catch(() => {});
    setActive({ alarm, preview: true });
  }
  function resolved(action: "stop" | "snooze", until?: number) {
    audio.current?.stop();
    if (action === "snooze" && active && until) {
      snoozes.current.set(active.alarm.id, until);
      notify(`${active.alarm.snoozeMinutes}分後に再び鳴ります`);
    } else notify("アラームを停止しました");
    setActive(null);
    if (user)
      void api
        .history()
        .then(setHistory)
        .catch(() => {});
  }
  async function logout() {
    try {
      await api.logout();
      setUser(null);
      setAlarms(loadAlarms());
      setHistory([]);
      armed.current = false;
      notify("ログアウトしました");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <>
      <div className="ambient" aria-hidden="true">
        <span />
        <span />
      </div>
      <AnimatePresence>
        {!loaded && (
          <motion.div
            key="skeleton"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Skeleton />
          </motion.div>
        )}
      </AnimatePresence>
      <main
        className={`app ${loaded ? "ready" : ""}`}
        aria-hidden={!loaded}
        inert={!loaded || !!active || sleeping || !!editor || login || help}
      >
        <header className="app-header">
          <a className="brand" href="/" aria-label="Daybreak ホーム">
            <span className="brand-mark">
              <Sun size={20} strokeWidth={1.7} />
            </span>
            <span>
              daybreak<span className="brand-dot">.</span>
            </span>
          </a>
          <div className="header-right">
            <time>
              {now.toLocaleDateString("ja-JP", {
                month: "long",
                day: "numeric",
                weekday: "short",
              })}
            </time>
            <button
              className="avatar glass"
              aria-label={user ? "アカウント設定" : "Googleでログイン"}
              onClick={() => (user ? setTab("settings") : setLogin(true))}
            >
              {user ? user.name.slice(0, 1) : <UserRound size={19} />}
            </button>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <p className="small-context">
              {tab === "alarms"
                ? "アラーム設定"
                : tab === "missions"
                  ? "ミッション設定"
                  : tab === "history"
                    ? "ミッションの履歴"
                    : "アプリの設定"}
            </p>
            <h1>
              {TABS.find((t) => t.id === tab)?.title}
              <span className="heading-dot" />
            </h1>
          </div>
          {tab === "alarms" ? (
            <button
              className="add-button glass"
              aria-label="アラームを追加"
              onClick={() => addAlarm()}
            >
              <Plus size={19} />
              <span>アラームを追加</span>
            </button>
          ) : (
            <span className="page-count">
              {tab === "missions"
                ? "3種類"
                : tab === "history"
                  ? `${history.length}件`
                  : ""}
            </span>
          )}
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 9 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22 }}
          >
            {tab === "alarms" && (
              <>
                <div className="dashboard-grid">
                  <section className="next-card glass">
                    <div className="card-topline">
                      <span>
                        <span className="status-dot" />
                        次のアラーム
                      </span>
                      <span className="time-until">
                        {next
                          ? `${Math.floor(delay / 60)}時間${delay % 60}分後`
                          : "未設定"}
                      </span>
                    </div>
                    <div className="clock-face">
                      <div className="clock-ring ring-outer" />
                      <div className="clock-ring ring-inner" />
                      <div className="clock-ticks" />
                      <div className="clock-sun" />
                      <div className="clock-display">
                        <span className="clock-date">{nextLabel}</span>
                        <span className="clock-time">
                          {nextAlarm?.time ?? "--:--"}
                        </span>
                        <span className="clock-label">
                          {nextAlarm?.label || "朝のアラーム"}
                        </span>
                      </div>
                      <span className="clock-orbit-dot" />
                    </div>
                    <div className="next-mission">
                      <span
                        className={`mission-icon ${MISSIONS[nextAlarm?.mission ?? "water"].color}`}
                      >
                        <MissionIcon kind={nextAlarm?.mission ?? "water"} />
                      </span>
                      <div>
                        <span className="next-mission-label">
                          起きたらすぐに
                        </span>
                        <strong>
                          {nextAlarm
                            ? MISSIONS[nextAlarm.mission].name
                            : "ミッションを選ぶ"}
                        </strong>
                      </div>
                      <span className="duration-pill">
                        {nextAlarm?.duration ?? 60}秒
                      </span>
                    </div>
                    <button
                      className="sleep-button"
                      onClick={() => void sleep()}
                    >
                      <Moon size={18} />
                      <span>就寝モード</span>
                      <ChevronRight size={17} />
                    </button>
                  </section>
                  <section className="alarm-list-section">
                    <div className="section-heading">
                      <h2>
                        マイアラーム{" "}
                        <span>{alarms.length.toString().padStart(2, "0")}</span>
                      </h2>
                      <button
                        className="text-icon-button"
                        onClick={() => setHelp(true)}
                        aria-label="アラームについて"
                      >
                        <CircleHelp size={18} />
                      </button>
                    </div>
                    <div className="alarm-list">
                      {alarms.map((alarm) => (
                        <motion.article
                          layout
                          key={alarm.id}
                          className={`alarm-card glass ${alarm.enabled ? "" : "disabled"}`}
                        >
                          <button
                            className="alarm-edit"
                            onClick={() => setEditor({ alarm, isNew: false })}
                            aria-label={`${alarm.time} ${alarm.label || "アラーム"}を編集`}
                          >
                            <span className="alarm-time">
                              {alarm.time}
                              <span>{alarm.label}</span>
                            </span>
                            <span className="alarm-days">
                              {formatWeekdays(alarm.days)}
                            </span>
                          </button>
                          <button
                            className={`toggle ${alarm.enabled ? "on" : ""}`}
                            role="switch"
                            aria-label={`${alarm.time}のアラーム`}
                            aria-checked={alarm.enabled}
                            disabled={pendingIds.includes(alarm.id)}
                            onClick={() => void toggle(alarm)}
                          >
                            <motion.span
                              layout
                              transition={{
                                type: "spring",
                                stiffness: 600,
                                damping: 35,
                              }}
                            />
                          </button>
                          <div className="alarm-card-footer">
                            <span>
                              <MissionIcon kind={alarm.mission} size={15} />
                              {MISSIONS[alarm.mission].name}
                            </span>
                            <span>
                              {alarm.duration}秒 <ChevronRight size={14} />
                            </span>
                          </div>
                        </motion.article>
                      ))}
                    </div>
                    {alarms.length === 0 && (
                      <div className="empty-state glass">
                        <AlarmClock size={35} />
                        <h3>アラームはありません</h3>
                        <button
                          className="text-button"
                          onClick={() => addAlarm()}
                        >
                          最初のアラームを追加
                        </button>
                      </div>
                    )}
                    <button
                      className="preview-button"
                      onClick={() =>
                        void preview(nextAlarm ?? DEFAULT_ALARMS[0])
                      }
                    >
                      <span className="preview-icon">
                        <Bell size={17} />
                      </span>
                      <span>
                        アラームを試す
                        <small>ミッションとフリック操作を確認</small>
                      </span>
                      <ArrowUpRight size={18} />
                    </button>
                  </section>
                </div>
                <section className="mission-strip">
                  <div>
                    <ShieldCheck size={18} />
                    <span>ミッション達成で、アラームを解除</span>
                  </div>
                  <button onClick={() => setTab("missions")}>
                    ミッションを見る
                    <ChevronRight size={15} />
                  </button>
                </section>
              </>
            )}
            {tab === "missions" && (
              <div className="mission-library">
                {(Object.keys(MISSIONS) as MissionKind[]).map((kind, i) => (
                  <article
                    className={`library-card glass ${MISSIONS[kind].color}`}
                    key={kind}
                  >
                    <div className={`mission-art art-${kind}`}>
                      <span />
                      <MissionIcon kind={kind} size={64} />
                    </div>
                    <div className="library-card-content">
                      <span className="library-index">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h2>{MISSIONS[kind].name}</h2>
                      <p>{MISSIONS[kind].detail}</p>
                      <div className="library-meta">
                        <span>
                          <Clock3 size={14} />
                          {MISSIONS[kind].defaultDuration}秒
                        </span>
                        <span>
                          <ShieldCheck size={14} />
                          動画で確認
                        </span>
                      </div>
                      <button
                        className="secondary-button"
                        onClick={() => addAlarm(kind)}
                      >
                        <Plus size={17} />
                        このミッションで追加
                      </button>
                    </div>
                  </article>
                ))}
                <div className="mission-explanation">
                  <ShieldCheck size={23} />
                  <div>
                    <h3>撮影した動画で達成を確認</h3>
                    <p>
                      その場で表示される動作の指示に従って撮影します。確認が終わると、停止とスヌーズのフリックが使えるようになります。
                    </p>
                  </div>
                </div>
              </div>
            )}
            {tab === "history" && (
              <section className="history-panel glass">
                {history.length ? (
                  history.map((entry) => (
                    <div className="history-row" key={entry.id}>
                      <span
                        className={`mission-icon ${MISSIONS[entry.mission].color}`}
                      >
                        <MissionIcon kind={entry.mission} />
                      </span>
                      <div>
                        <strong>{MISSIONS[entry.mission].name}</strong>
                        <span>
                          {new Date(entry.completedAt).toLocaleString("ja-JP", {
                            month: "long",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <span
                        className={`history-status ${entry.status === "failed" ? "failed" : ""}`}
                      >
                        {entry.status === "failed"
                          ? "未達成"
                          : entry.status === "snoozed"
                            ? "スヌーズ"
                            : "達成"}
                        {entry.status !== "failed" && <Check size={14} />}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <div className="empty-orbit">
                      <History size={33} strokeWidth={1.3} />
                    </div>
                    <h2>まだ記録がありません</h2>
                    <p>ミッションの結果がここに残ります。</p>
                    {!user && (
                      <button
                        className="secondary-button"
                        onClick={() => setLogin(true)}
                      >
                        Googleでログイン
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
            {tab === "settings" && (
              <div className="settings-layout">
                <section className="settings-panel glass">
                  <h2>アカウント</h2>
                  <div className="account-row">
                    <span className="account-avatar">
                      <UserRound size={24} />
                    </span>
                    <div>
                      <strong>{user?.name ?? "ログインしていません"}</strong>
                      <span>
                        {user?.email ?? "Googleアカウントでアラームを同期"}
                      </span>
                    </div>
                  </div>
                  {user ? (
                    <button
                      className="secondary-button"
                      onClick={() => void logout()}
                    >
                      <LogOut size={17} />
                      ログアウト
                    </button>
                  ) : (
                    <button
                      className="google-button"
                      onClick={() => setLogin(true)}
                    >
                      <GoogleLogo />
                      Googleでログイン
                    </button>
                  )}
                </section>
                <section className="settings-panel glass">
                  <h2>サウンド</h2>
                  <label className="volume-row">
                    <Volume2 size={20} />
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={volume}
                      aria-label="アラーム音量"
                      onChange={(e) => setVolume(Number(e.target.value))}
                    />
                    <span>{Math.round(volume * 100)}%</span>
                  </label>
                  <button
                    className="text-button"
                    onClick={async () => {
                      await audio.current?.arm();
                      audio.current?.start(volume);
                      setTimeout(() => audio.current?.stop(), 1600);
                    }}
                  >
                    サウンドを確認
                  </button>
                </section>
                <section className="settings-panel glass">
                  <h2>接続状況</h2>
                  <div className="connection-row">
                    <span>Google認証</span>
                    <span
                      className={
                        config?.googleClientId ? "connected" : "not-connected"
                      }
                    >
                      {config?.googleClientId ? "設定済み" : "設定待ち"}
                    </span>
                  </div>
                  <div className="connection-row">
                    <span>動画の達成判定</span>
                    <span
                      className={
                        config?.aiConfigured ? "connected" : "not-connected"
                      }
                    >
                      {config?.aiConfigured ? "設定済み" : "設定待ち"}
                    </span>
                  </div>
                  <div className="connection-row">
                    <span>データ保存</span>
                    <span
                      className={
                        config?.storageConfigured
                          ? "connected"
                          : "not-connected"
                      }
                    >
                      {config?.storageConfigured ? "設定済み" : "設定待ち"}
                    </span>
                  </div>
                </section>
                <section className="settings-panel glass usage-note">
                  <h2>使用前に</h2>
                  <p>
                    就寝モード中は画面を開いたまま、充電しながらお使いください。スマホのロック中やアプリ終了後の鳴動は保証されません。
                  </p>
                  <p>
                    カメラの動画は判定のためだけに使用し、判定後に通常の保存領域から削除します。クラウドの復旧用バックアップには一定期間残る場合があります。ごまかしを抑止する仕組みですが、誤判定や不正を完全に防ぐことはできません。
                  </p>
                  <button className="text-button" onClick={() => setHelp(true)}>
                    使い方と制限を見る <ChevronRight size={15} />
                  </button>
                </section>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        <footer className="page-footer">
          <span>Daybreak</span>
          <span>
            {user ? "アカウントに保存" : "この端末に保存"}
            <span className="footer-dot" />
          </span>
        </footer>
      </main>
      <nav
        inert={!loaded || !!active || sleeping || !!editor || login || help}
        className="bottom-nav glass"
        aria-label="メインナビゲーション"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
            aria-label={item.title}
            aria-current={tab === item.id ? "page" : undefined}
          >
            {tab === item.id && (
              <motion.span
                className="nav-highlight"
                layoutId="nav-highlight"
                transition={{ type: "spring", damping: 30, stiffness: 400 }}
              />
            )}
            <item.icon size={21} strokeWidth={1.7} />
            <span>{item.title}</span>
          </button>
        ))}
      </nav>
      <AnimatePresence>
        {editor && (
          <AlarmEditor
            key={editor.alarm.id}
            {...editor}
            onClose={() => setEditor(null)}
            onSave={(a) => save(a, editor.isNew)}
            onDelete={remove}
          />
        )}{" "}
        {login && (
          <Modal title="Googleでログイン" onClose={() => setLogin(false)}>
            <div className="login-content">
              <div className="login-mark">
                <Sun size={35} strokeWidth={1.4} />
              </div>
              <p>
                アラームとミッションの記録を
                <br />
                Googleアカウントに保存します。
              </p>
              {config?.googleClientId ? (
                <a className="google-button" href="/api/auth/google">
                  <GoogleLogo />
                  Googleで続ける
                </a>
              ) : (
                <>
                  <button className="google-button" disabled>
                    <GoogleLogo />
                    Googleで続ける
                  </button>
                  <p className="setup-note">
                    Google認証の接続設定を準備中です。
                    <br />
                    アラームの編集とプレビューは使用できます。
                  </p>
                </>
              )}
              <span className="login-footnote">
                ログイン方法はGoogleのみです
              </span>
            </div>
          </Modal>
        )}
        {help && (
          <Modal title="アラームの使い方" onClose={() => setHelp(false)}>
            <div className="help-content">
              <ol>
                <li>
                  <strong>アラームとミッションを設定</strong>
                  <p>水・コーヒー・腕立て伏せから選びます。</p>
                </li>
                <li>
                  <strong>就寝モードを開始</strong>
                  <p>
                    音声を有効にして、画面を開いたままにします。ロック中やブラウザ終了後の鳴動は保証されません。
                  </p>
                </li>
                <li>
                  <strong>アラームと同時にミッション開始</strong>
                  <p>動作の指示に従い、制限時間内に撮影します。</p>
                </li>
                <li>
                  <strong>達成後にフリック</strong>
                  <p>
                    右で停止、左でスヌーズ。スヌーズ後も新しいミッションが必要です。
                  </p>
                </li>
              </ol>
              <p className="setup-note">
                判定にはインターネット接続が必要です。通信障害や判定エラーの場合は解除されません。緊急時はブラウザを閉じてください。
              </p>
            </div>
          </Modal>
        )}
        {sleeping && (
          <motion.div
            className="sleep-screen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button
              className="icon-button"
              onClick={leaveSleep}
              aria-label="就寝モードを終了"
            >
              <X size={22} />
            </button>
            <Moon size={30} strokeWidth={1.2} />
            <span className="sleep-caption">就寝モード</span>
            <time>
              {now.toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <div className="sleep-next glass">
              <AlarmClock size={19} />
              <span>{nextAlarm?.time}</span>
              <span>{nextAlarm && MISSIONS[nextAlarm.mission].name}</span>
            </div>
            <span className="wake-status">
              <span className={wakeLocked ? "status-dot" : "warning-dot"} />
              {wakeLocked
                ? "画面の自動消灯を防いでいます"
                : "画面を開いたままにしてください"}
            </span>
            <p>充電しながら、画面を開いたままお使いください。</p>
          </motion.div>
        )}
        {active && (
          <MissionScreen
            alarm={active.alarm}
            preview={active.preview}
            initialSession={active.session}
            onClose={() => {
              audio.current?.stop();
              setActive(null);
            }}
            onResolved={resolved}
            onVolume={setAlarmVolume}
          />
        )}{" "}
        {toast && (
          <motion.div
            className="toast glass"
            role="status"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
          >
            <Check size={17} />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
