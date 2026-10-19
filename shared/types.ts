export type MissionKind = "water" | "coffee" | "pushups";
export interface Alarm {
  id: string;
  time: string;
  label: string;
  days: number[];
  enabled: boolean;
  mission: MissionKind;
  duration: number;
  repetitions: number;
  snoozeMinutes: number;
}
export interface User {
  id: string;
  name: string;
  email: string;
  picture?: string;
}
export interface MissionSession {
  id: string;
  alarmId: string;
  mission: MissionKind;
  deadline: number;
  challenge: string;
  challengeFingers: number;
  snoozeUntil?: number;
  status:
    | "pending"
    | "recording"
    | "verifying"
    | "passed"
    | "failed"
    | "expired"
    | "stopped"
    | "snoozed";
}
export interface HistoryEntry {
  id: string;
  mission: MissionKind;
  completedAt: number;
  status: "passed" | "failed" | "snoozed" | "stopped";
}
export interface AppConfig {
  googleClientId: string | null;
  aiConfigured: boolean;
  storageConfigured: boolean;
}
