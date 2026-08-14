'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../config/config');
const logger = require('../utils/logger');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migration idempotente : sur une base déjà déployée, CREATE TABLE IF NOT EXISTS
// n'ajoute pas les nouvelles colonnes à une table existante. On vérifie donc et
// on complète au besoin (ne s'exécute qu'une seule fois par colonne manquante).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('users', 'telegram_chat_id', 'telegram_chat_id TEXT');
ensureColumn('groups', 'antispam_enabled', 'antispam_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'antispam_max_msgs', 'antispam_max_msgs INTEGER NOT NULL DEFAULT 5');
ensureColumn('groups', 'antispam_window_sec', 'antispam_window_sec INTEGER NOT NULL DEFAULT 10');
ensureColumn('groups', 'antimedia_enabled', 'antimedia_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'welcome_enabled', 'welcome_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'welcome_message', "welcome_message TEXT DEFAULT ''");
ensureColumn('groups', 'antibot_enabled', 'antibot_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('groups', 'voice_enabled', 'voice_enabled INTEGER');

function now() {
  return Date.now();
}

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function genApiKey() {
  return `ua_${crypto.randomBytes(24).toString('hex')}`;
}

// ── Utilisateurs ───────────────────────────────────────────────────────────
function createUser() {
  const id = genId('user');
  const apiKey = genApiKey();
  const t = now();
  db.prepare(
    `INSERT INTO users (id, api_key, connection_status, created_at, updated_at)
     VALUES (?, ?, 'disconnected', ?, ?)`
  ).run(id, apiKey, t, t);
  return getUserById(id);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByApiKey(apiKey) {
  if (!apiKey) return null;
  return db.prepare('SELECT * FROM users WHERE api_key = ?').get(apiKey) || null;
}

function getUserByTelegramChatId(chatId) {
  if (!chatId) return null;
  return db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId)) || null;
}

/** Crée le compte s'il n'existe pas encore pour ce chat Telegram, sinon le retourne. */
function findOrCreateUserByTelegramChatId(chatId) {
  const existing = getUserByTelegramChatId(chatId);
  if (existing) return existing;
  const user = createUser();
  db.prepare('UPDATE users SET telegram_chat_id = ?, updated_at = ? WHERE id = ?').run(
    String(chatId),
    now(),
    user.id
  );
  return getUserById(user.id);
}

function updateUserSession(id, { phoneNumber, sessionPath, connectionStatus }) {
  const existing = getUserById(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE users SET
       phone_number = COALESCE(?, phone_number),
       session_path = COALESCE(?, session_path),
       connection_status = COALESCE(?, connection_status),
       updated_at = ?
     WHERE id = ?`
  ).run(phoneNumber || null, sessionPath || null, connectionStatus || null, now(), id);
  return getUserById(id);
}

function listUsersWithSessions() {
  return db.prepare("SELECT * FROM users WHERE phone_number IS NOT NULL AND session_path IS NOT NULL").all();
}

// ── Groupes ────────────────────────────────────────────────────────────────
function upsertGroup(groupJid, userId, patch = {}) {
  const existing = getGroup(groupJid, userId);
  const t = now();
  if (!existing) {
    db.prepare(
      `INSERT INTO groups
        (group_jid, user_id, name, enabled, ai_enabled, anti_link_enabled, max_warnings, memory_limit, rules,
         antispam_enabled, antispam_max_msgs, antispam_window_sec, antimedia_enabled, welcome_enabled, welcome_message,
         antibot_enabled, voice_enabled,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      groupJid,
      userId,
      patch.name ?? null,
      patch.enabled ? 1 : 0,
      patch.aiEnabled === false ? 0 : 1,
      patch.antiLinkEnabled === false ? 0 : 1,
      patch.maxWarnings ?? config.moderation.maxWarnings,
      patch.memoryLimit ?? config.memory.limit,
      patch.rules ?? '',
      patch.antispamEnabled ? 1 : 0,
      patch.antispamMaxMsgs ?? 5,
      patch.antispamWindowSec ?? 10,
      patch.antimediaEnabled ? 1 : 0,
      patch.welcomeEnabled ? 1 : 0,
      patch.welcomeMessage ?? '',
      patch.antibotEnabled ? 1 : 0,
      patch.voiceEnabled === undefined ? null : (patch.voiceEnabled === null ? null : (patch.voiceEnabled ? 1 : 0)),
      t,
      t
    );
    db.prepare(
      `INSERT OR IGNORE INTO memory_stats (group_jid, user_id, current_count, archive_count, updated_at)
       VALUES (?, ?, 0, 0, ?)`
    ).run(groupJid, userId, t);
    return getGroup(groupJid, userId);
  }

  db.prepare(
    `UPDATE groups SET
       name = COALESCE(?, name),
       enabled = COALESCE(?, enabled),
       ai_enabled = COALESCE(?, ai_enabled),
       anti_link_enabled = COALESCE(?, anti_link_enabled),
       max_warnings = COALESCE(?, max_warnings),
       memory_limit = COALESCE(?, memory_limit),
       rules = COALESCE(?, rules),
       antispam_enabled = COALESCE(?, antispam_enabled),
       antispam_max_msgs = COALESCE(?, antispam_max_msgs),
       antispam_window_sec = COALESCE(?, antispam_window_sec),
       antimedia_enabled = COALESCE(?, antimedia_enabled),
       welcome_enabled = COALESCE(?, welcome_enabled),
       welcome_message = COALESCE(?, welcome_message),
       antibot_enabled = COALESCE(?, antibot_enabled),
       voice_enabled = CASE WHEN ? = 1 THEN NULL WHEN ? IS NOT NULL THEN ? ELSE voice_enabled END,
       updated_at = ?
     WHERE group_jid = ? AND user_id = ?`
  ).run(
    patch.name ?? null,
    patch.enabled === undefined ? null : (patch.enabled ? 1 : 0),
    patch.aiEnabled === undefined ? null : (patch.aiEnabled ? 1 : 0),
    patch.antiLinkEnabled === undefined ? null : (patch.antiLinkEnabled ? 1 : 0),
    patch.maxWarnings ?? null,
    patch.memoryLimit ?? null,
    patch.rules ?? null,
    patch.antispamEnabled === undefined ? null : (patch.antispamEnabled ? 1 : 0),
    patch.antispamMaxMsgs ?? null,
    patch.antispamWindowSec ?? null,
    patch.antimediaEnabled === undefined ? null : (patch.antimediaEnabled ? 1 : 0),
    patch.welcomeEnabled === undefined ? null : (patch.welcomeEnabled ? 1 : 0),
    patch.welcomeMessage ?? null,
    patch.antibotEnabled === undefined ? null : (patch.antibotEnabled ? 1 : 0),
    patch.resetVoiceToDefault ? 1 : 0,
    patch.voiceEnabled === undefined ? null : (patch.voiceEnabled === null ? null : (patch.voiceEnabled ? 1 : 0)),
    patch.voiceEnabled === undefined ? null : (patch.voiceEnabled === null ? null : (patch.voiceEnabled ? 1 : 0)),
    t,
    groupJid,
    userId
  );
  return getGroup(groupJid, userId);
}

/** Isolation stricte : un groupe n'est jamais retourné pour un autre user_id. */
function getGroup(groupJid, userId) {
  return db.prepare('SELECT * FROM groups WHERE group_jid = ? AND user_id = ?').get(groupJid, userId) || null;
}

function listGroupsForUser(userId) {
  return db.prepare('SELECT * FROM groups WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

// ── Avertissements (isolés par groupe) ───────────────────────────────────────
function getWarning(groupJid, userId, memberJid) {
  return (
    db.prepare('SELECT * FROM warnings WHERE group_jid = ? AND user_id = ? AND member_jid = ?')
      .get(groupJid, userId, memberJid) || { group_jid: groupJid, user_id: userId, member_jid: memberJid, count: 0 }
  );
}

function listWarnings(groupJid, userId) {
  return db.prepare('SELECT * FROM warnings WHERE group_jid = ? AND user_id = ? ORDER BY count DESC').all(groupJid, userId);
}

function addWarning(groupJid, userId, memberJid, delta = 1) {
  const t = now();
  const current = getWarning(groupJid, userId, memberJid).count || 0;
  const next = Math.max(0, current + delta);
  db.prepare(
    `INSERT INTO warnings (group_jid, user_id, member_jid, count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_jid, member_jid) DO UPDATE SET count = ?, updated_at = ?`
  ).run(groupJid, userId, memberJid, next, t, next, t);
  return next;
}

function resetWarning(groupJid, userId, memberJid) {
  db.prepare('DELETE FROM warnings WHERE group_jid = ? AND user_id = ? AND member_jid = ?').run(groupJid, userId, memberJid);
}

/** Fixe le compteur d'avertissements à une valeur absolue (ex: .warn en mode direct → passe droit au seuil). */
function setWarningCount(groupJid, userId, memberJid, count) {
  const t = now();
  const value = Math.max(0, count);
  db.prepare(
    `INSERT INTO warnings (group_jid, user_id, member_jid, count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_jid, member_jid) DO UPDATE SET count = ?, updated_at = ?`
  ).run(groupJid, userId, memberJid, value, t, value, t);
  return value;
}

// ── Autorisations de liens (isolées par groupe) ──────────────────────────────
function setLinkAuthorization(groupJid, userId, memberJid, maxLinks, authorizedBy) {
  const t = now();
  db.prepare(
    `INSERT INTO link_authorizations (group_jid, user_id, member_jid, max_links, used_links, authorized_by, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(group_jid, member_jid) DO UPDATE SET max_links = ?, used_links = 0, authorized_by = ?, updated_at = ?`
  ).run(groupJid, userId, memberJid, maxLinks, authorizedBy, t, maxLinks, authorizedBy, t);
  return getLinkAuthorization(groupJid, userId, memberJid);
}

function getLinkAuthorization(groupJid, userId, memberJid) {
  return (
    db.prepare('SELECT * FROM link_authorizations WHERE group_jid = ? AND user_id = ? AND member_jid = ?')
      .get(groupJid, userId, memberJid) || null
  );
}

function consumeLinkQuota(groupJid, userId, memberJid, count = 1) {
  const auth = getLinkAuthorization(groupJid, userId, memberJid);
  if (!auth) return { allowed: false, remaining: 0 };
  const remaining = auth.max_links - auth.used_links;
  if (remaining < count) return { allowed: false, remaining: Math.max(0, remaining) };
  db.prepare(
    'UPDATE link_authorizations SET used_links = used_links + ?, updated_at = ? WHERE group_jid = ? AND user_id = ? AND member_jid = ?'
  ).run(count, now(), groupJid, userId, memberJid);
  return { allowed: true, remaining: remaining - count };
}

function resetLinkUsage(groupJid, userId, memberJid) {
  db.prepare(
    'UPDATE link_authorizations SET used_links = 0, updated_at = ? WHERE group_jid = ? AND user_id = ? AND member_jid = ?'
  ).run(now(), groupJid, userId, memberJid);
  return getLinkAuthorization(groupJid, userId, memberJid);
}

// ── Statistiques mémoire (compteur rapide sans lire les fichiers) ───────────
function bumpMemoryCount(groupJid, userId, delta = 1) {
  db.prepare(
    `INSERT INTO memory_stats (group_jid, user_id, current_count, archive_count, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(group_jid, user_id) DO UPDATE SET current_count = current_count + ?, updated_at = ?`
  ).run(groupJid, userId, Math.max(0, delta), now(), delta, now());
}

function resetMemoryCount(groupJid, userId) {
  db.prepare(
    `INSERT INTO memory_stats (group_jid, user_id, current_count, archive_count, updated_at)
     VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(group_jid, user_id) DO UPDATE SET current_count = 0, archive_count = archive_count + 1, updated_at = ?`
  ).run(groupJid, userId, now(), now());
}

function getMemoryStats(groupJid, userId) {
  return (
    db.prepare('SELECT * FROM memory_stats WHERE group_jid = ? AND user_id = ?').get(groupJid, userId) || {
      current_count: 0,
      archive_count: 0,
    }
  );
}

logger.info({ dbPath: config.dbPath }, 'Base SQLite initialisée');

// ── Mutes (isolés par groupe) ─────────────────────────────────────────────
function muteMember(groupJid, userId, memberJid, until, mutedBy) {
  const t = now();
  db.prepare(
    `INSERT INTO mutes (group_jid, user_id, member_jid, until, muted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_jid, member_jid) DO UPDATE SET until = ?, muted_by = ?, created_at = ?`
  ).run(groupJid, userId, memberJid, until ?? null, mutedBy ?? null, t, until ?? null, mutedBy ?? null, t);
}

function unmuteMember(groupJid, userId, memberJid) {
  db.prepare('DELETE FROM mutes WHERE group_jid = ? AND user_id = ? AND member_jid = ?').run(groupJid, userId, memberJid);
}

/** Vrai si le membre est actuellement muet. Nettoie automatiquement les mutes expirés. */
function isMuted(groupJid, userId, memberJid) {
  const row = db
    .prepare('SELECT * FROM mutes WHERE group_jid = ? AND user_id = ? AND member_jid = ?')
    .get(groupJid, userId, memberJid);
  if (!row) return false;
  if (row.until && row.until <= now()) {
    unmuteMember(groupJid, userId, memberJid);
    return false;
  }
  return true;
}

// ── Liste noire de mots (isolée par groupe) ──────────────────────────────
function addBlacklistWord(groupJid, userId, word, addedBy) {
  db.prepare(
    `INSERT OR IGNORE INTO blacklist_words (group_jid, user_id, word, added_by, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(groupJid, userId, word, addedBy ?? null, now());
}

function removeBlacklistWord(groupJid, userId, word) {
  db.prepare('DELETE FROM blacklist_words WHERE group_jid = ? AND user_id = ? AND word = ?').run(groupJid, userId, word);
}

function listBlacklistWords(groupJid, userId) {
  return db
    .prepare('SELECT word FROM blacklist_words WHERE group_jid = ? AND user_id = ?')
    .all(groupJid, userId)
    .map((r) => r.word);
}

module.exports = {
  raw: db,
  createUser,
  getUserById,
  getUserByApiKey,
  getUserByTelegramChatId,
  findOrCreateUserByTelegramChatId,
  updateUserSession,
  listUsersWithSessions,
  upsertGroup,
  getGroup,
  listGroupsForUser,
  getWarning,
  listWarnings,
  addWarning,
  setWarningCount,
  resetWarning,
  setLinkAuthorization,
  getLinkAuthorization,
  consumeLinkQuota,
  resetLinkUsage,
  bumpMemoryCount,
  resetMemoryCount,
  getMemoryStats,
  muteMember,
  unmuteMember,
  isMuted,
  addBlacklistWord,
  removeBlacklistWord,
  listBlacklistWords,
};
