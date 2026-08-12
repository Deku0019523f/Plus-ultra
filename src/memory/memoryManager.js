'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const db = require('../database/db');
const groupStore = require('../groups/groupStore');
const logger = require('../utils/logger');

function currentPath(userId, groupJid) {
  return path.join(groupStore.groupDir(userId, groupJid), 'memory', 'current.json');
}

function archiveDir(userId, groupJid) {
  return path.join(groupStore.groupDir(userId, groupJid), 'memory', 'archive');
}

function writeJsonAtomic(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

/** Lecture défensive : un fichier mémoire corrompu ne doit jamais faire planter le bot. */
function readCurrent(userId, groupJid) {
  groupStore.ensureGroupDirs(userId, groupJid);
  const file = currentPath(userId, groupJid);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.error({ userId, groupJid, err: err.message }, 'Mémoire corrompue — sauvegarde et réinitialisation');
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch { /* fichier déjà déplacé/absent */ }
    return [];
  }
}

function cleanForArchive(messages) {
  const seen = new Set();
  const cleaned = [];
  for (const m of messages) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const entry = {
      id: m.id,
      userId: m.userId,
      name: m.name || '',
      type: m.type === 'audio' ? 'audio' : 'text',
      content: m.content || '',
      timestamp: Number(m.timestamp) || Date.now(),
    };
    if (m.type === 'audio' && m.transcription) entry.transcription = m.transcription;
    cleaned.push(entry);
  }
  return cleaned;
}

function nextArchiveFile(userId, groupJid) {
  const dir = archiveDir(userId, groupJid);
  const existing = fs.readdirSync(dir).filter((f) => /^archive_\d+\.json$/.test(f));
  const nums = existing.map((f) => parseInt(f.match(/\d+/)[0], 10));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return path.join(dir, `archive_${String(next).padStart(3, '0')}.json`);
}

function archive(userId, groupJid, messages) {
  const cleaned = cleanForArchive(messages);
  const file = nextArchiveFile(userId, groupJid);
  writeJsonAtomic(file, cleaned);
  db.resetMemoryCount(groupJid, userId);
  logger.info({ userId, groupJid, file: path.basename(file), count: cleaned.length }, 'Archive mémoire créée');
}

/**
 * Ajoute un message à la mémoire du groupe. Déclenche l'archivage automatique
 * dès que la limite est atteinte — jamais de perte silencieuse.
 */
function appendMessage(userId, groupJid, message, memoryLimit) {
  const limit = memoryLimit || config.memory.limit;
  const current = readCurrent(userId, groupJid);
  current.push({
    id: message.id,
    userId: message.userId,
    name: message.name || '',
    type: message.type || 'text',
    content: message.content || '',
    transcription: message.transcription,
    timestamp: message.timestamp || Date.now(),
  });

  if (current.length >= limit) {
    archive(userId, groupJid, current);
    writeJsonAtomic(currentPath(userId, groupJid), []);
  } else {
    writeJsonAtomic(currentPath(userId, groupJid), current);
    db.bumpMemoryCount(groupJid, userId, 1);
  }
}

function getRecent(userId, groupJid, n = 20) {
  const current = readCurrent(userId, groupJid);
  return current.slice(-n);
}

/**
 * Sélectionne un contexte pertinent et borné (pas les 1000 messages) pour l'IA :
 * derniers messages du groupe + messages impliquant l'utilisateur courant.
 */
function getRelevantContext(userId, groupJid, senderJid, limit = config.memory.contextMessages) {
  const current = readCurrent(userId, groupJid);
  if (current.length <= limit) return current;

  const recentCount = Math.ceil(limit * 0.7);
  const recent = current.slice(-recentCount);
  const recentIds = new Set(recent.map((m) => m.id));

  const fromUser = current
    .filter((m) => m.userId === senderJid && !recentIds.has(m.id))
    .slice(-(limit - recent.length));

  return [...fromUser, ...recent].sort((a, b) => a.timestamp - b.timestamp);
}

function getStats(userId, groupJid) {
  const stats = db.getMemoryStats(groupJid, userId);
  return {
    current: stats.current_count,
    limit: config.memory.limit,
    archives: stats.archive_count,
  };
}

module.exports = { appendMessage, getRecent, getRelevantContext, getStats, readCurrent };
