/**
 * gq_options KV 读写（GQSHOP 配置体系地基，M0 五大基础件之一）。
 * 值一律存字符串；读取带默认值。上游兼容：同名 option 语义对齐。
 */
import { eq } from "drizzle-orm";

import { optionsTable, type GqshopDb } from "@gqshop/db";

export async function getOption(
  db: GqshopDb,
  name: string,
  defaultValue: string,
): Promise<string> {
  const rows = await db
    .select({ v: optionsTable.option_value })
    .from(optionsTable)
    .where(eq(optionsTable.option_name, name))
    .limit(1);
  return rows[0]?.v ?? defaultValue;
}

export async function getOptionInt(db: GqshopDb, name: string, defaultValue: number): Promise<number> {
  const v = await getOption(db, name, String(defaultValue));
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

export async function setOption(db: GqshopDb, name: string, value: string): Promise<void> {
  await db
    .insert(optionsTable)
    .values({ option_name: name, option_value: value })
    .onConflictDoUpdate({ target: optionsTable.option_name, set: { option_value: value } });
}
