'use strict';

const groqClient = require('../ai/groqClient');
const { buildModerationPrompt } = require('../ai/prompts');
const logger = require('../utils/logger');

// Pré-filtre local volontairement simple et rapide : sert uniquement à décider si
// un message MÉRITE une analyse IA, jamais à sanctionner directement (§27 : éviter
// un appel Groq pour chaque message reçu dans un groupe).
const SUSPECT_PATTERNS = [
  /\b(con|idiot|débile|stupide|merde|pute|salope|batard|nul{2,})\b/i,
  /[A-ZÀ-Ü]{8,}/, // longue séquence en majuscules (agressivité probable)
  /(.)\1{5,}/, // caractère répété excessivement (spam/flood)
];

function looksSuspicious(text) {
  if (!text || text.trim().length < 3) return false;
  return SUSPECT_PATTERNS.some((re) => re.test(text));
}

const EMPTY_DECISION = { violation: false, rule: '', severity: 'low', action: 'none', reason: '' };

function parseDecision(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      violation: !!parsed.violation,
      rule: String(parsed.rule || ''),
      severity: ['low', 'medium', 'high'].includes(parsed.severity) ? parsed.severity : 'low',
      action: parsed.action === 'warning' ? 'warning' : 'none',
      reason: String(parsed.reason || ''),
    };
  } catch (err) {
    logger.warn({ err: err.message, raw: raw?.slice(0, 200) }, 'Réponse de modération IA non parsable — aucune sanction par sécurité');
    return null;
  }
}

/**
 * Analyse un message et propose une décision structurée. Ne sanctionne jamais
 * directement : en cas de doute ou d'échec IA, retourne "aucune violation".
 */
async function evaluateMessage({ text, rules, senderName, forceCheck = false }) {
  if (!forceCheck && !looksSuspicious(text)) return EMPTY_DECISION;

  try {
    const { content } = await groqClient.chatComplete({
      messages: [{ role: 'user', content: buildModerationPrompt({ rules, message: text, senderName }) }],
      jsonMode: true,
      temperature: 0,
      maxTokens: 200,
    });
    const decision = parseDecision(content);
    return decision || EMPTY_DECISION;
  } catch (err) {
    logger.error({ err: err.message }, 'Modération IA indisponible — message laissé passer par sécurité');
    return EMPTY_DECISION;
  }
}

/**
 * Le code applicatif — jamais l'IA — décide de la sanction finale.
 * Retourne { shouldWarn, shouldSanction, newCount }.
 */
function decideAction(decision, currentWarnings, maxWarnings) {
  if (!decision.violation || decision.action !== 'warning') {
    return { shouldWarn: false, shouldSanction: false, newCount: currentWarnings };
  }
  const newCount = currentWarnings + 1;
  return { shouldWarn: true, shouldSanction: newCount >= maxWarnings, newCount };
}

module.exports = { evaluateMessage, decideAction, looksSuspicious };
