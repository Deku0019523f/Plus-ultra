'use strict';

// État en mémoire uniquement : associe un JID sur le point d'être expulsé à
// la raison exacte (avertissements, anti-spam, mot interdit...), pour que le
// message de départ enregistré en mémoire de groupe soit précis plutôt qu'un
// simple "a quitté le groupe". Auto-expire pour ne jamais fuiter si l'event
// WhatsApp n'arrive jamais.
const registry = new Map(); // `${groupJid}:${jid}` -> reason

function key(groupJid, jid) {
  return `${groupJid}:${jid}`;
}

/** Enregistre la raison d'une expulsion sur le point d'être déclenchée. */
function record(groupJid, jid, reason) {
  if (!jid) return;
  const k = key(groupJid, jid);
  registry.set(k, reason);
  const timer = setTimeout(() => registry.delete(k), 10_000);
  timer.unref?.();
}

/** Consomme (et retire) la raison enregistrée pour ce JID, ou null si aucune. */
function consume(groupJid, jid) {
  if (!jid) return null;
  const k = key(groupJid, jid);
  const reason = registry.get(k);
  registry.delete(k);
  return reason || null;
}

module.exports = { record, consume };
