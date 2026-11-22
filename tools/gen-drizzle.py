# -*- coding: utf-8 -*-
"""Generate Drizzle ORM schema (PostgreSQL) from an upstream install.sql schema dump.

78 tables, 808 fields, 1:1 mapping per 复刻计划附录A10:
  int -> integer, varchar(n) -> varchar(n), bigint -> bigint(number mode),
  text/mediumtext/longtext -> text, tinyint -> smallint, decimal(m,n) -> numeric(m,n),
  enum('a','b') -> varchar(len=max) + comment note, char(n) -> char(n).
AUTO_INCREMENT -> identity column. Table names keep snake_case; PREFIX_MAP maps upstream dc_ -> gq_ (ADR-010 R1).

Usage: python -I tools/gen-drizzle.py <path-to-install.sql>
Output: packages/db/src/schema/*.ts
"""
import io
import os
import re
import sys
import collections

SQL = sys.argv[1] if len(sys.argv) > 1 else ""
if not SQL:
    sys.exit("usage: python -I tools/gen-drizzle.py <path-to-install.sql>")
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packages", "db", "src", "schema")
# ADR-010 R1: 输出表名前缀（上游 dc_ 映射为 gq_，命名自主）
def OUT_TABLE(name):
    return name[3:] if name.startswith("dc_") else name

DOMAINS = ["user", "goods", "order", "station", "docking", "physical", "content", "system"]
DOMAIN_MAP = {
    "user": "user", "member": "user", "member_price": "user",
    "level_order": "user", "balance_log": "user", "withdraw": "user",
    "recharge_card": "user", "user_log": "user",
    "user_goods_footprint": "user", "admin_group": "user",
    "free_claim_log": "user",
    "goods": "goods", "goods_type": "goods", "sku_attr": "goods",
    "sku_value": "goods", "skus": "goods", "sort": "goods",
    "tag": "goods", "goods_general": "goods", "goods_general_sale": "goods",
    "goods_once": "goods", "goods_service": "goods",
    "goods_service_sale": "goods", "stock": "goods",
    "stock_export_log": "goods", "storage": "goods",
    "order": "order", "order_list": "order", "order_required": "order",
    "pay_callback_log": "order", "aftersale": "order",
    "aftersale_chat": "order", "cart": "order", "deliver": "order",
    "coupon": "order", "coupon_log": "order", "discount": "order",
    "single_rule": "order", "profit_rule": "order",
    "station": "station", "station_level": "station", "station_goods": "station",
    "station_sort": "station", "station_plugin": "station", "station_storage": "station",
    "docking_sources": "docking", "docking_goods": "docking",
    "docking_sale": "docking", "docking_category_map": "docking",
    "qingjiu_sources": "docking", "qingjiu_goods": "docking",
    "qingjiu_sale": "docking", "qingjiu_sku_map": "docking",
    "qingjiu_category_map": "docking",
    "yiciyuan_sources": "docking", "yiciyuan_goods": "docking",
    "yiciyuan_sale": "docking", "yiciyuan_sku_map": "docking",
    "mcy_sources": "docking", "mcy_goods": "docking",
    "mcy_sale": "docking", "mcy_sku_map": "docking",
    "physical_address": "physical", "physical_goods_shipping": "physical",
    "physical_sale": "physical", "physical_shipping_template": "physical",
    "blog": "content", "blog_fields": "content", "blog_navi": "content",
    "navi": "content", "comment": "content", "twitter": "content",
    "link": "content", "media_sort": "content", "attachment": "content",
    "options": "system", "tpl_options_data": "system", "authorization": "system",
}

TABLE_DESC = {
    "dc_user": "用户主表：余额/等级/角色/邀请码/上级/各开放平台 openid/api_key",
    "dc_member": "会员等级定义（8 档默认种子）",
    "dc_member_price": "商品×会员等级价格覆盖",
    "dc_level_order": "等级/分店套餐购买订单（会员等级与分店开通共用）",
    "dc_balance_log": "余额流水",
    "dc_withdraw": "提现申请与审核",
    "dc_recharge_card": "充值卡密",
    "dc_user_log": "用户操作日志",
    "dc_user_goods_footprint": "商品访问足迹",
    "dc_admin_group": "后台用户组权限",
    "dc_free_claim_log": "免费领取记录",
    "dc_goods": "商品主表（类型/模板/跳转/加价规则引用/允许对接等）",
    "dc_goods_type": "商品类型（对应插件注册）",
    "dc_sku_attr": "规格属性名",
    "dc_sku_value": "规格属性值",
    "dc_skus": "SKU 组合（价格/成本/库存/销量）",
    "dc_sort": "分类（商品+文章双用）",
    "dc_tag": "标签",
    "dc_goods_general": "通用卡密库存（多商品共用卡池）",
    "dc_goods_general_sale": "通用卡密售出记录",
    "dc_goods_once": "一卡一密库存（每条绑订单）",
    "dc_goods_service": "虚拟服务（人工/自动交付内容）",
    "dc_goods_service_sale": "虚拟服务售出记录",
    "dc_stock": "库存视图（未售/已售）",
    "dc_stock_export_log": "卡密导出留痕",
    "dc_storage": "仓库/存储抽象",
    "dc_order": "订单主表（out_trade_no/支付插件/双状态字段）",
    "dc_order_list": "订单子项（商品/SKU/数量/发货内容）",
    "dc_order_required": "下单必填字段（商品级）",
    "dc_pay_callback_log": "支付回调原始日志（全量审计）",
    "dc_aftersale": "售后单",
    "dc_aftersale_chat": "售后沟通记录",
    "dc_cart": "购物车",
    "dc_deliver": "交付记录（发货内容留痕，交付回收对应）",
    "dc_coupon": "优惠券",
    "dc_coupon_log": "优惠券使用记录",
    "dc_discount": "批量优惠（数量减免/订单减免/订单折扣）",
    "dc_single_rule": "单品加价规则",
    "dc_profit_rule": "成本区间利润规则",
    "dc_station": "分店主表（uid/level/slug/独立 SEO/软删）",
    "dc_station_level": "分店等级（5 档种子：基础0/入门29/标准99/专业199/旗舰399）",
    "dc_station_goods": "分店商品同步映射",
    "dc_station_sort": "分店分类同步映射",
    "dc_station_plugin": "分店可用插件/模板",
    "dc_station_storage": "分店存储",
    "dc_docking_sources": "同系统对接货源站配置（API+密钥）",
    "dc_docking_goods": "对接商品映射",
    "dc_docking_sale": "代采销售记录",
    "dc_docking_category_map": "对接分类映射",
    "dc_qingjiu_sources": "青酒上游源配置",
    "dc_qingjiu_goods": "青酒商品映射",
    "dc_qingjiu_sale": "青酒代采记录",
    "dc_qingjiu_sku_map": "青酒 SKU 映射",
    "dc_qingjiu_category_map": "青酒分类映射",
    "dc_yiciyuan_sources": "一慈云上游源配置",
    "dc_yiciyuan_goods": "一慈云商品映射",
    "dc_yiciyuan_sale": "一慈云代采记录",
    "dc_yiciyuan_sku_map": "一慈云 SKU 映射",
    "dc_mcy_sources": "MCY 上游源配置",
    "dc_mcy_goods": "MCY 商品映射",
    "dc_mcy_sale": "MCY 代采记录",
    "dc_mcy_sku_map": "MCY SKU 映射",
    "dc_physical_address": "收货地址",
    "dc_physical_goods_shipping": "实物发货单",
    "dc_physical_sale": "实物销售记录",
    "dc_physical_shipping_template": "运费模板",
    "dc_blog": "博客文章（EMLOG 血统 log）",
    "dc_blog_fields": "文章扩展字段",
    "dc_blog_navi": "博客导航",
    "dc_navi": "页面导航",
    "dc_comment": "评论",
    "dc_twitter": "微语（说说）",
    "dc_link": "友情链接",
    "dc_media_sort": "媒体/资源分类",
    "dc_attachment": "附件（媒体模型实际映射此表）",
    "dc_options": "全站配置 KV（约 90+ 项，序列化存储）",
    "dc_tpl_options_data": "模板配置数据（front_default 等）",
    "dc_authorization": "授权信息（复刻时剔除重写）",
}

DOMAIN_LABEL = {
    "user": "用户与会员",
    "goods": "商品与SKU",
    "order": "订单与支付",
    "station": "分店系统",
    "docking": "供货对接",
    "physical": "实物商城",
    "content": "内容系统",
    "system": "系统",
}


# A2 增量：复刻计划规定的 schema 增强（1:1 平移之外的刻意偏差，均注明）
ADDITIONS = {
    "dc_order": [
        {"name": "idempotency_key", "ts": 'varchar({ length: 64 })', "note": "A2: client idempotency key (unique)"},
    ],
    # M2 收尾：dc_discount 原表无主键（MySQL 无 PK），补自增主键（迁移 0002）
    "dc_discount": [
        {"name": "id", "ts": 'integer().primaryKey().generatedByDefaultAsIdentity({ name: "dc_discount_id_seq" })', "note": "M2: surrogate pk for admin row ops", "pk": True},
    ],
}
EXTRA_INDEXES = {
    "dc_order": [
        {"name": "out_trade_no", "unique": True, "cols": ["out_trade_no"], "note": "A1: 订单号全局唯一"},
        {"name": "idempotency_key", "unique": True, "cols": ["idempotency_key"], "note": "A2: 幂等唯一"},
    ],
    "dc_discount": [
        {"name": "goods", "unique": False, "cols": ["goods_id", "sku"], "note": "M2: 按商品+规格查规则"},
    ],
}

text = io.open(SQL, "r", encoding="utf-8", errors="replace").read()
blocks = re.findall(r"CREATE TABLE `([^`]+)` \((.*?)\)\s*ENGINE=([^;]+);", text, re.S)

FIELD_RE = re.compile(r"^`([^`]+)`\s+([a-zA-Z]+(?:\([^)]*\))?(?:\s+unsigned)?)(.*)$", re.S)


def snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


def map_type(ftype):
    """Return (ts_chain, needs_identity_possible, note)."""
    m = re.match(r"^([a-zA-Z]+)(\([^)]*\))?", ftype)
    base = m.group(1).lower()
    args = m.group(2) or ""
    if base == "int":
        return "integer()", None
    if base == "tinyint" or base == "smallint":
        return "smallint()", None
    if base == "bigint":
        return "bigint({ mode: 'number' })", None
    if base == "varchar":
        n = int(re.search(r"\((\d+)\)", args).group(1))
        return f"varchar({{ length: {n} }})", None
    if base == "char":
        n = int(re.search(r"\((\d+)\)", args).group(1))
        return f"char({{ length: {n} }})", None
    if base in ("text", "mediumtext", "longtext", "tinytext"):
        return "text()", None
    if base == "decimal":
        mm = re.search(r"\((\d+)\s*,\s*(\d+)\)", args)
        p, s = (mm.group(1), mm.group(2)) if mm else ("10", "2")
        return f"numeric({{ precision: {p}, scale: {s} }})", None
    if base == "enum":
        vals = re.findall(r"'((?:[^'\\]|\\.)*)'", args)
        maxlen = max((len(v) for v in vals), default=255)
        note = "enum: " + "|".join(vals)
        return f"varchar({{ length: {maxlen} }})", note
    if base == "json":
        return "jsonb()", None
    if base == "datetime" or base == "timestamp":
        return "timestamp({ mode: 'string' })", None
    if base == "date":
        return "date({ mode: 'string' })", None
    if base == "double":
        return "doublePrecision()", None
    if base == "float":
        return "real()", None
    raise SystemExit(f"UNMAPPED TYPE: {ftype}")


def map_default(rest, ts, base):
    dm = re.search(r"DEFAULT\s+'((?:[^'\\]|\\.)*)'|DEFAULT\s+([^\s,]+)", rest)
    if not dm:
        return ts, None
    if dm.group(1) is not None:
        val = dm.group(1)
        if val.upper() == "CURRENT_TIMESTAMP":
            return ts + ".defaultNow()", None
        # MySQL dump quotes numeric defaults for int/bigint/tinyint — unquote for PG int columns
        if base in ("int", "tinyint", "smallint", "bigint") and re.match(r"^-?\d+$", val):
            return f"{ts}.default({val})", None
        if base in ("decimal", "double", "float") and re.match(r"^-?\d+(\.\d+)?$", val):
            return f"{ts}.default('{val}')", None
        esc = val.replace("\\", "\\\\").replace("'", "\\'")
        return f"{ts}.default('{esc}')", None
    raw = dm.group(2).strip()
    if raw.upper() == "CURRENT_TIMESTAMP":
        return ts + ".defaultNow()", None
    if raw.upper() == "NULL":
        return ts, None
    if re.match(r"^-?\d+(\.\d+)?$", raw):
        return f"{ts}.default({raw})", None
    esc = raw.replace("'", "\\'")
    return f"{ts}.default('{esc}')", None


tables = collections.OrderedDict()
for name, body, engine in blocks:
    fields = []
    indexes = []
    pk = []
    for raw in body.splitlines():
        line = raw.strip().rstrip(",")
        if not line:
            continue
        if line.startswith("`"):
            m = FIELD_RE.match(line)
            if not m:
                raise SystemExit(f"FIELD PARSE FAIL in {name}: {line[:120]}")
            fname, ftype, rest = m.group(1), m.group(2), m.group(3)
            comment = ""
            cm = re.search(r"COMMENT\s+'((?:[^'\\]|\\.)*)'", rest)
            if cm:
                comment = cm.group(1).replace("\\'", "'").replace("''", "'")
            notnull = "NOT NULL" in rest
            ai = bool(re.search(r"AUTO_INCREMENT", rest, re.I))
            base_type = re.match(r"^([a-zA-Z]+)", ftype).group(1).lower()
            ts, note = map_type(ftype)
            ts, _ = map_default(rest, ts, base_type)
            fields.append({"name": fname, "ts": ts, "notnull": notnull, "ai": ai, "comment": comment, "type": ftype, "note": note})
        elif line.upper().startswith("PRIMARY KEY"):
            pk = re.findall(r"`([^`]+)`", line)
        elif line.upper().startswith(("KEY ", "UNIQUE KEY")):
            mm = re.match(r"(?:UNIQUE )?KEY `([^`]+)` \(([^)]+)\)", line, re.I)
            if mm:
                cols = [c.strip() for c in mm.group(2).split(",")]
                clean = []
                for c in cols:
                    cn = re.match(r"`([^`]+)`", c)
                    clean.append(cn.group(1) if cn else c)
                indexes.append({"name": mm.group(1), "unique": line.upper().startswith("UNIQUE"), "cols": clean})
    tables[name] = {"fields": fields, "pk": pk, "indexes": indexes}

for tname, extra_fields in ADDITIONS.items():
    if tname in tables:
        for f in extra_fields:
            tables[tname]["fields"].append({"name": f["name"], "ts": f["ts"], "notnull": False, "ai": False, "comment": f.get("note", ""), "type": "added", "note": f.get("note", "")})
for tname, extra_idx in EXTRA_INDEXES.items():
    if tname in tables:
        tables[tname]["indexes"].extend(extra_idx)

os.makedirs(OUT_DIR, exist_ok=True)
by_domain = collections.OrderedDict((d, []) for d in DOMAINS)
for name in tables:
    short = name[3:]
    by_domain[DOMAIN_MAP[short]].append(name)

HEADER = """// AUTO-GENERATED by tools/gen-drizzle.py from upstream install.sql
// (source sha256 recorded in private project docs)
// 1:1 平移：表名/列名保留 dc_ 前缀与 snake_case；类型映射见附录A10。
// 唯一偏差：AUTO_INCREMENT -> PG identity；unsigned 无对应（PG 不支持，迁移时需范围校验）。
// DO NOT hand-edit — regenerate via: python -I tools/gen-drizzle.py

import {
  bigint, char, index, integer, numeric, pgTable, smallint, text, uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
"""

for domain in DOMAINS:
    tnames = by_domain[domain]
    lines = [HEADER, f"// ============ {DOMAIN_LABEL[domain]} ============", ""]
    for name in tnames:
        t = tables[name]
        short = name[3:]
        export = snake_to_camel(short) + "Table"
        desc = TABLE_DESC.get(name, "")
        lines.append("/**")
        if desc:
            lines.append(f" * {desc}")
        lines.append(f" * MySQL 原表：`{name}`")
        lines.append(" */")
        extras = []
        pk_cols = t["pk"]
        # primary key: single col inline; composite via extras (none in upstream dump but keep generic)
        lines.append(f"export const {export} = pgTable(")
        lines.append(f'  "{name}",')
        lines.append("  {")
        for f in t["fields"]:
            ts = f["ts"]
            if f.get("note"):
                lines.append(f"    // {f['note']}")
            is_pk = f["name"] in pk_cols
            if f["ai"]:
                if is_pk:
                    ts += f'.primaryKey().generatedByDefaultAsIdentity({{ name: "{name}_{f["name"]}_seq" }})'
                else:
                    ts += f'.generatedByDefaultAsIdentity({{ name: "{name}_{f["name"]}_seq" }})'
            elif is_pk:
                ts += ".primaryKey()"
            if f["notnull"] and "primaryKey" not in ts:
                ts += ".notNull()"
            # enum notes are appended as // comment in ts — move to doc comment line
            lines.append(f"    {f['name']}: {ts},")
        lines.append("  },")
        # extra config: indexes
        if t["indexes"]:
            lines.append("  (t) => [")
            for idx in t["indexes"]:
                iname = f"{name}_{idx['name']}"
                cols = ", ".join(f"t.{c}" for c in idx["cols"] if c in [f["name"] for f in t["fields"]])
                if not cols:
                    continue
                if idx["unique"]:
                    lines.append(f'    uniqueIndex("{iname}").on({cols}),')
                else:
                    lines.append(f'    index("{iname}").on({cols}),')
            lines.append("  ],")
        lines.append(");")
        lines.append("")
    out = "\n".join(lines).rstrip() + "\n"
    path = os.path.join(OUT_DIR, f"{domain}.ts")
    io.open(path, "w", encoding="utf-8", newline="\n").write(out)
    print("written:", path, f"({len(tnames)} tables)")

# schema index
idx_lines = ["/** All 78 tables (8 domains) - AUTO-GENERATED index. */"]
for domain in DOMAINS:
    tnames = by_domain[domain]
    idx_lines.append(f'export * from "./{domain}.js";')
idx_lines.append("")
idx_lines.append("/** Table count sanity check constant (update only via generator). */")
idx_lines.append(f"export const GQSHOP_TABLE_COUNT = {len(tables)} as const;")
io.open(os.path.join(OUT_DIR, "index.ts"), "w", encoding="utf-8", newline="\n").write("\n".join(idx_lines))
print("written:", os.path.join(OUT_DIR, "index.ts"))
print("TOTAL:", len(tables), "tables /", sum(len(t["fields"]) for t in tables.values()), "fields")
