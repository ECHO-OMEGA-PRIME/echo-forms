-- Echo Forms v1.0.0 Schema
-- AI-powered form builder and survey system

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  plan TEXT DEFAULT 'free',
  max_forms INTEGER DEFAULT 5,
  max_responses_per_form INTEGER DEFAULT 100,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'form',
  status TEXT DEFAULT 'draft',
  fields_json TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT DEFAULT '{}',
  thank_you_message TEXT DEFAULT 'Thank you for your response!',
  redirect_url TEXT,
  webhook_url TEXT,
  notification_email TEXT,
  allow_multiple INTEGER DEFAULT 0,
  requires_auth INTEGER DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  max_responses INTEGER DEFAULT 0,
  response_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  theme_json TEXT DEFAULT '{}',
  slug TEXT,
  is_template INTEGER DEFAULT 0,
  template_category TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_forms_tenant ON forms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms(slug);
CREATE INDEX IF NOT EXISTS idx_forms_template ON forms(is_template, template_category);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  metadata_json TEXT DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  completion_time_sec INTEGER,
  is_complete INTEGER DEFAULT 1,
  score REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (form_id) REFERENCES forms(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_responses_form ON responses(form_id);
CREATE INDEX IF NOT EXISTS idx_responses_tenant ON responses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_responses_date ON responses(form_id, created_at);

CREATE TABLE IF NOT EXISTS form_views (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (form_id) REFERENCES forms(id)
);
CREATE INDEX IF NOT EXISTS idx_views_form ON form_views(form_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT DEFAULT 'response.created',
  is_active INTEGER DEFAULT 1,
  secret TEXT,
  last_triggered_at TEXT,
  failure_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (form_id) REFERENCES forms(id)
);
CREATE INDEX IF NOT EXISTS idx_webhooks_form ON webhooks(form_id);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (form_id) REFERENCES forms(id)
);
CREATE INDEX IF NOT EXISTS idx_integrations_form ON integrations(form_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
