-- GQSHOP 市场站 α 表结构（幂等自迁移；ADR-012）
CREATE TABLE IF NOT EXISTS market_account (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name VARCHAR(64) NOT NULL DEFAULT '',
  role VARCHAR(16) NOT NULL DEFAULT 'customer',
  state SMALLINT NOT NULL DEFAULT 0,
  dev_profile TEXT,
  dev_pending BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_plugin (
  name VARCHAR(50) PRIMARY KEY,
  developer_id BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_submission (
  id BIGSERIAL PRIMARY KEY,
  plugin_name VARCHAR(50) NOT NULL,
  version VARCHAR(30) NOT NULL,
  developer_id BIGINT NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  zip_path VARCHAR(255) NOT NULL,
  zip_sha256 CHAR(64) NOT NULL,
  manifest_json TEXT,
  scan_report TEXT,
  status VARCHAR(16) NOT NULL,
  review_notes TEXT,
  reviewer_id BIGINT,
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  CONSTRAINT market_submission_name_ver UNIQUE (plugin_name, version)
);
CREATE INDEX IF NOT EXISTS market_submission_status_idx ON market_submission (status, created_at);
-- β 付费流（ADR-012 A4）
ALTER TABLE market_plugin ADD COLUMN IF NOT EXISTS price_model VARCHAR(16) NOT NULL DEFAULT 'free';
ALTER TABLE market_plugin ADD COLUMN IF NOT EXISTS price_cents INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS market_pay_order (
  id BIGSERIAL PRIMARY KEY,
  out_trade_no VARCHAR(64) UNIQUE NOT NULL,
  account_id BIGINT NOT NULL,
  sku_type VARCHAR(16) NOT NULL,
  plugin_name VARCHAR(50),
  licensee VARCHAR(255) NOT NULL,
  amount_cents INTEGER NOT NULL,
  status SMALLINT NOT NULL DEFAULT 0,
  gateway VARCHAR(16) NOT NULL DEFAULT 'epay',
  trade_no VARCHAR(64),
  create_time BIGINT NOT NULL,
  paid_time BIGINT
);
CREATE TABLE IF NOT EXISTS market_license (
  id BIGSERIAL PRIMARY KEY,
  license_type VARCHAR(16) NOT NULL,
  plugin_name VARCHAR(50),
  licensee VARCHAR(255) NOT NULL,
  account_id BIGINT NOT NULL,
  order_no VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  sig TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT,
  state SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS market_license_account_idx ON market_license (account_id, state);
-- γ 运营台（ADR-012 A6）：结算落账（settle 时写入，day one 记账）
CREATE TABLE IF NOT EXISTS market_sales_record (
  id BIGSERIAL PRIMARY KEY,
  order_no VARCHAR(64) UNIQUE NOT NULL,
  plugin_name VARCHAR(50) NOT NULL,
  developer_id BIGINT NOT NULL,
  gross_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  dev_net_cents INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_sales_plugin_idx ON market_sales_record (plugin_name, created_at);
CREATE INDEX IF NOT EXISTS market_sales_dev_idx ON market_sales_record (developer_id, created_at);
