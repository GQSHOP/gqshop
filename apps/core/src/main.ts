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
import { seedAdminGroups, loadPlugins, scanTemplates, serveTemplate, bus } from "@gqshop/kernel";
import { seedMemberships, registerDomainHooks as membersHooks, startMembersJobs } from "@gqshop/domain-members";
import { seedStationLevels, registerDomainHooks as stationHooks } from "@gqshop/domain-station";
import { startJobs } from "@gqshop/domain-trade";
import { registerDomainHooks as contentHooks } from "@gqshop/domain-content";

async function main(): Promise<void> {
  const { db, pool } = createDbHandle(dbConfigFromEnv());
  const jwtSecret = process.env.GQSHOP_JWT_SECRET;
  if (!jwtSecret) {
    console.error("[gqshop-core] FATAL: GQSHOP_JWT_SECRET not set");
    process.exit(1);
  }

  await runMigrations(db);
  await seedMemberships(pool);
  await seedStationLevels(pool);
  await seedAdminGroups(pool);
  await loadPlugins(pool);
  // R2-β：域事件订阅（pay:settled → 佣金/分成/实物单；aftersale:refunded → 反扣）
  membersHooks(bus);
  stationHooks(bus);
  contentHooks(bus);
  console.log("[gqshop-core] migrations applied + seeds + plugins + domain hooks loaded");

  const app = createApp(db, jwtSecret, pool);
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
  startMembersJobs(pool); // 等级到期物理降级（功能池①；价格链的过期掉档在下单时另行校验）

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[gqshop-core] listening on http://${info.address}:${info.port} (pid ${process.pid})`);
  });
}

await main();

