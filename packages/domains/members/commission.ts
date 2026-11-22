/**
 * 分销佣金链（M7 C1 对齐上游真算法，ADR-009）。
 *
 * 上游语义（gq_options 键名完全对齐）：
 *   commission_base: 'total'|'profit'（基数=订单总额 | 总额-成本差，默认 total）
 *   commission_ratio: 池占基数百分比（默认 100）
 *   order_level_check: 1=上级等级须≥下级才可分（默认 0）
 *   level_infinite_division / level_infinite_skip: 无限分销 / 不满足时跳级（默认 0/1）
 *   level_commits_distribute: 分店订单是否同时走分销链（默认 0=互斥，只给分店主）
 *   level_upgrade_profit: 下级升级直属上级奖励%（默认 0=关）
 *   upgrade_level_check: 1=上级等级≥目标级（默认）；2=上级有分店即可
 *
 * 链分发（distributeChain 等价）：池=基数×ratio（cap=pool）；每级
 *   amount = remain × 下级等级 actual_profit%；起提线 amount > 下级等级
 *   profit_threshold% × 订单总额（不达线断链）；amount 超 profitCap 截断且链终止；
 *   发放后 cap 递减；MAX_CHAIN_DEPTH=20。金额元两位 round 后转分（对齐上游）。
 * gq_member 种子（上游 install.sql 原值）：actual_profit 10/12/14/16/18/20/22/25，
 *   profit_threshold 3/3/2/2/2/1/1/1（八档）。
 */
import type { Pool, PoolClient } from "pg";

async function getOption(pool: Pool | PoolClient, name: string, def: string): Promise<string> {
  const r = await pool.query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = $1 LIMIT 1`,
    [name],
  );
  return r.rows[0]?.option_value ?? def;
}

export interface ChainUser {
  uid: number;
  superior: number;
  state: number;
  level: number;
  level_expire_time: number | null;
}

async function getUser(pool: Pool | PoolClient, uid: number): Promise<ChainUser | null> {
  const r = await pool.query<ChainUser>(
    `SELECT uid, superior, state, level, level_expire_time FROM gq_user WHERE uid = $1 LIMIT 1`,
    [uid],
  );
  return r.rows[0] ?? null;
}

/** getActiveLevelId 等价：等级有效（永久或未过期）返回 level，否则 null。 */
function activeLevel(u: ChainUser): number | null {
  const lv = Number(u.level ?? 0);
  if (lv <= 0) return null;
  const expire = Number(u.level_expire_time ?? 0);
  if (expire === 0) return lv;
  if (expire * 1000 < Date.now()) return null;
  return lv;
}

/** isLevelAtLeast 等价：按 gq_member.sort 比较（sort 越大等级越高）。 */
async function isLevelAtLeast(
  pool: Pool | PoolClient,
  currentLevelId: number | null,
  requiredLevelId: number,
): Promise<boolean> {
  if (requiredLevelId <= 0) return true;
  if (currentLevelId === null) return false;
  const r = await pool.query<{ cs: number | null; rs: number | null }>(
    `SELECT (SELECT sort FROM gq_member WHERE id = $1) AS cs,
            (SELECT sort FROM gq_member WHERE id = $2) AS rs`,
    [currentLevelId, requiredLevelId],
  );
  const { cs, rs } = r.rows[0] ?? { cs: null, rs: null };
  if (rs === null) return true;
  if (cs === null) return false;
  return cs >= rs;
}

export interface CommissionEntry {
  uid: number;
  fromUid: number;
  amountCents: number;
}

const MAX_CHAIN_DEPTH = 20;

/** 元两位小数 → 分（round 对齐上游 number_format 语义）。 */
function yuanToCents(v: number): number {
  return Math.round(v * 100);
}

/**
 * 支付成功后的佣金结算（payOrder + distributeChain 等价）。
 * 返回实际入账的分销链（可能为空）。orderAmountCents/costCents 单位=分。
 */
export async function payCommissionChain(
  client: PoolClient,
  buyerUid: number,
  orderNo: string,
  orderAmountCents: number,
  opts: { costCents?: number; stationOwnerUid?: number } = {},
): Promise<CommissionEntry[]> {
  try {
    const buyer = buyerUid > 0 ? await getUser(client, buyerUid) : null;
    if (!buyer || buyer.superior <= 0 || buyer.superior === buyer.uid) return [];

    // resolveCommissionPath：分店订单默认与链互斥（level_commits_distribute=0 只给分店主）
    const stationOwnerUid = opts.stationOwnerUid ?? 0;
    if (stationOwnerUid > 0) {
      const dist = await getOption(client, "level_commits_distribute", "0");
      if (dist !== "1") return [];
    }

    // calculateCommissionPool（语义反推自调用上下文）：pool = 基数 × ratio%；cap = pool
    const base = await getOption(client, "commission_base", "total");
    const ratio = Number(await getOption(client, "commission_ratio", "100")) || 0;
    const orderYuan = orderAmountCents / 100;
    const costYuan = (opts.costCents ?? 0) / 100;
    const baseYuan = base === "profit" ? orderYuan - costYuan : orderYuan;
    const poolYuan = Math.round(baseYuan * ratio) / 100;
    if (poolYuan <= 0.005) return [];
    let profitCapYuan = poolYuan;

    const levelCheck = (await getOption(client, "order_level_check", "0")) === "1";
    const infiniteDiv = (await getOption(client, "level_infinite_division", "0")) === "1";
    const infiniteSkip = (await getOption(client, "level_infinite_skip", "1")) === "1";

    const out: CommissionEntry[] = [];
    const credit = async (uid: number, amountYuan: number, fromUid: number) => {
      const cents = yuanToCents(amountYuan);
      if (cents <= 0) return;
      // 描述保持 "分销佣金" 前缀（wallet.ts 邀请统计 LIKE '分销佣金%' 依赖）
      const before = await client.query<{ money: string }>(
        `SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`,
        [uid],
      );
      const after = await client.query<{ money: string }>(
        `UPDATE gq_user SET money = money + $1::numeric WHERE uid = $2 RETURNING money`,
        [amountYuan.toFixed(2), uid],
      );
      if (!after.rows[0]) return;
      await client.query(
        `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'y', $2, $3, $4, $5)`,
        [uid, before.rows[0]?.money ?? "0.00", after.rows[0].money,
          `分销佣金：下级[UID:${fromUid}]下单[${orderNo}]分成¥${amountYuan.toFixed(2)}`, Date.now()],
      );
      out.push({ uid, fromUid, amountCents: cents });
    };

    let from = buyer;
    let remainYuan = poolYuan;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      if (remainYuan <= 0.005 || profitCapYuan <= 0.005) break;
      const supUid = Number(from.superior ?? 0);
      if (supUid <= 0 || supUid === from.uid) break;
      const superior = await getUser(client, supUid);
      if (!superior || superior.state !== 0) break;

      const fromLevel = activeLevel(from);
      if (fromLevel === null) break; // 下级等级失效 → 断链（上游语义）
      const supLevel = activeLevel(superior);

      if (levelCheck && !(await isLevelAtLeast(client, supLevel, fromLevel))) {
        if (!infiniteDiv) break; // 检查开+无限关 → 断链
        if (infiniteSkip) {
          from = superior; // 跳过该上级，继续向上
          continue;
        }
        // 无限开+不跳级 → 该上级照分（落到下方发放逻辑）
      }

      const member = await client.query<{ actual_profit: string; profit_threshold: string }>(
        `SELECT actual_profit, profit_threshold FROM gq_member WHERE id = $1 LIMIT 1`,
        [fromLevel],
      );
      const m = member.rows[0];
      if (!m) break;
      const profitPct = Number(m.actual_profit) || 0;
      const thresholdPct = Number(m.profit_threshold) || 0;

      let amountYuan = Math.round(remainYuan * profitPct) / 100;
      let remainNextYuan = Math.round((remainYuan - amountYuan) * 100) / 100;
      const thresholdYuan = Math.round(orderYuan * thresholdPct) / 100;
      if (amountYuan <= thresholdYuan) break; // 起提线：不达线本层不发且断链（上游 `<=` 语义）
      if (amountYuan > profitCapYuan) {
        amountYuan = Math.round(profitCapYuan * 100) / 100;
        remainNextYuan = 0; // 池帽截断，链终止
      }
      if (amountYuan > 0) {
        await credit(superior.uid, amountYuan, from.uid);
        profitCapYuan = Math.round((profitCapYuan - amountYuan) * 100) / 100;
      }
      if (remainNextYuan <= 0.005 || profitCapYuan <= 0.005) break;
      if (!superior.superior || superior.superior <= 0) break;
      from = superior;
      remainYuan = remainNextYuan;
    }
    return out;
  } catch (err) {
    console.error("[commission] chain payout failed:", err);
    return [];
  }
}

/**
 * 等级购买佣金（payUpgrade 等价）：直属上级得 basePrice × level_upgrade_profit%。
 * upgrade_level_check：1=上级等级≥目标级（默认）；2=上级有分店即可。
 */
export async function payUpgradeCommission(
  client: PoolClient,
  userUid: number,
  basePriceCents: number,
  targetLevel: number,
  orderNo: string,
): Promise<void> {
  try {
    const profitPct = Number(await getOption(client, "level_upgrade_profit", "0")) || 0;
    if (profitPct <= 0) return;
    const user = await getUser(client, userUid);
    if (!user || user.superior <= 0 || user.superior === user.uid) return;
    const superior = await getUser(client, user.superior);
    if (!superior || superior.state !== 0) return;

    const check = Number(await getOption(client, "upgrade_level_check", "1"));
    if (check > 0 && check !== 2) {
      if (!(await isLevelAtLeast(client, activeLevel(superior), targetLevel))) return;
    } else if (check === 2) {
      const st = await client.query(
        `SELECT id FROM gq_station WHERE user_id = $1 AND delete_time IS NULL LIMIT 1`,
        [superior.uid],
      );
      if (st.rows.length === 0) return;
    }

    const baseYuan = basePriceCents / 100;
    const rewardYuan = Math.round(baseYuan * profitPct) / 100;
    const cents = yuanToCents(rewardYuan);
    if (cents <= 0) return;
    const before = await client.query<{ money: string }>(
      `SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`,
      [superior.uid],
    );
    const after = await client.query<{ money: string }>(
      `UPDATE gq_user SET money = money + $1::numeric WHERE uid = $2 RETURNING money`,
      [rewardYuan.toFixed(2), superior.uid],
    );
    if (!after.rows[0]) return;
    await client.query(
      `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'y', $2, $3, $4, $5)`,
      [superior.uid, before.rows[0]?.money ?? "0.00", after.rows[0].money,
        `分销佣金：下级[UID:${userUid}]升级至等级#${targetLevel}奖励¥${rewardYuan.toFixed(2)}${orderNo ? `（${orderNo}）` : ""}`,
        Date.now()],
    );
  } catch (err) {
    console.error("[commission] upgrade payout failed:", err);
  }
}

/**
 * 退款反扣（deductOrder 等价）：按订单号回收已发佣金，保留 keepRatio%。
 * 金额按流水变动额（money - update_before）计；余额不足跳过不追负。返回反扣人数。
 */
export async function deductCommission(
  client: PoolClient,
  orderNo: string,
  keepRatio = 0,
): Promise<number> {
  try {
    const kr = Math.min(100, Math.max(0, keepRatio));
    const rows = await client.query<{ id: number; user_id: number; delta: string }>(
      `SELECT id, user_id, (money - update_before) AS delta FROM gq_balance_log
       WHERE plus = 'y' AND description LIKE '分销佣金%' AND description LIKE $1
         AND (money - update_before) > 0
       ORDER BY id DESC LIMIT 100`,
      [`%${orderNo}%`],
    );
    let n = 0;
    for (const r of rows.rows) {
      const amountYuan = Number(r.delta);
      const keepYuan = Math.round(amountYuan * kr) / 100;
      const deductYuan = Math.round((amountYuan - keepYuan) * 100) / 100;
      if (deductYuan <= 0) continue;
      const before = await client.query<{ money: string }>(
        `SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`,
        [r.user_id],
      );
      const after = await client.query<{ money: string }>(
        `UPDATE gq_user SET money = money - $1::numeric
         WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
        [deductYuan.toFixed(2), r.user_id],
      );
      if (!after.rows[0]) continue;
      await client.query(
        `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'n', $2, $3, $4, $5)`,
        [r.user_id, before.rows[0]?.money ?? "0.00", after.rows[0].money,
          `分销佣金退款反扣：订单[${orderNo}]回收¥${deductYuan.toFixed(2)}（保留¥${keepYuan.toFixed(2)}）`,
          Date.now()],
      );
      n++;
    }
    return n;
  } catch (err) {
    console.error("[commission] deduct failed:", err);
    return 0;
  }
}
