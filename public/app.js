(() => {
  'use strict';

  const API = '/api';
  let apiKey = localStorage.getItem('ultraAgentApiKey');
  let userId = localStorage.getItem('ultraAgentUserId');
  let currentGroupJid = null;
  let statusPollTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const toastEl = $('#toast');

  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('is-error', isError);
    toastEl.classList.add('is-visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('is-visible'), 3200);
  }

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erreur ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /**
   * Comme api(), mais s'auto-répare si la clé stockée localement ne
   * correspond plus à un compte en base (401 "Clé API invalide/manquante") :
   * efface le cache, ré-enregistre un nouveau compte, puis retente UNE fois.
   * Évite qu'une clé périmée ne bloque tout le site indéfiniment.
   */
  async function apiAuth(path, options = {}) {
    try {
      return await api(path, options);
    } catch (err) {
      if (err.status !== 401) throw err;
      localStorage.removeItem('ultraAgentApiKey');
      localStorage.removeItem('ultraAgentUserId');
      apiKey = null;
      userId = null;
      await ensureAccount();
      return api(path, options);
    }
  }

  async function ensureAccount() {
    if (apiKey && userId) return;
    const data = await api('/register', { method: 'POST' });
    apiKey = data.apiKey;
    userId = data.userId;
    localStorage.setItem('ultraAgentApiKey', apiKey);
    localStorage.setItem('ultraAgentUserId', userId);
  }

  // ── Navigation ───────────────────────────────────────────────────────
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    document.querySelectorAll('.rail-btn').forEach((b) => b.classList.remove('is-active'));
    const view = document.getElementById(`view-${name}`);
    if (view) view.classList.add('is-active');
    const btn = document.querySelector(`.rail-btn[data-view="${name}"]`);
    if (btn) btn.classList.add('is-active');
  }

  document.querySelectorAll('.rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === 'groupes') loadGroups();
    });
  });

  $('#backToGroups').addEventListener('click', () => showView('groupes'));

  // ── Statut de connexion ─────────────────────────────────────────────
  function renderStatus(status) {
    $('#statusConnection').textContent = status.connectionStatus;
    $('#statusPhone').textContent = status.phoneNumber || '—';
    $('#statusUserId').textContent = status.userId;

    const pill = $('#railStatusPill');
    pill.className = 'pill';
    if (status.connected) {
      pill.classList.add('pill-on');
      pill.textContent = 'connecté';
    } else if (status.connectionStatus === 'pending') {
      pill.classList.add('pill-pending');
      pill.textContent = 'jumelage...';
    } else {
      pill.classList.add('pill-off');
      pill.textContent = 'déconnecté';
    }
  }

  async function refreshStatus() {
    try {
      const status = await apiAuth('/status');
      renderStatus(status);
      return status;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  }

  function pollStatusUntilConnected() {
    clearInterval(statusPollTimer);
    statusPollTimer = setInterval(async () => {
      const status = await refreshStatus();
      if (status?.connected) {
        clearInterval(statusPollTimer);
        toast('Compte WhatsApp connecté ✅');
        loadGroups();
      }
    }, 4000);
  }

  // ── Jumelage ─────────────────────────────────────────────────────────
  $('#pairingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneNumber = $('#phoneInput').value.trim();
    if (!phoneNumber) return;

    const submitBtn = $('#pairingSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Génération...';

    try {
      const { pairingCode } = await apiAuth('/pairing', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber }),
      });
      if (pairingCode === 'ALREADY_REGISTERED') {
        $('#pairingCode').textContent = 'DÉJÀ LIÉ';
        toast('Cette session est déjà enregistrée — reconnexion en cours.');
      } else {
        $('#pairingCode').textContent = pairingCode;
        toast('Entre ce code dans WhatsApp → Appareils connectés → Associer un appareil.');
      }
      pollStatusUntilConnected();
    } catch (err) {
      toast(err.message, true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Obtenir le code';
    }
  });

  // ── Groupes ──────────────────────────────────────────────────────────
  async function loadGroups() {
    const grid = $('#groupGrid');
    try {
      const { groups } = await apiAuth('/groups');
      if (!groups.length) {
        grid.innerHTML = '<div class="empty-state">Aucun groupe trouvé pour ce compte WhatsApp.</div>';
        return;
      }
      grid.innerHTML = groups.map(groupCardHtml).join('');
      grid.querySelectorAll('.group-card').forEach((card) => {
        card.addEventListener('click', () => openGroupDetail(card.dataset.jid, card.dataset.name));
      });
    } catch (err) {
      grid.innerHTML = `<div class="empty-state">${err.message === 'Aucun compte WhatsApp connecté pour le moment.' ? 'Connecte d\'abord un compte WhatsApp (onglet Connexion).' : err.message}</div>`;
    }
  }

  function groupCardHtml(g) {
    return `
      <div class="group-card" data-jid="${g.groupJid}" data-name="${escapeHtml(g.name)}">
        <div class="gc-head">
          <div>
            <div class="gc-name">${escapeHtml(g.name)}</div>
            <div class="gc-members">${g.memberCount} membre(s)</div>
          </div>
          <span class="badge ${g.enabled ? 'on' : ''}">${g.enabled ? 'ACTIF' : 'INACTIF'}</span>
        </div>
        <div class="gc-badges">
          <span class="badge ${g.aiEnabled ? 'on' : ''}">🤖 IA</span>
          <span class="badge ${g.antiLinkEnabled ? 'on' : ''}">🔗 Anti-liens</span>
        </div>
      </div>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  $('#refreshGroups').addEventListener('click', loadGroups);

  // ── Détail groupe ────────────────────────────────────────────────────
  async function openGroupDetail(groupJid, fallbackName) {
    currentGroupJid = groupJid;
    $('#detailName').textContent = fallbackName || groupJid;
    $('#detailJid').textContent = groupJid;
    showView('groupe-detail');

    try {
      const detail = await apiAuth(`/groups/${encodeURIComponent(groupJid)}`);
      renderDetail(detail);
    } catch {
      // Pas encore activé : le groupe n'existe pas en base tant que .plus_ultra
      // ou "Activer" n'a pas été utilisé — on affiche un état par défaut.
      renderDetail({ enabled: false, aiEnabled: true, antiLinkEnabled: true, maxWarnings: 3, rules: '' });
    }

    try {
      const stats = await apiAuth(`/groups/${encodeURIComponent(groupJid)}/stats`);
      renderMemory(stats);
    } catch {
      renderMemory({ current: 0, limit: 1000, archives: 0 });
    }
  }

  function renderDetail(g) {
    $('#detailFeatures').innerHTML = `
      <div class="feature-row"><span>Statut</span><span>${g.enabled ? '🟢 Actif' : '⚪ Inactif'}</span></div>
      <div class="feature-row"><span>IA conversationnelle</span><span>${g.aiEnabled ? 'ON' : 'OFF'}</span></div>
      <div class="feature-row"><span>Anti-liens</span><span>${g.antiLinkEnabled ? 'ON' : 'OFF'}</span></div>
      <div class="feature-row"><span>Avertissements max</span><span>${g.maxWarnings}</span></div>
    `;
    $('#detailRules').textContent = g.rules?.trim() ? g.rules : '(aucun règlement défini — utilise .reglement dans le groupe)';
  }

  function renderMemory(stats) {
    const pct = stats.limit ? Math.min(100, Math.round((stats.current / stats.limit) * 100)) : 0;
    $('#memBarFill').style.width = `${pct}%`;
    $('#memBarLabel').textContent = `${stats.current} / ${stats.limit} messages`;
    $('#memArchiveLabel').textContent = `${stats.archives} archive(s)`;
  }

  $('#detailEnable').addEventListener('click', async () => {
    if (!currentGroupJid) return;
    try {
      await apiAuth(`/groups/${encodeURIComponent(currentGroupJid)}/enable`, { method: 'POST' });
      toast('Groupe activé ✅');
      openGroupDetail(currentGroupJid, $('#detailName').textContent);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#detailDisable').addEventListener('click', async () => {
    if (!currentGroupJid) return;
    try {
      await apiAuth(`/groups/${encodeURIComponent(currentGroupJid)}/disable`, { method: 'POST' });
      toast('Groupe désactivé');
      openGroupDetail(currentGroupJid, $('#detailName').textContent);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ── Démarrage ────────────────────────────────────────────────────────
  (async function init() {
    try {
      await ensureAccount();
      const status = await refreshStatus();
      if (status && !status.connected && status.connectionStatus === 'pending') {
        pollStatusUntilConnected();
      }
      if (status?.connected) loadGroups();
    } catch (err) {
      toast(err.message, true);
    }
  })();
})();
