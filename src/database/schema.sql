-- Ultra Agent — schéma SQLite
-- Sert de source fiable pour les recherches rapides et l'isolation multi-tenant.
-- Les fichiers JSON (user.json, config.json) restent des instantanés lisibles,
-- mais toute vérification d'appartenance/permission passe par cette base.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,        -- identifiant interne (USER_001, ...)
  api_key         TEXT UNIQUE NOT NULL,
  telegram_chat_id TEXT UNIQUE,
  phone_number    TEXT,
  session_path    TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected', -- pending | connected | disconnected | failed
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  group_jid           TEXT NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT,
  enabled             INTEGER NOT NULL DEFAULT 0,
  ai_enabled          INTEGER NOT NULL DEFAULT 1,
  anti_link_enabled   INTEGER NOT NULL DEFAULT 1,
  max_warnings        INTEGER NOT NULL DEFAULT 3,
  memory_limit        INTEGER NOT NULL DEFAULT 1000,
  rules               TEXT DEFAULT '',
  antispam_enabled    INTEGER NOT NULL DEFAULT 0,
  antispam_max_msgs   INTEGER NOT NULL DEFAULT 5,
  antispam_window_sec INTEGER NOT NULL DEFAULT 10,
  antimedia_enabled   INTEGER NOT NULL DEFAULT 0,
  welcome_enabled     INTEGER NOT NULL DEFAULT 0,
  welcome_message     TEXT DEFAULT '',
  antibot_enabled     INTEGER NOT NULL DEFAULT 0,
  antibot_prefixes    TEXT DEFAULT '.!/#',
  voice_enabled       INTEGER, -- NULL = suit AI_VOICE_REPLY (.env), 0/1 = override par groupe
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (group_jid, user_id)
);

CREATE TABLE IF NOT EXISTS mutes (
  group_jid   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  member_jid  TEXT NOT NULL,
  until       INTEGER, -- NULL = mute indéfini (jusqu'à .unmute manuel)
  muted_by    TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (group_jid, member_jid),
  FOREIGN KEY (group_jid, user_id) REFERENCES groups(group_jid, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blacklist_words (
  group_jid  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  word       TEXT NOT NULL,
  added_by   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_jid, word),
  FOREIGN KEY (group_jid, user_id) REFERENCES groups(group_jid, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS warnings (
  group_jid   TEXT NOT NULL,
  user_id     TEXT NOT NULL, -- propriétaire (isolation)
  member_jid  TEXT NOT NULL, -- membre averti
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (group_jid, member_jid),
  FOREIGN KEY (group_jid, user_id) REFERENCES groups(group_jid, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS link_authorizations (
  group_jid     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  member_jid    TEXT NOT NULL,
  max_links     INTEGER NOT NULL DEFAULT 0,
  used_links    INTEGER NOT NULL DEFAULT 0,
  authorized_by TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (group_jid, member_jid),
  FOREIGN KEY (group_jid, user_id) REFERENCES groups(group_jid, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_stats (
  group_jid       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  current_count   INTEGER NOT NULL DEFAULT 0,
  archive_count   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (group_jid, user_id),
  FOREIGN KEY (group_jid, user_id) REFERENCES groups(group_jid, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_warnings_group ON warnings(group_jid, user_id);
CREATE INDEX IF NOT EXISTS idx_linkauth_group ON link_authorizations(group_jid, user_id);
CREATE INDEX IF NOT EXISTS idx_mutes_group ON mutes(group_jid, user_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_group ON blacklist_words(group_jid, user_id);
