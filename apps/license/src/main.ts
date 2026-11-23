/**
 * GQSHOP 市场站服务入口（ADR-012 α）。
 * 独立于 core：自有库 gqshop_market、自有 JWT；发布物落 GQSHOP_MARKET_DIR（nginx /repo 静态分发不变）。
 * 配置全部来自 env（12-factor）：连接/密钥零硬编码。
 * 表结构由部署侧经 psql 应用 src/schema.sql（幂等）；本服务启动只探测不建表。
 */
import { serve } from "@hono/node-server";
import { Pool } from "pg";

import { createApp } from "./routes.ts";

const pool = new Pool({
  host: process.env.GQSHOP_MARKET_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.GQSHOP_MARKET_DB_PORT ?? 5432),
  user: process.env.GQSHOP_MARKET_DB_USER ?? "gqshop_market",
  password: process.env.GQSHOP_MARKET_DB_PASSWORD ?? "",
  database: process.env.GQSHOP_MARKET_DB_NAME ?? "gqshop_market",
  max: 5,
});

if (!process.env.GQSHOP_LICENSE_JWT_SECRET) {
  console.error("[license] FATAL: GQSHOP_LICENSE_JWT_SECRET not set");
  process.exit(1);
}

// 探测表结构是否已应用（缺表给明确指引，不静默崩溃循环）
try {
  await pool.query("SELECT 1 FROM market_account LIMIT 1");
} catch {
  console.error("[license] FATAL: market_account 表不存在——请先执行 psql -d gqshop_market -f apps/license/src/schema.sql");
  process.exit(1);
}

const app = createApp(pool);
const port = Number(process.env.GQSHOP_LICENSE_PORT ?? 8102);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`[license] market service listening :${port} (market dir: ${process.env.GQSHOP_MARKET_DIR ?? "./data/market"})`);
});
