'use strict';

const config = require('../config/config');
const groupStore = require('../groups/groupStore');
const warnings = require('../groups/warnings');
const linkAuth = require('../groups/linkAuth');
const mutes = require('../groups/mutes');
const blacklist = require('../groups/blacklist');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('../whatsapp/groupMeta');
const moderationActions = require('../whatsapp/moderationActions');
const templates = require('../whatsapp/templates');
const { parseDuration, formatUntil } = require('../moderation/duration');
const { firstMentionedJid, jidToPhone, resolveToPhoneJid } = require('../utils/jid');
const logger = require('../utils/logger');

const ADMIN_ONLY_MSG = '❌ Cette commande est réservée aux administrateurs.';

function parseCommand(text) {
  if (!text || !text.startsWith(config.commandPrefix)) return null;
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  return { cmd: cmdRaw.toLowerCase(), args: rest, rawText: text };
}

async function reply(sock, groupJid, text, mentions) {
  await sock.sendMessage(groupJid, { text, ...(mentions?.length ? { mentions } : {}) });
}

/**
 * Résout un JID (LID inclus) vers le numéro affiché en @mention, et renvoie
 * à la fois le texte "@numéro" et le JID à mettre dans `mentions` pour que
 * WhatsApp rende une vraie mention cliquable (et pas juste du texte brut).
 */
async function buildMention(sock, jid) {
  const resolved = await resolveToPhoneJid(sock, jid);
  return { text: `@${jidToPhone(resolved)}`, jid: resolved };
}

/** true si le JID (candidat) désigne le bot lui-même — pour exclure le bot de .lien_tous/.tagall. */
function isBotJid(sock, jid) {
  const a = jidToPhone(jid);
  return a === jidToPhone(sock.user?.id) || (sock.user?.lid && a === jidToPhone(sock.user.lid));
}

async function handleCommand(ctx) {
  const { sock, userId, groupJid, senderJid, isAdmin, parsed } = ctx;
  const { cmd, args, rawText } = parsed;

  const ADMIN_COMMANDS = new Set([
    '.plus_ultra', '.plus_ultra_off', '.lien', '.warn', '.unwarn', '.reglement',
    '.mute', '.unmute', '.kick', '.antispam', '.blacklist', '.lien_reset', '.lien_tous',
    '.antimedia', '.tagall', '.bienvenue', '.antibot', '.vocal',
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
    case '.lien_reset':
      await cmdLienReset(ctx);
      return true;
    case '.lien_tous':
      await cmdLienTous(ctx);
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
    case '.mute':
      await cmdMute(ctx);
      return true;
    case '.unmute':
      await cmdUnmute(ctx);
      return true;
    case '.kick':
      await cmdKick(ctx);
      return true;
    case '.antispam':
      await cmdAntispam(ctx);
      return true;
    case '.antimedia':
      await cmdAntimedia(ctx);
      return true;
    case '.antibot':
      await cmdAntibot(ctx);
      return true;
    case '.blacklist':
      await cmdBlacklist(ctx);
      return true;
    case '.tagall':
      await cmdTagAll(ctx);
      return true;
    case '.info':
      await cmdInfo(ctx);
      return true;
    case '.bienvenue':
      await cmdBienvenue(ctx);
      return true;
    case '.vocal':
      await cmdVocal(ctx);
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
      `Le règlement du groupe sera utilisé comme référence.\n` +
      `Tape .help pour voir toutes les commandes.`
  );
}

async function cmdDeactivate({ sock, userId, groupJid }) {
  groupStore.deactivateGroup(userId, groupJid);
  await reply(sock, groupJid, '🔴 ULTRA AGENT DÉSACTIVÉ\n\nModération, anti-liens et IA sont désormais désactivés dans ce groupe.');
}

async function cmdAuthorizeLink({ sock, userId, groupJid, senderJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  const n = parseInt(parsed.args.find((a) => /^\d+$/.test(a)) || '', 10);

  if (!rawMemberJid || !Number.isFinite(n) || n < 0) {
    await reply(sock, groupJid, 'Usage : .lien @membre <nombre>');
    return;
  }

  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  linkAuth.authorize(groupJid, userId, memberJid, n, senderJid);
  const mention = await buildMention(sock, memberJid);
  await reply(sock, groupJid, `✅ ${mention.text} peut désormais envoyer ${n} lien(s) dans ce groupe.`, [mention.jid]);
}

async function cmdLienReset({ sock, userId, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .lien_reset @membre');
    return;
  }
  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  const mention = await buildMention(sock, memberJid);
  const auth = linkAuth.resetUsage(groupJid, userId, memberJid);
  if (!auth) {
    await reply(sock, groupJid, `${mention.text} n'a aucune autorisation de lien enregistrée.`, [mention.jid]);
    return;
  }
  await reply(sock, groupJid, `🔄 Quota de liens de ${mention.text} remis à zéro (${auth.max_links} lien(s) à nouveau disponibles).`, [mention.jid]);
}

async function cmdLienTous({ sock, userId, groupJid, senderJid, parsed }) {
  const n = parseInt(parsed.args.find((a) => /^\d+$/.test(a)) || '', 10);
  if (!Number.isFinite(n) || n < 0) {
    await reply(sock, groupJid, 'Usage : .lien_tous <nombre>');
    return;
  }
  const meta = await groupMeta.getGroupMetadata(sock, groupJid);
  let count = 0;
  for (const p of meta.participants) {
    if (isBotJid(sock, p.id)) continue;
    linkAuth.authorize(groupJid, userId, p.id, n, senderJid);
    count++;
  }
  await reply(sock, groupJid, `✅ ${count} membre(s) peuvent désormais envoyer ${n} lien(s) chacun dans ce groupe.`);
}

async function cmdWarn({ sock, userId, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .warn @membre [raison]');
    return;
  }
  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  const mention = await buildMention(sock, memberJid);
  const mentionToken = parsed.args.find((a) => a.startsWith('@'));
  const reason = parsed.args.filter((a) => a !== mentionToken).join(' ').trim();

  const group = groupStore.getOwnedGroup(userId, groupJid);
  const maxWarnings = group?.max_warnings || config.moderation.maxWarnings;
  const { count, limitReached } = warnings.warn(groupJid, userId, memberJid, maxWarnings);

  if (!limitReached) {
    await reply(
      sock,
      groupJid,
      templates.warnMessage({ mentionText: mention.text, reason, current: count, max: maxWarnings }),
      [mention.jid]
    );
    return;
  }

  await reply(
    sock,
    groupJid,
    templates.sanctionMessage({ mentionText: mention.text, current: count, max: maxWarnings }),
    [mention.jid]
  );
  const result = await moderationActions.kickMember(sock, groupJid, rawMemberJid);
  if (!result.ok) await reply(sock, groupJid, result.reason);
}

async function cmdUnwarn({ sock, userId, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .unwarn @membre');
    return;
  }
  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  const mention = await buildMention(sock, memberJid);
  const { count } = warnings.unwarn(groupJid, userId, memberJid);
  await reply(sock, groupJid, `✅ Avertissement retiré : ${mention.text} est maintenant à ${count}.`, [mention.jid]);
}

async function cmdListWarns({ sock, userId, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  const group = groupStore.getOwnedGroup(userId, groupJid);
  const maxWarnings = group?.max_warnings || config.moderation.maxWarnings;

  if (rawMemberJid) {
    const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
    const mention = await buildMention(sock, memberJid);
    const count = warnings.get(groupJid, userId, memberJid);
    await reply(sock, groupJid, `⚠️ ${mention.text} : ${count}/${maxWarnings} avertissement(s).`, [mention.jid]);
    return;
  }

  const list = warnings.list(groupJid, userId);
  if (!list.length) {
    await reply(sock, groupJid, '✅ Aucun avertissement enregistré dans ce groupe.');
    return;
  }
  const lines = list.map((w) => `• @${jidToPhone(w.memberJid)} — ${w.count}/${maxWarnings}`);
  await reply(sock, groupJid, `⚠️ AVERTISSEMENTS DU GROUPE\n\n${lines.join('\n')}`, list.map((w) => w.memberJid));
}

async function cmdMute({ sock, userId, groupJid, senderJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .mute @membre [durée] (ex: .mute @membre 30m)');
    return;
  }
  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  const mention = await buildMention(sock, memberJid);
  const durationArg = parsed.args.find((a) => /^\d+[smhd]$/i.test(a));
  const durationMs = durationArg ? parseDuration(durationArg) : null;

  mutes.mute(groupJid, userId, memberJid, durationMs, senderJid);
  const label = durationMs ? `pour ${formatUntil(Date.now() + durationMs)}` : "jusqu'à nouvel ordre";
  await reply(sock, groupJid, `🔇 ${mention.text} est maintenant muet ${label}.`, [mention.jid]);
}

async function cmdUnmute({ sock, userId, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .unmute @membre');
    return;
  }
  const memberJid = await resolveToPhoneJid(sock, rawMemberJid);
  const mention = await buildMention(sock, memberJid);
  mutes.unmute(groupJid, userId, memberJid);
  await reply(sock, groupJid, `🔊 ${mention.text} peut de nouveau parler.`, [mention.jid]);
}

async function cmdKick({ sock, groupJid, parsed }) {
  const rawMemberJid = firstMentionedJid(parsed.message);
  if (!rawMemberJid) {
    await reply(sock, groupJid, 'Usage : .kick @membre');
    return;
  }
  const mention = await buildMention(sock, rawMemberJid);
  const result = await moderationActions.kickMember(sock, groupJid, rawMemberJid);
  if (!result.ok) {
    await reply(sock, groupJid, result.reason);
    return;
  }
  await reply(sock, groupJid, `👢 ${mention.text} a été expulsé du groupe.`, [mention.jid]);
}

async function cmdAntispam({ sock, userId, groupJid, parsed }) {
  const value = parsed.args[0]?.toLowerCase();
  if (value !== 'on' && value !== 'off') {
    await reply(sock, groupJid, 'Usage : .antispam on|off');
    return;
  }
  groupStore.updateSettings(userId, groupJid, { antispamEnabled: value === 'on' });
  await reply(sock, groupJid, `🚦 Anti-spam ${value === 'on' ? 'ACTIVÉ' : 'DÉSACTIVÉ'}.`);
}

async function cmdAntimedia({ sock, userId, groupJid, parsed }) {
  const value = parsed.args[0]?.toLowerCase();
  if (value !== 'on' && value !== 'off') {
    await reply(sock, groupJid, 'Usage : .antimedia on|off');
    return;
  }
  groupStore.updateSettings(userId, groupJid, { antimediaEnabled: value === 'on' });
  await reply(
    sock,
    groupJid,
    `🖼️ Anti-média ${value === 'on' ? 'ACTIVÉ (images/vidéos/stickers bloqués pour les non-admins)' : 'DÉSACTIVÉ'}.`
  );
}

async function cmdAntibot({ sock, userId, groupJid, parsed }) {
  const value = parsed.args[0]?.toLowerCase();
  if (value !== 'on' && value !== 'off') {
    await reply(sock, groupJid, 'Usage : .antibot on|off');
    return;
  }
  groupStore.updateSettings(userId, groupJid, { antibotEnabled: value === 'on' });
  await reply(
    sock,
    groupJid,
    `🤖 Anti-bot ${value === 'on' ? "ACTIVÉ (commandes destinées à d'autres bots supprimées)" : 'DÉSACTIVÉ'}.`
  );
}

async function cmdBlacklist({ sock, userId, groupJid, parsed }) {
  const [action, ...rest] = parsed.args;
  const word = rest.join(' ');

  switch (action?.toLowerCase()) {
    case 'ajouter': {
      if (!word) {
        await reply(sock, groupJid, 'Usage : .blacklist ajouter <mot>');
        return;
      }
      blacklist.add(groupJid, userId, word);
      await reply(sock, groupJid, `🚫 "${word}" ajouté à la liste noire.`);
      return;
    }
    case 'retirer': {
      if (!word) {
        await reply(sock, groupJid, 'Usage : .blacklist retirer <mot>');
        return;
      }
      blacklist.remove(groupJid, userId, word);
      await reply(sock, groupJid, `✅ "${word}" retiré de la liste noire.`);
      return;
    }
    case 'liste': {
      const words = blacklist.list(groupJid, userId);
      await reply(
        sock,
        groupJid,
        words.length ? `🚫 LISTE NOIRE\n\n${words.map((w) => `• ${w}`).join('\n')}` : 'Aucun mot dans la liste noire.'
      );
      return;
    }
    default:
      await reply(sock, groupJid, 'Usage : .blacklist ajouter|retirer|liste <mot>');
  }
}

async function cmdTagAll({ sock, groupJid, parsed }) {
  const meta = await groupMeta.getGroupMetadata(sock, groupJid);
  const customMsg = parsed.rawText.replace(/^\.tagall\s*/i, '').trim();
  const lines = meta.participants.map((p) => `@${jidToPhone(p.id)}`);
  const header = customMsg ? `📢 ${customMsg}\n\n` : '📢 Attention à tous !\n\n';
  await reply(sock, groupJid, header + lines.join(' '), meta.participants.map((p) => p.id));
}

async function cmdInfo({ sock, groupJid }) {
  const meta = await groupMeta.getGroupMetadata(sock, groupJid);
  const admins = meta.participants.filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
  const created = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('fr-FR') : 'inconnue';
  await reply(
    sock,
    groupJid,
    `ℹ️ INFOS DU GROUPE\n\n` +
      `📛 Nom : ${meta.subject}\n` +
      `👥 Membres : ${meta.participants.length}\n` +
      `👑 Admins : ${admins.length}\n` +
      `📅 Création : ${created}`
  );
}

async function cmdBienvenue({ sock, userId, groupJid, parsed }) {
  const value = parsed.args[0]?.toLowerCase();
  if (value !== 'on' && value !== 'off') {
    await reply(sock, groupJid, "Usage : .bienvenue on|off [message, avec {membre} et {groupe}]");
    return;
  }
  const customMessage = parsed.rawText.replace(new RegExp(`^\\.bienvenue\\s+${value}\\s*`, 'i'), '').trim();
  groupStore.updateSettings(userId, groupJid, {
    welcomeEnabled: value === 'on',
    ...(customMessage ? { welcomeMessage: customMessage } : {}),
  });
  await reply(
    sock,
    groupJid,
    `👋 Message de bienvenue ${value === 'on' ? 'ACTIVÉ' : 'DÉSACTIVÉ'}${customMessage ? ' (message personnalisé enregistré)' : ''}.`
  );
}

async function cmdVocal({ sock, userId, groupJid, parsed }) {
  const value = parsed.args[0]?.toLowerCase();
  if (!['on', 'off', 'defaut', 'défaut'].includes(value)) {
    await reply(sock, groupJid, 'Usage : .vocal on|off|defaut');
    return;
  }
  if (value === 'defaut' || value === 'défaut') {
    groupStore.updateSettings(userId, groupJid, { resetVoiceToDefault: true });
    await reply(sock, groupJid, `🎤 Réponses vocales : suivent le réglage global (${config.aiReply.voiceEnabled ? 'ON' : 'OFF'}).`);
    return;
  }
  groupStore.updateSettings(userId, groupJid, { voiceEnabled: value === 'on' });
  await reply(sock, groupJid, `🎤 Réponses vocales de l'IA : ${value === 'on' ? 'ACTIVÉES' : 'DÉSACTIVÉES'} pour ce groupe.`);
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
  const voiceLabel = group.voice_enabled === null ? (config.aiReply.voiceEnabled ? 'ON (défaut)' : 'OFF (défaut)') : (group.voice_enabled ? 'ON' : 'OFF');
  await reply(
    sock,
    groupJid,
    `🟢 STATUT — ${config.botName}\n\n` +
      `🤖 IA : ${group.ai_enabled ? 'ON' : 'OFF'}\n` +
      `🎤 Vocal IA : ${voiceLabel}\n` +
      `🛡️ Modération : ACTIVÉE\n` +
      `🔗 Anti-liens : ${group.anti_link_enabled ? 'ON' : 'OFF'}\n` +
      `🚦 Anti-spam : ${group.antispam_enabled ? 'ON' : 'OFF'}\n` +
      `🖼️ Anti-média : ${group.antimedia_enabled ? 'ON' : 'OFF'}\n` +
      `🤖 Anti-bot : ${group.antibot_enabled ? 'ON' : 'OFF'}\n` +
      `👋 Bienvenue : ${group.welcome_enabled ? 'ON' : 'OFF'}\n` +
      `⚠️ Avertissements max : ${group.max_warnings}\n` +
      `🧠 Mémoire : ${stats.current}/${stats.limit} messages (${stats.archives} archive(s))`
  );
}

function commandsListText() {
  return (
    `.plus_ultra — active l'agent dans ce groupe (admin)\n` +
    `.plus_ultra_off — désactive l'agent (admin)\n` +
    `.lien @membre N — autorise N liens (admin)\n` +
    `.lien_reset @membre — remet son quota de liens à zéro (admin)\n` +
    `.lien_tous N — autorise N liens à tous les membres (admin)\n` +
    `.warn @membre [raison] — ajoute un avertissement (admin)\n` +
    `.unwarn @membre — retire un avertissement (admin)\n` +
    `.warns [@membre] — affiche les avertissements\n` +
    `.mute @membre [durée] — rend un membre muet, ex: 30m/2h/1d (admin)\n` +
    `.unmute @membre — lève le mute (admin)\n` +
    `.kick @membre — expulse directement (admin)\n` +
    `.antispam on|off — anti-flood (admin)\n` +
    `.antimedia on|off — bloque images/vidéos/stickers (admin)\n` +
    `.antibot on|off — supprime les commandes destinées à d'autres bots (admin)\n` +
    `.blacklist ajouter|retirer|liste <mot> — mots interdits (admin)\n` +
    `.tagall [message] — mentionne tous les membres (admin)\n` +
    `.info — infos du groupe\n` +
    `.bienvenue on|off [message] — message d'accueil auto (admin)\n` +
    `.vocal on|off|defaut — réponses IA en vocal ou texte (admin)\n` +
    `.reglement — actualise le règlement (admin)\n` +
    `.status — affiche l'état de l'agent\n` +
    `.help — affiche ce message`
  );
}

async function cmdHelp({ sock, groupJid }) {
  await reply(sock, groupJid, `🤖 COMMANDES — ${config.botName}\n\n${commandsListText()}`);
}

module.exports = { parseCommand, handleCommand, commandsListText };
