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
 *  游客：guest_price。market_price 仅作最终兜底。
 *  （single_rule/cost+markup 高级定价层 上游 默认全关，未实现——配置启用属 M7 后续。） */
export function unitPriceCents(
  sku: { guest_price: number | null; user_price?: number | null; market_price: number | null },
  isRegistered = false,
): number {
  if (isRegistered && (sku.user_price ?? 0) > 0) return sku.user_price as number;
  return sku.guest_price ?? sku.market_price ?? 0;
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
