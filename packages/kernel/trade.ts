/**
 * 交易域公共工具：订单号、金额（分）、价格计算链（M1 游客价；M2 扩会员等级价）。
 */
import { randomBytes } from "node:crypto";

/** 上游风格订单号：30 字符内全局唯一。GQ + 时间 + 8 位随机。 */
export function genOutTradeNo(now = new Date()): string {
  const t = now.toISOString().replace(/[-:TZ.]/g, "").slice(2, 14); // yyMMddHHmmss
  return `GQ${t}${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** 价格链（M7 C2 对齐上游 Level_Price::calculate 通用段）：
 *  会员：member_price 覆盖 > user_price > guest_price；
 *  注册普通（uid>0, level=0）：user_price > guest_price；
 *  游客：guest_price。market_price 仅作最终兜底。 */
export function unitPriceCents(
  sku: { guest_price: number | null; user_price?: number | null; market_price: number | null },
  isRegistered = false,
): number {
  if (isRegistered && (sku.user_price ?? 0) > 0) return sku.user_price as number;
  return sku.guest_price ?? sku.market_price ?? 0;
}

/** 高级定价层（功能池④，上游 single_rule/cost+markup/profit_rule 的 GQSHOP 语义，默认全关）。
 *  - single_rule（全场统一价）：>0 时压过一切价格（含会员价覆盖）——促销语义；
 *  - profit_rule（成本+固定利润）：SKU 有 cost_price 时替代常规链基价；
 *  - cost_markup（成本加成 %）：同上，二者同时启用时 profit 优先。
 *  与会员价覆盖的优先级：single > member_price > profit/markup > 常规链。 */
export interface AdvancedPriceOpts {
  singleCents: number;
  profitCents: number;
  markupPercent: number;
}

export function advancedPriceActive(o: AdvancedPriceOpts): boolean {
  return o.singleCents > 0 || o.profitCents > 0 || o.markupPercent > 0;
}

/** 成本规则价：无成本或规则未启用返回 null（沿用常规链）。
 *  costCents 接受 number|string|null——pg numeric 列经 node-pg 回传字符串（"100"+60 会变字符串拼接）。 */
export function costBasedUnitCents(costCents: number | string | null | undefined, o: AdvancedPriceOpts): number | null {
  const cost = Number(costCents ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (o.profitCents > 0) return cost + o.profitCents;
  if (o.markupPercent > 0) return Math.round(cost * (1 + o.markupPercent / 100));
  return null;
}

export function calcTotalCents(unit: number, quantity: number): number {
  return unit * quantity;
}

/** 分 -> 元字符串（DB numeric 用）。 */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 元/数值字符串 -> 分整数（回调金额校验用，浮点安全）。 */
export function yuanToCents(v: string | number): number {
  return Math.round(Number(v) * 100);
}

/** 订单状态机（16.3 灵魂 #1）：{pay_status, status} 双字段。 */
export type OrderState = { pay_status: number; status: number };

export const TRANSITIONS: Record<string, OrderState> = {
  pay: { pay_status: 1, status: 1 }, // 支付成功 -> 已支付待发货（人工商品停在此态）
  deliver: { pay_status: 1, status: 2 }, // 自动发货完成
};

export function canTransition(from: OrderState, action: "pay" | "deliver"): boolean {
  if (action === "pay") return from.pay_status === 0;
  if (action === "deliver") return from.pay_status === 1 && from.status === 1;
  return false;
}
