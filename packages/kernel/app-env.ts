import type { GqshopDb } from "@gqshop/db";
import type { Pool } from "pg";

import type { AdminAuth } from "./admin-auth.js";

/** 内核应用上下文类型（ADR-010 R2：原 apps/core/src/index.ts AppEnv 迁入）。 */
export interface AppEnv {
  Variables: {
    db: GqshopDb;
    pool: Pool;
    jwtSecret: string;
    uid?: number;
    adminAuth?: AdminAuth;
  };
}
