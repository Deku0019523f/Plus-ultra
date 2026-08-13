'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { isGroupJid, jidToPhone, normalizeJid, allMentionedJids, resolveToPhoneJid } = require('../utils/jid');

const groupStore = require('../groups/groupStore');
const warnings = require('../groups/warnings');
const linkAuth = require('../groups/linkAuth');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('./groupMeta');
const moderationActions = require('./moderationActions');
const antiLink = require('../moderation/antiLink');
const moderationEngine = require('../moderation/moderationEngine');
const agent = require('../ai/agent');
const tts = require('../ai/tts');
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

function randomDelayMs(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rassemble tous les identifiants plausibles du bot lui-même (numéro + LID). */
function botCandidateIds(sock) {
  const candidates = new Set();
  const add = (jid) => {
    const u = jidToPhone(jid);
    if (u) candidates.add(u);
  };
  add(sock.user?.id);
  add(sock.user?.lid);
  return candidates;
}

/**
 * Détermine si un JID donné désigne le bot, en tentant d'abord une
 * correspondance directe puis, si besoin, une résolution LID<->numéro via le
 * repository Baileys (nécessaire depuis le système LID de WhatsApp, où un
 * même compte peut être désigné par deux formats différents selon le
 * contexte).
 */
async function jidIsBot(sock, jid, botCandidates) {
  if (!jid) return false;
  if (botCandidates.has(jidToPhone(jid))) return true;

  const mapping = sock?.signalRepository?.lidMapping;
  if (!mapping) return false;
  try {
    let alt = null;
    if (jid.endsWith('@lid') && mapping.getPNForLID) alt = await mapping.getPNForLID(jid);
    else if (jid.endsWith('@s.whatsapp.net') && mapping.getLIDForPN) alt = await mapping.getLIDForPN(jid);
    return !!alt && botCandidates.has(jidToPhone(alt));
  } catch {
    return false;
  }
}

/**
 * Comme pour isSenderAdmin, une mention peut arriver sous forme de LID alors
 * que sock.user.id est un numéro (ou l'inverse) — une simple comparaison de
 * chaîne rate alors la mention. On rassemble donc tous les identifiants
 * plausibles du bot et on tente en plus une résolution LID<->numéro via le
 * repository Baileys si le format ne correspond à aucun candidat direct.
 */
async function botIsMentioned(sock, message) {
  const mentioned = allMentionedJids(message);
  if (!mentioned.length) return false;
  const botCandidates = botCandidateIds(sock);
  for (const raw of mentioned) {
    if (await jidIsBot(sock, raw, botCandidates)) return true;
  }
  return false;
}

/** Extrait le contextInfo (métadonnées de citation) quel que soit le type de message. */
function getContextInfo(message) {
  return (
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    message?.audioMessage?.contextInfo ||
    null
  );
}

/** Vrai si le message est une réponse (quote) directe à un message envoyé par le bot. */
async function isReplyToBot(sock, message) {
  const ctx = getContextInfo(message);
  if (!ctx?.quotedMessage || !ctx?.participant) return false;
  return jidIsBot(sock, ctx.participant, botCandidateIds(sock));
}

async function handleMessage(userId, sock, msg) {
  const groupJid = msg.key.remoteJid || '';
  if (!isGroupJid(groupJid)) return; // Ultra Agent ne traite que les groupes

  const senderJid = msg.key.fromMe
    ? normalizeJid(sock.user?.id)
    : msg.key.participant || groupJid;
  // Numéro canonique (résolu depuis un éventuel LID) : utilisé comme clé DB
  // (liens/avertissements) et pour l'affichage @mention, afin que la même
  // personne soit toujours reconnue quel que soit le format sous lequel
  // WhatsApp présente l'expéditeur.
  const senderPhoneJid = await resolveToPhoneJid(sock, senderJid);
  const senderName = msg.pushName || jidToPhone(senderPhoneJid);

  const message = msg.message;
  if (!message) return;

  const text = extractText(message);
  const isVoice = isVoiceMessage(message);

  // ── Détection admin (nécessaire pour les commandes ET les exemptions) ─────
  const isAdmin = await groupMeta.isSenderAdmin(sock, groupJid, senderJid, msg);

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
      const { allowed } = linkAuth.consume(groupJid, userId, senderPhoneJid, linkCount);
      if (!allowed) {
        const result = await moderationActions.deleteMessage(sock, groupJid, msg.key);
        if (result.ok) {
          await sock.sendMessage(groupJid, {
            text: `🔗 Lien supprimé — @${jidToPhone(senderPhoneJid)} n'est pas autorisé à envoyer de lien ici.`,
            mentions: [senderPhoneJid],
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
    const mentioned = await botIsMentioned(sock, message);
    const repliedToBot = mentioned ? false : await isReplyToBot(sock, message);
    if (mentioned || repliedToBot) {
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
        const delay = randomDelayMs(config.aiReply.delayMinMs, config.aiReply.delayMaxMs);
        await sleep(delay);

        let sentAsVoice = false;
        if (config.aiReply.voiceEnabled) {
          try {
            const audio = await tts.synthesizeFrenchVoiceNote(responseText);
            if (audio) {
              await sock.sendMessage(
                groupJid,
                { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true },
                { quoted: msg }
              );
              sentAsVoice = true;
            }
          } catch (err) {
            logger.warn({ groupJid, err: err.message }, 'Échec synthèse vocale — repli en texte');
          }
        }
        if (!sentAsVoice) {
          await sock.sendMessage(groupJid, { text: responseText }, { quoted: msg });
        }
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
      warnings.get(groupJid, userId, senderPhoneJid),
      group.max_warnings
    );

    if (action.shouldWarn) {
      warnings.warn(groupJid, userId, senderPhoneJid, group.max_warnings);
      if (!action.shouldSanction) {
        await sock.sendMessage(groupJid, {
          text: `⚠️ @${jidToPhone(senderPhoneJid)} — ${decision.reason || 'règlement non respecté'} (${action.newCount}/${group.max_warnings})`,
          mentions: [senderPhoneJid],
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: `🚫 SANCTION\n\n@${jidToPhone(senderPhoneJid)} a atteint ${action.newCount}/${group.max_warnings} avertissements.\n\nLe membre va être retiré du groupe.`,
          mentions: [senderPhoneJid],
        });
        const result = await moderationActions.kickMember(sock, groupJid, senderJid);
        if (!result.ok) await sock.sendMessage(groupJid, { text: result.reason });
      }
    }
  }
}

module.exports = { handleMessage };
