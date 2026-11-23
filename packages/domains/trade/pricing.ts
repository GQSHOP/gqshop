/**
 * 高级定价层选项读取（功能池④）：gq_options 驱动，默认全关。
 *   price_single_rule='y' + price_single_yuan     → 全场统一价（分）
 *   price_profit_rule='y' + price_profit_yuan     → 成本+固定利润（分）
 *   price_cost_markup='y' + price_markup_percent  → 成本加成（%）
 * 订单侧与商品展示侧共用同一读取，保证所见即所付。
 */
import type { Pool } from "pg";

import type { AdvancedPriceOpts } from "@gqshop/kernel";

const OPTION_NAMES = ["price_single_rule", "price_single_yuan", "price_profit_rule", "price_profit_yuan", "price_cost_markup", "price_markup_percent"] as const;

function cents(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

export async function readAdvancedPriceOpts(pool: Pool): Promise<AdvancedPriceOpts> {
  const r = await pool.query<{ option_name: string; option_value: string }>(
    `SELECT option_name, option_value FROM gq_options WHERE option_name = ANY($1)`,
    [OPTION_NAMES as unknown as string[]],
  );
  const m = new Map(r.rows.map((row) => [row.option_name, row.option_value]));
  return {
    singleCents: m.get("price_single_rule") === "y" ? cents(m.get("price_single_yuan")) : 0,
    profitCents: m.get("price_profit_rule") === "y" ? cents(m.get("price_profit_yuan")) : 0,
    markupPercent: m.get("price_cost_markup") === "y" ? Math.max(0, Math.round(Number(m.get("price_markup_percent") ?? 0) || 0)) : 0,
  };
}
