import { Coffee, Droplets, Dumbbell } from "lucide-react";
import type { MissionKind } from "../../shared/types";
export const MISSIONS = {
  water: {
    name: "水を飲む",
    short: "水",
    detail: "コップを持ち、水を飲むところを撮影",
    icon: Droplets,
    color: "blue",
    unit: "杯",
    defaultDuration: 60,
  },
  coffee: {
    name: "コーヒーを淹れる",
    short: "コーヒー",
    detail: "カップにコーヒーを注ぐところを撮影",
    icon: Coffee,
    color: "amber",
    unit: "杯",
    defaultDuration: 120,
  },
  pushups: {
    name: "腕立て伏せ",
    short: "腕立て伏せ",
    detail: "全身が映る位置から、動作を撮影",
    icon: Dumbbell,
    color: "sage",
    unit: "回",
    defaultDuration: 90,
  },
} as const;
export function MissionIcon({
  kind,
  size = 22,
}: {
  kind: MissionKind;
  size?: number;
}) {
  const Icon = MISSIONS[kind].icon;
  return <Icon size={size} strokeWidth={1.6} />;
}
