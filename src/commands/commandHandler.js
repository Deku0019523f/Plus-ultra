'use strict';

const config = require('../config/config');
const groupStore = require('../groups/groupStore');
const warnings = require('../groups/warnings');
const linkAuth = require('../groups/linkAuth');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('../whatsapp/groupMeta');
const moderationActions = require('../whatsapp/moderationActions');
const { firstMentionedJid, jidToPhone } = require('../utils/jid');
const logger = require('../utils/logger');

const ADMIN_ONLY_MSG = '❌ Cette commande est réservée aux administrateurs.';

function parseCommand(text) {
  if (!text || !text.startsWith(config.commandPrefix)) return null;
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  return { cmd: cmdRaw.toLowerCase(), args: rest, rawText: text };
}

async function reply(sock, groupJid, text) {
  await sock.sendMessage(groupJid, { text });
}

async function handleCommand(ctx) {
  const { sock, userId, groupJid, senderJid, isAdmin, parsed } = ctx;
  const { cmd, args, rawText } = parsed;

  const ADMIN_COMMANDS = new Set([
    '.plus_ultra', '.plus_ultra_off', '.lien', '.warn', '.unwarn', '.reglement',
  ]);
  if (ADMIN_COMMANDS.has(cmd) && !isAdmin) {
    await reply(sock, groupJid, ADMIN_ONLY_MSG);
    return true;
  }

  switch (cmd) {
    case '.plus_ultra':
      await cmdActivate(ctx);
      return true;
    case '.plus_ultra_off':
      await cmdDeactivate(ctx);
      return true;
    case '.lien':
      await cmdAuthorizeLink(ctx);
      return true;
    case '.warn':
      await cmdWarn(ctx);
      return true;
    case '.unwarn':
      await cmdUnwarn(ctx);
      return true;
    case '.warns':
      await cmdListWarns(ctx);
      return true;
    case '.reglement':
      await cmdRefreshRules(ctx);
      return true;
    case '.status':
      await cmdStatus(ctx);
      return true;
    case '.help':
      await cmdHelp(ctx);
      return true;
    default:
      return false; // pas une commande connue → laisser le reste du pipeline traiter le message
  }
}

async function cmdActivate({ sock, userId, groupJid }) {
  const name = await groupMeta.getGroupName(sock, groupJid);
  const rules = await groupMeta.getGroupDescription(sock, groupJid);
  const group = groupStore.activateGroup(userId, groupJid, { name, rules });

  await reply(
    sock,
    groupJid,
    `🟢 ULTRA AGENT ACTIVÉ\n\n` +
      `🛡️ Modération : ACTIVÉE\n` +
      `🔗 Anti-liens : ${group.anti_link_enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ'}\n` +
      `⚠️ Avertissements : ${group.max_warnings}/${group.max_warnings}\n` +
      `🤖 IA : ${group.ai_enabled ? 'ACTIVÉE' : 'DÉSACTIVÉE'}\n` +
      `🎤 Analyse vocale : ACTIVÉE\n\n` +
      `Le règlement du groupe sera utilisé comme référence.`
  );
}

async function cmdDeactivate({ sock, userId, groupJid }) {
  groupStore.deactivateGroup(userId, groupJid);
  await reply(sock, groupJid, '🔴 ULTRA AGENT DÉSACTIVÉ\n\nModération, anti-liens et IA sont désormais désactivés dans ce groupe.');
}

async function cmdAuthorizeLink({ sock, userId, groupJid, senderJid, parsed }) {
  const memberJid = firstMentionedJid(parsed.message);
  const n = parseInt(parsed.args.find((a) => /^\d+$/.test(a)) || '', 10);

  if (!memberJid || !Number.isFinite(n) || n < 0) {
    await reply(sock, groupJid, 'Usage : .lien @membre <nombre>');
    return;
  }

  linkAuth.authorize(groupJid, userId, memberJid, n, senderJid);
  await reply(sock, groupJid, `✅ @${jidToPhone(memberJid)} peut désormais envoyer ${n} lien(s) dans ce groupe.`);
}

async function cmdWarn({ sock, userId, groupJid, parsed }) {
  const memberJid = firstMentionedJid(parsed.message);
  if (!memberJid) {
    await reply(sock, groupJid, 'Usage : .warn @membre');
    return;
  }

  const group = groupStore.getOwnedGroup(userId, groupJid);
  const maxWarnings = group?.max_warnings || config.moderation.maxWarnings;
  const { count, limitReached } = warnings.warn(groupJid, userId, memberJid, maxWarnings);

  if (!limitReached) {
    await reply(sock, groupJid, `⚠️ Avertissement ajouté : @${jidToPhone(memberJid)} est à ${count}/${maxWarnings}.`);
    return;
  }

  await reply(
    sock,
    groupJid,
    `🚫 SANCTION\n\n@${jidToPhone(memberJid)} a atteint ${count}/${maxWarnings} avertissements.\n\nLe membre va être retiré du groupe.`
  );
  const result = await moderationActions.kickMember(sock, groupJid, memberJid);
  if (!result.ok) await reply(sock, groupJid, result.reason);
}

async function cmdUnwarn({ sock, userId, groupJid, parsed }) {
  const memberJid = firstMentionedJid(parsed.message);
  if (!memberJid) {
    await reply(sock, groupJid, 'Usage : .unwarn @membre');
    return;
  }
  const { count } = warnings.unwarn(groupJid, userId, memberJid);
  await reply(sock, groupJid, `✅ Avertissement retiré : @${jidToPhone(memberJid)} est maintenant à ${count}.`);
}

async function cmdListWarns({ sock, userId, groupJid, parsed }) {
  const memberJid = firstMentionedJid(parsed.message);
  const group = groupStore.getOwnedGroup(userId, groupJid);
  const maxWarnings = group?.max_warnings || config.moderation.maxWarnings;

  if (memberJid) {
    const count = warnings.get(groupJid, userId, memberJid);
    await reply(sock, groupJid, `⚠️ @${jidToPhone(memberJid)} : ${count}/${maxWarnings} avertissement(s).`);
    return;
  }

  const list = warnings.list(groupJid, userId);
  if (!list.length) {
    await reply(sock, groupJid, '✅ Aucun avertissement enregistré dans ce groupe.');
    return;
  }
  const lines = list.map((w) => `• @${jidToPhone(w.memberJid)} — ${w.count}/${maxWarnings}`);
  await reply(sock, groupJid, `⚠️ AVERTISSEMENTS DU GROUPE\n\n${lines.join('\n')}`);
}

async function cmdRefreshRules({ sock, userId, groupJid }) {
  groupMeta.invalidateGroupMetadata(groupJid);
  const rules = await groupMeta.getGroupDescription(sock, groupJid);
  groupStore.updateRules(userId, groupJid, rules);
  await reply(sock, groupJid, '📜 Règlement actualisé depuis la description du groupe.');
}

async function cmdStatus({ sock, userId, groupJid }) {
  const group = groupStore.getOwnedGroup(userId, groupJid);
  if (!group || !group.enabled) {
    await reply(sock, groupJid, `⚪ ${config.botName} n'est pas actif dans ce groupe.\n\nUn administrateur peut taper .plus_ultra pour l'activer.`);
    return;
  }
  const stats = memoryManager.getStats(userId, groupJid);
  await reply(
    sock,
    groupJid,
    `🟢 STATUT — ${config.botName}\n\n` +
      `🤖 IA : ${group.ai_enabled ? 'ON' : 'OFF'}\n` +
      `🛡️ Modération : ACTIVÉE\n` +
      `🔗 Anti-liens : ${group.anti_link_enabled ? 'ON' : 'OFF'}\n` +
      `⚠️ Avertissements max : ${group.max_warnings}\n` +
      `🧠 Mémoire : ${stats.current}/${stats.limit} messages (${stats.archives} archive(s))`
  );
}

function commandsListText() {
  return (
    `.plus_ultra — active l'agent dans ce groupe (admin)\n` +
    `.plus_ultra_off — désactive l'agent (admin)\n` +
    `.lien @membre N — autorise N liens (admin)\n` +
    `.warn @membre — ajoute un avertissement (admin)\n` +
    `.unwarn @membre — retire un avertissement (admin)\n` +
    `.warns [@membre] — affiche les avertissements\n` +
    `.reglement — actualise le règlement (admin)\n` +
    `.status — affiche l'état de l'agent\n` +
    `.help — affiche ce message`
  );
}

async function cmdHelp({ sock, groupJid }) {
  await reply(sock, groupJid, `🤖 COMMANDES — ${config.botName}\n\n${commandsListText()}`);
}

module.exports = { parseCommand, handleCommand, commandsListText };
