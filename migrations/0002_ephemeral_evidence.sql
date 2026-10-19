-- Private, transient fallback when R2 is not enabled. Never exposed by a download route.
-- 1 MiB chunks remain below D1's 2 MB row limit. Deleted after verdict or by the cleanup cron.
CREATE TABLE evidence_objects (object_key TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 25165824), created_at INTEGER NOT NULL);
CREATE INDEX evidence_objects_expiry ON evidence_objects(created_at);
CREATE TABLE evidence_chunks (object_key TEXT NOT NULL REFERENCES evidence_objects(object_key) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(object_key, chunk_index));
