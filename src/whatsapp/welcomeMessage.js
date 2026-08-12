'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { commandsListText } = require('../commands/commandHandler');

function buildCaption() {
  const sitesBlock = config.botInfo.sites
    .map((s) => `🔸 *${s.label}* — ${s.desc}`)
    .join('\n');

  return (
    `🤖 *${config.botName}* est maintenant actif !\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ Votre agent de modération WhatsApp est connecté et prêt à protéger et animer vos groupes 24h/24.\n\n` +
    `🌐 *Nos sites :*\n${sitesBlock}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🤖 *Commandes disponibles dans un groupe :*\n${commandsListText()}`
  );
}

/**
 * Envoie le message de bienvenue au numéro qui vient de connecter son compte.
 * Tente d'abord l'image (logo), puis retombe sur du texte seul en cas d'échec
 * (logo indisponible, erreur d'envoi média, etc.) — ne doit jamais faire planter
 * le flux de connexion.
 */
async function sendWelcomeMessage(sock, phoneNumber) {
  if (!phoneNumber) return;
  const selfJid = `${phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
  const caption = buildCaption();

  try {
    await sock.sendMessage(selfJid, { image: { url: config.botInfo.logo }, caption });
    return;
  } catch (err) {
    logger.warn({ err: err.message }, "Échec envoi du message de bienvenue avec logo, repli en texte seul");
  }

  try {
    await sock.sendMessage(selfJid, { text: caption });
  } catch (err) {
    logger.warn({ err: err.message }, 'Message de bienvenue non envoyé');
  }
}

module.exports = { sendWelcomeMessage };
