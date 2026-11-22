/**
 * 运费报价注册表（ADR-010 R2-β）：content 域注册实现，trade 域下单调用——
 * 域间经 kernel 注册表解耦（同 goodsType/payPlugin 注册表模式）。
 */
import type { Pool } from "pg";

export interface ShippingQuote {
  templateId: number;
  feeCents: number;
}

type QuoteFn = (pool: Pool, goodsId: number, qty: number, subtotalCents: number) => Promise<ShippingQuote | null>;

let quoteFn: QuoteFn | null = null;

export function registerShippingQuote(fn: QuoteFn): void {
  quoteFn = fn;
}

export function getShippingQuote(
  pool: Pool,
  goodsId: number,
  qty: number,
  subtotalCents: number,
): Promise<ShippingQuote | null> {
  if (!quoteFn) return Promise.resolve(null); // 无注册=免运费兜底
  return quoteFn(pool, goodsId, qty, subtotalCents);
}
