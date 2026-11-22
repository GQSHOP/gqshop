/**
 * CLI 无人值守安装（Phase 1 验收项）。
 * 幂等：检测 dc_options 的 gqshop_installed 锁；已安装则直接退出。
 * 用法（容器/主机内）：
 *   GQSHOP_INSTALL_ADMIN_USER=admin GQSHOP_INSTALL_ADMIN_PASSWORD=xxx tsx src/install-cli.ts
 */
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { createDbHandle, dbConfigFromEnv, runMigrations, optionsTable } from "@gqshop/db";

async function main(): Promise<void> {
  const { db } = createDbHandle(dbConfigFromEnv());
  console.log("[install] running migrations…");
  await runMigrations(db);

  const lock = await db
    .select()
    .from(optionsTable)
    .where(eq(optionsTable.option_name, "gqshop_installed"))
    .limit(1);
  if (lock.length > 0) {
    console.log("[install] already installed (gqshop_installed lock present) — nothing to do");
    return;
  }

  const username = process.env.GQSHOP_INSTALL_ADMIN_USER ?? "admin";
  const password = process.env.GQSHOP_INSTALL_ADMIN_PASSWORD;
  if (!password || password.length < 6) FATAL();
  const hash = bcrypt.hashSync(password, 10);
  const now = Math.floor(Date.now() / 1000);
  await db.insert(optionsTable).values({ option_name: "gqshop_installed", option_value: String(now) });
  console.log(`[install] install lock written (founder admin username: ${username})`);
  console.log("[install] NOTE: founder user must exist in dc_user — creating…");
  const { userTable } = await import("@gqshop/db");
  const existing = await db.select({ uid: userTable.uid }).from(userTable).where(eq(userTable.username, username)).limit(1);
  if (existing.length === 0) {
    await db.insert(userTable).values({
      username,
      password: hash,
      email: "",
      role: "admin",
      level: 0,
      state: 0,
      create_time: now,
      update_time: now,
    });
    console.log(`[install] founder admin created: ${username}`);
  } else {
    console.log(`[install] founder admin exists: ${username} (uid ${existing[0]?.uid})`);
  }
  console.log("[install] DONE");
  process.exit(0);
}

function FATAL(): never {
  console.error("[install] FATAL: GQSHOP_INSTALL_ADMIN_PASSWORD (>=6 chars) required");
  process.exit(1);
}

await main();
