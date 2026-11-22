/**
 * GQSHOP 插件契约（ADR-008 P1/P2）。
 * 进程内模型：插件与 core 同进程运行，ctx 为最小 API 面（不透传 env/fs/raw pool）；
 * hook 派发异常隔离（try-catch，只记日志不阻断主流程）。
 */

// ============ Hook 总线（typed，doAction 等价） ============

export interface HookMap {
  "core:init": Record<string, never>;
  "order:created": { orderId: number; outTradeNo: string; userId: number; amountCents: number };
  "pay:settled": { orderId: number; gateway: string; amountCents: number };
  "deliver:after": { orderId: number; goodsType: string; contents: string[] };
  "deliver:failed": { orderId: number; goodsType: string; error: string };
  "stock:low": { goodsId: number; stock: number };
  "user:registered": { uid: number; superior: number };
  "aftersale:created": { aftersaleId: number; orderId: number };
  "station:opened": { stationId: number; uid: number };
  "withdraw:reviewed": { withdrawId: number; uid: number; approved: boolean };
}
export type HookName = keyof HookMap;

type Handler<K extends HookName> = (payload: HookMap[K]) => void | Promise<void>;

export class PluginBus {
  private handlers = new Map<HookName, Array<{ plugin: string; fn: Handler<HookName> }>>();

  /** 注册 hook（注册序即执行序，v1 无优先级）。 */
  on<K extends HookName>(plugin: string, name: K, fn: Handler<K>): void {
    const arr = this.handlers.get(name) ?? [];
    arr.push({ plugin, fn: fn as Handler<HookName> });
    this.handlers.set(name, arr);
  }

  /** 派发：逐个执行，单个插件异常隔离（记日志不阻断）。 */
  async emit<K extends HookName>(name: K, payload: HookMap[K], log: (msg: string) => void = console.error): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) {
      try {
        await h.fn(payload);
      } catch (err) {
        log(`[plugin:${h.plugin}] hook "${name}" failed: ${String(err).slice(0, 200)}`);
      }
    }
  }

  /** 反注册（插件 deactivate 用）。 */
  off(plugin: string): void {
    for (const [k, arr] of this.handlers) {
      this.handlers.set(k, arr.filter((h) => h.plugin !== plugin));
    }
  }
}

// ============ 注册表条目（core 宿主持有，插件声明） ============

/** 商品类型注册项：deliver 分发 handler（对齐原 deliver.ts switch 分支语义）。 */
export interface GoodsTypeEntry {
  /** dc_goods.type 值，如 goods_once */
  type: string;
  label: string;
  /** 发货：返回 delivered=false 表示待人工/失败（不抛异常语义与 A2 一致） */
  deliver: (executor: QueryExecutor, orderId: number, item: OrderItemRef) => Promise<{ delivered: boolean; contents: string[]; error?: string }>;
}

/** 支付方式注册项（v1：清单+下单校验；submit/notify 路由完全化挂 M6）。 */
export interface PayPluginEntry {
  name: string; // 下单 pay_plugin 值：balance / epay_ali / epay_wx
  label: string;
  kind: "balance" | "epay";
}

/** 受控查询执行器（pg 参数化接口的最小暴露；插件禁止拼接 SQL）。 */
export interface QueryExecutor {
  query<T extends { rows: unknown[] } = { rows: unknown[] }>(sql: string, params?: unknown[]): Promise<T>;
}

/** 结算单子项引用（deliver 入参）。 */
export interface OrderItemRef {
  id: number;
  goods_id: number | null;
  sku: string | null;
  quantity: number | null;
}

// ============ PluginContext（最小 API 面） ============

export interface PluginContext {
  bus: PluginBus;
  log: (msg: string) => void;
  /** dc_options 受控读写 */
  options: {
    get: (name: string) => Promise<string | null>;
    set: (name: string, value: string) => Promise<void>;
  };
  /** 注册表（幂等；deactivate 时宿主自动摘除） */
  registerGoodsType: (entry: GoodsTypeEntry) => void;
  registerPayPlugin: (entry: PayPluginEntry) => void;
  /** 受控 SQL 执行器（同事务/池由宿主在调用点传入，插件不持有长连接） */
  query: QueryExecutor;
}

export interface PluginDef {
  name: string;
  version: string;
  description?: string;
  activate: (ctx: PluginContext) => void | Promise<void>;
  deactivate?: (ctx: PluginContext) => void | Promise<void>;
}

/** 插件定义入口（类型收紧 + 停止扩散）。 */
export function definePlugin(def: PluginDef): PluginDef {
  return def;
}
