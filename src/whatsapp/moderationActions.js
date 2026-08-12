'use strict';

const groupMeta = require('./groupMeta');
const logger = require('../utils/logger');

const NOT_ADMIN_MSG = '⚠️ Je ne peux pas effectuer cette action car je ne suis pas administrateur du groupe.';

/** Supprime un message pour tout le monde. Vérifie d'abord que le bot est admin. */
async function deleteMessage(sock, groupJid, messageKey) {
  const botIsAdmin = await groupMeta.isBotAdmin(sock, groupJid);
  if (!botIsAdmin) return { ok: false, reason: NOT_ADMIN_MSG };

  try {
    await sock.sendMessage(groupJid, { delete: messageKey });
    return { ok: true };
  } catch (err) {
    logger.warn({ groupJid, err: err.message }, 'Échec suppression de message');
    return { ok: false, reason: 'Erreur lors de la suppression du message.' };
  }
}

/** Expulse un membre du groupe. Vérifie d'abord que le bot est admin et que la cible est présente. */
async function kickMember(sock, groupJid, memberJid) {
  const botIsAdmin = await groupMeta.isBotAdmin(sock, groupJid);
  if (!botIsAdmin) return { ok: false, reason: NOT_ADMIN_MSG };

  try {
    const meta = await groupMeta.getGroupMetadata(sock, groupJid);
    const present = meta.participants.some((p) => p.id === memberJid);
    if (!present) return { ok: false, reason: 'Ce membre ne fait plus partie du groupe.' };

    await sock.groupParticipantsUpdate(groupJid, [memberJid], 'remove');
    groupMeta.invalidateGroupMetadata(groupJid);
    return { ok: true };
  } catch (err) {
    logger.warn({ groupJid, memberJid, err: err.message }, 'Échec expulsion membre');
    return { ok: false, reason: "Erreur lors de l'expulsion du membre." };
  }
}

module.exports = { deleteMessage, kickMember, NOT_ADMIN_MSG };
