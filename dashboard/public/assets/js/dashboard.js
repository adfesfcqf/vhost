// ── État global ───────────────────────────────────────────
let state = {
  bot: {},
  ticketTypes: [],
  guilds: [],
  panelChannels: [],
  staffCategories: [],
  staffRoles: [],
  me: null,
  admins: [],
  service: 'discord',
  minecraft: { config: {}, runtime: {} },
  botHost: { config: {}, runtime: {} },
  files: { path: '', items: [], openFile: null },
};

// ── Utilitaires ───────────────────────────────────────────
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur inconnue');
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function fillSelect(select, items, { value, label, placeholder }) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = value(item);
    opt.textContent = label(item);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── LAZY LOADING DES VUES & NAVIGATION ────────────────────
const LAZY_LOADERS = { 
  stats: loadStats, 
  access: loadAdmins,
  audit: loadAuditLog,
  general: loadBotHost,
  minecraft: loadMinecraft,
  'minecraft-console': loadMinecraft,
  'minecraft-player-logs': loadPlayerLogs,
  files: () => loadFiles(''),
  'server-console': loadServerConsole,
  tokens: loadTokensSection,
};
const loadedViews = new Set(['overview']);

function initNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      
      item.classList.add('active');
      const viewName = item.dataset.view;
      const targetView = document.getElementById(`view-${viewName}`);
      if (targetView) targetView.classList.add('active');

      if (!loadedViews.has(viewName) && LAZY_LOADERS[viewName]) {
        loadedViews.add(viewName);
        LAZY_LOADERS[viewName]();
      }
    });
  });
}

// Cache les entrées de nav qui ne concernent pas le service de ce tenant
// (data-service="discord" masqué pour un tenant Minecraft, et inversement).
// Un nav-item sans attribut data-service est toujours visible (vue commune
// aux deux services : vue d'ensemble, abonnement, accès admin, fichiers…).
// Le service lui-même est fixé à l'inscription et ne peut plus changer
// ensuite (pas de switcher : voir /api/signup côté serveur).
function applyServiceVisibility() {
  document.querySelectorAll('.nav-item[data-service]').forEach((item) => {
    item.style.display = item.dataset.service === state.service ? '' : 'none';
  });
  // Éléments hors nav qui ne doivent apparaître que pour un service donné
  // (ex: bouton d'installation de packs Bedrock, propre à Minecraft).
  document.querySelectorAll('[data-service-only]').forEach((item) => {
    item.style.display = item.dataset.serviceOnly === state.service ? '' : 'none';
  });
  // Si la vue active vient d'être masquée (ex: on était sur "Connexion bot"
  // et le tenant est en fait Minecraft), on retombe sur "Vue d'ensemble".
  const activeItem = document.querySelector('.nav-item.active');
  if (activeItem && activeItem.style.display === 'none') {
    document.querySelector('.nav-item[data-view="overview"]')?.click();
  }
}

document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await api('POST', '/api/logout');
  window.location.href = '/login';
});

// ── Utilisateur connecté (Discord) ─────────────────────────
async function loadMe() {
  try {
    const data = await api('GET', '/api/me');
    state.me = data.user;
  window.__tenantId = data.user?.dbId || null;
  window.__currentService = data.service || state.service;
  window.__currentPlanType = data.planType || data.user?.planType || null;
  if (data.user && data.user.isDemo) {
    state.isDemo = true;
    // Rediriger le bouton logout vers demo/logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.onclick = () => window.location.href = '/demo/logout';
  }
  if (data.user && data.user.isDemo) {
    const banner = document.getElementById('demo-banner');
    if (banner) { banner.style.display='flex'; document.getElementById('main-sidebar').style.marginTop='37px'; }
    state.isDemo = true;
  }
    state.admins = data.admins;
    const avatar = document.getElementById('user-avatar');
    const name = document.getElementById('user-name');
    if (avatar) avatar.src = data.user.avatar;
    if (name) name.textContent = data.user.username;
  } catch {}
}

// ── Statut du bot ─────────────────────────────────────────
const STATUS_LABELS = {
  online: 'En ligne',
  connecting: 'Connexion…',
  offline: 'Hors ligne',
  error: 'Erreur',
};

function onViewChange(id) {
  if (id === 'referral') loadReferral();
}

async function refreshStatus() {
  try {
    const s = await api('GET', '/api/status');
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (dot) dot.className = `status-dot ${s.status}`;
    if (text) text.textContent = STATUS_LABELS[s.status] || s.status;

    const lines = [];
    lines.push(`<strong>Statut :</strong> ${STATUS_LABELS[s.status] || s.status}`);
    if (s.tag) lines.push(`<strong>Compte :</strong> <span class="mono">${escapeHtml(s.tag)}</span>`);
    if (s.guildCount) lines.push(`<strong>Serveurs :</strong> ${s.guildCount}`);
    if (s.ping !== null && s.ping >= 0) lines.push(`<strong>Latence :</strong> ${s.ping} ms`);
    if (s.lastError) lines.push(`<strong style="color:var(--coral)">Dernière erreur :</strong> ${escapeHtml(s.lastError)}`);
    
    const overviewStatus = document.getElementById('overview-status');
    if (overviewStatus) overviewStatus.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');

    // Même statut, dupliqué dans le "Panel" (onglet hébergement Discord).
    const panelStatus = document.getElementById('panel-bot-status');
    if (panelStatus) panelStatus.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  } catch {}
}

// ── Chargement des settings ───────────────────────────────
async function loadSettings() {
  const data = await api('GET', '/api/settings');
  state.bot = data.bot;
  state.ticketTypes = data.ticketTypes;

  const tokenInput = document.getElementById('input-token');
  if (tokenInput) tokenInput.placeholder = data.hasToken ? data.bot.token : 'Colle ton token ici';

  const setInputValue = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  };

  setInputValue('input-panel-title', data.bot.panelTitle);
  setInputValue('input-panel-desc', data.bot.panelDescription);
  setInputValue('input-panel-banner', data.bot.panelBanner);
  setInputValue('input-embed-color', data.bot.embedColor);
  setInputValue('input-footer', data.bot.footerText);

  renderTicketTypes();
}

async function loadGuilds() {
  state.guilds = await api('GET', '/api/discord/guilds');

  const panelGuildSelect = document.getElementById('select-panel-guild');
  const staffGuildSelect = document.getElementById('select-staff-guild');

  const opts = { value: (g) => g.id, label: (g) => g.name, placeholder: 'Sélectionner un serveur…' };
  fillSelect(panelGuildSelect, state.guilds, opts);
  fillSelect(staffGuildSelect, state.guilds, opts);

  if (panelGuildSelect) panelGuildSelect.value = state.bot.panelGuildId || '';
  if (staffGuildSelect) staffGuildSelect.value = state.bot.staffGuildId || '';

  if (state.guilds.length === 0) {
    toast("Le bot n'est connecté à aucun serveur pour l'instant.", true);
  }

  await Promise.all([onPanelGuildChange(false), onStaffGuildChange(false)]);
}

async function onPanelGuildChange(fromUser = true) {
  const guildSelect = document.getElementById('select-panel-guild');
  const channelSelect = document.getElementById('select-panel-channel');
  if (!guildSelect || !channelSelect) return;

  const guildId = guildSelect.value;
  if (!guildId) return fillSelect(channelSelect, [], { value: () => '', label: () => '', placeholder: 'Choisis un serveur d\'abord' });

  state.panelChannels = await api('GET', `/api/discord/guilds/${guildId}/channels`);
  fillSelect(channelSelect, state.panelChannels, {
    value: (c) => c.id,
    label: (c) => `#${c.name}`,
    placeholder: 'Sélectionner un salon…',
  });
  if (!fromUser) channelSelect.value = state.bot.panelChannelId || '';
  else channelSelect.value = '';
}

async function onStaffGuildChange(fromUser = true) {
  const guildSelect = document.getElementById('select-staff-guild');
  const categorySelect = document.getElementById('select-staff-category');
  if (!guildSelect || !categorySelect) return;

  const guildId = guildSelect.value;
  if (!guildId) {
    fillSelect(categorySelect, [], { value: () => '', label: () => '', placeholder: 'Choisis un serveur d\'abord' });
    state.staffRoles = [];
    state.staffCategories = [];
    renderTicketTypes();
    return;
  }

  const [categories, roles] = await Promise.all([
    api('GET', `/api/discord/guilds/${guildId}/categories`),
    api('GET', `/api/discord/guilds/${guildId}/roles`),
  ]);

  state.staffCategories = categories;
  state.staffRoles = roles;

  fillSelect(categorySelect, categories, {
    value: (c) => c.id,
    label: (c) => c.name,
    placeholder: 'Aucune catégorie (Par défaut)',
  });
  if (!fromUser) categorySelect.value = state.bot.staffCategoryId || '';
  else categorySelect.value = '';

  renderTicketTypes();
}

document.getElementById('select-panel-guild')?.addEventListener('change', () => onPanelGuildChange(true));
document.getElementById('select-staff-guild')?.addEventListener('change', () => onStaffGuildChange(true));

// ── Enregistrement token & config ─────────────────────────
// Attend que le bot passe à 'online' (ou 'error') au lieu de miser sur un
// délai fixe : la connexion à Discord peut prendre de 1 à plusieurs
// secondes selon le nombre de serveurs/le réseau, un setTimeout unique de
// 2.5s déclarait le bot "hors ligne" bien avant qu'il ait fini de se
// connecter, ce qui donnait l'impression que ça restait bloqué.
async function waitForBotOnline(timeoutMs = 20000, intervalMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api('GET', '/api/status').catch(() => null);
    if (s && s.status === 'online') return s;
    if (s && s.status === 'error') return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return api('GET', '/api/status').catch(() => ({ status: 'connecting' }));
}

document.getElementById('save-token-btn')?.addEventListener('click', async () => {
  const token = document.getElementById('input-token').value.trim();
  if (!token) return toast('Colle un token avant de sauvegarder.', true);
  try {
    await api('POST', '/api/settings/bot', { token });
    toast('Token enregistré, connexion en cours…');
    document.getElementById('input-token').value = '';

    const finalStatus = await waitForBotOnline();
    await loadSettings();
    await loadGuilds();

    if (finalStatus.status !== 'online') {
      toast(
        finalStatus.lastError
          ? `La connexion du bot a échoué : ${finalStatus.lastError}`
          : "Le bot met plus de temps que prévu à se connecter, vérifie son statut dans \"Vue d'ensemble\".",
        true
      );
      return;
    }

    // Le bot vient de se connecter : on tente de republier le panel et on
    // remonte le vrai résultat, au lieu de laisser ça se passer
    // silencieusement en tâche de fond sans aucun retour visible.
    try {
      await api('POST', '/api/bot/refresh-panel');
      toast('Bot connecté, panel republié dans le salon configuré.');
    } catch (err) {
      toast(`Bot connecté, mais le panel n'a pas pu être envoyé : ${err.message}`, true);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('save-general-btn')?.addEventListener('click', async () => {
  const patch = {
    panelGuildId: document.getElementById('select-panel-guild').value,
    panelChannelId: document.getElementById('select-panel-channel').value,
    staffGuildId: document.getElementById('select-staff-guild').value,
    staffCategoryId: document.getElementById('select-staff-category').value,
    panelTitle: document.getElementById('input-panel-title').value,
    panelDescription: document.getElementById('input-panel-desc').value,
    panelBanner: document.getElementById('input-panel-banner').value,
    embedColor: document.getElementById('input-embed-color').value.replace('#', ''),
    footerText: document.getElementById('input-footer').value,
  };
  try {
    const res = await api('POST', '/api/settings/bot', patch);
    state.bot = { ...state.bot, ...res.bot };
    // res.panel contient le vrai résultat de la republication tentée côté
    // serveur juste après la sauvegarde (voir /api/settings/bot).
    if (res.panel && !res.panel.ok) {
      toast(`Configuration enregistrée, mais le panel n'a pas pu être republié : ${res.panel.reason}`, true);
    } else if (res.panel && res.panel.ok) {
      toast('Configuration enregistrée et panel republié.');
    } else {
      toast('Configuration enregistrée.');
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Actions rapides ────────────────────────────────────────
document.getElementById('refresh-panel-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/bot/refresh-panel');
    toast('Panel republié.');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('restart-bot-btn')?.addEventListener('click', async () => {
  try {
    toast('Reconnexion en cours…');
    await api('POST', '/api/bot/restart');
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('diagnose-bot-btn')?.addEventListener('click', async () => {
  const out = document.getElementById('diagnose-result');
  const btn = document.getElementById('diagnose-bot-btn');
  if (out) {
    out.style.display = 'block';
    out.textContent = 'Diagnostic en cours (test token + réseau Discord)…';
  }
  if (btn) btn.disabled = true;
  try {
    const r = await api('GET', '/api/bot/diagnose');
    const lines = r.steps.map((s) => `${s.ok ? '✅' : '❌'} ${s.step} (${s.ms}ms)\n   ${s.detail}`);
    lines.push('', `→ ${r.verdict}`);
    if (out) out.textContent = lines.join('\n');
  } catch (err) {
    if (out) out.textContent = `Erreur : ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ── Bot Discord hébergé (Panel) : start/stop/restart d'un process Node
// arbitraire, à partir du code que le client a envoyé dans l'onglet
// Fichiers. Indépendant du bot de tickets (Statut du bot / Connexion). ──
let bhLogsPollTimer = null;

function renderBotHostStatus() {
  const runtime = state.botHost?.runtime;
  if (!runtime) return;
  const badge = document.getElementById('bh-status-badge');
  if (badge) {
    const labels = {
      stopped: 'Arrêté',
      installing: 'Installation des dépendances…',
      starting: 'Démarrage…',
      running: 'En ligne',
      stopping: 'Arrêt…',
      crashed: 'Crashé',
      error: 'Erreur',
    };
    badge.className = `mc-status-badge ${runtime.status}`;
    badge.textContent = labels[runtime.status] || runtime.status;
  }
  const entryInput = document.getElementById('bh-entry-input');
  if (entryInput && document.activeElement !== entryInput) entryInput.value = runtime.entryFile || 'index.js';

  const autoToggle = document.getElementById('bh-autorestart-toggle');
  if (autoToggle) autoToggle.checked = !!state.botHost?.config?.autoRestart;

  const startBtn = document.getElementById('bh-start-btn');
  const stopBtn = document.getElementById('bh-stop-btn');
  const restartBtn = document.getElementById('bh-restart-btn');
  const busy = runtime.status === 'starting' || runtime.status === 'installing';
  const isRunning = runtime.status === 'running';
  if (startBtn) startBtn.disabled = busy || isRunning;
  if (stopBtn) stopBtn.disabled = !isRunning;
  if (restartBtn) restartBtn.disabled = !isRunning;

  if (runtime.lastError) toast(runtime.lastError, true);
}

async function loadBotHost() {
  try {
    const config = await api('GET', '/api/bot-host');
    state.botHost = config;
    renderBotHostStatus();
    startBhLogsPolling();
  } catch (err) {
    toast(err.message, true);
  }
}

function startBhLogsPolling() {
  if (bhLogsPollTimer) clearInterval(bhLogsPollTimer);
  pollBhLogs();
  bhLogsPollTimer = setInterval(pollBhLogs, 2000);
}

async function pollBhLogs() {
  const box = document.getElementById('bh-console');
  if (!box) return;
  try {
    const { logs } = await api('GET', '/api/bot-host/logs');
    const text = logs.join('\n');
    const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.textContent = text;
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
  } catch {}
  // Le statut (running/crashed…) peut changer sans action de l'utilisateur
  // (crash, redémarrage auto) — on le rafraîchit au même rythme que les logs.
  try {
    const data = await api('GET', '/api/bot-host');
    state.botHost = data;
    renderBotHostStatus();
  } catch {}
}

document.getElementById('bh-start-btn')?.addEventListener('click', async () => {
  try {
    const result = await api('POST', '/api/bot-host/start');
    state.botHost = { ...state.botHost, runtime: result };
    renderBotHostStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('bh-stop-btn')?.addEventListener('click', async () => {
  try {
    const result = await api('POST', '/api/bot-host/stop');
    state.botHost = { ...state.botHost, runtime: result };
    renderBotHostStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('bh-restart-btn')?.addEventListener('click', async () => {
  try {
    const result = await api('POST', '/api/bot-host/restart');
    state.botHost = { ...state.botHost, runtime: result };
    renderBotHostStatus();
    toast('Bot redémarré.');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('bh-save-entry-btn')?.addEventListener('click', async () => {
  const entryFile = document.getElementById('bh-entry-input')?.value.trim() || 'index.js';
  const autoRestart = !!document.getElementById('bh-autorestart-toggle')?.checked;
  try {
    const res = await api('POST', '/api/bot-host/settings', { entryFile, autoRestart });
    state.botHost = { ...state.botHost, config: res.config };
    toast('Configuration enregistrée.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Types de tickets ───────────────────────────────────────
function roleNameById(id) {
  const r = state.staffRoles.find((r) => r.id === id);
  return r ? r.name : id;
}

function categoryNameById(id) {
  const c = state.staffCategories.find((cat) => cat.id === id);
  return c ? c.name : null;
}

function renderTicketTypes() {
  const container = document.getElementById('types-list');
  if (!container) return;
  container.innerHTML = '';

  if (state.ticketTypes.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🎟️</div>Aucun type de ticket. Clique sur "+ Nouveau type" pour commencer.</div>`;
    return;
  }

  for (const type of state.ticketTypes) {
    const el = document.createElement('div');
    el.className = 'ticket-stub';
    const roleChips = (type.allowedRoles || [])
      .map((rid) => `<span class="role-chip">${escapeHtml(roleNameById(rid))}</span>`)
      .join('');

    const specificCategory = type.categoryId ? categoryNameById(type.categoryId) : null;
    const catBadge = specificCategory 
      ? `<span class="badge-ultra" style="margin-left:8px;">📁 ${escapeHtml(specificCategory)}</span>` 
      : '';

    el.innerHTML = `
      <div class="stub-emoji">${escapeHtml(type.emoji) || '🎫'}</div>
      <div class="stub-body">
        <div class="stub-title-row">
          <span class="color-dot" style="background:#${(type.color || '5865F2').replace('#', '')}"></span>
          <span class="stub-title">${escapeHtml(type.label)}</span>
          <span class="stub-id mono">${escapeHtml(type.id)}</span>
          ${catBadge}
        </div>
        <div class="stub-desc">${escapeHtml(type.description || '')}</div>
        <div class="stub-roles">${roleChips || '<span class="field-hint">Aucun rôle assigné — personne ne verra ce ticket.</span>'}</div>
      </div>
      <div class="stub-actions">
        <button class="btn-ghost edit-type-btn">✏️ Modifier</button>
      </div>
    `;
    el.querySelector('.edit-type-btn').addEventListener('click', () => openTypeModal(type));
    container.appendChild(el);
  }
}

// ── Modal type de ticket ───────────────────────────────────
let selectedRoleIds = new Set();

function renderRolesPicker() {
  const picker = document.getElementById('type-roles-picker');
  if (!picker) return;
  picker.innerHTML = '';

  if (state.staffRoles.length === 0) {
    picker.innerHTML = `<span class="field-hint">Aucun rôle disponible — sélectionne d'abord un serveur staff connecté dans "Configuration générale".</span>`;
    return;
  }

  for (const role of state.staffRoles) {
    const label = document.createElement('label');
    label.className = 'role-option' + (selectedRoleIds.has(role.id) ? ' selected' : '');
    label.innerHTML = `<input type="checkbox" value="${role.id}" ${selectedRoleIds.has(role.id) ? 'checked' : ''}> ${escapeHtml(role.name)}`;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) selectedRoleIds.add(role.id);
      else selectedRoleIds.delete(role.id);
      label.classList.toggle('selected', e.target.checked);
    });
    picker.appendChild(label);
  }
}

function openTypeModal(type = null) {
  document.getElementById('type-modal-title').textContent = type ? 'Modifier le type de ticket' : 'Nouveau type de ticket';
  document.getElementById('type-original-id').value = type ? type.id : '';
  document.getElementById('type-emoji').value = type ? type.emoji : '';
  document.getElementById('type-label').value = type ? type.label : '';
  document.getElementById('type-id').value = type ? type.id : '';
  document.getElementById('type-id').disabled = !!type;
  document.getElementById('type-desc').value = type ? type.description : '';
  document.getElementById('type-color').value = type ? type.color : '5865F2';
  document.getElementById('type-delete-btn').style.display = type ? 'inline-flex' : 'none';

  const categorySelect = document.getElementById('type-category');
  if (categorySelect) {
    categorySelect.innerHTML = '<option value="">Utiliser la catégorie par défaut (Globale)</option>';
    
    if (state.staffCategories && state.staffCategories.length > 0) {
      state.staffCategories.forEach((cat) => {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = `📁 ${cat.name}`;
        categorySelect.appendChild(opt);
      });
    }
    categorySelect.value = type ? (type.categoryId || '') : '';
  }

  const welcomeInput = document.getElementById('type-welcome-msg');
  if (welcomeInput) {
    welcomeInput.value = type ? (type.welcomeMessage || '') : '';
  }

  selectedRoleIds = new Set(type ? type.allowedRoles || [] : []);
  renderRolesPicker();

  document.getElementById('type-modal-backdrop')?.classList.add('show');
}

function closeTypeModal() {
  document.getElementById('type-modal-backdrop')?.classList.remove('show');
}

document.getElementById('add-type-btn')?.addEventListener('click', () => openTypeModal());
document.getElementById('type-cancel-btn')?.addEventListener('click', closeTypeModal);

document.getElementById('type-save-btn')?.addEventListener('click', async () => {
  const originalId = document.getElementById('type-original-id').value;
  const id = document.getElementById('type-id').value.trim().toLowerCase().replace(/\s+/g, '-');
  const label = document.getElementById('type-label').value.trim();
  const emoji = document.getElementById('type-emoji').value.trim();
  const description = document.getElementById('type-desc').value.trim();
  const color = document.getElementById('type-color').value.trim().replace('#', '') || '5865F2';
  
  const categoryId = document.getElementById('type-category')?.value || '';
  const welcomeMessage = document.getElementById('type-welcome-msg')?.value.trim() || '';

  if (!id || !label || !emoji) {
    return toast('Emoji, nom et identifiant sont obligatoires.', true);
  }
  // Miroir de lib/config.js#isValidEmoji côté serveur : évite un aller-retour
  // API inutile pour une erreur qu'on peut détecter tout de suite. La
  // validation serveur reste la source de vérité (voir /api/settings/ticket-types).
  const CUSTOM_EMOJI_RE = /^<a?:\w{2,32}:\d{17,20}>$/;
  const UNICODE_EMOJI_RE = /^(\p{Extended_Pictographic}\uFE0F?)(\u200d\p{Extended_Pictographic}\uFE0F?)*$/u;
  if (!CUSTOM_EMOJI_RE.test(emoji) && !UNICODE_EMOJI_RE.test(emoji)) {
    return toast(`Emoji invalide : "${emoji}". Utilise un emoji Unicode (ex: 🎫) ou un emoji du serveur (ex: <:nom:1234567890>).`, true);
  }

  const newType = { 
    id, 
    label, 
    emoji, 
    description, 
    color, 
    categoryId,
    welcomeMessage,
    allowedRoles: [...selectedRoleIds] 
  };

  let updated;
  if (originalId) {
    updated = state.ticketTypes.map((t) => (t.id === originalId ? newType : t));
  } else {
    if (state.ticketTypes.some((t) => t.id === id)) {
      return toast('Cet identifiant est déjà utilisé.', true);
    }
    updated = [...state.ticketTypes, newType];
  }

  try {
    const res = await api('POST', '/api/settings/ticket-types', { ticketTypes: updated });
    state.ticketTypes = res.ticketTypes;
    renderTicketTypes();
    closeTypeModal();
    toast('Type de ticket enregistré !');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('type-delete-btn')?.addEventListener('click', async () => {
  const originalId = document.getElementById('type-original-id').value;
  if (!confirm('Supprimer ce type de ticket ? Les boutons du panel seront mis à jour.')) return;

  const updated = state.ticketTypes.filter((t) => t.id !== originalId);
  try {
    const res = await api('POST', '/api/settings/ticket-types', { ticketTypes: updated });
    state.ticketTypes = res.ticketTypes;
    renderTicketTypes();
    closeTypeModal();
    toast('Type de ticket supprimé.');
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Playlist musicale (Configuration générale) ──────────────
state.music = { enabled: false, volume: 100, loop: true, trackDurationSec: 180, tracks: [], playing: false, currentTrackId: null, hasLinkedServer: false };

function formatBytes(bytes) {
  if (!bytes) return '0 Ko';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadMusicPlaylist() {
  const box = document.getElementById('music-accordion');
  try {
    state.music = await api('GET', '/api/music');
    if (box) box.style.display = 'none';
  } catch {
    if (box) box.style.display = 'none';
    return;
  }
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

  setChecked('toggle-music-enabled', state.music.enabled);
  setChecked('toggle-music-loop', state.music.loop);
  setVal('input-music-volume', state.music.volume);
  setVal('input-music-duration', state.music.trackDurationSec);

  const hint = document.getElementById('music-server-hint');
  if (hint) {
    hint.textContent = state.music.hasLinkedServer
      ? "Ce compte est lié à un serveur Minecraft — dès que le serveur démarre, la playlist se lance automatiquement si elle est activée ci-dessous."
      : "Aucun serveur Minecraft n'est lié à ce compte pour l'instant : tu peux déjà préparer la playlist, elle se lancera automatiquement dès qu'un serveur tournera.";
  }

  renderMusicTracks();
}

function renderMusicTracks() {
  const container = document.getElementById('music-tracks-list');
  if (!container) return;
  container.innerHTML = '';

  if (state.music.tracks.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🎵</div>Aucune piste. Ajoute un fichier audio ou vidéo ci-dessus pour créer ta playlist.</div>`;
    return;
  }

  state.music.tracks.forEach((track, idx) => {
    const el = document.createElement('div');
    el.className = 'music-track' + (state.music.currentTrackId === track.id ? ' is-playing' : '');
    el.innerHTML = `
      <span class="music-track-name">${state.music.currentTrackId === track.id ? '🔊 ' : '🎧 '}${escapeHtml(track.name)}</span>
      <span class="music-track-meta">${escapeHtml((track.ext || '').replace('.', '').toUpperCase())} · ${formatBytes(track.sizeBytes)}</span>
      <div class="music-track-actions">
        <button class="btn-ghost move-up-btn" ${idx === 0 ? 'disabled' : ''} title="Monter">⬆️</button>
        <button class="btn-ghost move-down-btn" ${idx === state.music.tracks.length - 1 ? 'disabled' : ''} title="Descendre">⬇️</button>
        <button class="btn-ghost delete-track-btn" title="Supprimer">🗑️</button>
      </div>
    `;
    el.querySelector('.move-up-btn').addEventListener('click', () => reorderMusicTrack(idx, idx - 1));
    el.querySelector('.move-down-btn').addEventListener('click', () => reorderMusicTrack(idx, idx + 1));
    el.querySelector('.delete-track-btn').addEventListener('click', () => deleteMusicTrack(track.id));
    container.appendChild(el);
  });
}

async function reorderMusicTrack(from, to) {
  if (to < 0 || to >= state.music.tracks.length) return;
  const tracks = [...state.music.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  try {
    state.music = { ...state.music, ...(await api('POST', '/api/music/tracks/reorder', { order: tracks.map((t) => t.id) })) };
    renderMusicTracks();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteMusicTrack(id) {
  if (!confirm('Supprimer cette piste de la playlist ?')) return;
  try {
    state.music = { ...state.music, ...(await api('POST', '/api/music/tracks/delete', { id })) };
    renderMusicTracks();
    toast('Piste supprimée.');
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('save-music-config-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/music/config', {
      enabled: document.getElementById('toggle-music-enabled').checked,
      loop: document.getElementById('toggle-music-loop').checked,
      volume: Number(document.getElementById('input-music-volume').value),
      trackDurationSec: Number(document.getElementById('input-music-duration').value),
    });
    // Recharge tout l'état (et pas juste le patch renvoyé) : si l'activation
    // vient de déclencher un démarrage/arrêt immédiat côté serveur (voir
    // /api/music/config), on veut que playing/currentTrackId reflètent
    // tout de suite ce changement dans la liste des pistes.
    await loadMusicPlaylist();
    toast('Réglages de la playlist enregistrés.');
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('input-music-upload')?.addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const file of files) {
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1] || '');
        reader.onerror = () => reject(new Error(`Lecture impossible pour ${file.name}`));
        reader.readAsDataURL(file);
      });
      state.music = { ...state.music, ...(await api('POST', '/api/music/tracks', { name: file.name, base64 })) };
      renderMusicTracks();
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (files.length) toast(`${files.length} piste(s) ajoutée(s).`);
});

document.getElementById('music-build-pack-btn')?.addEventListener('click', async () => {
  try {
    const result = await api('POST', '/api/music/resource-pack', {});
    toast(result.autoInstalled
      ? `Resource pack généré et installé (${result.trackCount} piste(s)).`
      : `Resource pack généré (${result.trackCount} piste(s)) — télécharge-le et installe-le manuellement.`);
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('music-download-pack-btn')?.addEventListener('click', () => {
  window.open('/api/music/resource-pack/download', '_blank');
});

// ── Statistiques ───────────────────────────────────────────
function typeLabel(typeId) {
  const t = state.ticketTypes.find((t) => t.id === typeId);
  return t ? `${t.emoji} ${t.label}` : typeId;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours} h ${remMins} min`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadStats() {
  let stats;
  try {
    stats = await api('GET', '/api/stats');
  } catch (err) {
    return toast(err.message, true);
  }

  const grid = document.getElementById('stat-grid');
  if (grid) {
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">Tickets créés</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--green)">${stats.open}</div>
        <div class="stat-label">Actuellement ouverts</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.closed}</div>
        <div class="stat-label">Fermés</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${stats.unclaimedOpen > 0 ? 'var(--amber)' : 'var(--text)'}">${stats.unclaimedOpen}</div>
        <div class="stat-label">Ouverts non pris en charge</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatDuration(stats.avgResolutionMs)}</div>
        <div class="stat-label">Temps de résolution moyen</div>
      </div>
    `;
  }

  const byTypeEl = document.getElementById('stat-by-type');
  if (byTypeEl) {
    const entries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      byTypeEl.innerHTML = `<div class="empty-state"><div class="icon">📊</div>Aucun ticket pour l'instant.</div>`;
    } else {
      const max = Math.max(...entries.map(([, count]) => count));
      byTypeEl.innerHTML = entries
        .map(
          ([typeId, count]) => `
          <div class="bar-row">
            <div class="bar-label">${escapeHtml(typeLabel(typeId))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(count / max) * 100}%"></div></div>
            <div class="bar-count">${count}</div>
          </div>`
        )
        .join('');
    }
  }

  const recentEl = document.getElementById('stat-recent');
  if (recentEl) {
    if (stats.recent.length === 0) {
      recentEl.innerHTML = `<div class="empty-state"><div class="icon">🕓</div>Rien à afficher pour l'instant.</div>`;
    } else {
      recentEl.innerHTML = stats.recent
        .map(
          (t) => `
          <div class="activity-row">
            <span class="status-dot ${t.status === 'open' ? 'online' : 'offline'}"></span>
            <div class="activity-body">
              <div><strong>${escapeHtml(typeLabel(t.typeId))}</strong> — ${escapeHtml(t.userTag || 'inconnu')} <span class="stub-id mono">#${escapeHtml(t.id)}</span></div>
              <div class="field-hint" style="margin-top:2px;">
                ${t.status === 'open' ? `Ouvert le ${formatDate(t.createdAt)}` : `Fermé le ${formatDate(t.closedAt)}`}
                ${t.claimedByTag ? ` · pris en charge par ${escapeHtml(t.claimedByTag)}` : ''}
              </div>
            </div>
          </div>`
        )
        .join('');
    }
  }
}

document.getElementById('export-csv-btn')?.addEventListener('click', () => {
  window.location.href = '/api/tickets/export.csv';
});

// ── Tickets ouverts ─────────────────────────────────────────
function ticketStatusBadge(t) {
  const base = 'display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;color:#fff;';
  if (t.claimedByTag) {
    return `<span style="${base}background:var(--green);">Pris en charge · ${escapeHtml(t.claimedByTag)}</span>`;
  }
  return `<span style="${base}background:var(--amber);">Ouvert · non pris en charge</span>`;
}

async function loadOpenTickets() {
  const tbody = document.getElementById('open-tickets-list');
  if (!tbody) return;

  let tickets;
  try {
    tickets = await api('GET', '/api/tickets/open');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#e04b4b;padding:20px;">Erreur de chargement : ${escapeHtml(err.message)}</td></tr>`;
    return;
  }

  if (!tickets.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:20px;">Aucun ticket ouvert pour l'instant.</td></tr>`;
    return;
  }

  tbody.innerHTML = tickets
    .map((t) => {
      const discordLink =
        t.guildId && t.channelId ? `https://discord.com/channels/${t.guildId}/${t.channelId}` : null;
      return `
        <tr>
          <td class="mono">#${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.userTag || 'inconnu')}</td>
          <td>${escapeHtml(typeLabel(t.typeId))}</td>
          <td>${ticketStatusBadge(t)}</td>
          <td>${discordLink ? `<a class="btn-ghost" href="${discordLink}" target="_blank" rel="noopener">Ouvrir sur Discord</a>` : '—'}</td>
        </tr>`;
    })
    .join('');
}

document.getElementById('refresh-open-tickets-btn')?.addEventListener('click', loadOpenTickets);

// ── Accès admin ─────────────────────────────────────────────
async function loadAdmins() {
  let data;
  try {
    data = await api('GET', '/api/admins');
  } catch (err) {
    return toast(err.message, true);
  }
  state.admins = data.admins;

  const list = document.getElementById('admins-list');
  if (!list) return;

  list.innerHTML = data.admins
    .map((admin) => {
      const isSelf = admin.id === data.selfId;
      return `
      <div class="admin-row" style="align-items:flex-start;">
        <div>
          <div class="mono">${escapeHtml(admin.id)}</div>
          <div class="field-row" style="margin-top:6px; align-items:center; gap:6px;">
            <input type="email" class="mono admin-email-input" data-id="${escapeHtml(admin.id)}"
              value="${escapeHtml(admin.email || '')}" placeholder="Pas d'e-mail lié" style="max-width:240px;">
            <button class="btn-ghost admin-email-save-btn" data-id="${escapeHtml(admin.id)}">Enregistrer l'e-mail</button>
          </div>
        </div>
        ${isSelf ? '<span class="role-chip">Toi</span>' : ''}
        <button class="btn-ghost admin-remove-btn" data-id="${escapeHtml(admin.id)}" ${data.admins.length <= 1 ? 'disabled' : ''}>Retirer</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.admin-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm("Retirer l'accès de cet administrateur ?")) return;
      try {
        await api('DELETE', `/api/admins/${btn.dataset.id}`);
        toast('Administrateur retiré.');
        loadAdmins();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  list.querySelectorAll('.admin-email-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = list.querySelector(`.admin-email-input[data-id="${CSS.escape(btn.dataset.id)}"]`);
      const email = input.value.trim();
      try {
        await api('PATCH', `/api/admins/${btn.dataset.id}/email`, { email });
        toast('E-mail mis à jour.');
        loadAdmins();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// ── Journal d'activités (audit log) ───────────────────────
const AUDIT_ACTION_LABELS = {
  'admins.add': 'Administrateur ajouté',
  'admins.remove': 'Administrateur retiré',
  'admins.role_change': "Rôle d'un administrateur modifié",
  'admins.email_change': "E-mail d'un administrateur modifié",
  'settings.bot.update': 'Configuration du bot modifiée',
  'settings.dayz.update': 'Configuration DayZ modifiée',
  'minecraft.create': 'Serveur Minecraft installé',
  'minecraft.start.launched': 'Démarrage lancé',
  'minecraft.start.success': 'Démarrage réussi',
  'minecraft.start.failed': 'Échec du démarrage',
  'minecraft.stop': 'Serveur arrêté',
  'minecraft.restart.launched': 'Redémarrage lancé',
  'minecraft.restart.success': 'Redémarrage réussi',
  'minecraft.restart.failed': 'Échec du redémarrage',
  'minecraft.update.launched': 'Mise à jour lancée',
  'minecraft.update.success': 'Mise à jour réussie',
  'minecraft.update.failed': 'Échec de la mise à jour',
  'minecraft.autoupdate.toggle': 'Mise à jour automatique modifiée',
  'minecraft.autoupdate.success': 'Mise à jour automatique réussie',
  'minecraft.autoupdate.failed': 'Échec de la mise à jour automatique',
  'minecraft.delete': 'Serveur Minecraft supprimé',
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action;
}

async function loadAuditLog() {
  let data;
  try {
    data = await api('GET', '/api/audit-log?limit=100');
  } catch (err) {
    return toast(err.message, true);
  }

  const list = document.getElementById('audit-log-list');
  if (!list) return;

  if (!data.entries || data.entries.length === 0) {
    list.innerHTML = '<div class="audit-empty">Aucune action enregistrée pour l\'instant.</div>';
    return;
  }

  list.innerHTML = data.entries
    .map((e) => {
      const who = e.actorTag || e.actorDiscordId || 'Inconnu';
      const target = e.target ? ` · <span class="mono">${escapeHtml(e.target)}</span>` : '';
      const details = e.details ? `<div class="audit-row-details">${escapeHtml(JSON.stringify(e.details))}</div>` : '';
      return `
      <div class="audit-row">
        <svg class="icon-svg audit-row-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <div class="audit-row-body">
          <div class="audit-row-action">${escapeHtml(auditActionLabel(e.action))}${target}</div>
          <div class="audit-row-meta">Par ${escapeHtml(who)} · ${formatDate(e.createdAt)}</div>
          ${details}
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('audit-refresh-btn')?.addEventListener('click', () => loadAuditLog());

document.getElementById('add-admin-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('input-new-admin');
  const id = input.value.trim();
  if (!/^\d{15,25}$/.test(id)) return toast('ID Discord invalide.', true);
  try {
    await api('POST', '/api/admins', { discordId: id });
    input.value = '';
    toast('Administrateur ajouté.');
    loadAdmins();
  } catch (err) {
    toast(err.message, true);
  }
});

// ── LIVE CONSOLE & SUPPORT DIRECT ─────────────────────────
window.activeTicketsData = {};

async function loadTickets() {
  const ticketSelect = document.getElementById('select-active-ticket');
  if (!ticketSelect) return;

  const previousValue = ticketSelect.value;

  try {
    const tickets = await api('GET', '/api/tickets/open');

    ticketSelect.innerHTML = '<option value="">-- Sélectionner un ticket ouvert --</option>';
    window.activeTicketsData = {};

    tickets.forEach((ticket) => {
      window.activeTicketsData[ticket.id] = ticket;
      const option = document.createElement('option');
      option.value = ticket.id;
      option.textContent = `#${ticket.id} — ${ticket.userTag || 'inconnu'} (${typeLabel(ticket.typeId)})`;
      ticketSelect.appendChild(option);
    });

    if ([...ticketSelect.options].some((o) => o.value === previousValue)) {
      ticketSelect.value = previousValue;
    }
  } catch (err) {
    console.error('Erreur de connexion au bot :', err);
    toast(err.message, true);
  }
}

async function renderMessages(ticketId) {
  const chatMessages = document.getElementById('chat-messages-container');
  if (!chatMessages) return;

  if (!ticketId) {
    chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Sélectionne un ticket pour voir le fil de discussion...</p>';
    return;
  }

  chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Chargement…</p>';

  let data;
  try {
    data = await api('GET', `/api/tickets/${encodeURIComponent(ticketId)}/messages`);
  } catch (err) {
    chatMessages.innerHTML = `<p style="color:#e04b4b; text-align:center; margin:auto;">${escapeHtml(err.message)}</p>`;
    return;
  }

  chatMessages.innerHTML = '';

  if (!data.messages.length) {
    chatMessages.innerHTML = '<p style="color:#777; text-align:center; margin:auto;">Aucun message pour l\'instant.</p>';
    return;
  }

  data.messages.forEach((msg) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.padding = '8px 12px';
    msgDiv.style.borderRadius = '6px';
    msgDiv.style.marginBottom = '6px';
    msgDiv.style.maxWidth = '80%';
    msgDiv.style.fontSize = '13px';

    if (msg.from === 'staff') {
      msgDiv.style.background = 'rgba(88, 101, 242, 0.2)';
      msgDiv.style.borderLeft = '3px solid #5865f2';
      msgDiv.style.alignSelf = 'flex-end';
    } else if (msg.from === 'user') {
      msgDiv.style.background = 'rgba(87, 242, 135, 0.12)';
      msgDiv.style.borderLeft = '3px solid #57f287';
      msgDiv.style.alignSelf = 'flex-start';
    } else {
      msgDiv.style.background = 'rgba(255, 255, 255, 0.06)';
      msgDiv.style.borderLeft = '3px solid #666';
      msgDiv.style.alignSelf = 'center';
      msgDiv.style.fontStyle = 'italic';
      msgDiv.style.opacity = '0.8';
    }

    msgDiv.innerHTML = `<strong>${escapeHtml(msg.sender)}</strong> <span style="font-size:10px; color:#aaa; margin-left:6px;">${escapeHtml(msg.time)}</span><br>${escapeHtml(msg.text)}`;
    chatMessages.appendChild(msgDiv);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendMessage() {
  const ticketSelect = document.getElementById('select-active-ticket');
  const chatInput = document.getElementById('live-chat-input');

  const activeTicketId = ticketSelect?.value;
  const text = chatInput?.value.trim();

  if (!activeTicketId || !text) return;

  try {
    await api('POST', `/api/tickets/${encodeURIComponent(activeTicketId)}/reply`, { message: text });
    chatInput.value = '';
    await renderMessages(activeTicketId);
  } catch (err) {
    toast(err.message, true);
  }
}

// ── STUDIO, THÈMES & FOND D'ÉCRAN ─────────────────────────
function applyThemeConfig(config) {
  const previewBox = document.getElementById('wallpaper-preview');
  const wallpaperUrlInput = document.getElementById('input-wallpaper-url');
  const blurRange = document.getElementById('range-blur');
  const blurVal = document.getElementById('blur-val');
  const opacityRange = document.getElementById('range-opacity');
  const opacityVal = document.getElementById('opacity-val');

  if (config.wallpaper) {
    document.body.style.backgroundImage = `url('${config.wallpaper}')`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';

    if (previewBox) {
      previewBox.style.backgroundImage = `url('${config.wallpaper}')`;
      previewBox.textContent = '';
    }
    if (wallpaperUrlInput) wallpaperUrlInput.value = config.wallpaper;
  }

  if (config.blur !== undefined) {
    if (blurRange) blurRange.value = config.blur;
    if (blurVal) blurVal.textContent = config.blur;
    document.querySelectorAll('.panel, .sidebar').forEach((el) => {
      el.style.backdropFilter = `blur(${config.blur}px)`;
    });
  }

  if (config.opacity !== undefined) {
    if (opacityRange) opacityRange.value = config.opacity;
    if (opacityVal) opacityVal.textContent = config.opacity;
    const opacityHex = Math.round((config.opacity / 100) * 255).toString(16).padStart(2, '0');
    document.querySelectorAll('.panel').forEach((el) => {
      el.style.backgroundColor = `#18191c${opacityHex}`;
    });
  }
}

// ── INITIALISATION COMPLÈTE AU DOM ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();

  // Live Console Events
  const ticketSelect = document.getElementById('select-active-ticket');
  const chatInput = document.getElementById('live-chat-input');
  const sendBtn = document.getElementById('send-chat-btn');
  const refreshChatBtn = document.getElementById('refresh-chat-btn');

  ticketSelect?.addEventListener('change', (e) => renderMessages(e.target.value));
  sendBtn?.addEventListener('click', sendMessage);
  chatInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  refreshChatBtn?.addEventListener('click', () => {
    loadTickets();
    if (ticketSelect?.value) renderMessages(ticketSelect.value);
  });

  // Theme Controls
  const blurRange = document.getElementById('range-blur');
  const opacityRange = document.getElementById('range-opacity');
  const wallpaperUrlInput = document.getElementById('input-wallpaper-url');
  const wallpaperFileInput = document.getElementById('input-wallpaper-file');
  const previewBox = document.getElementById('wallpaper-preview');

  blurRange?.addEventListener('input', (e) => {
    const val = e.target.value;
    const blurVal = document.getElementById('blur-val');
    if (blurVal) blurVal.textContent = val;
    document.querySelectorAll('.panel, .sidebar').forEach((el) => {
      el.style.backdropFilter = `blur(${val}px)`;
    });
  });

  opacityRange?.addEventListener('input', (e) => {
    const val = e.target.value;
    const opacityVal = document.getElementById('opacity-val');
    if (opacityVal) opacityVal.textContent = val;
    const opacityHex = Math.round((val / 100) * 255).toString(16).padStart(2, '0');
    document.querySelectorAll('.panel').forEach((el) => {
      el.style.backgroundColor = `#18191c${opacityHex}`;
    });
  });

  wallpaperUrlInput?.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    if (url && previewBox) {
      previewBox.style.backgroundImage = `url('${url}')`;
      previewBox.textContent = '';
    }
  });

  wallpaperFileInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target.result;
        if (previewBox) {
          previewBox.style.backgroundImage = `url('${result}')`;
          previewBox.textContent = '';
        }
        if (wallpaperUrlInput) wallpaperUrlInput.value = result;
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('save-theme-btn')?.addEventListener('click', () => {
    const config = {
      blur: blurRange?.value || 10,
      opacity: opacityRange?.value || 80,
      wallpaper: wallpaperUrlInput?.value || '',
    };
    localStorage.setItem('dashboard_theme_config', JSON.stringify(config));
    applyThemeConfig(config);
    toast('Thème enregistré avec succès !');
  });

  document.getElementById('reset-theme-btn')?.addEventListener('click', () => {
    localStorage.removeItem('dashboard_theme_config');
    location.reload();
  });

  // ── Paramètres du compte : photo de profil ─────────────────────
  // (auparavant : aucun listener nulle part, les boutons restaient
  // "disabled" pour toujours et la preview ne recevait jamais de src.)
  const avatarPreview = document.getElementById('settings-avatar-preview');
  const avatarInput = document.getElementById('settings-avatar-input');
  const avatarSaveBtn = document.getElementById('settings-avatar-save');
  const avatarCancelBtn = document.getElementById('settings-avatar-cancel');
  let avatarOriginalSrc = '';
  let avatarPendingDataUrl = '';

  avatarInput?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('Image trop lourde (2 Mo maximum).', true);
      avatarInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      avatarPendingDataUrl = event.target.result;
      if (avatarPreview) avatarPreview.src = avatarPendingDataUrl;
      if (avatarSaveBtn) avatarSaveBtn.disabled = false;
      if (avatarCancelBtn) avatarCancelBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  });

  avatarSaveBtn?.addEventListener('click', async () => {
    if (!avatarPendingDataUrl) return;
    avatarSaveBtn.disabled = true;
    try {
      await api('POST', '/api/profile/avatar', { avatar: avatarPendingDataUrl });
      toast('Photo de profil mise à jour.');
      avatarOriginalSrc = avatarPendingDataUrl;
      avatarPendingDataUrl = '';
      if (avatarInput) avatarInput.value = '';
      if (avatarCancelBtn) avatarCancelBtn.disabled = true;
      // La sidebar affiche aussi l'avatar : on la met à jour tout de suite
      // sans attendre un rechargement de page.
      const sidebarAvatar = document.getElementById('user-avatar');
      if (sidebarAvatar) sidebarAvatar.src = avatarOriginalSrc;
      if (state.me) state.me.avatar = avatarOriginalSrc;
    } catch (err) {
      toast(err.message, true);
      avatarSaveBtn.disabled = false;
    }
  });

  avatarCancelBtn?.addEventListener('click', () => {
    avatarPendingDataUrl = '';
    if (avatarInput) avatarInput.value = '';
    if (avatarPreview) avatarPreview.src = avatarOriginalSrc;
    if (avatarSaveBtn) avatarSaveBtn.disabled = true;
    avatarCancelBtn.disabled = true;
  });

  // ── Paramètres du compte : nom d'utilisateur ────────────────────
  const usernameInput = document.getElementById('settings-username');
  const usernameSaveBtn = document.getElementById('settings-username-save');
  const usernameHint = document.getElementById('settings-username-hint');
  let usernameOriginal = '';

  usernameInput?.addEventListener('input', () => {
    if (usernameSaveBtn) usernameSaveBtn.disabled = usernameInput.value.trim() === usernameOriginal || usernameInput.disabled;
  });

  usernameSaveBtn?.addEventListener('click', async () => {
    const value = usernameInput?.value.trim();
    if (!value) return;
    usernameSaveBtn.disabled = true;
    try {
      const data = await api('POST', '/api/profile/username', { username: value });
      toast("Nom d'utilisateur mis à jour.");
      usernameOriginal = data.username;
      if (usernameInput) usernameInput.value = data.username;
      const sidebarName = document.getElementById('user-name');
      if (sidebarName) sidebarName.textContent = data.username;
      if (state.me) state.me.username = data.username;
    } catch (err) {
      toast(err.message, true);
      usernameSaveBtn.disabled = false;
    }
  });

  // ── Paramètres du compte : e-mail ────────────────────────────────
  const emailInput = document.getElementById('settings-email');
  const emailSaveBtn = document.getElementById('settings-email-save');
  const emailHint = document.getElementById('settings-email-hint');
  let emailOriginal = '';

  emailInput?.addEventListener('input', () => {
    if (emailSaveBtn) emailSaveBtn.disabled = emailInput.value.trim() === emailOriginal || emailInput.disabled;
  });

  emailSaveBtn?.addEventListener('click', async () => {
    const value = emailInput?.value.trim();
    if (!value) return;
    emailSaveBtn.disabled = true;
    try {
      const data = await api('POST', '/api/profile/email', { email: value });
      toast('Adresse e-mail mise à jour.');
      emailOriginal = data.email;
      if (emailInput) emailInput.value = data.email;
      if (state.me) state.me.email = data.email;
    } catch (err) {
      toast(err.message, true);
      emailSaveBtn.disabled = false;
    }
  });

  // Pré-remplit avatar + pseudo dès que /api/me a répondu (loadMe() est
  // appelée au démarrage) ; si la personne arrive directement sur l'onglet
  // Paramètres avant que ça ait fini de charger, on réessaie une fois.
  function fillAccountSettings() {
    if (!state.me) return false;
    if (avatarPreview) avatarPreview.src = state.me.avatar;
    avatarOriginalSrc = state.me.avatar;
    if (usernameInput) {
      usernameInput.value = state.me.username;
      usernameOriginal = state.me.username;
      const isLocalAccount = String(state.me.id || '').startsWith('local:');
      usernameInput.disabled = !isLocalAccount;
      if (usernameHint) {
        usernameHint.textContent = isLocalAccount
          ? ''
          : "Compte connecté via Discord : le pseudo est synchronisé automatiquement depuis Discord et ne peut pas être changé ici.";
      }
    }
    if (emailInput) {
      emailInput.value = state.me.email || '';
      emailOriginal = state.me.email || '';
      const isLocalAccount = String(state.me.id || '').startsWith('local:');
      emailInput.disabled = !isLocalAccount;
      if (emailHint) {
        emailHint.textContent = isLocalAccount
          ? ''
          : "Compte connecté via Discord : pas d'e-mail associé sur ce dashboard.";
      }
    }
    return true;
  }
  if (!fillAccountSettings()) {
    const retry = setInterval(() => { if (fillAccountSettings()) clearInterval(retry); }, 300);
    setTimeout(() => clearInterval(retry), 5000);
  }

  // Restauration du thème sauvegardé
  const savedTheme = localStorage.getItem('dashboard_theme_config');
  if (savedTheme) {
    try {
      applyThemeConfig(JSON.parse(savedTheme));
    } catch {}
  }
});

// ── SERVEUR MINECRAFT ───────────────────────────────────────
let mcLogsPollTimer = null;
const MC_STATUS_LABELS = {
  stopped: 'Arrêté', starting: 'Démarrage…', running: 'En ligne',
  stopping: 'Arrêt en cours…', provisioning: 'Installation…', crashed: 'Erreur',
  updating: 'Mise à jour…',
};

let mcSelectedEdition = 'java';

async function loadMinecraft() {
  try {
    const data = await api('GET', '/api/minecraft');
    state.minecraft = data;
    renderMinecraftPanel();
    if (data.config.created) {
      // Pendant une mise à jour (téléchargement en arrière-plan), on
      // repolle comme pour une installation initiale — c'est ce qui fait
      // sortir automatiquement le badge de l'état 'updating' dès que c'est
      // terminé, sans recharger la page.
      if (data.runtime.status === 'updating') {
        startMcProvisionPolling();
      } else {
        stopMcProvisionPolling();
      }
      startMcLogsPolling();
      loadMcProperties();
      loadMcAdmins();
      loadMusicPlaylist();
    } else if (data.runtime.status === 'provisioning') {
      startMcProvisionPolling();
      startMcLogsPolling();
    } else {
      stopMcProvisionPolling();
      setMcEdition(data.config.edition || 'java');
      if (mcSelectedEdition === 'java') loadMcVersions();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// Pendant l'installation (téléchargement/extraction en arrière-plan côté
// serveur), on repolle /api/minecraft toutes les 2s jusqu'à ce que
// runtime.status sorte de 'provisioning' — c'est ce qui fait basculer
// automatiquement l'UI vers la carte de gestion dès que c'est prêt, sans
// que la personne ait besoin de recharger la page.
let mcProvisionPollTimer = null;
function startMcProvisionPolling() {
  if (mcProvisionPollTimer) return;
  mcProvisionPollTimer = setInterval(loadMinecraft, 2000);
}
function stopMcProvisionPolling() {
  if (mcProvisionPollTimer) clearInterval(mcProvisionPollTimer);
  mcProvisionPollTimer = null;
}

// ── Sélecteur Java / Bedrock du formulaire de création ─────────────
function setMcEdition(edition) {
  mcSelectedEdition = edition === 'bedrock' ? 'bedrock' : 'java';
  document.querySelectorAll('#mc-edition-toggle .mc-edition-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.edition === mcSelectedEdition);
  });

  const versionField = document.getElementById('mc-version-field');
  const sub = document.getElementById('mc-edition-sub');
  const portInput = document.getElementById('mc-port-input');
  if (portInput) { portInput.readOnly = true; portInput.style.opacity = '0.6'; portInput.style.cursor = 'not-allowed'; portInput.title = 'Port attribué automatiquement'; }
  const isBedrock = mcSelectedEdition === 'bedrock';

  if (versionField) versionField.style.display = isBedrock ? 'none' : '';
  if (sub) {
    sub.textContent = isBedrock
      ? "Le Bedrock Dedicated Server officiel (Mojang) est téléchargé automatiquement — toujours la dernière version, pas de choix à faire."
      : 'Le jar Paper officiel est téléchargé automatiquement pour la version choisie.';
  }
  // Change le port par défaut affiché uniquement s'il n'a pas déjà été
  // modifié à la main par l'utilisateur (on ne veut pas écraser sa saisie).
  if (portInput && (portInput.value === '25565' || portInput.value === '19132')) {
    portInput.value = isBedrock ? '19132' : '25565';
  }
}

document.getElementById('mc-edition-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mc-edition-option');
  if (!btn) return;
  const wasJava = mcSelectedEdition === 'java';
  setMcEdition(btn.dataset.edition);
  if (mcSelectedEdition === 'java' && !wasJava) loadMcVersions();
});

function renderMcConnectionBox() {
  const box = document.getElementById('mc-connection-box');
  if (!box) return;
  const { connection } = state.minecraft;
  if (!connection) { box.style.display = 'none'; return; }
  box.style.display = '';
  const publicEl = document.getElementById('mc-ip-public');
  const localEl = document.getElementById('mc-ip-local');
  if (publicEl) publicEl.textContent = connection.publicIp ? `${connection.publicIp}:${connection.port}` : `${connection.localIp}:${connection.port}`;
  if (localEl) {
    if (connection.localIp && connection.publicIp !== connection.localIp) {
      localEl.textContent = 'Réseau local (LAN) : ' + connection.localIp + ':' + connection.port;
    } else if (!connection.publicIp) {
      localEl.textContent = 'Ouvre/redirige ce port sur ton pare-feu ou ta box pour que tes joueurs puissent se connecter depuis internet.';
    } else {
      localEl.textContent = '';
    }
  }
}

document.getElementById('mc-ip-copy-btn')?.addEventListener('click', () => {
  const text = document.getElementById('mc-ip-public')?.textContent;
  if (!text || text === '—') return;
  navigator.clipboard?.writeText(text).then(() => toast('Adresse copiée.')).catch(() => {});
});

function renderMinecraftPanel() {
  const { config, runtime } = state.minecraft;
  const createBox = document.getElementById('mc-create-box');
  const manageBox = document.getElementById('mc-manage-box');
  const provisioningBox = document.getElementById('mc-provisioning-box');
  if (!createBox || !manageBox) return;

  const isCreated = !!config.created;
  const isProvisioning = !isCreated && runtime.status === 'provisioning';
  createBox.style.display = (isCreated || isProvisioning) ? 'none' : '';
  if (provisioningBox) provisioningBox.style.display = isProvisioning ? '' : 'none';
  manageBox.style.display = isCreated ? '' : 'none';
  const activityBox = document.getElementById('mc-activity-box');
  if (activityBox) activityBox.style.display = isCreated ? '' : 'none';

  if (!isCreated && !isProvisioning && runtime.lastError) {
    toast(`Dernière installation échouée : ${runtime.lastError}`, true);
  }
  if (isCreated && runtime.status === 'crashed' && runtime.lastError && runtime.lastError !== state.mcLastReportedUpdateError) {
    state.mcLastReportedUpdateError = runtime.lastError;
    toast(`Mise à jour échouée : ${runtime.lastError}`, true);
  }

  // Copie autonome de la console (vue "Console Minecraft") : même logique
  // d'affichage, indépendante de l'onglet Configuration.
  const consoleBox = document.getElementById('mc-console-standalone-box');
  const consoleEmpty = document.getElementById('mc-console-standalone-empty');
  if (consoleBox) {
    document.getElementById('mc-console-2').style.display = isCreated ? '' : 'none';
    document.getElementById('mc-command-form-2').style.display = isCreated ? '' : 'none';
    if (consoleEmpty) consoleEmpty.style.display = isCreated ? 'none' : '';
  }
  if (!isCreated) return;

  const badge = document.getElementById('mc-status-badge');
  const badge2 = document.getElementById('mc-status-badge-2');
  [badge, badge2].forEach((el) => {
    if (!el) return;
    el.className = `mc-status-badge ${runtime.status}`;
    el.textContent = MC_STATUS_LABELS[runtime.status] || runtime.status;
  });
  const isBedrock = config.edition === 'bedrock';
  const nameLabel = isBedrock
    ? `${config.name} — port ${config.port}`
    : `${config.name} — ${config.mcVersion} (${config.loader ? config.loader.charAt(0).toUpperCase()+config.loader.slice(1) : 'Paper'}) — port ${config.port}`;
  const nameEl = document.getElementById('mc-server-name');
  const nameEl2 = document.getElementById('mc-server-name-2');
  if (nameEl) nameEl.textContent = nameLabel;
  if (nameEl2) nameEl2.textContent = nameLabel;
  const editionBadge = document.getElementById('mc-edition-badge');
  const editionBadge2 = document.getElementById('mc-edition-badge-2');
  [editionBadge, editionBadge2].forEach((el) => {
    if (!el) return;
    el.className = `mc-edition-badge ${isBedrock ? 'bedrock' : 'java'}`;
    el.textContent = isBedrock ? 'Bedrock' : 'Java';
  });

  renderMcConnectionBox();

  const startBtn = document.getElementById('mc-start-btn');
  const stopBtn = document.getElementById('mc-stop-btn');
  const restartBtn = document.getElementById('mc-restart-btn');
  const updateBtn = document.getElementById('mc-update-btn');
  const running = runtime.status === 'running' || runtime.status === 'starting';
  const updating = runtime.status === 'updating';
  if (startBtn) startBtn.disabled = running || runtime.status === 'stopping' || updating;
  if (stopBtn) stopBtn.disabled = !running;
  if (restartBtn) restartBtn.disabled = !running || updating;
  // Le serveur doit être arrêté pour être mis à jour (le binaire/jar est
  // remplacé sur disque) — même logique que provision().
  if (updateBtn) {
    updateBtn.disabled = running || runtime.status === 'stopping' || updating;
    updateBtn.textContent = updating ? 'Mise à jour…' : 'Mise à jour';
  }
  const autoUpdateToggle = document.getElementById('mc-auto-update-toggle');
  if (autoUpdateToggle) autoUpdateToggle.checked = !!config.autoUpdate;

  loadMcActivity();
}

// ── Journal d'activités du Tableau de bord Minecraft : réutilise
// l'endpoint d'audit-log général, filtré sur les actions "minecraft.*". ──
function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `Il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Il y a ${h}h`;
  const d = Math.round(h / 24);
  return `Il y a ${d} jour${d > 1 ? 's' : ''}`;
}

const MC_ACTIVITY_ICONS = {
  'minecraft.create': { icon: 'ok', svg: '<path d="M20 6L9 17l-5-5"/>' },
  'minecraft.start.launched': { icon: 'pending', svg: '<polygon points="5 3 19 12 5 21 5 3"/>' },
  'minecraft.start.success': { icon: 'ok', svg: '<path d="M20 6L9 17l-5-5"/>' },
  'minecraft.start.failed': { icon: 'fail', svg: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
  'minecraft.stop': { icon: 'fail', svg: '<rect x="6" y="6" width="12" height="12" rx="1"/>' },
  'minecraft.restart.launched': { icon: 'pending', svg: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' },
  'minecraft.restart.success': { icon: 'ok', svg: '<path d="M20 6L9 17l-5-5"/>' },
  'minecraft.restart.failed': { icon: 'fail', svg: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
  'minecraft.update.launched': { icon: 'pending', svg: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' },
  'minecraft.update.success': { icon: 'ok', svg: '<path d="M20 6L9 17l-5-5"/>' },
  'minecraft.update.failed': { icon: 'fail', svg: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
  'minecraft.autoupdate.success': { icon: 'ok', svg: '<path d="M20 6L9 17l-5-5"/>' },
  'minecraft.autoupdate.failed': { icon: 'fail', svg: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
  'minecraft.delete': { icon: 'fail', svg: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' },
};

async function loadMcActivity() {
  const list = document.getElementById('mc-activity-list');
  if (!list) return;
  let entries;
  try {
    const data = await api('GET', '/api/audit-log?limit=100');
    entries = (data.entries || data || []).filter((e) => String(e.action || '').startsWith('minecraft.'));
  } catch {
    return; // silencieux : ce journal n'est qu'un bonus d'info sur cette page
  }

  if (!entries.length) {
    list.innerHTML = '<div class="activity-row"><div class="activity-body">Aucune activité pour le moment.</div></div>';
    return;
  }

  list.innerHTML = entries.slice(0, 8).map((e) => {
    const meta = MC_ACTIVITY_ICONS[e.action] || { icon: 'pending', svg: '<circle cx="12" cy="12" r="4"/>' };
    const label = auditActionLabel(e.action);
    const detail = e.action.endsWith('.failed') && e.details?.error
      ? e.details.error
      : (e.target || '');
    return `
      <div class="activity-row">
        <span class="activity-icon ${meta.icon}">
          <svg class="icon-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${meta.svg}</svg>
        </span>
        <div class="activity-body">
          <b>${escapeHtml(label)}</b> · ${formatRelativeTime(e.createdAt)}
          <div class="field-hint" style="margin-top:2px;">${escapeHtml(detail)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Logs du serveur (journal des actions joueurs) : recherche + filtre
// par type d'événement, pagination par "Charger plus". ──────────────
const PL_TYPE_META = {
  join: { cls: 'join', label: 'Connexion', svg: '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' },
  leave: { cls: 'leave', label: 'Déconnexion', svg: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>' },
  chat: { cls: 'chat', label: 'Chat', svg: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' },
  death: { cls: 'death', label: 'Mort', svg: '<path d="M12 2a5 5 0 0 0-5 5c0 2 1 3.5 2 4.5L6 15v5h2v-3h2v3h4v-3h2v3h2v-5l-3-3.5c1-1 2-2.5 2-4.5a5 5 0 0 0-5-5z"/><circle cx="10" cy="7" r="1"/><circle cx="14" cy="7" r="1"/>' },
  command: { cls: 'command', label: 'Commande', svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
};
const PL_PAGE_SIZE = 40;
let plOffset = 0;
let plSearchDebounce = null;

function plDetailLine(entry) {
  switch (entry.eventType) {
    case 'chat': return `« ${entry.detail || ''} »`;
    case 'command': return entry.detail || '';
    case 'death': return entry.detail || '';
    default: return '';
  }
}

async function loadPlayerLogs(reset = true) {
  const list = document.getElementById('pl-list');
  const empty = document.getElementById('pl-empty');
  const countHint = document.getElementById('pl-count-hint');
  const loadMoreBtn = document.getElementById('pl-load-more-btn');
  if (!list) return;

  if (reset) plOffset = 0;
  const query = document.getElementById('pl-search-input')?.value.trim() || '';
  const type = document.getElementById('pl-type-filter')?.value || '';

  let data;
  try {
    const params = new URLSearchParams({ limit: PL_PAGE_SIZE, offset: plOffset });
    if (query) params.set('q', query);
    if (type) params.set('type', type);
    data = await api('GET', `/api/minecraft/player-logs?${params.toString()}`);
  } catch (err) {
    return toast(err.message, true);
  }

  const rows = data.entries.map((entry) => {
    const meta = PL_TYPE_META[entry.eventType] || PL_TYPE_META.join;
    const detail = plDetailLine(entry);
    return `
      <div class="audit-row">
        <span class="pl-icon ${meta.cls}">
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${meta.svg}</svg>
        </span>
        <div class="audit-row-body">
          <span class="pl-player">${escapeHtml(entry.playerName)}</span> — ${meta.label}
          <div class="audit-row-meta">${formatDate(entry.createdAt)}</div>
          ${detail ? `<div class="pl-detail">${escapeHtml(detail)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (reset) {
    list.innerHTML = rows;
  } else {
    list.insertAdjacentHTML('beforeend', rows);
  }

  const shown = plOffset + data.entries.length;
  if (empty) empty.style.display = shown === 0 ? '' : 'none';
  if (countHint) {
    countHint.textContent = data.total
      ? `${shown} / ${data.total} action${data.total > 1 ? 's' : ''}`
      : '';
  }
  if (loadMoreBtn) loadMoreBtn.style.display = shown < data.total ? '' : 'none';
  plOffset = shown;
}

document.getElementById('pl-search-input')?.addEventListener('input', () => {
  clearTimeout(plSearchDebounce);
  plSearchDebounce = setTimeout(() => loadPlayerLogs(true), 350);
});
document.getElementById('pl-type-filter')?.addEventListener('change', () => loadPlayerLogs(true));
document.getElementById('pl-load-more-btn')?.addEventListener('click', () => loadPlayerLogs(false));

// ── Actions rapides (Tableau de bord Minecraft) : navigation vers un
// autre onglet, ou scroll fluide vers une section de la page courante. ──
document.querySelectorAll('.mc-quick-action[data-goto-view]').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelector(`.nav-item[data-view="${el.dataset.gotoView}"]`)?.click();
  });
});
document.querySelectorAll('.mc-quick-action[data-scroll-to]').forEach((el) => {
  el.addEventListener('click', () => {
    const target = document.getElementById(el.dataset.scrollTo);
    if (!target) return;
    // Configuration/Admins sont maintenant des accordéons repliés par
    // défaut (<details>) : on les ouvre avant de scroller, sinon on
    // atterrit sur un titre fermé sans voir le contenu visé.
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// ── Onglet "Configuration" : formulaire généré depuis le schéma renvoyé
// par l'API (une clé server.properties par champ), propre à l'édition
// (java/bedrock) du serveur du tenant. ──────────────────────────────
async function loadMcProperties() {
  const box = document.getElementById('mc-properties-box');
  if (!box) return;
  try {
    const data = await api('GET', '/api/minecraft/properties');
    renderMcPropertiesForm(data.schema, data.properties);
    box.style.display = 'none';
  } catch (err) {
    box.style.display = 'none';
  }
}

function renderMcPropertiesForm(schema, properties) {
  const container = document.getElementById('mc-properties-fields');
  if (!container) return;
  container.innerHTML = '';
  (schema || []).forEach((field) => {
    const value = properties?.[field.key] ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.propKey = field.key;
    const inputId = `mc-prop-${field.key}`;

    if (field.type === 'bool') {
      wrap.classList.add('mc-prop-bool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = inputId;
      input.checked = value === 'true';
      const label = document.createElement('label');
      label.htmlFor = inputId;
      label.style.margin = '0';
      label.textContent = field.label;
      wrap.append(input, label);
    } else {
      const label = document.createElement('label');
      label.htmlFor = inputId;
      label.textContent = field.label;
      wrap.appendChild(label);
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        (field.options || []).forEach((o) => {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          opt.selected = o === value;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : 'text';
        input.value = value;
      }
      input.id = inputId;
      wrap.appendChild(input);
    }
    container.appendChild(wrap);
  });
}

document.getElementById('mc-properties-save-btn')?.addEventListener('click', async () => {
  const container = document.getElementById('mc-properties-fields');
  const statusEl = document.getElementById('mc-properties-status');
  const btn = document.getElementById('mc-properties-save-btn');
  if (!container || !btn) return;
  const properties = {};
  container.querySelectorAll('[data-prop-key]').forEach((wrap) => {
    const key = wrap.dataset.propKey;
    const input = wrap.querySelector('input, select');
    if (!input) return;
    properties[key] = input.type === 'checkbox' ? (input.checked ? 'true' : 'false') : input.value;
  });
  btn.disabled = true;
  try {
    await api('POST', '/api/minecraft/properties', { properties });
    if (statusEl) {
      statusEl.textContent = 'Enregistré ✓ — redémarre le serveur pour appliquer les changements.';
      statusEl.style.color = 'var(--green)';
    }
    toast('Configuration enregistrée.');
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--coral)';
    }
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Panneau "Administrateurs" : liste de pseudos qui passent en Creative
// automatiquement à leur connexion (le reste des joueurs reste en Survie —
// voir MinecraftController._checkPlayerJoin côté serveur). ──────────────
let mcAdmins = [];

async function loadMcAdmins() {
  const box = document.getElementById('mc-admins-box');
  if (!box) return;
  try {
    const data = await api('GET', '/api/minecraft/admins');
    mcAdmins = data.admins || [];
    renderMcAdminList();
    box.style.display = '';
  } catch (err) {
    box.style.display = 'none';
  }
}

function renderMcAdminList() {
  const list = document.getElementById('mc-admin-list');
  if (!list) return;
  list.innerHTML = '';
  if (!mcAdmins.length) {
    const empty = document.createElement('div');
    empty.className = 'mc-admin-empty';
    empty.textContent = 'Aucun admin — tous les joueurs sont en Survie.';
    list.appendChild(empty);
    return;
  }
  mcAdmins.forEach((name) => {
    const chip = document.createElement('div');
    chip.className = 'mc-admin-chip';
    const label = document.createElement('span');
    label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'mc-admin-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Retirer';
    removeBtn.addEventListener('click', () => saveMcAdmins(mcAdmins.filter((a) => a !== name)));
    chip.append(label, removeBtn);
    list.appendChild(chip);
  });
}

async function saveMcAdmins(nextAdmins) {
  try {
    const data = await api('POST', '/api/minecraft/admins', { admins: nextAdmins });
    mcAdmins = data.admins || [];
    renderMcAdminList();
    toast('Liste des admins mise à jour.');
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('mc-admin-add-btn')?.addEventListener('click', () => {
  const input = document.getElementById('mc-admin-input');
  const name = input?.value.trim();
  if (!name) return;
  if (mcAdmins.some((a) => a.toLowerCase() === name.toLowerCase())) {
    toast('Ce pseudo est déjà admin.', true);
    return;
  }
  saveMcAdmins([...mcAdmins, name]);
  input.value = '';
});

document.getElementById('mc-admin-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('mc-admin-add-btn')?.click();
  }
});

// ── Console du serveur : conso CPU/RAM réelle (hôte + process suivi) ──
// Graphiques dessinés à la main sur <canvas> (pas de dépendance externe) :
// deux historiques glissants (CPU%, RAM Mo) redessinés à chaque sondage.
const scHistory = { cpu: [], mem: [] };
const SC_HISTORY_MAX = 60; // 60 points * 2s = 2 min d'historique affiché
let scPollTimer = null;

function loadServerConsole() {
  pollServerStats();
  if (scPollTimer) clearInterval(scPollTimer);
  scPollTimer = setInterval(pollServerStats, 2000);
}

async function pollServerStats() {
  try {
    const data = await api('GET', '/api/server/stats');
    renderServerStats(data);
  } catch {
    // Silencieux : on retentera au prochain tick.
  }
}

function renderServerStats(data) {
  const { host, process: proc } = data;

  const labelEl = document.getElementById('sc-proc-label');
  const statusEl = document.getElementById('sc-proc-status');
  const cpuEl = document.getElementById('sc-proc-cpu');
  const memEl = document.getElementById('sc-proc-mem');
  const hostMemEl = document.getElementById('sc-host-mem');
  const hostDetailsEl = document.getElementById('sc-host-details');

  if (labelEl) labelEl.textContent = proc?.label || '—';
  if (statusEl) {
    statusEl.textContent = proc?.running ? 'En ligne' : 'Hors ligne';
    statusEl.className = `mc-status-badge ${proc?.running ? 'running' : 'stopped'}`;
  }
  // statsUnavailable : le process tourne (running: true) mais la lecture
  // CPU/RAM a échoué côté serveur (ex: /proc absent sous Windows). On
  // l'affiche explicitement au lieu d'un "0%" trompeur ou d'un tiret qui
  // laisserait penser que le process est arrêté.
  if (cpuEl) cpuEl.textContent = proc?.statsUnavailable ? 'indisponible' : (proc ? `${proc.cpuPercent ?? 0}%` : '—');
  if (memEl) memEl.textContent = proc?.statsUnavailable ? 'indisponible' : (proc ? `${proc.memMb ?? 0} Mo` : '—');
  if (hostMemEl) {
    const MC_PLAN_RAM = { minecraft_std: 7168, minecraft_pro: 15360, minecraft_custom: null, bot_standard: 512, bot_avance: 2048, bot_premium: 4096, bot_ultra: 24576, default: 512 };
    const planRam = MC_PLAN_RAM[window.__currentPlanType] || MC_PLAN_RAM.default;
    hostMemEl.textContent = `${host.usedMb} / ${planRam} Mo`;
  }
  const loadBar = document.getElementById('sc-load-bar');
  const loadValue = document.getElementById('sc-load-value');
  if (loadBar) loadBar.style.width = `${Math.max(0, Math.min(100, host.loadPercent))}%`;
  if (loadValue) loadValue.textContent = `${host.loadPercent}%`;
  if (hostDetailsEl) {
    const hours = Math.floor(host.uptimeSec / 3600);
    hostDetailsEl.innerHTML = `
      <div>🧮 Cœurs CPU : <b>${host.cpuCount}</b></div>
      <div>📈 Load average (1 min) : <b>${host.loadAvg[0].toFixed(2)}</b></div>
      <div>⏱️ Uptime de l'hôte : <b>${hours}h</b></div>
    `;
  }

  // On alimente les graphiques dès qu'on a un `proc` avec une mesure fiable :
  // - proc null (aucun process suivi du tout) → rien à tracer.
  // - statsUnavailable (mesure impossible, ex: /proc absent) → on ne pousse
  //   rien plutôt que de mentir avec un faux 0.
  // - proc.running === false (serveur arrêté) → on pousse quand même 0 :
  //   le graphique doit rester "fonctionnel" et continuer à tracer une
  //   ligne (plate à 0) plutôt que de rester bloqué indéfiniment sur
  //   "En attente de données" simplement parce que le serveur est éteint.
  if (proc && !proc.statsUnavailable) {
    scHistory.cpu.push(proc.cpuPercent ?? 0);
    scHistory.mem.push(proc.memMb ?? 0);
    if (scHistory.cpu.length > SC_HISTORY_MAX) scHistory.cpu.shift();
    if (scHistory.mem.length > SC_HISTORY_MAX) scHistory.mem.shift();
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  drawLineChart(document.getElementById('sc-chart-cpu'), scHistory.cpu, {
    color: cssVar('--cyan'), suffix: '%', min: 0, max: 100,
  });
  drawLineChart(document.getElementById('sc-chart-mem'), scHistory.mem, {
    color: cssVar('--amber'), suffix: ' Mo', min: 0,
  });
}

// Petit line-chart "maison" : pas de lib externe, juste un canvas redessiné
// à chaque sondage. `opts.max` fixe le plafond de l'axe Y (sinon calculé
// depuis les données, avec un peu de marge au-dessus du pic). La courbe est
// lissée (segments arrondis via quadraticCurveTo, technique du "midpoint")
// et remplie d'un dégradé doux, dans le même esprit que le graphique
// "Historique des joueurs" d'un panel de stats classique.
function drawLineChart(canvas, points, opts = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 100);
  const h = Math.max(rect.height, 100);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padding = { top: 16, right: 12, bottom: 22, left: 42 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  if (!points.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('En attente de données…', padding.left, h / 2);
    return;
  }

  const dataMax = Math.max(...points, 1);
  const max = opts.max ?? Math.ceil(dataMax * 1.25);
  const min = opts.min ?? 0;
  const color = opts.color || '#0f9c8f';

  const xAt = (i) => padding.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => padding.top + plotH - ((v - min) / Math.max(1, max - min)) * plotH;
  const xs = points.map((_, i) => xAt(i));
  const ys = points.map((v) => yAt(v));

  // Grille horizontale + labels (0%, 50%, 100% de l'échelle)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '11px Inter, sans-serif';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach((ratio) => {
    const y = padding.top + plotH * (1 - ratio);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
    const value = Math.round(min + (max - min) * ratio);
    ctx.fillText(`${value}${opts.suffix || ''}`, 2, y + 4);
  });

  // Trace un chemin lissé passant par tous les points : chaque segment est
  // une courbe quadratique dont le point de contrôle est le point de
  // données lui-même et le point d'arrivée le milieu du segment suivant —
  // ça arrondit les angles sans faire "déborder" la courbe au-delà des
  // valeurs réelles (contrairement à un vrai Catmull-Rom).
  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 0; i < xs.length - 1; i++) {
      const midX = (xs[i] + xs[i + 1]) / 2;
      const midY = (ys[i] + ys[i + 1]) / 2;
      ctx.quadraticCurveTo(xs[i], ys[i], midX, midY);
    }
    ctx.lineTo(xs[xs.length - 1], ys[xs.length - 1]);
  };

  // Zone remplie sous la courbe, en dégradé (opaque en haut, transparent
  // en bas) pour un rendu plus doux qu'un simple aplat de couleur.
  tracePath();
  ctx.lineTo(xs[xs.length - 1], padding.top + plotH);
  ctx.lineTo(xs[0], padding.top + plotH);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  gradient.addColorStop(0, color.startsWith('#') ? `${color}40` : color); // ~25%
  gradient.addColorStop(1, color.startsWith('#') ? `${color}00` : color); // 0%
  ctx.fillStyle = gradient;
  ctx.fill();

  // Ligne de la courbe (lissée)
  tracePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Point + valeur courante en fin de courbe
  const lastX = xs[xs.length - 1];
  const lastY = ys[ys.length - 1];
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '12px Inter, sans-serif';
  const label = `${Math.round(points[points.length - 1] * 10) / 10}${opts.suffix || ''}`;
  ctx.fillText(label, Math.min(lastX + 6, w - ctx.measureText(label).width - 4), Math.max(lastY - 6, 14));
}

async function loadMcVersions() {
  const select = document.getElementById('mc-version-select');
  const loader = document.getElementById('mc-loader-select')?.value || 'paper';
  if (!select) return;
  select.innerHTML = '<option>Chargement des versions…</option>';
  try {
    let versions = [];
    if (loader === 'paper') {
      versions = await api('GET', '/api/minecraft/versions');
    } else if (loader === 'forge') {
      versions = await api('GET', '/api/minecraft/versions/forge');
    } else if (loader === 'fabric') {
      versions = await api('GET', '/api/minecraft/versions/fabric');
    } else if (loader === 'vanilla') {
      versions = await api('GET', '/api/minecraft/versions/vanilla');
    }
    select.innerHTML = '';
    versions.slice(0, 60).forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
  } catch (err) {
    select.innerHTML = '<option value="">Impossible de charger les versions</option>';
  }
}

// Recharger les versions quand on change de loader
document.getElementById('mc-loader-select')?.addEventListener('change', loadMcVersions);

// Mapping offre → ressources Minecraft
const MC_PLAN_RESOURCES = {
  minecraft_std:    { memoryMb: 2048,  maxPlayers: 10,   label: 'Standard'     },
  minecraft_pro:    { memoryMb: 4096,  maxPlayers: 25,   label: 'Pro'          },
  minecraft_custom: { memoryMb: null,  maxPlayers: null, label: 'Personnalise' },
  bot_standard:     { memoryMb: 512,   maxPlayers: null, label: 'Standard'     },
  bot_avance:       { memoryMb: 2048,  maxPlayers: null, label: 'Avance'       },
  bot_premium:      { memoryMb: 4096,  maxPlayers: null, label: 'Premium'      },
  bot_ultra:        { memoryMb: 24576, maxPlayers: null, label: 'Ultra'        },
  default:          { memoryMb: 512,   maxPlayers: null, label: 'Basique'      },
};

function getMcPlanResources() {
  // Récupère le planType depuis la section abonnement si dispo, sinon fallback
  const planType = window.__currentPlanType || null;
  return MC_PLAN_RESOURCES[planType] || MC_PLAN_RESOURCES.default;
}

// Affiche les ressources dès que la section Minecraft est chargée
function updateMcPlanDisplay() {
  const res = getMcPlanResources();
  const ramEl     = document.getElementById('mc-plan-ram');
  const playersEl = document.getElementById('mc-plan-players');
  const nameEl    = document.getElementById('mc-plan-name');
  if (ramEl)     ramEl.textContent     = res.memoryMb ? (res.memoryMb >= 1024 ? (res.memoryMb / 1024) + ' Go' : res.memoryMb + ' Mo') : 'Sur mesure';
  if (playersEl) playersEl.textContent = res.maxPlayers ? res.maxPlayers + ' joueurs' : 'Illimite';
  if (nameEl)    nameEl.textContent    = res.label;
}

// Afficher/cacher config selon l'édition choisie
document.querySelectorAll('.mc-edition-option').forEach(b => {
  b.addEventListener('click', () => {
    const ed = b.dataset.edition;
    const bedrockCfg = document.getElementById('mc-bedrock-config');
    const javaCfg = document.getElementById('mc-java-config');
    if (bedrockCfg) bedrockCfg.style.display = ed === 'bedrock' ? '' : 'none';
    if (javaCfg) javaCfg.style.display = ed === 'java' ? '' : 'none';
  });
});

document.getElementById('mc-create-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('mc-name-input')?.value.trim() || 'Mon serveur';
  const edition = mcSelectedEdition === 'bedrock' ? 'bedrock' : 'java';
  const mcVersion = document.getElementById('mc-version-select')?.value;
  const planRes = getMcPlanResources();
  const memoryMb = planRes.memoryMb;
  const port = parseInt(document.getElementById('mc-port-input')?.value, 10) || (edition === 'bedrock' ? 19132 : 25565);
  if (edition === 'java' && !mcVersion) return toast('Choisis une version Minecraft.', true);

  const bedrockConfig = edition === 'bedrock' ? {
    difficulty: document.getElementById('mc-difficulty')?.value || 'normal',
    gamemode: document.getElementById('mc-gamemode')?.value || 'survival',
    onlineMode: document.getElementById('mc-online-mode')?.value || 'true',
    allowCheats: document.getElementById('mc-allow-cheats')?.value || 'false',
    adminXuid: document.getElementById('mc-admin-xuid')?.value.trim() || '',
  } : null;

  const javaConfig = edition === 'java' ? {
    difficulty: document.getElementById('mc-java-difficulty')?.value || 'normal',
    gamemode: document.getElementById('mc-java-gamemode')?.value || 'survival',
    onlineMode: document.getElementById('mc-java-online-mode')?.value || 'true',
    adminUsername: document.getElementById('mc-java-admin')?.value.trim() || '',
  } : null;

  const btn = document.getElementById('mc-create-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Lancement…'; }
  try {
    const loader = edition === 'java' ? (document.getElementById('mc-loader-select')?.value || 'paper') : null;
    await api('POST', '/api/minecraft/create', { name, edition, mcVersion, memoryMb, port, bedrockConfig, javaConfig, loader });
    toast('Installation lancée — suivi en direct ci-dessous.');
    await loadMinecraft();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Installer le serveur'; }
  }
});

document.getElementById('mc-start-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/start');
    toast('Démarrage du serveur…');
    startMcLogsPolling();
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-stop-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/stop');
    toast('Arrêt du serveur…');
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-restart-btn')?.addEventListener('click', async () => {
  try {
    await api('POST', '/api/minecraft/restart');
    toast('Redémarrage du serveur…');
    setTimeout(loadMinecraft, 1500);
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-update-btn')?.addEventListener('click', async () => {
  const isBedrock = state.minecraft?.config?.edition === 'bedrock';
  const msg = isBedrock
    ? 'Télécharger la dernière version du Bedrock Dedicated Server ? Le monde, la configuration et les listes de joueurs sont conservés.'
    : 'Télécharger la dernière version Minecraft (Paper) disponible ? Le monde, la configuration et les listes de joueurs sont conservés.';
  if (!confirm(msg)) return;
  try {
    await api('POST', '/api/minecraft/update');
    toast('Mise à jour lancée — suivi en direct dans la console.');
    startMcLogsPolling();
    await loadMinecraft();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('mc-auto-update-toggle')?.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    await api('POST', '/api/minecraft/auto-update', { enabled });
    if (state.minecraft?.config) state.minecraft.config.autoUpdate = enabled;
    toast(enabled ? 'Mise à jour automatique activée.' : 'Mise à jour automatique désactivée.');
  } catch (err) {
    e.target.checked = !enabled;
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('mc-delete-btn')?.addEventListener('click', async () => {
  if (!confirm('Supprimer définitivement ce serveur (monde, plugins, config) ?')) return;
  try {
    await api('DELETE', '/api/minecraft');
    toast('Serveur supprimé.');
    stopMcLogsPolling();
    await loadMinecraft();
  } catch (err) { toast(err.message, true); }
});

document.querySelectorAll('.mc-command-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('.mc-command-input');
    const command = input?.value.trim();
    if (!command) return;

    // Petite commande utilitaire côté dashboard (pas envoyée au process
    // Minecraft) : affiche direct l'adresse de connexion dans la console
    // (celle du formulaire qui a servi à l'envoyer — config ou standalone).
    if (/^\/?ip$/i.test(command)) {
      const box = form.closest('.panel')?.querySelector('.mc-console');
      const { connection } = state.minecraft;
      const line = connection
        ? `[Dashboard] Adresse de connexion : ${connection.publicIp || connection.localIp}:${connection.port}`
        : '[Dashboard] Adresse indisponible pour le moment.';
      if (box) { box.textContent += `\n${line}`; box.scrollTop = box.scrollHeight; }
      input.value = '';
      return;
    }

    try {
      await api('POST', '/api/minecraft/command', { command });
      input.value = '';
    } catch (err) { toast(err.message, true); }
  });
});

function startMcLogsPolling() {
  stopMcLogsPolling();
  pollMcLogs();
  mcLogsPollTimer = setInterval(pollMcLogs, 2000);
}
function stopMcLogsPolling() {
  if (mcLogsPollTimer) clearInterval(mcLogsPollTimer);
  mcLogsPollTimer = null;
}
async function pollMcLogs() {
  // .mc-console existe désormais en double (onglet Configuration + onglet
  // Console dédié) : on met à jour toutes les instances trouvées dans le DOM.
  const boxes = document.querySelectorAll('.mc-console');
  if (!boxes.length) return;
  try {
    const { logs } = await api('GET', '/api/minecraft/logs');
    const text = logs.join('\n');
    boxes.forEach((box) => {
      const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      box.textContent = text;
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
    });
  } catch {}
}

// ── GESTIONNAIRE DE FICHIERS (Discord & Minecraft) ──────────
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// Formatage type "Explorateur Windows" (colonnes Nom / Modifié le / Type /
// Taille) — cf. capture d'écran de référence.
function fmFormatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const date = d.toLocaleDateString('fr-FR');
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

const FM_TYPE_LABELS = {
  js: 'Fichier source JavaScript',
  mjs: 'Fichier source JavaScript',
  cjs: 'Fichier source JavaScript',
  json: 'Fichier source JSON',
  md: 'Fichier source Markdown',
  env: 'Fichier ENV',
  yml: 'Fichier YAML',
  yaml: 'Fichier YAML',
  txt: 'Document texte',
  log: 'Fichier journal',
  gitignore: 'Fichier source Git Ignore',
};

function fmTypeLabel(item) {
  if (item.isDir) return 'Dossier de fichiers';
  const name = item.name;
  const dot = name.lastIndexOf('.');
  // Fichiers sans extension visible commençant par un point (.env, .gitignore…)
  const ext = (dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, '')).toLowerCase();
  return FM_TYPE_LABELS[ext] || (ext ? `Fichier ${ext.toUpperCase()}` : 'Fichier');
}

async function loadFiles(relPath) {
  state.files.path = relPath || '';
  state.files.openFile = null;
  renderFileEditor();
  try {
    const { items } = await api('GET', `/api/files?path=${encodeURIComponent(state.files.path)}`);
    state.files.items = items;
    renderFileList();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBreadcrumb() {
  const el = document.getElementById('fm-breadcrumb');
  if (!el) return;
  const parts = state.files.path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = [`<span data-path="">racine</span>`];
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    crumbs.push(`<span data-path="${escapeHtml(acc)}">${escapeHtml(part)}</span>`);
  }
  el.innerHTML = crumbs.join(' / ');
  el.querySelectorAll('span[data-path]').forEach((span) => {
    span.addEventListener('click', () => loadFiles(span.dataset.path));
  });
}

function renderFileList() {
  renderBreadcrumb();
  const list = document.getElementById('fm-list');
  if (!list) return;

  const header = `
    <div class="fm-row fm-header-row">
      <span class="fm-name">Nom</span>
      <span class="fm-modified">Modifié le</span>
      <span class="fm-type">Type</span>
      <span class="fm-size">Taille</span>
      <span class="fm-row-actions"></span>
    </div>`;

  if (!state.files.items.length) {
    list.innerHTML = header + '<div class="fm-row"><span class="fm-name" style="opacity:.6">Dossier vide.</span></div>';
    return;
  }

  list.innerHTML = header + state.files.items.map((item) => `
    <div class="fm-row" data-name="${escapeHtml(item.name)}" data-dir="${item.isDir}" data-editable="${item.editable}">
      <span class="fm-name"><span class="fm-icon">${item.isDir ? '📁' : '📄'}</span>${escapeHtml(item.name)}</span>
      <span class="fm-modified">${fmFormatDate(item.modifiedAt)}</span>
      <span class="fm-type">${escapeHtml(fmTypeLabel(item))}</span>
      <span class="fm-size">${item.isDir ? '' : humanSize(item.size)}</span>
      <span class="fm-row-actions"><button class="btn-ghost fm-delete-btn" type="button">Suppr.</button></span>
    </div>
  `).join('');

  list.querySelectorAll('.fm-row:not(.fm-header-row)').forEach((row) => {
    const name = row.dataset.name;
    const isDir = row.dataset.dir === 'true';
    const editable = row.dataset.editable === 'true';
    const childPath = state.files.path ? `${state.files.path}/${name}` : name;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.fm-delete-btn')) return;
      if (isDir) return loadFiles(childPath);
      if (editable) return openFileForEdit(childPath);
      toast('Ce type de fichier ne peut pas être édité en ligne — utilise le téléchargement/upload.');
    });
    row.querySelector('.fm-delete-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer "${name}" ?`)) return;
      try {
        await api('DELETE', `/api/files?path=${encodeURIComponent(childPath)}`);
        await loadFiles(state.files.path);
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function openFileForEdit(relPath) {
  try {
    const { content } = await api('GET', `/api/files/content?path=${encodeURIComponent(relPath)}`);
    state.files.openFile = relPath;
    renderFileEditor(content);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFileEditor(content) {
  const wrap = document.getElementById('fm-editor-wrap');
  const editor = document.getElementById('fm-editor');
  const label = document.getElementById('fm-editor-filename');
  if (!wrap || !editor) return;
  if (!state.files.openFile) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (label) label.textContent = state.files.openFile;
  editor.value = content ?? editor.value;
}

document.getElementById('fm-save-btn')?.addEventListener('click', async () => {
  if (!state.files.openFile) return;
  try {
    await api('POST', '/api/files/content', {
      path: state.files.openFile,
      content: document.getElementById('fm-editor')?.value ?? '',
    });
    toast('Fichier enregistré.');
  } catch (err) { toast(err.message, true); }
});

document.getElementById('fm-close-editor-btn')?.addEventListener('click', () => {
  state.files.openFile = null;
  renderFileEditor();
});

document.getElementById('fm-new-folder-btn')?.addEventListener('click', async () => {
  const name = prompt('Nom du nouveau dossier :');
  if (!name) return;
  const target = state.files.path ? `${state.files.path}/${name}` : name;
  try {
    await api('POST', '/api/files/mkdir', { path: target });
    await loadFiles(state.files.path);
  } catch (err) { toast(err.message, true); }
});

async function uploadZipFile(file) {
  if (file.size > 150 * 1024 * 1024) {
    toast('Archive trop volumineuse (max 150 Mo).', true);
    return;
  }
  const progressWrap = document.getElementById('fm-upload-progress');
  const progressLabel = document.getElementById('fm-upload-progress-label');
  if (progressWrap) progressWrap.style.display = '';
  if (progressLabel) progressLabel.textContent = `Extraction de "${file.name}"…`;

  try {
    const base64 = await fileToBase64(file);
    await api('POST', '/api/files/upload-zip', { path: state.files.path, base64 });
    toast('Archive extraite.');
  } catch (err) {
    toast(err.message, true);
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }
  if (progressWrap) progressWrap.style.display = 'none';
  await loadFiles(state.files.path);

  // Même logique qu'après un envoi de dossier : dépendances + démarrage
  // automatiques, sans que le client ait à toucher au Panel.
  if (state.service === 'discord') {
    toast('Installation des dépendances et démarrage du bot…');
    try {
      const result = await api('POST', '/api/bot-host/start');
      state.botHost = { ...state.botHost, runtime: result };
      renderBotHostStatus();
      if (result.status === 'running') toast('Bot démarré automatiquement.');
    } catch (err) {
      toast(err.message, true);
    }
  }
}

document.getElementById('fm-upload-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (/\.zip$/i.test(file.name)) {
    await uploadZipFile(file);
    e.target.value = '';
    return;
  }
  // Installation automatique de plugins Java (.jar) et packs Bedrock (.mcpack/.mcaddon)
  if (/\.(jar|mcpack|mcaddon)$/i.test(file.name) && state.service === 'minecraft') {
    if (file.size > 150 * 1024 * 1024) {
      toast('Fichier trop volumineux (max 150 Mo).', true);
      e.target.value = '';
      return;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    const reader2 = new FileReader();
    reader2.onload = async () => {
      const base64 = String(reader2.result).split(',')[1];
      try {
        if (ext === 'jar') {
          // Déterminer le bon dossier selon le loader du serveur
          const mcConfig = state.minecraft?.config;
          const serverLoader = mcConfig?.loader || document.getElementById('mc-loader-select')?.value || 'paper';
          const folder = serverLoader === 'fabric' ? 'mods' : (serverLoader === 'forge' ? 'mods' : 'plugins');
          const target = folder + '/' + file.name;
          await api('POST', '/api/files/upload', { path: target, base64 });
          toast("Mod/Plugin installé dans " + folder + "/ — redémarre le serveur pour l'activer.");
        } else {
          // Pack Bedrock → installer via l'API
          await api('POST', '/api/minecraft/packs/install', { base64, filename: file.name });
          toast("Pack installé — redémarre le serveur pour l'activer.");
        }
        await loadFiles(state.files.path);
      } catch (err) {
        toast(err.message, true);
      } finally {
        e.target.value = '';
      }
    };
    reader2.readAsDataURL(file);
    return;
  }
  if (file.size > 60 * 1024 * 1024) {
    toast('Fichier trop volumineux (max 60 Mo par upload).', true);
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = String(reader.result).split(',')[1];
    const target = state.files.path ? `${state.files.path}/${file.name}` : file.name;
    try {
      await api('POST', '/api/files/upload', { path: target, base64 });
      toast('Fichier envoyé.');
      await loadFiles(state.files.path);
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsDataURL(file);
});

// ── Envoi de dossier entier (bot hébergé) : sélection via bouton
// (input webkitdirectory) OU glisser-déposer sur la liste de fichiers.
// node_modules/.git sont ignorés (inutile de les envoyer, npm install
// s'en charge tout seul côté serveur) — voir uploadFolderFiles().
const FM_SKIP_SEGMENTS = new Set(['node_modules', '.git', '.DS_Store']);
function fmShouldSkip(relPath) {
  return relPath.split('/').some((seg) => FM_SKIP_SEGMENTS.has(seg));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Impossible de lire "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

// Traverse récursivement une DataTransferItemList (glisser-déposer) pour
// en extraire tous les fichiers, dossiers imbriqués compris — l'API
// native <input webkitdirectory> ne s'applique qu'au bouton, pas au drop.
function fmReadEntry(entry, basePath) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => { file.__relPath = basePath + file.name; resolve([file]); },
        () => resolve([])
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let collected = [];
      const readBatch = () => {
        reader.readEntries((entries) => {
          if (!entries.length) {
            Promise.all(collected.map((en) => fmReadEntry(en, `${basePath}${entry.name}/`)))
              .then((groups) => resolve(groups.flat()));
            return;
          }
          collected = collected.concat(entries);
          readBatch();
        }, () => resolve([]));
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

async function fmCollectDroppedFiles(dataTransfer) {
  const items = dataTransfer?.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = [...items].map((it) => it.webkitGetAsEntry()).filter(Boolean);
    const groups = await Promise.all(entries.map((e) => fmReadEntry(e, '')));
    return groups.flat();
  }
  return [...(dataTransfer?.files || [])]; // navigateur sans support des entries : fichiers à plat uniquement
}

// Quand on glisse/sélectionne un dossier ("vhost-bot"), chaque fichier
// arrive avec ce nom en tête de son chemin relatif ("vhost-bot/index.js",
// "vhost-bot/commands/ban.js"…). Sans retrait, tout se retrouverait dans
// un NOUVEAU sous-dossier "vhost-bot" au lieu d'atterrir directement à la
// racine — exactement comme le "wrapper folder" déjà géré pour les .zip.
// On ne retire ce premier segment que s'il est commun à 100% des fichiers
// (donc bien le dossier source lui-même, pas un dossier interne légitime).
function fmStripCommonRootFolder(relPaths) {
  if (!relPaths.length || relPaths.some((p) => !p.includes('/'))) return null;
  const firstSegments = new Set(relPaths.map((p) => p.slice(0, p.indexOf('/'))));
  return firstSegments.size === 1 ? [...firstSegments][0] : null;
}

async function uploadFolderFiles(rawFiles) {
  const files = [...rawFiles].filter((f) => !fmShouldSkip(f.__relPath || f.webkitRelativePath || f.name));
  if (!files.length) {
    toast('Aucun fichier à envoyer (dossier vide, ou entièrement filtré — node_modules est ignoré).', true);
    return;
  }

  const rawRelPaths = files.map((f) => (f.__relPath || f.webkitRelativePath || f.name).replace(/^\/+/, ''));
  const commonRoot = fmStripCommonRootFolder(rawRelPaths);

  const progressWrap = document.getElementById('fm-upload-progress');
  const progressLabel = document.getElementById('fm-upload-progress-label');
  if (progressWrap) progressWrap.style.display = '';

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relPath = commonRoot ? rawRelPaths[i].slice(commonRoot.length + 1) : rawRelPaths[i];
    if (progressLabel) progressLabel.textContent = `Envoi ${sent + failed + 1}/${files.length} : ${relPath}`;
    if (file.size > 60 * 1024 * 1024) {
      toast(`"${relPath}" ignoré (> 60 Mo).`, true);
      failed++;
      continue;
    }
    const target = state.files.path ? `${state.files.path}/${relPath}` : relPath;
    try {
      const base64 = await fileToBase64(file);
      await api('POST', '/api/files/upload', { path: target, base64 });
      sent++;
    } catch (err) {
      toast(`Échec envoi "${relPath}" : ${err.message}`, true);
      failed++;
    }
  }

  if (progressWrap) progressWrap.style.display = 'none';
  toast(`${sent} fichier(s) envoyé(s)${failed ? `, ${failed} échec(s)` : ''}.`, failed > 0 && sent === 0);
  await loadFiles(state.files.path);

  // Le dossier envoyé, on installe les dépendances et on démarre le bot
  // tout seul — inutile de configurer quoi que ce soit à la main.
  if (state.service === 'discord' && sent > 0) {
    toast('Installation des dépendances et démarrage du bot…');
    try {
      const result = await api('POST', '/api/bot-host/start');
      state.botHost = { ...state.botHost, runtime: result };
      renderBotHostStatus();
      if (result.status === 'running') toast('Bot démarré automatiquement.');
    } catch (err) {
      toast(err.message, true);
    }
  }
}

document.getElementById('fm-upload-folder-input')?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files && files.length) await uploadFolderFiles(files);
  e.target.value = '';
});

(() => {
  const dropzone = document.getElementById('fm-list');
  if (!dropzone) return;
  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      if (state.service !== 'discord') return;
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('fm-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('fm-dragover');
    });
  });
  dropzone.addEventListener('drop', async (e) => {
    // Le glisser-déposer "dossier entier + auto-install" ne concerne que
    // l'hébergement de bot Discord — pour Minecraft, l'upload de fichiers
    // isolés (bouton) reste le chemin normal.
    if (state.service !== 'discord') return;
    const files = await fmCollectDroppedFiles(e.dataTransfer);
    if (!files.length) return;

    // Un seul fichier .zip déposé tel quel (pas depuis un dossier — donc
    // sans "/" dans son chemin relatif) : on l'extrait plutôt que de
    // l'envoyer tel quel.
    const relOf = (f) => (f.__relPath || f.webkitRelativePath || f.name);
    if (files.length === 1 && !relOf(files[0]).includes('/') && /\.zip$/i.test(files[0].name)) {
      await uploadZipFile(files[0]);
      return;
    }

    await uploadFolderFiles(files);
  });
})();

// ── Installation de packs Bedrock (.mcaddon / .mcpack) ───────────────
(() => {
  const backdrop = document.getElementById('mc-pack-modal-backdrop');
  const openBtn = document.getElementById('mc-pack-install-open-btn');
  const cancelBtn = document.getElementById('mc-pack-cancel-btn');
  const dropzone = document.getElementById('mc-pack-dropzone');
  const dropzoneText = document.getElementById('mc-pack-dropzone-text');
  const fileInput = document.getElementById('mc-pack-file-input');
  const statusEl = document.getElementById('mc-pack-status');
  if (!backdrop || !dropzone || !fileInput) return;

  const MAX_PACK_BYTES = 150 * 1024 * 1024;

  function openModal() {
    statusEl.textContent = '';
    dropzoneText.textContent = 'Glisse ton fichier ici, ou clique pour le choisir';
    backdrop.classList.add('show');
  }
  function closeModal() {
    backdrop.classList.remove('show');
  }

  openBtn?.addEventListener('click', openModal);
  cancelBtn?.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handlePackFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handlePackFile(file);
    fileInput.value = '';
  });

  function handlePackFile(file) {
    const name = file.name || '';
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!['.mcaddon', '.mcpack', '.zip'].includes(ext)) {
      statusEl.textContent = "Format non reconnu — envoie un fichier .mcaddon ou .mcpack (une archive ZIP).";
      return;
    }
    if (file.size > MAX_PACK_BYTES) {
      statusEl.textContent = 'Fichier trop volumineux (max 150 Mo).';
      return;
    }
    dropzoneText.textContent = `Installation de "${name}" en cours…`;
    statusEl.textContent = '';
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1];
      try {
        const { installed } = await api('POST', '/api/minecraft/packs/install', { base64, filename: name });
        const summary = installed.map((p) => `${p.name} (${p.kind === 'resource' ? 'ressources' : 'comportement'})`).join(', ');
        statusEl.textContent = `✅ Installé : ${summary}. Redémarre le serveur pour l'activer.`;
        dropzoneText.textContent = 'Glisse ton fichier ici, ou clique pour le choisir';
        toast('Pack installé.');
      } catch (err) {
        statusEl.textContent = `❌ ${err.message}`;
        dropzoneText.textContent = 'Glisse ton fichier ici, ou clique pour le choisir';
      }
    };
    reader.readAsDataURL(file);
  }
})();

// ── Module DayZ ─────────────────────────────────────────────
state.dayz = { safeZones: [], staffWhitelist: [] };

function fmtPlaytime(seconds) {
  const h = Math.floor((seconds || 0) / 3600);
  const m = Math.floor(((seconds || 0) % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}

async function loadDayz() {
  let data;
  try {
    data = await api('GET', '/api/dayz/settings');
  } catch (err) {
    return toast(err.message, true);
  }
  state.dayz = data;

  document.getElementById('dayz-enabled-toggle').checked = !!data.enabled;
  document.getElementById('dayz-currency-input').value = data.currencySymbol || '💰';
  document.getElementById('dayz-rcon-host').value = data.rcon?.host || '';
  document.getElementById('dayz-rcon-port').value = data.rcon?.port || 2302;
  document.getElementById('dayz-rcon-password').value = '';
  document.getElementById('dayz-rcon-password').placeholder = data.rcon?.password ? data.rcon.password : '••••••••';
  document.getElementById('dayz-log-dir').value = data.admLogDir || '';

  const guildSelect = document.getElementById('select-dayz-guild');
  const opts = { value: (g) => g.id, label: (g) => g.name, placeholder: 'Même serveur que le panel de tickets' };
  fillSelect(guildSelect, state.guilds || [], opts);
  guildSelect.value = data.commandsGuildId || '';

  renderDayzZones();
  renderDayzStaff();
  await Promise.all([loadDayzLeaderboard(), loadDayzBanLog(), loadDayzNitradoStatus()]);
}

// ── Liaison compte Nitrado ───────────────────────────────────
async function loadDayzNitradoStatus() {
  let n;
  try {
    n = await api('GET', '/api/dayz/nitrado');
  } catch (err) {
    return; // pas bloquant pour le reste du panneau
  }
  state.dayzNitrado = n;
  renderDayzNitradoStatus();
}

function renderDayzNitradoStatus() {
  const box = document.getElementById('dayz-nitrado-status');
  const linkedActions = document.getElementById('dayz-nitrado-linked-actions');
  if (!box) return;
  const n = state.dayzNitrado || {};

  if (n.linked) {
    const syncedAt = n.lastSyncAt ? new Date(n.lastSyncAt).toLocaleString('fr-FR') : 'jamais';
    const warning = n.lastSyncError ? `<br><span style="color:#faa61a;">⚠️ Infos manquantes côté Nitrado : ${escapeHtml(n.lastSyncError)} — complète-les dans "Connexion manuelle" ci-dessous.</span>` : '';
    box.innerHTML = `<span style="color:#57f287;">✅ Compte Nitrado lié</span> — dernière synchro : ${syncedAt}${warning}`;
    linkedActions.style.display = '';
  } else {
    box.innerHTML = `<span style="color:#b5bac1;">Aucun compte Nitrado lié pour l'instant.</span>`;
    linkedActions.style.display = 'none';
  }
}

function applyDayzSyncResult(dayzData) {
  state.dayz = { ...state.dayz, ...dayzData };
  state.dayzNitrado = dayzData.nitrado || state.dayzNitrado;
  document.getElementById('dayz-rcon-host').value = dayzData.rcon?.host || '';
  document.getElementById('dayz-rcon-port').value = dayzData.rcon?.port || 2302;
  document.getElementById('dayz-rcon-password').value = '';
  document.getElementById('dayz-rcon-password').placeholder = dayzData.rcon?.password || '••••••••';
  document.getElementById('dayz-log-dir').value = dayzData.admLogDir || '';
  renderDayzNitradoStatus();
}

document.getElementById('dayz-nitrado-link-btn')?.addEventListener('click', async (e) => {
  const token = document.getElementById('dayz-nitrado-token').value.trim();
  if (!token) return toast('Colle ton token API Nitrado.', true);
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/link', { token });
    const select = document.getElementById('dayz-nitrado-service-select');
    fillSelect(select, res.services || [], {
      value: (s) => s.id,
      label: (s) => `${s.game || 'Service'} — ${s.address || s.id} (${s.status})`,
    });
    document.getElementById('dayz-nitrado-services').style.display = res.services?.length ? '' : 'none';
    if (!res.services?.length) toast('Token valide, mais aucun service trouvé sur ce compte.', true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-select-btn')?.addEventListener('click', async (e) => {
  const token = document.getElementById('dayz-nitrado-token').value.trim();
  const serviceId = document.getElementById('dayz-nitrado-service-select').value;
  if (!token || !serviceId) return toast('Choisis un serveur dans la liste.', true);
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/select', { token, serviceId });
    applyDayzSyncResult(res.dayz);
    document.getElementById('dayz-nitrado-token').value = '';
    document.getElementById('dayz-nitrado-services').style.display = 'none';
    toast(res.warning || 'Compte Nitrado lié et synchronisé.', !!res.warning);
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-sync-btn')?.addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const res = await api('POST', '/api/dayz/nitrado/sync', {});
    applyDayzSyncResult(res.dayz);
    toast('Synchronisation Nitrado effectuée.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-nitrado-unlink-btn')?.addEventListener('click', async (e) => {
  if (!confirm('Délier ce compte Nitrado ? Le RCon manuel restera tel quel.')) return;
  e.target.disabled = true;
  try {
    const res = await api('DELETE', '/api/dayz/nitrado');
    state.dayzNitrado = res.dayz.nitrado;
    renderDayzNitradoStatus();
    toast('Compte Nitrado délié.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('dayz-enabled-toggle')?.addEventListener('change', async (e) => {
  try {
    const updated = await api('POST', '/api/dayz/settings', { enabled: e.target.checked });
    state.dayz = updated.dayz;
    toast(e.target.checked ? 'Module DayZ activé.' : 'Module DayZ désactivé.');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});

document.getElementById('dayz-save-connection-btn')?.addEventListener('click', async () => {
  const patch = {
    currencySymbol: document.getElementById('dayz-currency-input').value.trim() || '💰',
    commandsGuildId: document.getElementById('select-dayz-guild').value,
    admLogDir: document.getElementById('dayz-log-dir').value.trim(),
    rcon: {
      host: document.getElementById('dayz-rcon-host').value.trim(),
      port: Number(document.getElementById('dayz-rcon-port').value) || 2302,
      password: document.getElementById('dayz-rcon-password').value || document.getElementById('dayz-rcon-password').placeholder,
    },
  };
  try {
    const updated = await api('POST', '/api/dayz/settings', patch);
    state.dayz = updated.dayz;
    document.getElementById('dayz-rcon-password').value = '';
    document.getElementById('dayz-rcon-password').placeholder = updated.dayz.rcon.password || '••••••••';
    toast('Connexion DayZ enregistrée.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderDayzZones() {
  const list = document.getElementById('dayz-zones-list');
  if (!list) return;
  const zones = state.dayz.safeZones || [];
  if (!zones.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucune safe zone configurée.</p>';
    return;
  }
  list.innerHTML = zones
    .map(
      (z) => `
      <div class="admin-row">
        <span><strong>${escapeHtml(z.name)}</strong> — X:${escapeHtml(String(z.x))} Z:${escapeHtml(String(z.z))} — rayon ${escapeHtml(String(z.radius))}m</span>
        <button class="btn-ghost dayz-zone-remove-btn" data-id="${escapeHtml(z.id)}">Retirer</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.dayz-zone-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer cette safe zone ?')) return;
      try {
        const res = await api('DELETE', `/api/dayz/safezones/${btn.dataset.id}`);
        state.dayz.safeZones = res.safeZones;
        renderDayzZones();
        toast('Safe zone retirée.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

document.getElementById('dayz-add-zone-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('dayz-zone-name').value.trim();
  const x = Number(document.getElementById('dayz-zone-x').value);
  const z = Number(document.getElementById('dayz-zone-z').value);
  const radius = Number(document.getElementById('dayz-zone-radius').value);
  if (!name || Number.isNaN(x) || Number.isNaN(z) || Number.isNaN(radius)) {
    return toast('Renseigne un nom et des coordonnées/rayon valides.', true);
  }
  try {
    const res = await api('POST', '/api/dayz/safezones', { name, x, z, radius });
    state.dayz.safeZones = res.safeZones;
    renderDayzZones();
    ['dayz-zone-name', 'dayz-zone-x', 'dayz-zone-z', 'dayz-zone-radius'].forEach((id) => (document.getElementById(id).value = ''));
    toast('Safe zone ajoutée.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderDayzStaff() {
  const list = document.getElementById('dayz-staff-list');
  if (!list) return;
  const staff = state.dayz.staffWhitelist || [];
  if (!staff.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucun staff DayZ ajouté (les admins du dashboard ont déjà accès).</p>';
    return;
  }
  list.innerHTML = staff
    .map(
      (id) => `
      <div class="admin-row">
        <span class="mono">${escapeHtml(id)}</span>
        <button class="btn-ghost dayz-staff-remove-btn" data-id="${escapeHtml(id)}">Retirer</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.dayz-staff-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('DELETE', `/api/dayz/staff/${btn.dataset.id}`);
        state.dayz.staffWhitelist = res.staffWhitelist;
        renderDayzStaff();
        toast('Staff retiré.');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

document.getElementById('dayz-add-staff-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('dayz-staff-input');
  const id = input.value.trim();
  if (!/^\d{15,25}$/.test(id)) return toast('ID Discord invalide.', true);
  try {
    const res = await api('POST', '/api/dayz/staff', { discordId: id });
    state.dayz.staffWhitelist = res.staffWhitelist;
    renderDayzStaff();
    input.value = '';
    toast('Staff ajouté.');
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadDayzLeaderboard() {
  const list = document.getElementById('dayz-leaderboard-list');
  if (!list) return;
  const type = document.getElementById('dayz-leaderboard-type').value;
  let data;
  try {
    data = await api('GET', `/api/dayz/leaderboard?type=${type}`);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!data.rows.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucune donnée pour le moment.</p>';
    return;
  }
  const currency = state.dayz.currencySymbol || '💰';
  list.innerHTML = `<div class="tickets-table"><table><thead><tr>
    <th>#</th><th>Joueur</th><th>Discord</th>
    ${type === 'money' ? '<th>Solde</th>' : ''}
    ${type === 'kills' ? '<th>Kills</th><th>Deaths</th>' : ''}
    ${type === 'ratio' ? '<th>Ratio</th><th>K/D</th>' : ''}
  </tr></thead><tbody>
    ${data.rows
      .map(
        (r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(r.player_name || r.steam_id)}</td>
          <td>${r.discord_id ? `<@${escapeHtml(r.discord_id)}>` : '—'}</td>
          ${type === 'money' ? `<td>${r.balance} ${currency}</td>` : ''}
          ${type === 'kills' ? `<td>${r.kills}</td><td>${r.deaths}</td>` : ''}
          ${type === 'ratio' ? `<td>${Number(r.ratio).toFixed(2)}</td><td>${r.kills}/${r.deaths}</td>` : ''}
        </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

document.getElementById('dayz-leaderboard-type')?.addEventListener('change', loadDayzLeaderboard);

async function loadDayzBanLog() {
  const list = document.getElementById('dayz-banlog-list');
  if (!list) return;
  let data;
  try {
    data = await api('GET', '/api/dayz/ban-log');
  } catch (err) {
    return toast(err.message, true);
  }
  if (!data.rows.length) {
    list.innerHTML = '<p class="field-hint" style="margin:0;">Aucun ban automatique pour le moment.</p>';
    return;
  }
  list.innerHTML = data.rows
    .map(
      (r) => `
      <div class="admin-row" style="align-items:flex-start;">
        <div>
          <strong>${escapeHtml(r.player_name || r.steam_id)}</strong> (<span class="mono">${escapeHtml(r.steam_id)}</span>)
          <div class="field-hint" style="margin:2px 0 0;">${escapeHtml(r.reason || '')} · ${new Date(r.created_at).toLocaleString('fr-FR')}</div>
        </div>
        <span class="mc-status-badge" style="background:${r.rcon_ok ? 'rgba(87,242,135,0.15)' : 'rgba(255,77,77,0.15)'}; color:${r.rcon_ok ? 'var(--green)' : 'var(--coral)'};">
          ${r.rcon_ok ? 'Ban confirmé' : 'Échec RCon'}
        </span>
      </div>`
    )
    .join('');
}

// ── Sous-domaine Cloudflare ───────────────────────────────────
let subdomainCheckTimer = null;

async function loadSubdomain() {
  try {
    const data = await api('GET', '/api/subdomain');
    const current = document.getElementById('subdomain-current');
    const form = document.getElementById('subdomain-form');
    const hostname = document.getElementById('subdomain-hostname');
    if (!current || !form) return;
    if (data.subdomain && data.subdomain.hostname) {
      current.style.display = 'block';
      form.style.display = 'none';
      hostname.textContent = data.subdomain.hostname;
    } else if (!data.subdomainActive && !data.subdomainFree) {
      // Option pas activee -> afficher le bouton d'achat
      current.style.display = 'none';
      form.innerHTML = '<div style="background:linear-gradient(135deg,rgba(99,102,241,.08),rgba(139,92,246,.06));border:1.5px solid rgba(99,102,241,.2);border-radius:12px;padding:20px;text-align:center">'+
        '<div style="font-size:22px;margin-bottom:8px">✨</div>'+
        '<div style="font-size:14px;font-weight:700;color:#4f46e5;margin-bottom:6px">Option Sous-domaine</div>'+
        '<div style="font-size:12px;color:#64748b;margin-bottom:4px">Connecte-toi avec <strong>tonnom.vhoste.cloud</strong></div>'+
        '<div style="font-size:12px;color:#64748b;margin-bottom:16px">Sans retenir IP ni port.</div>'+
        '<div style="font-size:20px;font-weight:800;color:#1e293b;margin-bottom:16px">2,00 € <span style="font-size:12px;font-weight:400;color:#94a3b8">/ mois</span></div>'+
        '<button class="btn-primary" onclick="subscribeSubdomain()" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);width:100%">Activer cette option</button>'+
      '</div>';
      form.style.display = 'block';
    } else {
      current.style.display = 'none';
      form.style.display = 'block';
    }
  } catch {}
}

function checkSubdomain() {
  const input = document.getElementById('subdomain-input');
  const status = document.getElementById('subdomain-status');
  const btn = document.getElementById('subdomain-save-btn');
  const val = input.value.trim().toLowerCase();
  if (!val || val.length < 3) {
    status.textContent = 'Minimum 3 caracteres.';
    status.style.color = '#94a3b8';
    btn.disabled = true;
    return;
  }
  if (!/^[a-z0-9-]+$/.test(val)) {
    status.textContent = 'Lettres minuscules, chiffres et tirets uniquement.';
    status.style.color = '#f43f5e';
    btn.disabled = true;
    return;
  }
  status.textContent = 'Verification...';
  status.style.color = '#94a3b8';
  btn.disabled = true;
  clearTimeout(subdomainCheckTimer);
  subdomainCheckTimer = setTimeout(async () => {
    try {
      const r = await api('GET', '/api/subdomain/check?slug='+encodeURIComponent(val));
      if (r.available) {
        status.textContent = '✓ '+val+'.vhoste.cloud est disponible';
        status.style.color = '#10b981';
        btn.disabled = false;
      } else {
        status.textContent = '✗ Ce nom est deja pris';
        status.style.color = '#f43f5e';
        btn.disabled = true;
      }
    } catch {
      status.textContent = 'Erreur de verification';
      status.style.color = '#f43f5e';
    }
  }, 600);
}

async function saveSubdomain() {
  const input = document.getElementById('subdomain-input');
  const btn = document.getElementById('subdomain-save-btn');
  const status = document.getElementById('subdomain-status');
  const slug = input.value.trim().toLowerCase();
  btn.disabled = true;
  btn.textContent = 'Activation...';
  try {
    const r = await api('POST', '/api/subdomain', { slug });
    if (r.ok) {
      status.textContent = '✓ Sous-domaine active !';
      status.style.color = '#10b981';
      await loadSubdomain();
    } else if (r.upgrade) {
      // Option pas activee -> proposer l'achat
      const form = document.getElementById('subdomain-form');
      form.innerHTML = '<div style="background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15);border-radius:10px;padding:16px;text-align:center">'+
        '<div style="font-size:13px;font-weight:600;color:#4f46e5;margin-bottom:6px">Option Sous-domaine — 2,00 €/mois</div>'+
        '<div style="font-size:12px;color:#64748b;margin-bottom:14px">Active cette option pour utiliser un sous-domaine personnalise.</div>'+
        '<button class="btn-primary" onclick="subscribeSubdomain()" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">Activer pour 2€/mois</button>'+
      '</div>';
      btn.disabled = false;
      btn.textContent = 'Activer';
    } else {
      status.textContent = r.error || 'Erreur';
      status.style.color = '#f43f5e';
      btn.disabled = false;
      btn.textContent = 'Activer';
    }
  } catch(e) {
    status.textContent = 'Erreur reseau';
    status.style.color = '#f43f5e';
    btn.disabled = false;
    btn.textContent = 'Activer';
  }
}

async function subscribeSubdomain() {
  try {
    const r = await api('POST', '/api/subdomain/subscribe');
    if (r.url) window.location.href = r.url;
    else alert(r.error || 'Erreur');
  } catch(e) { alert('Erreur reseau'); }
}

async function deleteSubdomain() {
  if (!confirm('Supprimer le sous-domaine ? Cette action est irreversible.')) return;
  try {
    await api('DELETE', '/api/subdomain');
    await loadSubdomain();
  } catch(e) { alert('Erreur : '+e.message); }
}

// ── Parrainage ────────────────────────────────────────────────
async function loadReferral() {
  try {
    const data = await api('GET', '/api/referral');
    const link = window.location.origin + '/?ref=' + data.code;
    const el = document.getElementById('referral-link');
    if (el) el.value = link;
    const countEl = document.getElementById('referral-count');
    if (countEl) countEl.textContent = data.count || 0;
    const bonusEl = document.getElementById('referral-bonus');
    if (bonusEl) bonusEl.textContent = data.bonusMonths || 0;
  } catch {}
}

function copyReferral() {
  const el = document.getElementById('referral-link');
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => {
    const btn = document.querySelector('#view-referral .btn-primary');
    if (btn) { btn.textContent = 'Copie !'; setTimeout(() => btn.textContent = 'Copier', 2000); }
  });
}

// ── Joueurs en temps reel ──────────────────────────────────
async function loadLivePlayers() {
  if (state.service !== 'minecraft') return;
  try {
    const data = await api('GET', '/api/minecraft/players');
    const players = data.players || [];
    // Afficher dans la vue overview
    let el = document.getElementById('live-players-count');
    if (!el) {
      // Creer le widget si pas encore present
      const overview = document.getElementById('view-overview');
      if (overview) {
        const widget = document.createElement('div');
        widget.style.cssText = 'background:var(--surface,#fff);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px';
        widget.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><span style="font-size:13px;font-weight:600">Joueurs connectes</span><span style="font-size:20px;font-weight:800;color:var(--cyan)" id="live-players-count">0</span></div><div id="live-players-list" style="display:flex;flex-wrap:wrap;gap:6px"></div>';
        overview.prepend(widget);
        el = document.getElementById('live-players-count');
      }
    }
    if (el) el.textContent = players.length;
    const listEl = document.getElementById('live-players-list');
    if (listEl) {
      if (!players.length) {
        listEl.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Aucun joueur connecte</span>';
      } else {
        listEl.innerHTML = players.map(p => {
          const name = typeof p === 'string' ? p : p.name;
          const uuid = typeof p === 'object' ? p.uuid : '';
          return '<div style="display:flex;align-items:center;gap:6px;background:var(--surface-2,#f8fafc);border-radius:8px;padding:5px 10px">'+(uuid?'<img src="https://crafatar.com/avatars/'+uuid+'?size=20&overlay" style="width:20px;height:20px;border-radius:4px">':'')+'<span style="font-size:12px;font-weight:500">'+name+'</span></div>';
        }).join('');
      }
    }
  } catch {}
}

// ── Monitoring RAM / alertes ──────────────────────────────────
let ramAlertShown = false;

function showRamAlert(percent) {
  if (ramAlertShown) return;
  ramAlertShown = true;
  const alert = document.createElement('div');
  alert.id = 'ram-alert-banner';
  alert.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:linear-gradient(135deg,#e5484d,#f59e0b);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 10px rgba(0,0,0,.2)';
  alert.innerHTML = '<span style="font-size:13px;font-weight:700;color:white">⚠️ RAM a '+percent+'% — Ton serveur risque de planter. Redémarre ou optimise.</span>'+
    '<button onclick="this.parentElement.remove();ramAlertShown=false" style="background:rgba(255,255,255,.2);border:none;color:white;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px">Fermer</button>';
  document.body.prepend(alert);
  setTimeout(() => { alert.remove(); ramAlertShown = false; }, 30000);
}

async function startRamMonitor() {
  if (state.service !== 'minecraft') return;
  setInterval(async () => {
    try {
      const r = await api('GET', '/api/server/stats');
      if (r && r.proc && r.proc.memUsageMb && r.proc.memLimitMb) {
        const percent = Math.round((r.proc.memUsageMb / r.proc.memLimitMb) * 100);
        if (percent >= 90) showRamAlert(percent);
        else ramAlertShown = false;
      }
    } catch {}
  }, 30000);
}

// ── Bundle switcher ──────────────────────────────────────────
async function switchService() {
  try {
    const r = await api('POST', '/api/switch-service');
    if (r.ok) window.location.reload();
  } catch(e) { console.error('switch-service:', e); }
}

async function checkBundleSwitcher() {
  try {
    const me = await api('GET', '/api/me');
    if (!me.linkedTenantId) return;
    const switcher = document.getElementById('bundle-switcher');
    if (!switcher) return;
    switcher.style.display = 'block';
    const isMc = me.service === 'minecraft';
    const mcBtn = document.getElementById('switcher-mc');
    const botBtn = document.getElementById('switcher-bot');
    if(mcBtn) {
      mcBtn.style.background = isMc ? 'rgba(34,211,238,.1)' : 'transparent';
      mcBtn.style.color = isMc ? '#22d3ee' : 'rgba(255,255,255,.4)';
      mcBtn.style.borderRight = '1px solid rgba(255,255,255,.06)';
      mcBtn.style.fontWeight = isMc ? '700' : '500';
    }
    if(botBtn) {
      botBtn.style.background = !isMc ? 'rgba(139,92,246,.1)' : 'transparent';
      botBtn.style.color = !isMc ? '#a855f7' : 'rgba(255,255,255,.4)';
      botBtn.style.fontWeight = !isMc ? '700' : '500';
    }
  } catch {}
}

// ── Démarrage Système ──────────────────────────────────────
(async function init() {
  await loadMe();

  try {
    const svc = await api('GET', '/api/service');
    state.service = svc.service || 'discord';
  } catch {
    state.service = 'discord';
  }
  applyServiceVisibility();

  await refreshStatus();
  checkBundleSwitcher();
  startRamMonitor();
  loadLivePlayers();
  setInterval(loadLivePlayers, 10000);
  if (state.isDemo) {
    const banner = document.getElementById('demo-banner');
    if (banner) { banner.style.display='flex'; document.getElementById('main-sidebar').style.marginTop='37px'; }
    setTimeout(() => {
      document.querySelectorAll('button').forEach(b => {
        if (!b.closest('.nav-item') && !b.id?.includes('logout')) {
          b.disabled=true; b.style.opacity='.4'; b.style.cursor='not-allowed'; b.title='Mode demo';
        }
      });
    }, 500);
  }
  if (state.service === 'minecraft') {
    loadSubdomain();
    const delBtn = document.getElementById('subdomain-delete-btn');
    if (delBtn) delBtn.addEventListener('click', deleteSubdomain);
  }

  if (state.service === 'minecraft') {
    setInterval(refreshStatus, 5000);
    return;
  }

  await loadSettings();
  await loadGuilds();
  setInterval(refreshStatus, 5000);
})();
// Masquer config serveur et playlist
document.addEventListener('DOMContentLoaded', () => {
  const hide = ['mc-properties-box','music-accordion'];
  hide.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.setProperty('display','none','important'); }
  });
});
const _origShow = window.showMcBoxes;

async function loadTokensSection() {
  try {
    const r = await fetch('/api/ai/tokens', { credentials: 'same-origin' });
    const d = await r.json();
    const bal = document.getElementById('tokens-balance-display');
    const used = document.getElementById('tokens-used-display');
    if (bal) bal.textContent = (d.balance || 0) + ' tokens';
    if (used && d.total_used) used.textContent = d.total_used + ' utilisés au total';
  } catch(e) {
    const bal = document.getElementById('tokens-balance-display');
    if (bal) bal.textContent = 'Erreur de chargement';
  }
}

async function buyTokensPack(priceId) {
  try {
    const r = await fetch('/api/ai/checkout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId }),
    });
    const d = await r.json();
    if (d.url) window.location.href = d.url;
    else alert(d.error || 'Erreur paiement');
  } catch { alert('Erreur de connexion.'); }
}
