/**
 * content 域事件订阅与注册（ADR-010 R2-β）：
 * pay:settled → 实物发货单创建；shipping-registry → 运费报价实现注册。
 */
import type { PluginBus } from "@gqshop/plugin-api";
import { registerShippingQuote } from "@gqshop/kernel";

import { createPhysicalSale, quoteShipping } from "./physical.js";

export function registerDomainHooks(bus: PluginBus): void {
  bus.on("content", "pay:settled", async (p) => {
    if (!p.executor as never) return;
    await createPhysicalSale(p.executor as never, p.orderId);
  });
  registerShippingQuote(quoteShipping);
}
