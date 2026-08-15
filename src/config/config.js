'use strict';

require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim()
  ? process.env.DATA_DIR
  : path.join(ROOT, 'data');

function splitList(value, fallback) {
  const raw = (value && value.trim()) || fallback;
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  dataDir,
  usersDir: path.join(dataDir, 'users'),
  dbPath: (process.env.DB_PATH && process.env.DB_PATH.trim()) || path.join(dataDir, 'ultra-agent.sqlite'),

  botName: process.env.BOT_NAME || 'Ultra Agent',
  commandPrefix: '.',
  browser: ['Ubuntu', 'Chrome', '22.04.4'],

  // Si le VPS ne peut pas joindre GitHub pour vérifier la dernière version WA Web,
  // fetchLatestBaileysVersion() retombe silencieusement sur une version repliée
  // (voir sessionManager.resolveWaVersion). En cas d'échecs de pairing répétés,
  // fixer ici une version connue-fonctionnelle, ex: WA_VERSION=2,3000,1023223821
  waVersionOverride: process.env.WA_VERSION
    ? process.env.WA_VERSION.split(',').map((n) => parseInt(n.trim(), 10))
    : null,

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Seul ce chat Telegram peut envoyer de nouvelles commandes personnalisées.
    ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID || '',
    // Code d'accès exigé en légende du fichier envoyé, en plus de l'ID ci-dessus.
    uploadCode: process.env.TELEGRAM_UPLOAD_CODE || '',
  },

  botInfo: {
    logo: process.env.BOT_LOGO_URL || 'https://raw.githubusercontent.com/Deku0019523f/Deku-Analyse/main/Logo.png',
    sites: [
      { label: 'Premium225.shop', desc: 'plateforme de vente en ligne' },
      { label: 'Boostapi.store', desc: 'abonnés, likes & vues' },
      { label: 'Mrateliers.store', desc: 'crée ta boutique en ligne' },
    ],
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    textModels: splitList(
      process.env.GROQ_TEXT_MODELS,
      // llama-3.3-70b-versatile, llama-3.1-8b-instant et llama-4-scout ont été
      // dépréciés par Groq (annonce du 17/06/2026) — remplacés par leurs
      // successeurs recommandés (openai/gpt-oss-* et qwen3.6-27b).
      'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b,openai/gpt-oss-safeguard-20b'
    ),
    voiceModel: process.env.GROQ_VOICE_MODEL || 'whisper-large-v3',
  },

  memory: {
    limit: parseInt(process.env.MEMORY_LIMIT, 10) || 1000,
    contextMessages: parseInt(process.env.MEMORY_CONTEXT_MESSAGES, 10) || 25,
  },

  moderation: {
    // Seuil général (antibot, anti-spam, anti-média, liste noire, .warn manuel, modération IA).
    maxWarnings: parseInt(process.env.MAX_WARNINGS, 10) || 5,
    // Seuil spécifique aux liens non autorisés — reste plus strict par défaut.
    linkMaxWarnings: parseInt(process.env.MAX_LINK_WARNINGS, 10) || 3,
  },

  // Délai aléatoire avant l'envoi d'une réponse conversationnelle de l'agent,
  // pour éviter un timing instantané trop "robot". Défaut : 10-60s.
  aiReply: {
    delayMinMs: parseInt(process.env.AI_REPLY_DELAY_MIN_MS, 10) || 10000,
    delayMaxMs: parseInt(process.env.AI_REPLY_DELAY_MAX_MS, 10) || 60000,
    // Si activé, la réponse de l'agent est envoyée en vocal (TTS français)
    // au lieu du texte, via l'endpoint public non-officiel de Google Translate.
    voiceEnabled: process.env.AI_VOICE_REPLY === 'true',
  },

  reconnect: {
    maxAttempts: 5,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
  },
};
