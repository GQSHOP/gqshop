import { definePlugin, type QueryExecutor, type OrderItemRef } from "@gqshop/plugin-api";

/** 一卡一密领卡（原子：SKIP LOCKED，无卡返回 null；对齐原 deliver.ts claimOnceCard）。 */
async function claimOnceCard(
  pool: QueryExecutor,
  goodsId: number,
  sku: string,
  orderListId: number,
): Promise<string | null> {
  const res = await pool.query<{ rows: Array<{ content: string | null }> }>(
    `UPDATE gq_goods_once
     SET order_list_id = $1, sale_time = $2
     WHERE id = (
       SELECT id FROM gq_goods_once
       WHERE goods_id = $3 AND sku = $4 AND order_list_id = 0
       ORDER BY id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING content`,
    [orderListId, Date.now(), goodsId, sku],
  );
  return (res.rows[0] as { content: string | null } | undefined)?.content ?? null;
}

export default definePlugin({
  name: "goods_once",
  version: "0.1.0",
  description: "一卡一密：每张卡密绑定一个订单，原子领取杜绝双发",
  activate(ctx) {
    ctx.registerGoodsType({
      type: "goods_once",
      label: "一卡一密",
      deliver: async (pool, orderId, item: OrderItemRef) => {
        const sku = item.sku ?? "0";
        const goodsId = item.goods_id ?? 0;
        const qty = Math.max(1, item.quantity ?? 1);
        const contents: string[] = [];
        try {
          for (let i = 0; i < qty; i++) {
            const card = await claimOnceCard(pool, goodsId, sku, item.id);
            if (card === null) return { delivered: false, contents, error: "card pool exhausted" };
            contents.push(card);
          }
          await ctx.bus.emit("deliver:after", { orderId, goodsType: "goods_once", contents });
          return { delivered: true, contents };
        } catch (err) {
          return { delivered: false, contents, error: String(err).slice(0, 300) };
        }
      },
    });
  },
});
