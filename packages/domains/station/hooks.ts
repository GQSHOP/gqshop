/**
 * station 域事件订阅（ADR-010 R2-β）：pay:settled → 分店即时分成（executor 同事务）。
 */
import type { PluginBus } from "@gqshop/plugin-api";

import { payStationIncome } from "./station-income.js";

export function registerDomainHooks(bus: PluginBus): void {
  bus.on("station", "pay:settled", async (p) => {
    if (!p.executor || !p.stationId) return;
    await payStationIncome(p.executor as never, p.orderId, p.stationId, p.amountCents);
  });
}
