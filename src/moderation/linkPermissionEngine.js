'use strict';

const groqClient = require('../ai/groqClient');
const { buildLinkPermissionPrompt } = require('../ai/prompts');
const logger = require('../utils/logger');

// Au-delà de ce nombre d'échanges sans décision claire, on refuse par
// défaut plutôt que de laisser la conversation traîner indéfiniment.
const MAX_EXCHANGES = 3;

function fallback(reply) {
  return { decision: 'deny', linksAllowed: 0, reply };
}

function parseDecision(raw) {
  try {
    const parsed = JSON.parse(raw);
    const decision = ['grant', 'ask_more', 'deny'].includes(parsed.decision) ? parsed.decision : 'deny';
    const linksAllowed = Number.isFinite(parsed.linksAllowed)
      ? Math.max(1, Math.min(5, Math.round(parsed.linksAllowed)))
      : 1;
    const reply = String(parsed.reply || '').trim().slice(0, 800);
    if (!reply) return null;
    return { decision, linksAllowed, reply };
  } catch (err) {
    logger.warn({ err: err.message, raw: raw?.slice(0, 200) }, 'Décision IA de permission de lien non parsable');
    return null;
  }
}

/**
 * Évalue une demande de permission de lien. Ne modifie jamais l'autorisation
 * elle-même — retourne une décision que l'appelant (messageRouter) exécute :
 * { decision: 'grant'|'ask_more'|'deny', linksAllowed, reply }.
 */
async function evaluate({ rules, link, memberMessage, exchanges }) {
  if (exchanges >= MAX_EXCHANGES) {
    return fallback(
      "Je n'ai pas assez d'éléments clairs pour autoriser ce lien — demande directement à un admin si tu penses que c'est légitime."
    );
  }

  try {
    const { content } = await groqClient.chatComplete({
      messages: [{ role: 'user', content: buildLinkPermissionPrompt({ rules, link, memberMessage }) }],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 300,
    });
    return (
      parseDecision(content) ||
      fallback("Je n'ai pas pu traiter ta demande correctement — réessaie, ou demande à un admin.")
    );
  } catch (err) {
    logger.error({ err: err.message }, 'IA indisponible pour évaluer une permission de lien');
    return fallback('Le service est momentanément indisponible pour traiter ta demande — demande à un admin directement.');
  }
}

module.exports = { evaluate, MAX_EXCHANGES };
