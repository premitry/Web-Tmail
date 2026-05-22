CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  domain TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id INTEGER NOT NULL,
  message_uid TEXT UNIQUE NOT NULL,
  sender TEXT,
  recipient TEXT NOT NULL,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  otp TEXT,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(inbox_id) REFERENCES inboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_preview TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings(key,value) VALUES
('app_name','Parciv Tmail'),
('logo_url','https://i.ibb.co.com/1tNtxMjH/image.png'),
('favicon_url','https://i.ibb.co.com/1tNtxMjH/image.png'),
('primary_color','#14b8a6'),
('accent_color','#8b5cf6'),
('default_language','id'),
('admin_username','admin'),
('admin_password_hash',''),
('delete_after_days','7'),
('emergency_cleanup_enabled','1'),
('storage_warning_percent','80'),
('storage_danger_percent','95'),
('attachments_enabled','0'),
('turnstile_enabled','0'),
('turnstile_site_key',''),
('turnstile_secret_key',''),
('otp_detector_enabled','1'),
('captcha_on_generate','0'),
('forbidden_username_enabled','1'),
('forbidden_usernames','admin,support,noreply,owner,billing,api,security,abuse,postmaster'),
('custom_min_length','4'),
('custom_max_length','32'),
('auto_refresh_seconds','5'),
('cookie_notice_enabled','0'),
('sound_enabled','0'),
('web_domain','domain.com'),
('api_domain','api.domain.com');

INSERT OR IGNORE INTO domains(domain,active) VALUES ('domain.com',1);
