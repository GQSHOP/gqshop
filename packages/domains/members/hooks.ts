/**
 * members 域事件订阅（ADR-010 R2-β：跨域经 bus，消除 trade→members 直接依赖）。
 * pay:settled → 佣金链；aftersale:refunded → 退款反扣。
 * executor 透传：与结算方同一事务（资金原子性保持）。
 */
import type { PluginBus } from "@gqshop/plugin-api";

import { payCommissionChain, deductCommission } from "./commission.js";

export function registerDomainHooks(bus: PluginBus): void {
  bus.on("members", "pay:settled", async (p) => {
    if (!p.executor || !p.buyerUid || !p.outTradeNo) return;
    await payCommissionChain(p.executor as never, p.buyerUid, p.outTradeNo, p.amountCents, {
      costCents: p.costCents,
      stationOwnerUid: p.stationOwnerUid,
    });
  });
  bus.on("members", "aftersale:refunded", async (p) => {
    if (!p.executor as never) return;
    await deductCommission(p.executor as never, p.orderNo, 0);
  });
}
