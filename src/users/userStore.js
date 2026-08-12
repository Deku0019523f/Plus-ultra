'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const db = require('../database/db');

function userDir(userId) {
  // userId est toujours généré en interne (jamais fourni par le client) → sûr pour un chemin.
  return path.join(config.usersDir, userId);
}

function ensureUserDir(userId) {
  const dir = userDir(userId);
  fs.mkdirSync(path.join(dir, 'session'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'groups'), { recursive: true });
  return dir;
}

function userJsonPath(userId) {
  return path.join(userDir(userId), 'user.json');
}

/** Instantané lisible du compte, régénéré à chaque changement d'état. */
function writeUserSnapshot(userId) {
  const user = db.getUserById(userId);
  if (!user) return;
  ensureUserDir(userId);
  const snapshot = {
    userId: user.id,
    phoneNumber: user.phone_number,
    connectionStatus: user.connection_status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
  const file = userJsonPath(userId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snapshot, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function sessionPath(userId) {
  return path.join(userDir(userId), 'session');
}

function groupsRootPath(userId) {
  return path.join(userDir(userId), 'groups');
}

module.exports = {
  userDir,
  ensureUserDir,
  writeUserSnapshot,
  sessionPath,
  groupsRootPath,
};
