'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');
const db = require('../database/db');
const sessionManager = require('../whatsapp/sessionManager');
const customCommands = require('../commands/customCommands');

let bot = null;

// chatId (string) -> true pendant qu'un pairing est en cours, pour éviter les doubles clics
const pairingInProgress = new Set();

function statusLabel(status) {
  switch (status) {
    case 'connected':
      return '✅ connecté';
    case 'pending':
      return '🟡 en attente de pairing';
    case 'failed':
      return '❌ échec';
    default:
      return '⚪ déconnecté';
  }
}

function formatPairingCode(code) {
  // Baileys renvoie un code à 8 caractères ; on l'affiche en "XXXX-XXXX" comme dans WhatsApp
  if (code.length === 8) return `${code.slice(0, 4)}-${code.slice(4)}`;
  return code;
}

/** Comparaison à temps constant, pour ne pas laisser fuiter le code par timing. */
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Seul ce chat Telegram (configuré une fois, en .env) peut gérer les commandes personnalisées. */
function isOwner(chatId) {
  return !!config.telegram.ownerChatId && String(chatId) === String(config.telegram.ownerChatId);
}

async function handleStart(chatId) {
  const user = db.findOrCreateUserByTelegramChatId(chatId);
  await bot.sendMessage(
    chatId,
    `Bienvenue sur *${config.botName}* 🤖\n\n` +
      `Ton compte est prêt (id: \`${user.id}\`).\n\n` +
      `Pour connecter ton WhatsApp, envoie :\n` +
      `\`/connect +225XXXXXXXXXX\`\n\n` +
      `Autres commandes :\n` +
      `/status — voir l'état de ta connexion WhatsApp\n` +
      `/disconnect — déconnecter ton WhatsApp`,
    { parse_mode: 'Markdown' }
  );
}

async function handleConnect(chatId, phoneArg) {
  const chatKey = String(chatId);
  if (!phoneArg) {
    await bot.sendMessage(chatId, 'Utilisation : /connect +225XXXXXXXXXX');
    return;
  }
  if (pairingInProgress.has(chatKey)) {
    await bot.sendMessage(chatId, 'Un pairing est déjà en cours, patiente un instant.');
    return;
  }

  const user = db.findOrCreateUserByTelegramChatId(chatId);
  pairingInProgress.add(chatKey);
  await bot.sendMessage(chatId, '⏳ Génération du code de pairing...');

  try {
    const { pairingCode } = await sessionManager.connectWhatsApp(user.id, phoneArg);

    if (pairingCode === 'ALREADY_REGISTERED') {
      await bot.sendMessage(chatId, '✅ Ta session WhatsApp est déjà enregistrée et en cours de reconnexion.');
      return;
    }

    await bot.sendMessage(
      chatId,
      `📲 Ton code de pairing : *${formatPairingCode(pairingCode)}*\n\n` +
        `Sur ton téléphone : WhatsApp → Appareils liés → Lier un appareil → ` +
        `Lier avec le numéro de téléphone → entre ce code.\n\n` +
        `⚠️ Le code expire rapidement, entre-le sans attendre. Je te préviens ici dès que c'est connecté.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'Échec /connect Telegram');
    await bot.sendMessage(chatId, `❌ Erreur lors de la génération du code : ${err.message}`);
  } finally {
    pairingInProgress.delete(chatKey);
  }
}

async function handleStatus(chatId) {
  const user = db.getUserByTelegramChatId(chatId);
  if (!user) {
    await bot.sendMessage(chatId, "Aucun compte lié pour l'instant. Envoie /start pour commencer.");
    return;
  }
  await bot.sendMessage(
    chatId,
    `Statut WhatsApp : ${statusLabel(user.connection_status)}\n` +
      `Numéro : ${user.phone_number || '—'}`
  );
}

async function handleDisconnect(chatId) {
  const user = db.getUserByTelegramChatId(chatId);
  if (!user) {
    await bot.sendMessage(chatId, "Aucun compte lié pour l'instant.");
    return;
  }
  sessionManager.disconnectAccount(user.id);
  await bot.sendMessage(chatId, '🔌 WhatsApp déconnecté.');
}

/** Relaie en Telegram les évènements de connexion émis par sessionManager. */
function attachSessionEvents() {
  sessionManager.events.on('connected', ({ userId }) => {
    const user = db.getUserById(userId);
    if (user?.telegram_chat_id) {
      bot.sendMessage(user.telegram_chat_id, '✅ WhatsApp connecté avec succès !').catch(() => {});
    }
  });

  sessionManager.events.on('logged_out', ({ userId }) => {
    const user = db.getUserById(userId);
    if (user?.telegram_chat_id) {
      bot
        .sendMessage(user.telegram_chat_id, '🚪 Ta session WhatsApp a été déconnectée depuis le téléphone (logout). Utilise /connect pour relier.')
        .catch(() => {});
    }
  });

  sessionManager.events.on('reconnect_failed', ({ userId }) => {
    const user = db.getUserById(userId);
    if (user?.telegram_chat_id) {
      bot
        .sendMessage(user.telegram_chat_id, "❌ Échec de reconnexion WhatsApp après plusieurs tentatives. Utilise /connect pour réessayer.")
        .catch(() => {});
    }
  });
}

/**
 * Réception d'un fichier .js envoyé en pièce jointe : n'est traité QUE si
 * (1) le chat est le propriétaire configuré (TELEGRAM_OWNER_CHAT_ID) ET
 * (2) la légende du fichier contient le code d'accès exact
 *     (TELEGRAM_UPLOAD_CODE) — format attendu : "code: xxxxx" dans la légende.
 * Sans les deux, le fichier est ignoré silencieusement (aucune confirmation
 * qui laisserait deviner que cette fonction existe).
 */
async function handleDocument(msg) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (!doc || !doc.file_name?.endsWith('.js')) return;

  if (!isOwner(chatId)) return; // silence total : ne révèle même pas que la fonction existe

  if (!config.telegram.uploadCode) {
    await bot.sendMessage(chatId, "⚠️ TELEGRAM_UPLOAD_CODE n'est pas configuré côté serveur — upload refusé par sécurité.");
    return;
  }

  const captionMatch = (msg.caption || '').match(/code\s*[:=]\s*(\S+)/i);
  const providedCode = captionMatch?.[1];
  if (!providedCode || !safeEquals(providedCode, config.telegram.uploadCode)) {
    await bot.sendMessage(chatId, '❌ Code d\'accès manquant ou incorrect (légende attendue : "code: TON_CODE").');
    return;
  }

  let tmpFilePath;
  try {
    tmpFilePath = await bot.downloadFile(doc.file_id, os.tmpdir());
    const source = fs.readFileSync(tmpFilePath, 'utf8');

    if (source.length > 200_000) {
      await bot.sendMessage(chatId, '❌ Fichier trop volumineux (limite 200 Ko) — refusé par prudence.');
      return;
    }

    const result = await customCommands.installFromSource(source);
    if (!result.ok) {
      await bot.sendMessage(chatId, `❌ Installation refusée :\n\n${result.error}`);
      return;
    }

    const riskLines = result.riskyApis?.length
      ? `\n\n⚠️ *API sensibles détectées* (à vérifier avant de faire confiance à cette commande) :\n${result.riskyApis.map((r) => `• ${r}`).join('\n')}`
      : '';

    await bot.sendMessage(
      chatId,
      `✅ Commande *${result.name}* installée et active immédiatement (hash \`${result.hash}\`).\n` +
        `${result.replaced ? "Une version précédente existait — sauvegardée, restaurable via /rollback.\n" : ''}` +
        riskLines,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'Échec traitement upload commande personnalisée');
    await bot.sendMessage(chatId, `❌ Erreur pendant le traitement : ${err.message}`);
  } finally {
    if (tmpFilePath) fs.unlink(tmpFilePath, () => {});
  }
}

async function handleListCommands(chatId) {
  if (!isOwner(chatId)) return;
  const list = customCommands.list();
  if (!list.length) {
    await bot.sendMessage(chatId, 'Aucune commande personnalisée installée.');
    return;
  }
  const lines = list.map((c) => `*${c.name}*${c.adminOnly ? ' (admin)' : ''} — ${c.description}`);
  await bot.sendMessage(chatId, `📦 Commandes personnalisées :\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

async function handleRemoveCommand(chatId, name) {
  if (!isOwner(chatId)) return;
  if (!name) {
    await bot.sendMessage(chatId, 'Usage : /remove_command .nomdelacommande');
    return;
  }
  const removed = await customCommands.remove(name);
  await bot.sendMessage(
    chatId,
    removed
      ? `🗑️ *${name}* désinstallée (sauvegardée, restaurable via /rollback).`
      : `Aucune commande personnalisée nommée "${name}".`,
    { parse_mode: 'Markdown' }
  );
}

async function handleRollback(chatId, name) {
  if (!isOwner(chatId)) return;
  if (!name) {
    await bot.sendMessage(chatId, 'Usage : /rollback .nomdelacommande');
    return;
  }
  const result = await customCommands.rollback(name);
  if (!result.ok) {
    await bot.sendMessage(chatId, `❌ ${result.error}`);
    return;
  }
  await bot.sendMessage(chatId, `↩️ *${result.name}* restaurée à sa version précédente.`, { parse_mode: 'Markdown' });
}

function start() {
  if (!config.telegram.botToken) {
    logger.info('TELEGRAM_BOT_TOKEN non défini — bot Telegram désactivé');
    return null;
  }

  bot = new TelegramBot(config.telegram.botToken, { polling: true });

  bot.onText(/^\/start$/, (msg) => handleStart(msg.chat.id));
  bot.onText(/^\/connect(?:\s+(.+))?$/, (msg, match) => handleConnect(msg.chat.id, match[1]?.trim()));
  bot.onText(/^\/status$/, (msg) => handleStatus(msg.chat.id));
  bot.onText(/^\/disconnect$/, (msg) => handleDisconnect(msg.chat.id));
  bot.onText(/^\/commands$/, (msg) => handleListCommands(msg.chat.id));
  bot.onText(/^\/remove_command(?:\s+(\S+))?$/, (msg, match) => handleRemoveCommand(msg.chat.id, match[1]));
  bot.onText(/^\/rollback(?:\s+(\S+))?$/, (msg, match) => handleRollback(msg.chat.id, match[1]));
  bot.on('document', (msg) => handleDocument(msg).catch((err) => logger.error({ err: err.message }, 'Erreur handleDocument')));

  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Erreur de polling Telegram');
  });

  attachSessionEvents();
  logger.info('Bot Telegram démarré (polling)');
  return bot;
}

module.exports = { start };
