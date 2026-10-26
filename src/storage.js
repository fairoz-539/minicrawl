// Picks the storage backend.
//   STORAGE=sqlite   (default) one file, zero setup: DB_PATH, default minicrawl.db
//   STORAGE=postgres scale mode: DATABASE_URL; many API and worker processes share it
// Both return { kind, queue, store, ping(), exec(sql, ...params), close() } with the
// same async Queue / CrawlStore methods.
import { openSqliteStorage } from "./db.js";

export async function openStorage({ dbPath } = {}) {
  const kind = (process.env.STORAGE ?? "sqlite").toLowerCase();
  if (kind === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("STORAGE=postgres needs DATABASE_URL");
    const { openPostgresStorage } = await import("./db-postgres.js");
    // ":memory:" (used by tests) means a throwaway schema, dropped on close.
    return openPostgresStorage({ url: process.env.DATABASE_URL, ephemeral: dbPath === ":memory:" });
  }
  if (kind !== "sqlite") throw new Error(`Unknown STORAGE "${kind}": use sqlite or postgres`);
  return openSqliteStorage(dbPath ?? process.env.DB_PATH ?? "minicrawl.db");
}
