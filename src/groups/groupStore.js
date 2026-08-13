'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const userStore = require('../users/userStore');
const { assertSafeGroupJid } = require('../utils/jid');
const logger = require('../utils/logger');

function groupDir(userId, groupJid) {
  assertSafeGroupJid(groupJid);
  return path.join(userStore.groupsRootPath(userId), groupJid);
}

function ensureGroupDirs(userId, groupJid) {
  const dir = groupDir(userId, groupJid);
  fs.mkdirSync(path.join(dir, 'memory', 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
  return dir;
}

function configPath(userId, groupJid) {
  return path.join(groupDir(userId, groupJid), 'config.json');
}

/** Régénère config.json à partir de la base SQLite (source de vérité). */
function writeGroupConfigSnapshot(userId, groupJid) {
  const row = db.getGroup(groupJid, userId);
  if (!row) return null;
  ensureGroupDirs(userId, groupJid);
  const snapshot = {
    groupId: row.group_jid,
    name: row.name,
    enabled: !!row.enabled,
    aiEnabled: !!row.ai_enabled,
    antiLinkEnabled: !!row.anti_link_enabled,
    maxWarnings: row.max_warnings,
    memoryLimit: row.memory_limit,
    rules: row.rules || '',
    antispamEnabled: !!row.antispam_enabled,
    antispamMaxMsgs: row.antispam_max_msgs,
    antispamWindowSec: row.antispam_window_sec,
    antimediaEnabled: !!row.antimedia_enabled,
    welcomeEnabled: !!row.welcome_enabled,
    welcomeMessage: row.welcome_message || '',
    antibotEnabled: !!row.antibot_enabled,
    voiceEnabled: row.voice_enabled === null ? null : !!row.voice_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const file = configPath(userId, groupJid);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snapshot, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return snapshot;
}

function activateGroup(userId, groupJid, { name, rules } = {}) {
  const row = db.upsertGroup(groupJid, userId, {
    name,
    rules,
    enabled: true,
  });
  writeGroupConfigSnapshot(userId, groupJid);
  logger.info({ userId, groupJid }, 'Groupe activé');
  return row;
}

function deactivateGroup(userId, groupJid) {
  const row = db.upsertGroup(groupJid, userId, { enabled: false });
  writeGroupConfigSnapshot(userId, groupJid);
  logger.info({ userId, groupJid }, 'Groupe désactivé');
  return row;
}

function updateRules(userId, groupJid, rules) {
  const row = db.upsertGroup(groupJid, userId, { rules });
  writeGroupConfigSnapshot(userId, groupJid);
  return row;
}

/** Point d'entrée générique pour tous les toggles/réglages de groupe (antispam, antimedia, bienvenue, antibot, vocal...). */
function updateSettings(userId, groupJid, patch) {
  const row = db.upsertGroup(groupJid, userId, patch);
  writeGroupConfigSnapshot(userId, groupJid);
  return row;
}

/** Le seul point d'entrée pour lire un groupe : impose l'appartenance à userId. */
function getOwnedGroup(userId, groupJid) {
  return db.getGroup(groupJid, userId);
}

module.exports = {
  groupDir,
  ensureGroupDirs,
  configPath,
  writeGroupConfigSnapshot,
  activateGroup,
  deactivateGroup,
  updateRules,
  updateSettings,
  getOwnedGroup,
};
