'use strict';

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');
const db = require('../database/db');
const sessionManager = require('../whatsapp/sessionManager');

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

  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Erreur de polling Telegram');
  });

  attachSessionEvents();
  logger.info('Bot Telegram démarré (polling)');
  return bot;
}

module.exports = { start };
