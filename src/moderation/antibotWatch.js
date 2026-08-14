'use strict';

// État en mémoire uniquement : après suppression d'une commande destinée à un
// autre bot, on "arme" une courte fenêtre pour supprimer aussi SA réponse
// (qui arrive généralement en quelques secondes, depuis le compte du bot
// tiers — donc un expéditeur DIFFÉRENT de la personne qui a tapé la
// commande). Reste une heuristique, mais ces deux garde-fous éliminent la
// majorité des faux positifs par rapport à un simple "premier message qui
// suit" :
//   1. on exclut explicitement l'auteur de la commande elle-même ;
//   2. on ignore les réactions trop courtes (probablement un vrai membre).
const MIN_CANDIDATE_LEN = 15; // en dessous, trop court pour être une réponse de bot plausible

const armed = new Map(); // groupJid -> { expiresAt, triggerJid }

function jidUser(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

function arm(groupJid, triggerJid, windowMs = 12_000) {
  armed.set(groupJid, { expiresAt: Date.now() + windowMs, triggerJid: jidUser(triggerJid) });
}

/**
 * Consomme (one-shot) la fenêtre si elle est encore active pour ce groupe ET
 * que le message candidat est plausible : pas envoyé par l'auteur de la
 * commande d'origine, et pas trivialement court.
 */
function consume(groupJid, candidateJid, candidateText) {
  const entry = armed.get(groupJid);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    armed.delete(groupJid);
    return false;
  }
  if (jidUser(candidateJid) === entry.triggerJid) return false; // même personne : on ne consomme pas, la fenêtre reste active
  if ((candidateText || '').trim().length < MIN_CANDIDATE_LEN) return false; // réaction trop courte : idem, on laisse la fenêtre active

  armed.delete(groupJid);
  return true;
}

module.exports = { arm, consume };
