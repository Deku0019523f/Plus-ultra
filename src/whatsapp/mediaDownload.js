'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const groupStore = require('../groups/groupStore');

/** Télécharge un message vocal vers le dossier temp/ du groupe et retourne son chemin. */
async function downloadVoiceToTemp(sock, msg, userId, groupJid) {
  const tempDir = path.join(groupStore.groupDir(userId, groupJid), 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const filePath = path.join(tempDir, `voice_${Date.now()}.ogg`);
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
  );
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { downloadVoiceToTemp };
