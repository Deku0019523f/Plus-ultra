'use strict';

const config = require('../config/config');
const logger = require('../utils/logger');
const { isGroupJid, jidToPhone, normalizeJid, allMentionedJids, resolveToPhoneJid } = require('../utils/jid');

const groupStore = require('../groups/groupStore');
const warnings = require('../groups/warnings');
const linkAuth = require('../groups/linkAuth');
const mutes = require('../groups/mutes');
const blacklist = require('../groups/blacklist');
const antiSpam = require('../moderation/antiSpam');
const antibotWatch = require('../moderation/antibotWatch');
const kickReasons = require('../moderation/kickReasons');
const customCommands = require('../commands/customCommands');
const pendingLinkRequests = require('../moderation/pendingLinkRequests');
const linkPermissionEngine = require('../moderation/linkPermissionEngine');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('./groupMeta');
const moderationActions = require('./moderationActions');
const antiLink = require('../moderation/antiLink');
const moderationEngine = require('../moderation/moderationEngine');
const templates = require('./templates');
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

/**
 * Fait évaluer une demande de permission de lien par l'IA et applique sa
 * décision (grant/ask_more/deny) — utilisée aussi bien pour une demande
 * proactive (lien envoyé en mentionnant l'agent, jamais compté comme
 * infraction) que pour la suite d'une conversation ouverte après suppression
 * d'un lien non autorisé.
 */
async function resolveLinkPermission({ sock, userId, groupJid, senderJid, senderPhoneJid, link, memberMessage, exchanges }) {
  const relevantMessages = memoryManager.getRelevantContext(userId, groupJid, senderJid);
  const groupName = await groupMeta.getGroupName(sock, groupJid);
  const group = groupStore.getOwnedGroup(userId, groupJid);

  const decision = await linkPermissionEngine.evaluate({
    groupName,
    rules: group?.rules,
    relevantMessages,
    link,
    memberMessage,
    exchanges,
  });

  const mentionText = `@${jidToPhone(senderPhoneJid)}`;
  if (decision.decision === 'grant') {
    linkAuth.authorize(groupJid, userId, senderPhoneJid, decision.linksAllowed, 'agent-ia');
    pendingLinkRequests.close(groupJid, senderPhoneJid);
    await sock.sendMessage(groupJid, {
      text: `✅ ${mentionText} ${decision.reply}\n\n(${decision.linksAllowed} lien(s) autorisé(s) — tu peux renvoyer ton lien maintenant.)`,
      mentions: [senderPhoneJid],
    });
  } else if (decision.decision === 'deny') {
    pendingLinkRequests.close(groupJid, senderPhoneJid);
    await sock.sendMessage(groupJid, { text: `${mentionText} ${decision.reply}`, mentions: [senderPhoneJid] });
  } else {
    pendingLinkRequests.bump(groupJid, senderPhoneJid);
    await sock.sendMessage(groupJid, { text: `${mentionText} ${decision.reply}`, mentions: [senderPhoneJid] });
  }
}

async function handleMessage(userId, sock, msg) {
  const groupJid = msg.key.remoteJid || '';
  if (!isGroupJid(groupJid)) return; // Ultra Agent ne traite que les groupes

  const senderJid = msg.key.fromMe
    ? normalizeJid(sock.user?.id)
    : msg.key.participant || groupJid;
  // Identifiant canonique du membre DANS CE GROUPE : utilisé comme clé DB
  // (liens/avertissements/mutes) et pour l'affichage @mention. On résout via
  // la liste des participants du groupe (groupMeta), pas via le cache
  // LID<->numéro de Baileys (resolveToPhoneJid) qui n'est pas toujours
  // peuplé au bon moment — un décalage entre la clé utilisée à
  // l'autorisation (.lien) et celle utilisée à l'envoi du message faisait
  // ignorer des autorisations pourtant valides.
  const senderPhoneJid = await groupMeta.resolveGroupParticipantJid(sock, groupJid, senderJid);
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
  let isKnownCommand = false;
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
    isKnownCommand = handled; // false ici, mais explicite : parsed ≠ reconnu (cf. antibot plus bas)
  }

  // ── 2. Le groupe doit être activé pour tout le reste du pipeline ─────────
  const group = groupStore.getOwnedGroup(userId, groupJid);
  if (!group || !group.enabled) return;

  // ── 2bis. Hooks personnalisés (ex: auto-like) — sur tout message, avant
  //          toute modération, sans jamais pouvoir interrompre le pipeline. ──
  await customCommands.runHooks({ sock, userId, groupJid, senderJid, senderPhoneJid, isAdmin, msg, message, text, group });

  // ── 3. Mute (silencieux : on supprime sans notifier à chaque fois) ───────
  if (!isAdmin && mutes.isMuted(groupJid, userId, senderPhoneJid)) {
    await moderationActions.deleteMessage(sock, groupJid, msg.key);
    return;
  }

  // ── 4. Anti-spam (déterministe, sur TOUS les messages) ────────────────────
  if (group.antispam_enabled && !isAdmin) {
    const { isFlooding } = antiSpam.record(groupJid, senderPhoneJid, group.antispam_max_msgs, group.antispam_window_sec);
    if (isFlooding) {
      await moderationActions.deleteMessage(sock, groupJid, msg.key);
      const mentionText = `@${jidToPhone(senderPhoneJid)}`;
      const maxWarnings = group.max_warnings;
      const { count, limitReached } = warnings.warn(groupJid, userId, senderPhoneJid, maxWarnings);
      if (!limitReached) {
        await sock.sendMessage(groupJid, {
          text: templates.warnMessage({ mentionText, reason: 'tu envoies des messages trop vite (anti-flood)', current: count, max: maxWarnings }),
          mentions: [senderPhoneJid],
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: templates.sanctionMessage({ mentionText, current: count, max: maxWarnings }),
          mentions: [senderPhoneJid],
        });
        kickReasons.record(groupJid, senderJid, 'anti-flood (messages trop rapides)');
        kickReasons.record(groupJid, senderPhoneJid, 'anti-flood (messages trop rapides)');
        const result = await moderationActions.kickMember(sock, groupJid, senderJid);
        if (!result.ok) await sock.sendMessage(groupJid, { text: result.reason });
      }
      return;
    }
  }

  // ── 5. Anti-bot : supprime les commandes destinées à d'autres bots ───────
  // Important : parseCommand(text) renvoie un objet dès que le texte commence
  // par "." — même si ce n'est PAS une commande reconnue d'Ultra Agent. On se
  // base donc sur isKnownCommand (résultat réel de l'étape 1), pas sur un
  // nouveau parsing, sinon aucun message en "." n'est jamais détecté comme
  // étranger (c'était le bug : l'antibot ne se déclenchait quasiment jamais).
  // Les préfixes sont configurables par groupe (.antibot_prefixes) car
  // d'autres bots peuvent utiliser des préfixes différents des nôtres
  // (!, /, #, +, -, %...) — aucune liste fixe ne peut toutes les couvrir.
  // Les stickers utilisés comme déclencheur sont couverts par .antimedia,
  // qui bloque déjà tout sticker envoyé par un non-admin.
  if (group.antibot_enabled && !isAdmin) {
    // Une commande étrangère vient d'être supprimée juste avant : on arme une
    // courte fenêtre pour supprimer aussi SA réponse (généralement le tout
    // premier message qui suit, envoyé par le compte du bot tiers). Ceci est
    // une heuristique one-shot — si un vrai membre parle pile dans cette
    // fenêtre, son message peut être supprimé par erreur ; c'est le
    // compromis demandé pour couper court aux réponses des bots tiers.
    if (antibotWatch.consume(groupJid, senderPhoneJid, text)) {
      const result = await moderationActions.deleteMessage(sock, groupJid, msg.key);
      if (result.ok) return;
      // suppression impossible (ex: message déjà supprimé) → on continue le pipeline normalement
    }

    if (text) {
      const prefixChars = (group.antibot_prefixes || '.!/#').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const botPrefixRe = new RegExp(`^[${prefixChars}]\\S`);
      const looksLikeBotCommand = botPrefixRe.test(text);
      const isForeignBotCommand = looksLikeBotCommand && !isKnownCommand;
      if (isForeignBotCommand) {
        const result = await moderationActions.deleteMessage(sock, groupJid, msg.key);
        if (result.ok) {
          antibotWatch.arm(groupJid, senderPhoneJid);
          const mentionText = `@${jidToPhone(senderPhoneJid)}`;
          await sock.sendMessage(groupJid, {
            text: templates.antibotDeletedMessage({ mentionText }),
            mentions: [senderPhoneJid],
          });
        }
        return;
      }
    }
  }

  // ── 6. Anti-média : bloque images/vidéos/stickers/documents ──────────────
  if (group.antimedia_enabled && !isAdmin) {
    const isMedia = !!(message.imageMessage || message.videoMessage || message.stickerMessage || message.documentMessage);
    if (isMedia) {
      await moderationActions.deleteMessage(sock, groupJid, msg.key);
      return;
    }
  }

  // ── 7. Liste noire de mots ─────────────────────────────────────────────
  if (!isAdmin && text) {
    const matchedWord = blacklist.findMatch(groupJid, userId, text);
    if (matchedWord) {
      await moderationActions.deleteMessage(sock, groupJid, msg.key);
      const mentionText = `@${jidToPhone(senderPhoneJid)}`;
      const maxWarnings = group.max_warnings;
      const { count, limitReached } = warnings.warn(groupJid, userId, senderPhoneJid, maxWarnings);
      const reason = `le mot "${matchedWord}" est interdit ici`;
      if (!limitReached) {
        await sock.sendMessage(groupJid, {
          text: templates.warnMessage({ mentionText, reason, current: count, max: maxWarnings }),
          mentions: [senderPhoneJid],
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: templates.sanctionMessage({ mentionText, current: count, max: maxWarnings }),
          mentions: [senderPhoneJid],
        });
        kickReasons.record(groupJid, senderJid, reason);
        kickReasons.record(groupJid, senderPhoneJid, reason);
        const result = await moderationActions.kickMember(sock, groupJid, senderJid);
        if (!result.ok) await sock.sendMessage(groupJid, { text: result.reason });
      }
      return;
    }
  }

  // ── 8. Anti-liens (déterministe, aucun appel IA) ─────────────────────────
  // Calculé ici (une seule fois, réutilisé à l'étape 11) car un lien envoyé
  // en mentionnant l'agent ou en réponse à lui est traité comme une demande
  // directe, jamais comme une infraction.
  const mentionedBot = await botIsMentioned(sock, message);
  const repliedToBotFlag = mentionedBot ? false : await isReplyToBot(sock, message);

  // Seuil séparé et plus strict que les autres infractions (catégorie 'link',
  // group.link_max_warnings — 3 par défaut, contre 5 pour tout le reste).
  if (group.anti_link_enabled && !isAdmin && text) {
    const linkCount = antiLink.countLinks(text);
    if (linkCount > 0) {
      // Demande proactive : lien envoyé en mentionnant l'agent ou en réponse
      // à lui -> jamais compté comme infraction (pas d'avertissement, pas de
      // risque de sanction), mais le message est quand même supprimé
      // immédiatement pour ne PAS laisser le lien visible du groupe pendant
      // que l'IA l'évalue (sinon la demande ne sert à rien : le lien est
      // déjà exposé, autorisé ou non). S'il est accordé, la personne doit
      // renvoyer son lien — il passera alors normalement, désormais autorisé.
      if (group.ai_enabled && (mentionedBot || repliedToBotFlag)) {
        await moderationActions.deleteMessage(sock, groupJid, msg.key);
        const link = antiLink.findLinks(text)[0] || text;
        pendingLinkRequests.open(groupJid, senderPhoneJid, link);
        await resolveLinkPermission({
          sock, userId, groupJid, senderJid, senderPhoneJid,
          link, memberMessage: text, exchanges: 0,
        });
        return;
      }

      const { allowed } = linkAuth.consume(groupJid, userId, senderPhoneJid, linkCount);
      if (!allowed) {
        const result = await moderationActions.deleteMessage(sock, groupJid, msg.key);
        if (result.ok) {
          const mentionText = `@${jidToPhone(senderPhoneJid)}`;
          const linkMaxWarnings = group.link_max_warnings;
          const { count, limitReached } = warnings.warn(groupJid, userId, senderPhoneJid, linkMaxWarnings, 'link');

          if (!limitReached) {
            // Si l'IA est active, on ouvre une fenêtre pour que le membre
            // puisse se justifier directement auprès de l'agent (en
            // répondant à ce message) plutôt que d'attendre un admin.
            if (group.ai_enabled) pendingLinkRequests.open(groupJid, senderPhoneJid, antiLink.findLinks(text)[0] || text);
            const baseWarn = templates.warnMessage({
              mentionText,
              reason: "envoi d'un lien non autorisé",
              current: count,
              max: linkMaxWarnings,
            });
            await sock.sendMessage(groupJid, {
              text: group.ai_enabled
                ? `${baseWarn}\n\n💬 Tu peux répondre à ce message pour expliquer ton lien à l'agent et demander la permission — ou mentionner l'agent AVANT d'envoyer un lien la prochaine fois pour lui demander sans risque.`
                : baseWarn,
              mentions: [senderPhoneJid],
            });
          } else {
            await sock.sendMessage(groupJid, {
              text: templates.sanctionMessage({ mentionText, current: count, max: linkMaxWarnings }),
              mentions: [senderPhoneJid],
            });
            kickReasons.record(groupJid, senderJid, 'liens non autorisés (seuil atteint)');
            kickReasons.record(groupJid, senderPhoneJid, 'liens non autorisés (seuil atteint)');
            const kickResult = await moderationActions.kickMember(sock, groupJid, senderJid);
            if (!kickResult.ok) await sock.sendMessage(groupJid, { text: kickResult.reason });
          }
        }
        return; // message supprimé : on ne le mémorise pas, on ne le modère pas davantage
      }
    }
  }

  // ── 9. Transcription vocale ───────────────────────────────────────────────
  let transcription = null;
  if (isVoice) {
    try {
      const audioPath = await downloadVoiceToTemp(sock, msg, userId, groupJid);
      transcription = await transcribeAndCleanup(audioPath);
    } catch (err) {
      logger.warn({ groupJid, err: err.message }, 'Échec traitement message vocal');
    }
  }

  // ── 10. Mémoire du groupe ──────────────────────────────────────────────────
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

  // ── 11. Mention de l'agent → réponse conversationnelle ────────────────────
  if (group.ai_enabled) {
    if (mentionedBot || repliedToBotFlag) {
      // Une demande de permission de lien est en cours pour ce membre : on
      // route vers le moteur dédié plutôt que la conversation générale,
      // tant qu'elle n'a pas abouti (accord, refus, ou expiration).
      const pendingLink = pendingLinkRequests.get(groupJid, senderPhoneJid);
      if (pendingLink) {
        await resolveLinkPermission({
          sock, userId, groupJid, senderJid, senderPhoneJid,
          link: pendingLink.link, memberMessage: effectiveText, exchanges: pendingLink.exchanges,
        });
        return;
      }

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
        // Réglage par groupe (.vocal) prioritaire sur le défaut global AI_VOICE_REPLY.
        const voiceEnabled = group.voice_enabled === null ? config.aiReply.voiceEnabled : !!group.voice_enabled;
        const delay = randomDelayMs(config.aiReply.delayMinMs, config.aiReply.delayMaxMs);

        // Simule "en train d'écrire..." / "en train d'enregistrer..." pendant
        // le délai, pour un rendu plus naturel qu'un message qui apparaît
        // d'un coup après un silence.
        try {
          await sock.sendPresenceUpdate(voiceEnabled ? 'recording' : 'composing', groupJid);
        } catch (err) {
          logger.warn({ groupJid, err: err.message }, 'Échec presence update (composing/recording)');
        }

        await sleep(delay);

        let sentAsVoice = false;
        if (voiceEnabled) {
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

        try {
          await sock.sendPresenceUpdate('paused', groupJid);
        } catch {
          // sans conséquence : la présence WhatsApp expire d'elle-même
        }
      }
      return; // une mention ne déclenche pas aussi une analyse de modération
    }
  }

  // ── 12. Modération IA (seulement pour les membres, pas les admins) ────────
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
      const mentionText = `@${jidToPhone(senderPhoneJid)}`;
      if (!action.shouldSanction) {
        await sock.sendMessage(groupJid, {
          text: templates.warnMessage({
            mentionText,
            reason: decision.reason || 'règlement non respecté',
            current: action.newCount,
            max: group.max_warnings,
          }),
          mentions: [senderPhoneJid],
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: templates.sanctionMessage({ mentionText, current: action.newCount, max: group.max_warnings }),
          mentions: [senderPhoneJid],
        });
        kickReasons.record(groupJid, senderJid, decision.reason || 'règlement non respecté (modération IA)');
        kickReasons.record(groupJid, senderPhoneJid, decision.reason || 'règlement non respecté (modération IA)');
        const result = await moderationActions.kickMember(sock, groupJid, senderJid);
        if (!result.ok) await sock.sendMessage(groupJid, { text: result.reason });
      }
    }
  }
}

/**
 * Gère les entrées ET sorties d'un groupe (event Baileys `group-participants-update`) :
 * - 'add' → envoie le message de bienvenue configuré (.bienvenue) ;
 * - 'remove' → enregistre le départ en mémoire de groupe, avec le motif s'il
 *   est connu (expulsion déclenchée par Ultra Agent lui-même — voir
 *   `src/moderation/kickReasons.js`) ou une estimation générique sinon
 *   (WhatsApp ne fournit pas de motif natif pour un départ volontaire).
 */
async function handleGroupParticipantsUpdate(userId, sock, update) {
  const { id: groupJid, participants, action, author } = update || {};
  if (!isGroupJid(groupJid) || !participants?.length) return;

  try {
    const group = groupStore.getOwnedGroup(userId, groupJid);
    if (!group || !group.enabled) return;

    if (action === 'add') {
      if (!group.welcome_enabled) return;
      const groupName = await groupMeta.getGroupName(sock, groupJid);
      for (const rawJid of participants) {
        const phoneJid = await resolveToPhoneJid(sock, rawJid);
        const mentionText = `@${jidToPhone(phoneJid)}`;
        const text = templates.welcomeMessage({ mentionText, groupName, customMessage: group.welcome_message });
        await sock.sendMessage(groupJid, { text, mentions: [phoneJid] });
      }
      return;
    }

    if (action === 'remove') {
      for (const rawJid of participants) {
        const phoneJid = await resolveToPhoneJid(sock, rawJid);
        const name = jidToPhone(phoneJid);

        // Le motif d'un kick déclenché par Ultra Agent lui-même a été
        // enregistré juste avant l'appel à kickMember — on le récupère s'il
        // existe (sous les deux formats de JID possibles).
        const reason = kickReasons.consume(groupJid, rawJid) || kickReasons.consume(groupJid, phoneJid);

        let content;
        if (reason) {
          content = `${name} a été retiré du groupe — motif : ${reason}.`;
        } else if (author && jidToPhone(author) !== jidToPhone(phoneJid)) {
          content = `${name} a été retiré du groupe par un administrateur (motif non communiqué par WhatsApp).`;
        } else {
          content = `${name} a quitté le groupe de lui-même.`;
        }

        memoryManager.appendMessage(
          userId,
          groupJid,
          { id: `leave-${Date.now()}-${name}`, userId: phoneJid, name, type: 'system', content, timestamp: Date.now() },
          group.memory_limit
        );
      }
    }
  } catch (err) {
    logger.warn({ groupJid, err: err.message }, 'Échec traitement group-participants-update');
  }
}

module.exports = { handleMessage, handleGroupParticipantsUpdate };
