import type {
  AppConfig,
  User,
  Alarm,
  MissionSession,
  HistoryEntry,
} from "../../shared/types";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(120000),
    ...options,
    headers: {
      "X-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(options.body instanceof Blob
        ? { "Content-Type": options.body.type }
        : options.body
          ? { "Content-Type": "application/json" }
          : {}),
      ...options.headers,
    },
  });
  const data: any = await response.json().catch(() => ({
    error: "サーバーに接続できません。もう一度お試しください。",
  }));
  if (!response.ok)
    throw new ApiError(
      data.error || "処理を完了できませんでした。",
      response.status,
    );
  return data as T;
}
export const api = {
  config: () =>
    request<AppConfig>("/api/config", { signal: AbortSignal.timeout(8000) }),
  me: () => request<User>("/api/me", { signal: AbortSignal.timeout(8000) }),
  alarms: () => request<Alarm[]>("/api/alarms"),
  history: () => request<HistoryEntry[]>("/api/history"),
  saveAlarm: (alarm: Alarm, isNew: boolean) => {
    const { id, ...body } = alarm;
    return request<Alarm>(isNew ? "/api/alarms" : `/api/alarms/${id}`, {
      method: isNew ? "POST" : "PATCH",
      body: JSON.stringify(body),
    });
  },
  removeAlarm: (id: string) =>
    request(`/api/alarms/${id}`, { method: "DELETE" }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  snoozes: () =>
    request<{ alarmId: string; snoozeUntil: number }[]>(
      "/api/missions/snoozes",
    ),
  status: (id: string) =>
    request<MissionSession & { reason?: string }>(`/api/missions/${id}`),
  active: () => request<MissionSession | null>("/api/missions/active"),
  abort: (id: string) =>
    request(`/api/missions/${id}/abort`, { method: "POST" }),
  start: (alarmId: string, retry = false) =>
    request<MissionSession>("/api/missions", {
      method: "POST",
      body: JSON.stringify({ alarmId, ...(retry ? { retry: true } : {}) }),
    }),
  frame: async (id: string, blob: Blob, sequence: number) => {
    const image = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return request(`/api/missions/${id}/frames`, {
      method: "POST",
      body: JSON.stringify({ sequence, image }),
    });
  },
  video: (id: string, blob: Blob, durationMs: number) =>
    request(`/api/missions/${id}/video`, {
      method: "POST",
      body: blob,
      headers: { "X-Recording-Duration": String(durationMs) },
    }),
  verify: (id: string) =>
    request<{ status: "passed" | "failed"; reason: string }>(
      `/api/missions/${id}/verify`,
      { method: "POST" },
    ),
  resolve: (id: string, action: "stop" | "snooze") =>
    request<{ status: "stopped" | "snoozed"; snoozeUntil?: number }>(
      `/api/missions/${id}/resolve`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),
};
