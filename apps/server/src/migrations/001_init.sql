-- Lite ERP 初始结构。全部在单个事务内执行(PostgreSQL 事务性 DDL),失败整体回滚。
-- 约定:租户表带 tenant_id、UNIQUE(tenant_id, id)、RLS 策略与禁止修改 tenant_id 的触发器。

CREATE OR REPLACE FUNCTION prevent_tenant_id_update() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

/* ─────────────── 平台表(无 RLS) ─────────────── */

CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  contact text NOT NULL,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  auth_epoch int NOT NULL DEFAULT 0,
  config_package_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account (
  id uuid PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  username text UNIQUE,
  password_hash text NOT NULL,
  failed_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wechat_binding (
  appid text NOT NULL,
  openid text NOT NULL,
  account_id uuid NOT NULL REFERENCES account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (appid, openid)
);

CREATE TABLE platform_admin (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_package (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  industry text NOT NULL DEFAULT '',
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now()
);

/* ─────────────── 租户:授权、配置、成员 ─────────────── */

CREATE TABLE license (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  expire_date date NOT NULL,
  modules text[] NOT NULL CHECK (cardinality(modules) >= 1),
  max_users int NOT NULL CHECK (max_users BETWEEN 1 AND 9999),
  max_warehouses int NOT NULL CHECK (max_warehouses BETWEEN 1 AND 999),
  signature text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  qty_scale smallint NOT NULL DEFAULT 2 CHECK (qty_scale BETWEEN 0 AND 4),
  price_scale smallint NOT NULL DEFAULT 4 CHECK (price_scale BETWEEN 0 AND 6),
  amount_scale smallint NOT NULL DEFAULT 2 CHECK (amount_scale BETWEEN 0 AND 2),
  allow_negative_stock boolean NOT NULL DEFAULT false,
  require_audit boolean NOT NULL DEFAULT true,
  multi_unit boolean NOT NULL DEFAULT false,
  multi_sku boolean NOT NULL DEFAULT false,
  barcode_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE tenant_module (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  module text NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, module)
);

CREATE TABLE tenant_user (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  account_id uuid NOT NULL REFERENCES account(id),
  name text NOT NULL,
  is_tenant_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  auth_epoch int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, account_id)
);

CREATE TABLE role (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  is_template boolean NOT NULL DEFAULT false,
  permissions text[] NOT NULL DEFAULT '{}',
  data_scope jsonb NOT NULL DEFAULT '{"type":"own"}',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE user_role (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  tenant_user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, tenant_user_id, role_id),
  FOREIGN KEY (tenant_id, tenant_user_id) REFERENCES tenant_user(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role(tenant_id, id)
);

CREATE TABLE open_api_key (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  key_id text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  name text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE tenant_plugin (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  plugin_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, plugin_name)
);

CREATE TABLE numbering_rule (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  doc_type text NOT NULL,
  prefix text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Z0-9-]{0,10}$'),
  date_format text NOT NULL DEFAULT 'YMD' CHECK (date_format IN ('YMD','YM','NONE')),
  seq_digits smallint NOT NULL DEFAULT 4 CHECK (seq_digits BETWEEN 3 AND 8),
  reset_cycle text NOT NULL DEFAULT 'daily' CHECK (reset_cycle IN ('daily','monthly','yearly','never')),
  PRIMARY KEY (tenant_id, doc_type)
);

CREATE TABLE number_sequence (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  doc_type text NOT NULL,
  period_key text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, doc_type, period_key)
);

CREATE TABLE attachment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  object_key text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  owner_type text,
  owner_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE branding_config (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  system_name text,
  logo_file_id uuid,
  theme_color text,
  login_bg_file_id uuid,
  copyright text,
  custom_domain text
);
CREATE UNIQUE INDEX branding_custom_domain_uq ON branding_config (lower(custom_domain)) WHERE custom_domain IS NOT NULL;

CREATE TABLE custom_field_def (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  object_type text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  default_value jsonb,
  options text[],
  display_order int NOT NULL DEFAULT 0,
  show_in_list boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX custom_field_code_uq ON custom_field_def (tenant_id, object_type, lower(code));

CREATE TABLE print_template (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  doc_type text NOT NULL,
  name text NOT NULL,
  paper text NOT NULL,
  layout jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_builtin boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_type, name)
);
CREATE UNIQUE INDEX print_template_default_uq ON print_template (tenant_id, doc_type) WHERE is_default;

/* ─────────────── 基础资料 ─────────────── */

CREATE TABLE product_category (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  parent_id uuid,
  name text NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  path text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES product_category(tenant_id, id)
);

CREATE TABLE product (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  category_id uuid,
  spec text NOT NULL DEFAULT '',
  base_unit text NOT NULL,
  barcode text NOT NULL DEFAULT '',
  ref_cost_price numeric(20,6) NOT NULL DEFAULT 0,
  ref_sale_price numeric(20,6) NOT NULL DEFAULT 0,
  wholesale_price numeric(20,6),
  stock_min numeric(20,4),
  stock_max numeric(20,4),
  images uuid[] NOT NULL DEFAULT '{}',
  remark text NOT NULL DEFAULT '',
  spec_dims jsonb,
  enabled boolean NOT NULL DEFAULT true,
  custom jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES product_category(tenant_id, id),
  CHECK (stock_min IS NULL OR stock_max IS NULL OR stock_max >= stock_min)
);

CREATE TABLE sku (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  product_id uuid NOT NULL,
  code text NOT NULL,
  barcode text NOT NULL DEFAULT '',
  spec_values jsonb,
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product(tenant_id, id)
);

-- Product 与 SKU 共用编码/条码命名空间,保证跨表唯一(需求 11.2)
CREATE TABLE code_registry (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('code','barcode')),
  value text NOT NULL,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, kind, value)
);

CREATE TABLE product_unit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  product_id uuid NOT NULL,
  unit_name text NOT NULL,
  ratio int NOT NULL CHECK (ratio BETWEEN 2 AND 100000),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, unit_name),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product(tenant_id, id)
);

CREATE TABLE partner (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer','supplier','both')),
  category text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  tax_no text NOT NULL DEFAULT '',
  bank text NOT NULL DEFAULT '',
  bank_account text NOT NULL DEFAULT '',
  opening_ar numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_ar >= 0),
  opening_ap numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_ap >= 0),
  price_level jsonb NOT NULL DEFAULT '{"type":"retail"}',
  credit_limit numeric(18,2),
  remark text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  custom jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE warehouse (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  custom jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE fund_account (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  type text NOT NULL CHECK (type IN ('cash','bank','wechat','alipay','other')),
  opening_balance numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  balance numeric(18,2) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE fund_category (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, direction, name)
);

/* ─────────────── 单据 ─────────────── */

CREATE TABLE document (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  doc_type text NOT NULL,
  doc_no text NOT NULL,
  doc_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','audited','voided')),
  partner_id uuid,
  warehouse_id uuid,
  to_warehouse_id uuid,
  fund_account_id uuid,
  fund_category_id uuid,
  upstream_id uuid,
  origin_doc_id uuid,
  is_inline boolean NOT NULL DEFAULT false,
  handler_id uuid,
  doc_discount numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  settled_amount numeric(18,2) NOT NULL DEFAULT 0,
  gross_profit numeric(18,2),
  fulfillment text,
  remark text NOT NULL DEFAULT '',
  custom jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  audited_at timestamptz,
  audited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_type, doc_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES partner(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id),
  FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouse(tenant_id, id),
  FOREIGN KEY (tenant_id, fund_account_id) REFERENCES fund_account(tenant_id, id),
  FOREIGN KEY (tenant_id, fund_category_id) REFERENCES fund_category(tenant_id, id),
  FOREIGN KEY (tenant_id, upstream_id) REFERENCES document(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_doc_id) REFERENCES document(tenant_id, id)
);
CREATE INDEX document_list_ix ON document (tenant_id, status, doc_type, doc_date);
CREATE INDEX document_upstream_ix ON document (tenant_id, upstream_id);
CREATE INDEX document_partner_ix ON document (tenant_id, partner_id, doc_date);

CREATE TABLE document_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  document_id uuid NOT NULL,
  line_no int NOT NULL,
  sku_id uuid NOT NULL,
  unit_name text,
  ratio int NOT NULL DEFAULT 1,
  qty numeric(20,4) NOT NULL DEFAULT 0,
  base_qty numeric(20,4) NOT NULL DEFAULT 0,
  price numeric(20,6) NOT NULL DEFAULT 0,
  discount_rate numeric(7,4) NOT NULL DEFAULT 100,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  warehouse_id uuid,
  upstream_line_id uuid,
  cost_price numeric(20,6),
  cost_amount numeric(18,2),
  line_profit numeric(18,2),
  snapshot_qty numeric(20,4),
  counted_qty numeric(20,4),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, line_no),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES sku(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)
);
CREATE INDEX document_line_doc_ix ON document_line (tenant_id, document_id);
CREATE INDEX document_line_sku_ix ON document_line (tenant_id, sku_id);
CREATE INDEX document_line_upstream_ix ON document_line (tenant_id, upstream_line_id);

CREATE TABLE settlement (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual','fifo','inline','return_offset')),
  target_type text NOT NULL CHECK (target_type IN ('opening','document')),
  target_doc_id uuid,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  applied boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document(tenant_id, id),
  FOREIGN KEY (tenant_id, target_doc_id) REFERENCES document(tenant_id, id)
);
CREATE INDEX settlement_doc_ix ON settlement (tenant_id, document_id);
CREATE INDEX settlement_target_ix ON settlement (tenant_id, target_doc_id);

CREATE TABLE idempotency_key (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  key text NOT NULL,
  document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

/* ─────────────── 流水与余额 ─────────────── */

CREATE TABLE stock_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  opening_qty numeric(20,4) NOT NULL DEFAULT 0,
  opening_amount numeric(18,2) NOT NULL DEFAULT 0,
  qty numeric(20,4) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  avg_cost numeric(20,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sku_id, warehouse_id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES sku(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)
);

CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  doc_no text NOT NULL,
  line_id uuid,
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  qty_delta numeric(20,4) NOT NULL,
  balance_after numeric(20,4) NOT NULL,
  unit_cost numeric(20,6) NOT NULL DEFAULT 0,
  amount_delta numeric(18,2) NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seq bigserial,
  reversal_of uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES sku(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse(tenant_id, id)
);
CREATE INDEX stock_ledger_ix ON stock_ledger (tenant_id, sku_id, warehouse_id, occurred_at);
CREATE INDEX stock_ledger_doc_ix ON stock_ledger (tenant_id, doc_id);

CREATE TABLE partner_balance (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  partner_id uuid NOT NULL,
  ar_balance numeric(18,2) NOT NULL DEFAULT 0,
  ap_balance numeric(18,2) NOT NULL DEFAULT 0,
  opening_ar_settled numeric(18,2) NOT NULL DEFAULT 0,
  opening_ap_settled numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, partner_id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES partner(tenant_id, id)
);

CREATE TABLE partner_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  partner_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('AR','AP')),
  doc_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'self',
  amount_delta numeric(18,2) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversal_of uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES partner(tenant_id, id)
);
CREATE INDEX partner_ledger_ix ON partner_ledger (tenant_id, partner_id, occurred_at);
CREATE INDEX partner_ledger_doc_ix ON partner_ledger (tenant_id, doc_id);

CREATE TABLE fund_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fund_account_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('receipt','payment','other_in','other_out','transfer_in','transfer_out')),
  source_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'self',
  amount_delta numeric(18,2) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reversal_of uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, fund_account_id) REFERENCES fund_account(tenant_id, id)
);
CREATE INDEX fund_ledger_ix ON fund_ledger (tenant_id, fund_account_id, occurred_at);
CREATE INDEX fund_ledger_src_ix ON fund_ledger (tenant_id, source_id);

CREATE TABLE fund_transfer (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  from_account_id uuid NOT NULL,
  to_account_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  transfer_date date NOT NULL,
  remark text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (from_account_id <> to_account_id),
  FOREIGN KEY (tenant_id, from_account_id) REFERENCES fund_account(tenant_id, id),
  FOREIGN KEY (tenant_id, to_account_id) REFERENCES fund_account(tenant_id, id)
);

/* ─────────────── 运维与扩展 ─────────────── */

-- 按月分区。tenant_id 可空:账号不存在等无租户上下文的平台级登录失败事件
CREATE TABLE audit_log (
  id uuid NOT NULL,
  tenant_id uuid,
  actor_id uuid,
  actor_type text NOT NULL DEFAULT 'user',
  actor_name text,
  client text,
  ip text,
  action text NOT NULL,
  object_type text,
  object_id text,
  object_no text,
  before jsonb,
  after jsonb,
  detail jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX audit_log_ix ON audit_log (tenant_id, occurred_at DESC);

CREATE FUNCTION ensure_audit_partition(month_start date) RETURNS void AS $$
DECLARE name text := 'audit_log_' || to_char(month_start, 'YYYYMM');
BEGIN
  IF to_regclass(name) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)', name, month_start, (month_start + interval '1 month')::date);
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TABLE event_outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX event_outbox_pending_ix ON event_outbox (status, id) WHERE status = 'pending';

CREATE TABLE io_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('import','export')),
  object_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  result_file_id uuid,
  error text,
  params jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id)
);

/* ─────────────── RLS / 触发器 / 授权 ─────────────── */

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
      AND c.table_name <> 'audit_log_default' AND c.table_name NOT LIKE 'audit_log_20%'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update()', t || '_tid_immutable', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO erp_app, erp_platform;

-- 受限应用角色:常规表 CRUD;流水表与审计日志只追加
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app, erp_platform;
REVOKE UPDATE, DELETE, TRUNCATE ON stock_ledger, partner_ledger, fund_ledger, audit_log FROM erp_app;
REVOKE DELETE, TRUNCATE ON document, fund_transfer FROM erp_app;
-- 平台账号表等只由平台角色写入
REVOKE INSERT, UPDATE, DELETE ON tenant, account, wechat_binding, platform_admin, config_package FROM erp_app;
GRANT SELECT ON tenant TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_platform;
GRANT EXECUTE ON FUNCTION ensure_audit_partition(date) TO erp_platform;

-- 直接访问分区会绕过父表的 RLS,因此应用角色不得持有分区的任何权限(经父表插入/查询即可)
REVOKE ALL ON audit_log_default FROM erp_app;

-- 之后迁移新建的表默认授予 CRUD;需要只追加的表在各自迁移中显式收回
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app, erp_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app, erp_platform;
