import type { Env } from "./types";
import { error, MAX_VIDEO_BYTES, requireDatabase } from "./security";

const CHUNK_BYTES = 1024 * 1024;
export interface EvidenceObject {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface EvidenceStore {
  put(
    key: string,
    bytes: Uint8Array,
    options?: {
      httpMetadata?: { contentType: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<EvidenceObject | null>;
  delete(keys: string | string[]): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
}
/** Private short-lived evidence. Prefer R2 when enabled; D1 avoids requiring an R2 account. */
export function evidence(env: Env): EvidenceStore {
  if (env.EVIDENCE) return env.EVIDENCE;
  const db = requireDatabase(env);
  return {
    async put(key, bytes, options) {
      if (bytes.byteLength > MAX_VIDEO_BYTES)
        return error(413, "ファイルが大きすぎます。");
      // Keep incomplete uploads unreadable. Avoid batching large BLOBs: D1's
      // JSON encoding can otherwise amplify a whole video's memory footprint.
      await db
        .prepare(
          "INSERT INTO evidence_objects (object_key, content_type, size, created_at) VALUES (?, '', ?, ?)",
        )
        .bind(key, bytes.byteLength, Date.now())
        .run();
      try {
        for (
          let offset = 0, index = 0;
          offset < bytes.byteLength;
          offset += CHUNK_BYTES, index++
        ) {
          await db
            .prepare(
              "INSERT INTO evidence_chunks (object_key, chunk_index, data) VALUES (?, ?, ?)",
            )
            .bind(key, index, bytes.slice(offset, offset + CHUNK_BYTES))
            .run();
        }
        await db
          .prepare(
            "UPDATE evidence_objects SET content_type = ? WHERE object_key = ?",
          )
          .bind(
            options?.httpMetadata?.contentType || "application/octet-stream",
            key,
          )
          .run();
      } catch (cause) {
        await db
          .prepare("DELETE FROM evidence_objects WHERE object_key = ?")
          .bind(key)
          .run();
        throw cause;
      }
    },
    async get(key) {
      const meta = await db
        .prepare(
          "SELECT size FROM evidence_objects WHERE object_key = ? AND content_type != ''",
        )
        .bind(key)
        .first<{ size: number }>();
      if (!meta) return null;
      if (meta.size > MAX_VIDEO_BYTES || meta.size < 0)
        return error(503, "撮影データのサイズが正しくありません。");
      const chunkCount = Math.ceil(meta.size / CHUNK_BYTES);
      const readChunk = async (index: number) => {
        const row = await db
          .prepare(
            "SELECT data FROM evidence_chunks WHERE object_key = ? AND chunk_index = ?",
          )
          .bind(key, index)
          .first<{ data: number[] | ArrayBuffer | Uint8Array }>();
        if (!row) return error(503, "撮影データの一部が見つかりません。");
        return new Uint8Array(row.data as ArrayBuffer);
      };
      let index = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              if (index >= chunkCount) return controller.close();
              controller.enqueue(await readChunk(index++));
            } catch (cause) {
              controller.error(cause);
            }
          },
        },
        { highWaterMark: 0 },
      );
      return {
        body,
        async arrayBuffer() {
          const bytes = new Uint8Array(meta.size);
          let offset = 0;
          for (let n = 0; n < chunkCount; n++) {
            const chunk = await readChunk(n);
            if (offset + chunk.length > bytes.length)
              return error(503, "撮影データが正しくありません。");
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          if (offset !== bytes.length)
            return error(503, "撮影データが不足しています。");
          return bytes.buffer;
        },
      };
    },
    async delete(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      // FK ON DELETE CASCADE removes private BLOB chunks with their metadata.
      for (let i = 0; i < list.length; i += 50) {
        const group = list.slice(i, i + 50);
        await db
          .prepare(
            `DELETE FROM evidence_objects WHERE object_key IN (${group.map(() => "?").join(",")})`,
          )
          .bind(...group)
          .run();
      }
    },
    async list({ prefix, cursor, limit }) {
      const result = await db
        .prepare(
          "SELECT object_key, created_at FROM evidence_objects WHERE object_key >= ? AND object_key < ? AND object_key > ? ORDER BY object_key LIMIT ?",
        )
        .bind(prefix, `${prefix}\uffff`, cursor || "", limit + 1)
        .all<{ object_key: string; created_at: number }>();
      const rows = result.results.slice(0, limit);
      const truncated = result.results.length > limit;
      return {
        objects: rows.map((row) => ({
          key: row.object_key,
          uploaded: new Date(row.created_at),
        })),
        truncated,
        ...(truncated ? { cursor: rows.at(-1)!.object_key } : {}),
      };
    },
  };
}
