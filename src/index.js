'use strict';

require('./database/db'); // initialise le schéma SQLite au démarrage
const logger = require('./utils/logger');
const server = require('./api/server');
const sessionManager = require('./whatsapp/sessionManager');
const telegramBot = require('./telegram/telegramBot');
const customCommands = require('./commands/customCommands');

async function main() {
  try {
    customCommands.loadAllFromDisk();
  } catch (err) {
    logger.error({ err: err.message }, 'Erreur au chargement des commandes personnalisées — le serveur continue');
  }

  server.start();

  try {
    telegramBot.start();
  } catch (err) {
    logger.error({ err: err.message }, 'Erreur au démarrage du bot Telegram — le serveur continue');
  }

  try {
    await sessionManager.restoreAllSessions();
  } catch (err) {
    logger.error({ err: err.message }, 'Erreur pendant la restauration des sessions — le serveur continue');
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason?.message || reason }, 'Rejet de promesse non géré');
});

process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Exception non interceptée — le processus continue');
});

function shutdown(signal) {
  logger.info({ signal }, "Arrêt d'Ultra Agent...");
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
