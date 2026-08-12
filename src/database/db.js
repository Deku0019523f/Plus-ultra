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
        (group_jid, user_id, name, enabled, ai_enabled, anti_link_enabled, max_warnings, memory_limit, rules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

module.exports = {
  raw: db,
  createUser,
  getUserById,
  getUserByApiKey,
  updateUserSession,
  listUsersWithSessions,
  upsertGroup,
  getGroup,
  listGroupsForUser,
  getWarning,
  listWarnings,
  addWarning,
  resetWarning,
  setLinkAuthorization,
  getLinkAuthorization,
  consumeLinkQuota,
  bumpMemoryCount,
  resetMemoryCount,
  getMemoryStats,
};
