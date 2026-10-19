import type { Alarm, MissionSession, User } from "../shared/types";

export interface MediaBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(options: { width?: number; height?: number; fit?: string }): {
      output(options: { mode: "frame"; time: string; format: "jpg" }): {
        response(): Promise<Response>;
      };
    };
  };
}
export interface Env {
  DB?: D1Database;
  EVIDENCE?: R2Bucket;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  MEDIA?: MediaBinding;
  ASSETS?: Fetcher;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
export type AppEnv = { Bindings: Env; Variables: { user: User } };
export interface AlarmRow extends Omit<
  Alarm,
  "days" | "enabled" | "snoozeMinutes"
> {
  user_id: string;
  days: string;
  enabled: number;
  snooze_minutes: number;
  timezone: string;
}
export interface MissionRow {
  id: string;
  user_id: string;
  alarm_id: string;
  mission: Alarm["mission"];
  repetitions: number;
  created_at: number;
  deadline: number;
  challenge_fingers: number;
  challenge: string;
  status: MissionSession["status"];
  next_sequence: number;
  first_frame_at: number | null;
  last_frame_at: number | null;
  video_key: string | null;
  video_duration: number | null;
  video_hash: string | null;
  occurrence_at: number;
  snooze_until: number | null;
  resolved_at: number | null;
  snooze_minutes: number;
  verdict: string | null;
}
export interface FrameRow {
  mission_id: string;
  sequence: number;
  hash: string;
  received_at: number;
  object_key: string;
}
