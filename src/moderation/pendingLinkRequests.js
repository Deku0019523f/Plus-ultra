'use strict';

// État en mémoire uniquement : suit une conversation "demande de permission
// de lien" en cours entre l'agent et un membre. Ouverte automatiquement
// quand un lien est supprimé faute d'autorisation, et le message de refus
// invite le membre à y répondre pour se justifier auprès de l'IA.
const TTL_MS = 15 * 60 * 1000; // 15 min d'inactivité max avant expiration

const pending = new Map(); // `${groupJid}:${memberJid}` -> { link, exchanges, expiresAt }

function key(groupJid, memberJid) {
  return `${groupJid}:${memberJid}`;
}

/** Ouvre (ou réinitialise) une demande pour ce membre, avec le lien concerné. */
function open(groupJid, memberJid, link) {
  pending.set(key(groupJid, memberJid), { link, exchanges: 0, expiresAt: Date.now() + TTL_MS });
}

/** Retourne la demande en cours (ou null si absente/expirée). */
function get(groupJid, memberJid) {
  const k = key(groupJid, memberJid);
  const entry = pending.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return null;
  }
  return entry;
}

/** Incrémente le compteur d'échanges et prolonge la fenêtre d'inactivité. */
function bump(groupJid, memberJid) {
  const entry = pending.get(key(groupJid, memberJid));
  if (!entry) return;
  entry.exchanges += 1;
  entry.expiresAt = Date.now() + TTL_MS;
}

function close(groupJid, memberJid) {
  pending.delete(key(groupJid, memberJid));
}

module.exports = { open, get, bump, close };
