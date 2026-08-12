'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { isGroupJid, jidToPhone, normalizeJid, allMentionedJids } = require('../utils/jid');

const groupStore = require('../groups/groupStore');
const warnings = require('../groups/warnings');
const linkAuth = require('../groups/linkAuth');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('./groupMeta');
const moderationActions = require('./moderationActions');
const antiLink = require('../moderation/antiLink');
const moderationEngine = require('../moderation/moderationEngine');
const agent = require('../ai/agent');
const { transcribeAndCleanup } = require('../ai/transcription');
const { downloadVoiceToTemp } = require('./mediaDownload');
const commandHandler = require('../commands/commandHandler');

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ''
  );
}

function isVoiceMessage(message) {
  return !!message?.audioMessage;
}

function botIsMentioned(message, botPhone) {
  const mentioned = allMentionedJids(message).map(jidToPhone);
  return mentioned.includes(botPhone);
}

async function handleMessage(userId, sock, msg) {
  const groupJid = msg.key.remoteJid || '';
  if (!isGroupJid(groupJid)) return; // Ultra Agent ne traite que les groupes

  const senderJid = msg.key.fromMe
    ? normalizeJid(sock.user?.id)
    : msg.key.participant || groupJid;
  const senderName = msg.pushName || jidToPhone(senderJid);

  const message = msg.message;
  if (!message) return;

  const text = extractText(message);
  const isVoice = isVoiceMessage(message);

  // ── Détection admin (nécessaire pour les commandes ET les exemptions) ─────
  const isAdmin = await groupMeta.isSenderAdmin(sock, groupJid, senderJid);

  // ── 1. Commandes (fonctionnent même si le groupe n'est pas encore activé,
  //      puisque .plus_ultra sert justement à l'activer) ──────────────────
  const parsed = commandHandler.parseCommand(text);
  if (parsed) {
    const handled = await commandHandler.handleCommand({
      sock,
      userId,
      groupJid,
      senderJid,
      isAdmin,
      parsed: { ...parsed, message },
    });
    if (handled) return;
  }

  // ── 2. Le groupe doit être activé pour tout le reste du pipeline ─────────
  const group = groupStore.getOwnedGroup(userId, groupJid);
  if (!group || !group.enabled) return;

  // ── 3. Anti-liens (déterministe, aucun appel IA) ─────────────────────────
  if (group.anti_link_enabled && !isAdmin && text) {
    const linkCount = antiLink.countLinks(text);
    if (linkCount > 0) {
      const { allowed } = linkAuth.consume(groupJid, userId, senderJid, linkCount);
      if (!allowed) {
        const result = await moderationActions.deleteMessage(sock, groupJid, msg.key);
        if (result.ok) {
          await sock.sendMessage(groupJid, {
            text: `🔗 Lien supprimé — @${jidToPhone(senderJid)} n'est pas autorisé à envoyer de lien ici.`,
          });
        }
        return; // message supprimé : on ne le mémorise pas, on ne le modère pas davantage
      }
    }
  }

  // ── 4. Transcription vocale ───────────────────────────────────────────────
  let transcription = null;
  if (isVoice) {
    try {
      const audioPath = await downloadVoiceToTemp(sock, msg, userId, groupJid);
      transcription = await transcribeAndCleanup(audioPath);
    } catch (err) {
      logger.warn({ groupJid, err: err.message }, 'Échec traitement message vocal');
    }
  }

  // ── 5. Mémoire du groupe ──────────────────────────────────────────────────
  const memoryEntry = {
    id: msg.key.id,
    userId: senderJid,
    name: senderName,
    type: isVoice ? 'audio' : 'text',
    content: isVoice ? '' : text,
    transcription: transcription || undefined,
    timestamp: (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
  };
  if (memoryEntry.content || memoryEntry.transcription) {
    memoryManager.appendMessage(userId, groupJid, memoryEntry, group.memory_limit);
  }

  const effectiveText = isVoice ? (transcription || '') : text;
  if (!effectiveText) return;

  // ── 6. Mention de l'agent → réponse conversationnelle ────────────────────
  if (group.ai_enabled) {
    const botPhone = jidToPhone(normalizeJid(sock.user?.id));
    if (botIsMentioned(message, botPhone)) {
      const relevantMessages = memoryManager.getRelevantContext(userId, groupJid, senderJid);
      const groupName = await groupMeta.getGroupName(sock, groupJid);
      const responseText = await agent.generateReply({
        groupName,
        rules: group.rules,
        userName: senderName,
        relevantMessages,
        userMessage: effectiveText,
      });
      if (responseText) {
        await sock.sendMessage(groupJid, { text: responseText }, { quoted: msg });
      }
      return; // une mention ne déclenche pas aussi une analyse de modération
    }
  }

  // ── 7. Modération IA (seulement pour les membres, pas les admins) ────────
  if (group.ai_enabled && !isAdmin) {
    const decision = await moderationEngine.evaluateMessage({
      text: effectiveText,
      rules: group.rules,
      senderName,
    });

    const action = moderationEngine.decideAction(
      decision,
      warnings.get(groupJid, userId, senderJid),
      group.max_warnings
    );

    if (action.shouldWarn) {
      warnings.warn(groupJid, userId, senderJid, group.max_warnings);
      if (!action.shouldSanction) {
        await sock.sendMessage(groupJid, {
          text: `⚠️ @${jidToPhone(senderJid)} — ${decision.reason || 'règlement non respecté'} (${action.newCount}/${group.max_warnings})`,
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: `🚫 SANCTION\n\n@${jidToPhone(senderJid)} a atteint ${action.newCount}/${group.max_warnings} avertissements.\n\nLe membre va être retiré du groupe.`,
        });
        const result = await moderationActions.kickMember(sock, groupJid, senderJid);
        if (!result.ok) await sock.sendMessage(groupJid, { text: result.reason });
      }
    }
  }
}

module.exports = { handleMessage };
