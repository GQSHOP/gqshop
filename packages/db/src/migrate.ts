/**
 * Runs generated Drizzle migrations (packages/db/drizzle) — idempotent.
 * Called from apps/core before serving; safe to call repeatedly.
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { GqshopDb } from "./client.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export async function runMigrations(db: GqshopDb): Promise<void> {
  const journal = join(MIGRATIONS_DIR, "meta", "_journal.json");
  console.log(`[gqshop-db] migrations dir: ${MIGRATIONS_DIR} (journal exists: ${existsSync(journal)})`);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
