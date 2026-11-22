/**
 * 发货分发（16.3 灵魂 #2）：M5-γ 起商品类型走插件注册表（ADR-008 P3）——
 * goods_once/general/service 由 @gqshop/plugin-goods-* 提供（active_plugins 可停用）；
 * goods_physical（待人工发货）与未知类型保留内置分支。
 * 事务边界：executor 必须传入结算方持有的 PoolClient——发货与订单支付标记同生共死。
 */
import type { Pool, PoolClient } from "pg";

import { getGoodsTypeHandler } from "@gqshop/kernel";

export type QueryExecutor = PoolClient | Pool;

export interface DeliverResult {
  delivered: boolean;
  contents: string[];
  error?: string;
}

/**
 * 发货单个订单子项。调用方保证：订单已支付（pay_status=1, status=1）。
 * 注册表命中：插件 handler 负责（含类型特定留痕），宿主统一写 gq_deliver。
 * 未命中：physical（待 admin 物流）/unknown 内置语义。
 */
export async function deliverOrderItem(
  executor: QueryExecutor,
  orderId: number,
  item: { id: number; goods_id: number | null; sku: string | null; quantity: number | null },
  goodsType: string,
): Promise<DeliverResult> {
  const handler = getGoodsTypeHandler(goodsType);
  if (handler) {
    const r = await handler(executor as never, orderId, item);
    if (!r.delivered) return r;
    // 交付留痕（与插件 handler 同 executor=同事务）
    await executor.query(
      `INSERT INTO gq_deliver (order_id, order_list_id, content, create_time) VALUES ($1, $2, $3, $4)`,
      [orderId, item.id, r.contents.join("\n"), Date.now()],
    );
    return r;
  }
  if (goodsType === "goods_physical") {
    // 实物不自动发货（ADR-005 P3）：发货单由 createPhysicalSale 建，物流由 admin 推进
    return { delivered: false, contents: [], error: "physical: awaiting manual shipment" };
  }
  return { delivered: false, contents: [], error: `unknown goods type: ${goodsType}` };
}
