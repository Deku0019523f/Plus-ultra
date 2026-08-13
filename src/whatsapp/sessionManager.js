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
const reconnectTimers = new Map(); // userId -> setTimeout handle

// Rompt la dépendance circulaire avec messageRouter (chargé au premier message).
let messageRouter = null;
function getMessageRouter() {
  if (!messageRouter) messageRouter = require('./messageRouter');
  return messageRouter;
}

function clearPendingReconnect(userId) {
  if (reconnectTimers.has(userId)) {
    clearTimeout(reconnectTimers.get(userId));
    reconnectTimers.delete(userId);
  }
}

/**
 * Un socket présent dans activeSockets ne signifie pas encore "connecté" :
 * il peut être en cours de pairing/handshake. La seule source fiable est
 * l'état "connected" écrit en base lorsque l'événement 'open' est reçu.
 */
function isConnected(userId) {
  if (!activeSockets.has(userId)) return false;
  return db.getUserById(userId)?.connection_status === 'connected';
}

function getSocket(userId) {
  return activeSockets.get(userId) || null;
}

async function loadAuthState(userId) {
  const sessionPath = userStore.sessionPath(userId);
  return useMultiFileAuthState(sessionPath);
}

/**
 * fetchLatestBaileysVersion() ne lève PAS d'exception si le GitHub raw
 * (source de la version WA Web) est injoignable depuis le VPS : elle retombe
 * silencieusement sur la version figée dans le package (isLatest: false).
 * Une version WA Web obsolète peut faire échouer l'enregistrement du pairing
 * SANS jamais notifier le téléphone — exactement le symptôme observé
 * (code généré, rien ne se passe, timeout 408 après ~2min).
 * On log donc explicitement le résultat, et on permet un override manuel
 * via WA_VERSION si le fetch échoue de façon récurrente.
 */
async function resolveWaVersion() {
  if (config.waVersionOverride) {
    logger.warn(
      { version: config.waVersionOverride },
      'Version WA Web forcée via WA_VERSION (override manuel)'
    );
    return config.waVersionOverride;
  }

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (!isLatest) {
      logger.warn(
        { version },
        'Impossible de confirmer la dernière version WA Web (fetch GitHub probablement bloqué depuis le VPS) — utilisation de la version repliée du package. Si le pairing échoue en boucle, vérifie la connectivité sortante du VPS vers github.com, ou fixe WA_VERSION manuellement.'
      );
    } else {
      logger.info({ version }, 'Version WA Web confirmée à jour');
    }
    return version;
  } catch (err) {
    logger.error({ err: err.message }, 'Échec total de la récupération de version WA Web');
    throw err;
  }
}

const DISCONNECT_REASON_NAMES = {
  [DisconnectReason.badSession]: 'badSession',
  [DisconnectReason.connectionClosed]: 'connectionClosed',
  [DisconnectReason.connectionLost]: 'connectionLost',
  [DisconnectReason.connectionReplaced]: 'connectionReplaced',
  [DisconnectReason.loggedOut]: 'loggedOut',
  [DisconnectReason.multideviceMismatch]: 'multideviceMismatch',
  [DisconnectReason.restartRequired]: 'restartRequired',
  [DisconnectReason.timedOut]: 'timedOut',
};

async function buildSocket(state, saveCreds) {
  const version = await resolveWaVersion();
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
    connectTimeoutMs: 45000,
    defaultQueryTimeoutMs: 45000,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 500,
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

async function createSocket(userId) {
  const { state, saveCreds } = await loadAuthState(userId);
  return buildSocket(state, saveCreds);
}

/**
 * Démarre (ou reprend) la connexion WhatsApp d'un utilisateur et demande un
 * pairing code si la session n'est pas déjà enregistrée.
 */
async function connectWhatsApp(userId, phoneNumber) {
  userStore.ensureUserDir(userId);
  clearPendingReconnect(userId);

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
      // Ce socket est définitivement fermé : ne jamais le laisser trainer dans
      // activeSockets, sous peine de faire croire à une connexion active
      // (isConnected() vérifie aussi le statut DB, mais autant rester propre).
      activeSockets.delete(userId);
      db.updateUserSession(userId, { connectionStatus: 'disconnected' });
      userStore.writeUserSnapshot(userId);
      logger.warn(
        { userId, code, reason: DISCONNECT_REASON_NAMES[code] || 'inconnue' },
        'Connexion WhatsApp fermée'
      );
      events.emit('disconnected', { userId, code });

      if (code === DisconnectReason.loggedOut) {
        clearPendingReconnect(userId);
        reconnectAttempts.delete(userId);
        events.emit('logged_out', { userId });
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        // Redémarrage normal juste après la validation du pairing code par
        // WhatsApp : ce n'est PAS une erreur. Il faut reconnecter IMMÉDIATEMENT
        // (sans backoff ni comptage de tentative) sous peine de bloquer
        // l'appairage sur "Connexion...".
        logger.info({ userId }, 'Redémarrage requis par WhatsApp (fin de pairing) — reconnexion immédiate');
        reconnectAccount(userId);
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

  sock.ev.on('group-participants-update', async (update) => {
    try {
      await getMessageRouter().handleGroupParticipantsUpdate(userId, sock, update);
    } catch (err) {
      logger.error({ userId, err: err.message }, 'Erreur traitement group-participants-update');
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
  const timer = setTimeout(() => reconnectAccount(userId), delay);
  reconnectTimers.set(userId, timer);
}

async function reconnectAccount(userId) {
  clearPendingReconnect(userId);
  const user = db.getUserById(userId);
  if (!user?.phone_number) return;

  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).end(undefined); } catch { /* déjà fermé */ }
    activeSockets.delete(userId);
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    const { state, saveCreds } = await loadAuthState(userId);

    if (!state.creds?.registered) {
      // Session jamais finalisée (pairing jamais entré ou jamais abouti) :
      // il n'y a rien de valide à "reconnecter". Retenter quand même reviendrait
      // à spammer WhatsApp d'une connexion vouée à l'échec (401 quasi instantané)
      // à chaque redémarrage — et ce type de trafic répété est justement ce que
      // WhatsApp détecte comme abusif.
      logger.warn({ userId }, 'Session jamais enregistrée — reconnexion automatique annulée, nouveau pairing requis');
      db.updateUserSession(userId, { connectionStatus: 'failed' });
      userStore.writeUserSnapshot(userId);
      reconnectAttempts.delete(userId);
      return;
    }

    const sock = await buildSocket(state, saveCreds);
    activeSockets.set(userId, sock);
    attachSocketHandlers(userId, sock);
    logger.info({ userId }, 'Compte reconnecté');
  } catch (err) {
    logger.error({ userId, err: err.message }, 'Échec de la reconnexion');
    scheduleReconnect(userId);
  }
}

function disconnectAccount(userId) {
  clearPendingReconnect(userId);
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
