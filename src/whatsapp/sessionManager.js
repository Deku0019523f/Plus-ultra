'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { EventEmitter } = require('events');

const config = require('../config/config');
const logger = require('../utils/logger');
const db = require('../database/db');
const userStore = require('../users/userStore');
const { cleanPhoneDigits } = require('../utils/jid');
const { sendWelcomeMessage } = require('./welcomeMessage');

const events = new EventEmitter();
const activeSockets = new Map(); // userId -> sock
const reconnectAttempts = new Map(); // userId -> count

// Rompt la dépendance circulaire avec messageRouter (chargé au premier message).
let messageRouter = null;
function getMessageRouter() {
  if (!messageRouter) messageRouter = require('./messageRouter');
  return messageRouter;
}

function isConnected(userId) {
  return activeSockets.has(userId);
}

function getSocket(userId) {
  return activeSockets.get(userId) || null;
}

async function createSocket(userId) {
  const sessionPath = userStore.sessionPath(userId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  const baileysLogger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: config.browser,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 20000,
    defaultQueryTimeoutMs: 20000,
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

/**
 * Démarre (ou reprend) la connexion WhatsApp d'un utilisateur et demande un
 * pairing code si la session n'est pas déjà enregistrée.
 */
async function connectWhatsApp(userId, phoneNumber) {
  userStore.ensureUserDir(userId);

  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).end(undefined); } catch { /* déjà fermé */ }
    activeSockets.delete(userId);
    await new Promise((r) => setTimeout(r, 800));
  }
  reconnectAttempts.delete(userId);

  const sock = await createSocket(userId);
  activeSockets.set(userId, sock);
  attachSocketHandlers(userId, sock);

  db.updateUserSession(userId, {
    phoneNumber,
    sessionPath: userStore.sessionPath(userId),
    connectionStatus: 'pending',
  });
  userStore.writeUserSnapshot(userId);

  // Laisse le socket s'initialiser avant de vérifier l'état d'enregistrement,
  // comme observé sur whatsapp-bot-v2 (évite un pairing code demandé à tort).
  await new Promise((r) => setTimeout(r, 3000));

  if (sock.authState?.creds?.registered) {
    logger.info({ userId }, 'Session déjà enregistrée, pas de nouveau pairing code');
    return { pairingCode: 'ALREADY_REGISTERED' };
  }

  const clean = cleanPhoneDigits(phoneNumber);
  if (!clean) throw new Error('Numéro de téléphone invalide');

  let pairingCode;
  try {
    pairingCode = await sock.requestPairingCode(clean);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Échec pairing code, nouvelle tentative...');
    await new Promise((r) => setTimeout(r, 2000));
    pairingCode = await sock.requestPairingCode(clean);
  }

  if (!pairingCode) throw new Error('Pairing code vide');
  logger.info({ userId }, 'Pairing code généré');
  return { pairingCode };
}

function attachSocketHandlers(userId, sock) {
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      logger.info({ userId }, 'WhatsApp connecté');
      db.updateUserSession(userId, { connectionStatus: 'connected' });
      userStore.writeUserSnapshot(userId);
      reconnectAttempts.delete(userId);
      events.emit('connected', { userId });

      const user = db.getUserById(userId);
      sendWelcomeMessage(sock, user?.phone_number).catch((err) =>
        logger.warn({ userId, err: err.message }, 'Erreur inattendue message de bienvenue')
      );
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      db.updateUserSession(userId, { connectionStatus: 'disconnected' });
      userStore.writeUserSnapshot(userId);
      logger.warn({ userId, code }, 'Connexion WhatsApp fermée');
      events.emit('disconnected', { userId, code });

      if (code === DisconnectReason.loggedOut) {
        activeSockets.delete(userId);
        reconnectAttempts.delete(userId);
        events.emit('logged_out', { userId });
        return;
      }

      scheduleReconnect(userId);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (isJidBroadcast(msg.key.remoteJid || '')) continue;
        await getMessageRouter().handleMessage(userId, sock, msg);
      } catch (err) {
        // Une erreur sur un message ne doit jamais interrompre le traitement des autres.
        logger.error({ userId, err: err.message }, 'Erreur de traitement message');
      }
    }
  });
}

function scheduleReconnect(userId) {
  const attempts = (reconnectAttempts.get(userId) || 0) + 1;
  reconnectAttempts.set(userId, attempts);

  if (attempts > config.reconnect.maxAttempts) {
    reconnectAttempts.delete(userId);
    db.updateUserSession(userId, { connectionStatus: 'failed' });
    userStore.writeUserSnapshot(userId);
    logger.error({ userId }, 'Nombre maximal de tentatives de reconnexion atteint');
    events.emit('reconnect_failed', { userId });
    return;
  }

  const delay = Math.min(config.reconnect.baseDelayMs * attempts, config.reconnect.maxDelayMs);
  logger.info({ userId, attempt: attempts, delayMs: delay }, 'Reconnexion planifiée');
  setTimeout(() => reconnectAccount(userId), delay);
}

async function reconnectAccount(userId) {
  const user = db.getUserById(userId);
  if (!user?.phone_number) return;

  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).end(undefined); } catch { /* déjà fermé */ }
    activeSockets.delete(userId);
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    const sock = await createSocket(userId);
    activeSockets.set(userId, sock);
    attachSocketHandlers(userId, sock);
    logger.info({ userId }, 'Compte reconnecté');
  } catch (err) {
    logger.error({ userId, err: err.message }, 'Échec de la reconnexion');
    scheduleReconnect(userId);
  }
}

function disconnectAccount(userId) {
  reconnectAttempts.delete(userId);
  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).end(undefined); } catch { /* déjà fermé */ }
    activeSockets.delete(userId);
  }
  db.updateUserSession(userId, { connectionStatus: 'disconnected' });
  userStore.writeUserSnapshot(userId);
}

/** Recharge toutes les sessions connues au démarrage du serveur. */
async function restoreAllSessions() {
  const users = db.listUsersWithSessions();
  logger.info({ count: users.length }, 'Restauration des sessions WhatsApp...');
  for (const user of users) {
    try {
      await reconnectAccount(user.id);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      logger.warn({ userId: user.id, err: err.message }, 'Échec de restauration de session');
    }
  }
}

module.exports = {
  events,
  connectWhatsApp,
  disconnectAccount,
  reconnectAccount,
  restoreAllSessions,
  isConnected,
  getSocket,
};
