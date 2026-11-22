/**
 * GQSHOP core entrypoint. Config strictly from env (12-factor); no secrets in code.
 * Boot order: connect DB -> run migrations (idempotent) -> serve.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDbHandle, dbConfigFromEnv, runMigrations } from "@gqshop/db";

import { createApp } from "./index.js";
import { seedMemberships } from "./memberships.js";
import { seedStationLevels } from "./station.js";
import { seedAdminGroups } from "./admin-groups.js";
import { loadPlugins } from "./lib/plugin-host.js";
import { scanTemplates, serveTemplate } from "./lib/templates.js";
import { startJobs } from "./jobs.js";

async function main(): Promise<void> {
  const { db, pool } = createDbHandle(dbConfigFromEnv());
  const jwtSecret = process.env.GQSHOP_JWT_SECRET;
  const adminKey = process.env.GQSHOP_ADMIN_KEY;
  if (!jwtSecret || !adminKey) {
    console.error("[gqshop-core] FATAL: GQSHOP_JWT_SECRET / GQSHOP_ADMIN_KEY not set");
    process.exit(1);
  }

  await runMigrations(db);
  await seedMemberships(pool);
  await seedStationLevels(pool);
  await seedAdminGroups(pool);
  await loadPlugins(pool);
  console.log("[gqshop-core] migrations applied + seeds + plugins loaded");

  const app = createApp(db, jwtSecret, pool, adminKey);
  const port = Number(process.env.GQSHOP_PORT ?? 8100);

  // user center at /user — register BEFORE storefront catch-all
  const userRoot = process.env.GQSHOP_USER_STATIC_DIR;
  if (userRoot && existsSync(resolve(userRoot, 'index.html'))) {
    app.get('/user', (c) => c.redirect('/user/', 301));
    app.get('/user/*', serveStatic({ root: userRoot, rewriteRequestPath: (p) => p.replace(/^\/user/, '') }));
    app.get('/user/*', serveStatic({ root: userRoot, rewriteRequestPath: () => '/index.html' }));
    console.log(`[gqshop-core] serving user center from ${userRoot}`);
  }

  // admin console at /admin — MUST register BEFORE the storefront catch-all
  const adminRoot = process.env.GQSHOP_ADMIN_STATIC_DIR;
  if (adminRoot && existsSync(resolve(adminRoot, "index.html"))) {
    app.get("/admin", (c) => c.redirect("/admin/", 301));
    app.get("/admin/*", serveStatic({ root: adminRoot, rewriteRequestPath: (p) => p.replace(/^\/admin/, "") }));
    app.get("/admin/*", serveStatic({ root: adminRoot, rewriteRequestPath: () => "/index.html" }));
    console.log(`[gqshop-core] serving admin console from ${adminRoot}`);
  }

  // storefront static hosting — after all API + admin routes.
  // M5-β：模板注册表优先（templates/{name}/dist，选择链 station_plugin > front_default > default）；
  // 未配置/扫描为空时回落旧 GQSHOP_STATIC_DIR 单模板模式。
  // Cache-Control: no-cache（协商缓存 304）——M4 收尾踩坑：构建产物偶发同名不同内容
  // （content hash 撞名），强缓存会让老访客 stuck 旧资源；发卡站流量下协商代价可忽略
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/assets/") || c.req.path.startsWith("/dcskin/") || c.req.path.startsWith("/uploads/")) {
      await next();
      c.res.headers.set("Cache-Control", "no-cache");
      return;
    }
    await next();
  });
  const reg = scanTemplates();
  if (reg) {
    // 挂在 stationMiddleware 之后（/s/* 与 /v1/shop/* 已解析 station），serveTemplate 内读 c.var.station
    app.get("*", (c) => serveTemplate(c));
    console.log(`[gqshop-core] templates root=${reg.root} registered=[${[...reg.templates.keys()].join(", ")}]`);
  }
  const staticRoot = process.env.GQSHOP_STATIC_DIR;
  if (!reg && staticRoot && existsSync(resolve(staticRoot, "index.html"))) {
    app.get("*", serveStatic({ root: staticRoot }));
    app.get("*", serveStatic({ root: staticRoot, rewriteRequestPath: () => "/index.html" }));
    console.log(`[gqshop-core] serving storefront (single-template fallback) from ${staticRoot}`);
  } else {
    console.log("[gqshop-core] storefront static dir not set; API-only mode");
  }

  startJobs(pool);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[gqshop-core] listening on http://${info.address}:${info.port} (pid ${process.pid})`);
  });
}

await main();

