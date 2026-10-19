ALTER TABLE alarms ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo';
ALTER TABLE missions ADD COLUMN occurrence_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE missions ADD COLUMN snooze_until INTEGER;
CREATE INDEX missions_occurrence ON missions(user_id, alarm_id, occurrence_at);
CREATE INDEX missions_snooze ON missions(user_id, snooze_until);
