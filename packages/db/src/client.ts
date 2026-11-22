/**
 * Database client factory for the GQSHOP core.
 *
 * Connection config comes from environment variables (12-factor):
 *   GQSHOP_DB_HOST / GQSHOP_DB_PORT / GQSHOP_DB_USER / GQSHOP_DB_PASSWORD / GQSHOP_DB_NAME
 */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema/index.js";

export type GqshopDb = NodePgDatabase<typeof schema>;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max?: number;
}

export interface DbHandle {
  db: GqshopDb;
  pool: pg.Pool;
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.GQSHOP_DB_HOST ?? "127.0.0.1",
    port: Number(env.GQSHOP_DB_PORT ?? 5432),
    user: env.GQSHOP_DB_USER ?? "postgres",
    password: env.GQSHOP_DB_PASSWORD ?? "",
    database: env.GQSHOP_DB_NAME ?? "gqshop",
    max: Number(env.GQSHOP_DB_POOL_MAX ?? 10),
  };
}

function newPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.max ?? 10,
  });
}

export function createDb(config: DbConfig): GqshopDb {
  return drizzle(newPool(config), { schema });
}

/** Preferred factory: exposes the raw pool for A1 atomic SQL (parameterized $n). */
export function createDbHandle(config: DbConfig): DbHandle {
  const pool = newPool(config);
  return { db: drizzle(pool, { schema }), pool };
}

export { schema };
