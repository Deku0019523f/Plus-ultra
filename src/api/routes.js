'use strict';

const express = require('express');
const db = require('../database/db');
const sessionManager = require('../whatsapp/sessionManager');
const groupStore = require('../groups/groupStore');
const memoryManager = require('../memory/memoryManager');
const groupMeta = require('../whatsapp/groupMeta');
const { requireAuth } = require('./auth');
const { isGroupJid } = require('../utils/jid');
const logger = require('../utils/logger');

const router = express.Router();

// ── Inscription — nécessaire pour obtenir la clé API utilisée par toutes les
//    autres routes (le cahier des charges impose des endpoints authentifiés). ─
router.post('/register', (req, res) => {
  const user = db.createUser();
  res.json({ userId: user.id, apiKey: user.api_key });
});

router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json({
    userId: req.user.id,
    phoneNumber: req.user.phone_number,
    connectionStatus: req.user.connection_status,
    connected: sessionManager.isConnected(req.user.id),
  });
});

router.post('/pairing', async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber requis (format E.164, ex: +2250700000000).' });

  try {
    const { pairingCode } = await sessionManager.connectWhatsApp(req.user.id, phoneNumber);
    res.json({ pairingCode });
  } catch (err) {
    logger.error({ userId: req.user.id, err: err.message }, 'Échec génération pairing code');
    res.status(500).json({ error: err.message });
  }
});

function getSockOr409(req, res) {
  const sock = sessionManager.getSocket(req.user.id);
  if (!sock) {
    res.status(409).json({ error: 'Aucun compte WhatsApp connecté pour le moment.' });
    return null;
  }
  return sock;
}

router.get('/groups', async (req, res) => {
  const sock = getSockOr409(req, res);
  if (!sock) return;

  try {
    const participating = await sock.groupFetchAllParticipating();
    const owned = db.listGroupsForUser(req.user.id);
    const ownedByJid = new Map(owned.map((g) => [g.group_jid, g]));

    const groups = Object.values(participating).map((g) => {
      const stored = ownedByJid.get(g.id);
      return {
        groupJid: g.id,
        name: g.subject,
        enabled: !!stored?.enabled,
        aiEnabled: stored ? !!stored.ai_enabled : true,
        antiLinkEnabled: stored ? !!stored.anti_link_enabled : true,
        memberCount: g.participants?.length || 0,
      };
    });
    res.json({ groups });
  } catch (err) {
    logger.error({ userId: req.user.id, err: err.message }, 'Échec récupération des groupes');
    res.status(500).json({ error: 'Impossible de récupérer les groupes.' });
  }
});

// Vérifie le format du JID et l'appartenance au user authentifié.
function loadOwnedGroupOr404(req, res) {
  const { groupId } = req.params;
  if (!isGroupJid(groupId)) {
    res.status(400).json({ error: 'Identifiant de groupe invalide.' });
    return null;
  }
  const group = groupStore.getOwnedGroup(req.user.id, groupId);
  if (!group) {
    res.status(404).json({ error: 'Groupe introuvable pour ce compte.' });
    return null;
  }
  return group;
}

router.get('/groups/:groupId', (req, res) => {
  const group = loadOwnedGroupOr404(req, res);
  if (!group) return;
  res.json({
    groupJid: group.group_jid,
    name: group.name,
    enabled: !!group.enabled,
    aiEnabled: !!group.ai_enabled,
    antiLinkEnabled: !!group.anti_link_enabled,
    maxWarnings: group.max_warnings,
    memoryLimit: group.memory_limit,
    rules: group.rules,
  });
});

router.post('/groups/:groupId/enable', async (req, res) => {
  const { groupId } = req.params;
  if (!isGroupJid(groupId)) return res.status(400).json({ error: 'Identifiant de groupe invalide.' });
  const sock = getSockOr409(req, res);
  if (!sock) return;

  try {
    const name = await groupMeta.getGroupName(sock, groupId);
    const rules = await groupMeta.getGroupDescription(sock, groupId);
    const group = groupStore.activateGroup(req.user.id, groupId, { name, rules });
    res.json({ enabled: !!group.enabled });
  } catch (err) {
    logger.error({ groupId, err: err.message }, 'Échec activation groupe via API');
    res.status(500).json({ error: "Impossible d'activer ce groupe (le compte en fait-il bien partie ?)." });
  }
});

router.post('/groups/:groupId/disable', (req, res) => {
  const group = loadOwnedGroupOr404(req, res);
  if (!group) return;
  groupStore.deactivateGroup(req.user.id, group.group_jid);
  res.json({ enabled: false });
});

router.get('/groups/:groupId/memory', (req, res) => {
  const group = loadOwnedGroupOr404(req, res);
  if (!group) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ messages: memoryManager.getRecent(req.user.id, group.group_jid, limit) });
});

router.get('/groups/:groupId/stats', (req, res) => {
  const group = loadOwnedGroupOr404(req, res);
  if (!group) return;
  res.json(memoryManager.getStats(req.user.id, group.group_jid));
});

module.exports = router;
