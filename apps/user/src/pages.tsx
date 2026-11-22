import { useCallback, useEffect, useState } from "react";

import {
  bindStationDomain,
  getStationTemplate,
  setStationTemplate,
  type StationTemplateView,
  buyLevel,
  createAftersale,
  getAftersales,
  getAddress,
  getInvite,
  getLedger,
  getLevel,
  getMe,
  getMyStation,
  getStationLevels,
  getTiers,
  getUserOrders,
  getWithdraws,
  openStation,
  redeemCard,
  requestWithdraw,
  saveAddress,
  updateStationProfile,
  type AftersaleRow,
  type Address,
  type InviteInfo,
  type Ledger,
  type LevelView,
  type MyStation,
  type Profile,
  type StationLevel,
  type Tier,
  type UserOrder,
  type WithdrawRow,
} from "./api.js";

function yuan(cents: number | string | null | undefined): string {
  return (Number(cents) / 100).toFixed(2);
}

/** 概览：资料 + 余额 + 当前等级。 */
export function Dashboard() {
  const [me, setMe] = useState<Profile | null>(null);
  const [level, setLevel] = useState<LevelView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([getMe(), getLevel().catch(() => null)])
      .then(([m, l]) => {
        setMe(m);
        if (l) setLevel(l);
      })
      .catch((e) => setError(String(e.message)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!me) return <p className="muted">加载中…</p>;

  return (
    <div>
      <h2 className="page-title">概览</h2>
      <div className="stat-grid">
        <div className="stat-card"><p className="stat-label">用户名</p><p className="stat-value small">{me.username}</p></div>
        <div className="stat-card"><p className="stat-label">余额（元）</p><p className="stat-value">{me.money}</p></div>
        <div className="stat-card"><p className="stat-label">当前等级</p><p className="stat-value small">{level?.level_name ?? "普通用户"}</p></div>
        <div className="stat-card"><p className="stat-label">UID</p><p className="stat-value small">#{me.uid}</p></div>
      </div>
      <p className="muted">提示：在店面前台下单享会员价；去「邀请分销」赚取佣金。</p>
    </div>
  );
}

/** 钱包：余额 / 充值卡兑换 / 流水 / 提现申请。 */
export function Wallet() {
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [balance, setBalance] = useState("0.00");
  const [cardKey, setCardKey] = useState("");
  const [msg, setMsg] = useState("");
  const [wdAmount, setWdAmount] = useState("");
  const [wdAccount, setWdAccount] = useState("");
  const [wdName, setWdName] = useState("");
  const [withdraws, setWithdraws] = useState<WithdrawRow[]>([]);

  const load = useCallback(() => {
    getLedger()
      .then((d) => {
        setLedger(d.list);
        setBalance(d.balance);
      })
      .catch((e) => setMsg(String(e.message)));
    getWithdraws().then(setWithdraws).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function redeem() {
    setMsg("");
    try {
      const d = await redeemCard(cardKey.trim());
      setMsg(`兑换成功 ¥${d.amount}，余额 ${d.balance}`);
      setCardKey("");
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  async function withdraw() {
    setMsg("");
    try {
      await requestWithdraw(Number(wdAmount), "alipay", wdAccount, wdName);
      setMsg("提现申请已提交，等待审核");
      setWdAmount("");
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">我的钱包（余额 ¥{balance}）</h2>
      <div className="panel">
        <h3>充值卡兑换</h3>
        <div className="toolbar">
          <input placeholder="输入充值卡密" value={cardKey} onChange={(e) => setCardKey(e.target.value)} />
          <button className="btn-primary" onClick={redeem} disabled={!cardKey}>兑换</button>
        </div>
        {msg && <p className="hint">{msg}</p>}
      </div>
      <div className="panel">
        <h3>提现申请</h3>
        <div className="toolbar">
          <input placeholder="金额（元）" value={wdAmount} onChange={(e) => setWdAmount(e.target.value)} />
          <input placeholder="收款账号（支付宝）" value={wdAccount} onChange={(e) => setWdAccount(e.target.value)} />
          <input placeholder="真实姓名" value={wdName} onChange={(e) => setWdName(e.target.value)} />
          <button className="btn-primary" onClick={withdraw} disabled={!wdAmount || !wdAccount || !wdName}>提交申请</button>
        </div>
        {withdraws.length > 0 && (
          <table className="table">
            <thead><tr><th>金额</th><th>状态</th><th>备注</th></tr></thead>
            <tbody>
              {withdraws.map((w) => (
                <tr key={w.id}>
                  <td>¥{w.amount}</td>
                  <td>{w.status === 0 ? "待审核" : w.status === 1 ? "已打款" : "已驳回"}</td>
                  <td>{w.handle_remark ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <h3 className="section-title">余额流水</h3>
      {ledger.length === 0 ? (
        <p className="muted">暂无流水</p>
      ) : (
        <table className="table">
          <thead><tr><th>方向</th><th>变动后</th><th>说明</th><th>时间</th></tr></thead>
          <tbody>
            {ledger.map((l, i) => (
              <tr key={i}>
                <td>{l.plus === "y" ? "➕ 收入" : "➖ 支出"}</td>
                <td>¥{l.money}</td>
                <td>{l.description}</td>
                <td className="muted">{l.create_time ? new Date(l.create_time).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 会员等级：当前状态 + 8 档购买。 */
export function LevelPage() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [level, setLevel] = useState<LevelView | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    getTiers().then(setTiers).catch((e) => setMsg(String(e.message)));
    getLevel().then(setLevel).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function buy(id: number) {
    setMsg("");
    try {
      const d = await buyLevel(id);
      setMsg(`升级成功：${d.level_name}`);
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">会员等级（当前：{level?.level_name ?? "普通用户"}）</h2>
      {msg && <p className="hint">{msg}</p>}
      <div className="stat-grid">
        {tiers.map((t) => {
          const current = level?.level === t.id;
          const free = Number(t.price) === 0;
          return (
            <div className={"stat-card" + (current ? " highlight" : "")} key={t.id}>
              <p className="stat-label">{t.name}{free ? "（默认）" : ""}</p>
              <p className="stat-value">{free ? "免费" : `¥${t.price}`}</p>
              <p className="muted">{t.content}</p>
              {!current && !free && (
                <button className="btn-primary" onClick={() => buy(t.id)}>
                  余额购买
                </button>
              )}
              {current && <p className="hint">当前等级</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 邀请分销。 */
export function InvitePage() {
  const [info, setInfo] = useState<InviteInfo | null>(null);

  useEffect(() => {
    getInvite().then(setInfo).catch(() => {});
  }, []);

  if (!info) return <p className="muted">加载中…</p>;
  const fullUrl = window.location.origin + "/?invite=" + info.invite_code;

  return (
    <div>
      <h2 className="page-title">邀请分销</h2>
      <div className="panel">
        <p>我的邀请码：<strong className="mono">{info.invite_code}</strong></p>
        <p>邀请链接：<a href={fullUrl}>{fullUrl}</a></p>
        <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(fullUrl)}>复制链接</button>
        <p className="muted">累计佣金：¥{info.commission_total}</p>
      </div>
      <h3 className="section-title">直推列表（{info.direct_count} 人）</h3>
      {info.direct_list.length === 0 ? (
        <p className="muted">暂无直推</p>
      ) : (
        <table className="table">
          <thead><tr><th>UID</th><th>用户名</th><th>注册时间</th></tr></thead>
          <tbody>
            {info.direct_list.map((u) => (
              <tr key={u.uid}>
                <td>#{u.uid}</td>
                <td>{u.username}</td>
                <td className="muted">{u.create_time ? new Date(u.create_time * 1000).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 我的订单。 */
export function MyOrders() {
  const [orders, setOrders] = useState<UserOrder[]>([]);

  useEffect(() => {
    getUserOrders().then((d) => setOrders(d.list)).catch(() => {});
  }, []);

  return (
    <div>
      <h2 className="page-title">我的订单</h2>
      {orders.length === 0 ? (
        <p className="muted">暂无订单</p>
      ) : (
        <table className="table">
          <thead><tr><th>订单号</th><th>金额</th><th>支付状态</th><th>发货状态</th><th>支付方式</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.out_trade_no}>
                <td className="mono">{o.out_trade_no}</td>
                <td>¥{yuan(o.amount)}</td>
                <td>{o.pay_status === 1 ? "已支付" : "待支付"}</td>
                <td>{o.status === 2 ? "已发货" : o.pay_status === 1 ? "待发货" : "-"}</td>
                <td>{o.payment ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 售后服务：我的售后单 + 对已发货订单发起新售后。 */
const AFTERSALE_TYPE_LABEL: Record<string, string> = { refund: "退款", resend: "补发", other: "其他" };
const AFTERSALE_STATUS_LABEL: Record<number, string> = { 0: "待处理", 1: "处理中", 2: "已完成" };

export function AftersalePage() {
  const [list, setList] = useState<AftersaleRow[]>([]);
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ out_trade_no: "", type: "other", reason: "", contact: "" });

  const load = useCallback(() => {
    getAftersales().then(setList).catch((e) => setMsg(String(e.message)));
    getUserOrders().then((d) => setOrders(d.list.filter((o) => o.status === 2))).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setMsg("");
    try {
      await createAftersale({
        out_trade_no: form.out_trade_no.trim(),
        type: form.type,
        reason: form.reason.trim(),
        contact: form.contact.trim(),
      });
      setMsg("售后单已提交，请等待管理员处理");
      setForm({ out_trade_no: "", type: "other", reason: "", contact: "" });
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">售后服务</h2>

      <div className="panel">
        <h3>发起售后</h3>
        <div className="form-grid">
          <label>
            订单号（仅已发货订单）
            <select value={form.out_trade_no} onChange={(e) => setForm({ ...form, out_trade_no: e.target.value })}>
              <option value="">选择订单…</option>
              {orders.map((o) => (
                <option key={o.out_trade_no} value={o.out_trade_no}>
                  {o.out_trade_no}（¥{yuan(o.amount)}）
                </option>
              ))}
            </select>
          </label>
          <label>
            售后类型
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="refund">退款</option>
              <option value="resend">补发</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label>
            联系方式（选填）
            <input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
          </label>
        </div>
        <label className="block">
          问题描述
          <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </label>
        <button className="btn-primary" disabled={!form.out_trade_no || !form.reason.trim()} onClick={submit}>
          提交售后单
        </button>
        {msg && <p className="hint">{msg}</p>}
      </div>

      {list.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>ID</th><th>订单号</th><th>商品</th><th>类型</th><th>状态</th><th>申请时间</th></tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td className="mono">{a.out_trade_no}</td>
                <td>{a.goods_title}</td>
                <td>{AFTERSALE_TYPE_LABEL[a.type] ?? a.type}</td>
                <td>{AFTERSALE_STATUS_LABEL[a.status] ?? a.status}</td>
                <td className="muted">{a.create_time ? new Date(a.create_time * 1000).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 我的分店（M3）：开通 / 店铺资料 / 域名绑定 / 收益概览。 */
export function StationPage() {
  const [levels, setLevels] = useState<StationLevel[]>([]);
  const [station, setStation] = useState<MyStation | null>(null);
  const [msg, setMsg] = useState("");
  const [openForm, setOpenForm] = useState({ level_id: 0, slug: "", name: "", title: "" });
  const [profileForm, setProfileForm] = useState({ name: "", title: "", roll_notice: "", home_notice: "" });
  const [domainInput, setDomainInput] = useState("");
  const [tpl, setTpl] = useState<StationTemplateView | null>(null);

  const load = useCallback(() => {
    getStationLevels().then(setLevels).catch((e) => setMsg(String(e.message)));
    getMyStation().then((s) => {
      setStation(s);
      setProfileForm({
        name: s.name ?? "", title: s.title ?? "",
        roll_notice: s.roll_notice ?? "", home_notice: s.home_notice ?? "",
      });
    }).catch(() => setStation(null));
    getStationTemplate().then(setTpl).catch(() => setTpl(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function open() {
    setMsg("");
    try {
      const d = await openStation({
        level_id: openForm.level_id,
        slug: openForm.slug || undefined,
        name: openForm.name || undefined,
        title: openForm.title || undefined,
      });
      setMsg(`开通成功！分店地址：/s/${d.slug}`);
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  async function saveProfile() {
    setMsg("");
    try {
      await updateStationProfile(profileForm);
      setMsg("店铺资料已保存");
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  async function bindDomain() {
    setMsg("");
    try {
      await bindStationDomain(domainInput.trim());
      setMsg("域名已绑定（请将域名 CNAME 指向本站并由站主在反代添加 server_name）");
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  async function pickTemplate(name: string) {
    setMsg("");
    try {
      await setStationTemplate(name);
      setMsg(`分店模板已切换：${name}`);
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  if (!station) {
    return (
      <div>
        <h2 className="page-title">我的分店</h2>
        <p className="hint">选择分店等级开通（使用余额支付，请先充值）。分店是同一主站下的轻隔离店铺：同步主站商品、可加价出售、按等级费率分成。</p>
        {msg && <p className="hint">{msg}</p>}
        <div className="stat-grid">
          {levels.map((l) => (
            <div className="stat-card" key={l.id} onClick={() => setOpenForm({ ...openForm, level_id: l.id })}>
              <p className="stat-label">{l.name}{openForm.level_id === l.id ? " ✅" : ""}</p>
              <p className="stat-value">¥{Number(l.price).toFixed(2)}</p>
              <p className="hint">手续费 {Number(l.service_change ?? 0)}% · 提现费 {Number(l.cash_change ?? 0)}%</p>
              <p className="hint">{l.description}</p>
            </div>
          ))}
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="form-grid">
            <label>
              slug（店铺地址后缀，选填）
              <input placeholder="如 myshop → /s/myshop" value={openForm.slug} onChange={(e) => setOpenForm({ ...openForm, slug: e.target.value })} />
            </label>
            <label>
              店铺名（选填）
              <input value={openForm.name} onChange={(e) => setOpenForm({ ...openForm, name: e.target.value })} />
            </label>
          </div>
          <button className="btn-primary" disabled={!openForm.level_id} onClick={open}>
            开通分店（扣余额 ¥{levels.find((l) => l.id === openForm.level_id)?.price ?? "0.00"}）
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="page-title">我的分店{station.status !== 1 ? "（已停用）" : ""}</h2>
      {msg && <p className="hint">{msg}</p>}
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">等级 / 分成费率</p>
          <p className="stat-value">{station.level_name ?? "-"}</p>
          <p className="hint">售卖手续费 {Number(station.service_change ?? 0)}%</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">累计分成收入</p>
          <p className="stat-value">¥{Number(station.income_total ?? 0).toFixed(2)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">店铺地址</p>
          <p className="stat-value mono" style={{ fontSize: 14 }}>/s/{station.slug}</p>
          <p className="hint">{station.domain ? `独立域名：${station.domain}` : "未绑定独立域名"}</p>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>店铺资料</h3>
        <div className="form-grid">
          <label>店铺名<input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} /></label>
          <label>店铺标题<input value={profileForm.title} onChange={(e) => setProfileForm({ ...profileForm, title: e.target.value })} /></label>
        </div>
        <label className="block">
          滚动公告
          <input value={profileForm.roll_notice} onChange={(e) => setProfileForm({ ...profileForm, roll_notice: e.target.value })} />
        </label>
        <label className="block">
          首页公告
          <textarea rows={3} value={profileForm.home_notice} onChange={(e) => setProfileForm({ ...profileForm, home_notice: e.target.value })} />
        </label>
        <button className="btn-primary" onClick={saveProfile}>保存资料</button>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>独立域名</h3>
        {station.is_domain === "y" ? (
          <>
            <div className="form-grid">
              <label>
                域名
                <input placeholder="shop.example.com" value={domainInput} onChange={(e) => setDomainInput(e.target.value)} />
              </label>
            </div>
            <button className="btn-primary" disabled={!domainInput.trim()} onClick={bindDomain}>绑定域名</button>
            <p className="hint">绑定后请将域名 CNAME 指向本站服务器，由站主在反向代理中添加 server_name 后生效。</p>
          </>
        ) : (
          <p className="hint">当前等级不支持独立域名（升级分店等级解锁）。</p>
        )}
      </div>

      {tpl && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>分店模板</h3>
          {tpl.can_pick ? (
            <>
              <p className="hint">当前：{tpl.current}。选择分店店面使用的模板（即时生效，仅影响本分店）。</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {tpl.templates.map((t) => (
                  <button
                    key={t}
                    className={t === tpl.current ? "btn-primary" : "btn-ghost"}
                    disabled={t === tpl.current}
                    onClick={() => pickTemplate(t)}
                  >
                    {t}{t === tpl.current ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="hint">当前等级不支持自定义模板（强制 default，升级分店等级解锁）。</p>
          )}
        </div>
      )}
    </div>
  );
}


/** 收货地址（M3 实物，ADR-005 P4）：一址 CRUD。 */
export function AddressPage() {
  const [addr, setAddr] = useState<Address | null>(null);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ receiver_name: "", receiver_phone: "", region: "", address: "", buyer_remark: "" });

  useEffect(() => {
    getAddress().then((a) => {
      if (a) {
        setAddr(a);
        setForm({ receiver_name: a.receiver_name, receiver_phone: a.receiver_phone, region: a.region, address: a.address, buyer_remark: a.buyer_remark });
      }
    }).catch(() => {});
  }, []);

  async function save() {
    setMsg("");
    try {
      await saveAddress(form);
      setMsg("收货地址已保存");
      setAddr({ id: addr?.id ?? 0, ...form });
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">收货地址</h2>
      <p className="hint">购买实物商品时自动使用此地址；每个账号保留一个地址。</p>
      <div className="panel">
        <div className="form-grid">
          <label>收货人<input value={form.receiver_name} onChange={(e) => setForm({ ...form, receiver_name: e.target.value })} /></label>
          <label>手机号<input value={form.receiver_phone} onChange={(e) => setForm({ ...form, receiver_phone: e.target.value })} /></label>
        </div>
        <label className="block">
          省市区
          <input placeholder="广东省 深圳市 南山区" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
        </label>
        <label className="block">
          详细地址
          <input placeholder="科技园 XX 路 XX 号" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </label>
        <label className="block">
          备注（选填）
          <input value={form.buyer_remark} onChange={(e) => setForm({ ...form, buyer_remark: e.target.value })} />
        </label>
        <button className="btn-primary" disabled={!form.receiver_name || !form.receiver_phone || !form.region || !form.address} onClick={save}>
          保存地址
        </button>
        {msg && <p className="hint">{msg}</p>}
      </div>
    </div>
  );
}
