'use strict';

const groqClient = require('./groqClient');
const { buildAgentSystemPrompt, truncate, MAX_USER_MESSAGE_CHARS } = require('./prompts');
const { commandsListText } = require('../commands/commandHandler');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Génère la réponse de l'agent lorsqu'il est mentionné dans un groupe.
 * Retourne null si l'IA est indisponible (dégradation silencieuse, jamais de crash).
 */
async function generateReply({ groupName, rules, userName, relevantMessages, userMessage }) {
  const systemPrompt = buildAgentSystemPrompt({
    botName: config.botName,
    groupName,
    rules,
    userName,
    relevantMessages,
    commandsList: commandsListText(),
  });

  try {
    const { content, model } = await groqClient.chatComplete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: truncate(userMessage, MAX_USER_MESSAGE_CHARS) },
      ],
      temperature: 0.5,
      maxTokens: 400,
    });
    logger.info({ model }, 'Réponse agent générée');
    return content.trim();
  } catch (err) {
    logger.error({ err: err.message }, 'Agent conversationnel indisponible');
    return null;
  }
}

module.exports = { generateReply };
