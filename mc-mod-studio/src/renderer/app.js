/* global require, monaco, PixelEditor, renderMarkdown, escapeHtml */
// ModCraft Studio — interface.
const api = window.studio;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = escapeHtml;

const state = {
  info: null,
  project: null, // { root, meta }
  tree: [],
  expanded: new Set(),
  tabs: [], // { path, kind: 'text'|'image', model?, dirty, pixel?, el? }
  active: null,
  editor: null,
  aiBusy: false,
  busy: false,
};

// ====================== Utilitaires UI ======================
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}

/** Ouvre une fenêtre modale. build(body) remplit le corps ; collect() renvoie la valeur ou lance une erreur. */
function modal(title, html, { okText = 'OK', cancelText = 'Annuler', onOpen, collect } = {}) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalOk').textContent = okText;
    $('#modalCancel').textContent = cancelText;
    $('#modalCancel').classList.toggle('hidden', !cancelText);
    m.classList.remove('hidden');
    const close = (v) => {
      m.classList.add('hidden');
      $('#modalOk').onclick = $('#modalCancel').onclick = null;
      m.onkeydown = null;
      resolve(v);
    };
    $('#modalCancel').onclick = () => close(null);
    $('#modalOk').onclick = async () => {
      try {
        const v = collect ? await collect($('#modalBody')) : true;
        if (v !== undefined) close(v);
      } catch (e) {
        const err = $('.form-error', $('#modalBody'));
        if (err) err.textContent = e.message;
        else toast(e.message, 'error');
      }
    };
    m.onkeydown = (e) => {
      if (e.key === 'Escape' && cancelText) close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('#modalOk').click();
    };
    if (onOpen) onOpen($('#modalBody'));
    const first = $('input, select, textarea', $('#modalBody'));
    if (first) first.focus();
  });
}

function confirmBox(title, text, okText = 'Oui') {
  return modal(title, `<p>${esc(text)}</p>`, { okText });
}

// ====================== Accueil ======================
async function refreshHome() {
  state.info = await api.info();
  const list = $('#recentList');
  list.innerHTML = '';
  $('#recentWrap').classList.toggle('hidden', !state.info.recent.length);
  state.info.recent.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(r.name)}</b><small>${esc(r.root)}</small>`;
    li.onclick = () => openProject(r.root);
    list.appendChild(li);
  });
  const ks = $('#keyStatus');
  ks.textContent = state.info.hasKey ? 'IA : prête ✔' : 'IA : ajoute ta clé API';
  ks.className = 'pill ' + (state.info.hasKey ? 'ok' : 'warn clickable');
  ks.onclick = state.info.hasKey ? null : openSettings;
  checkMinecraft();
}

async function checkMinecraft() {
  const ms = $('#mcStatus');
  try {
    const m = await api.minecraft();
    ms.textContent = m.message;
    ms.className = 'pill ' + (m.ok ? 'ok' : 'warn');
    ms.title = m.ok ? m.path : 'Tu peux quand même créer ton add-on et l\'exporter en .mcaddon';
  } catch (e) {
    ms.textContent = 'Minecraft : ' + e.message;
  }
}

async function newModWizard() {
  const info = state.info || (await api.info());
  const html = `
    <p class="muted">Ton add-on sera fait pour <b>Minecraft Bedrock</b> (1.21.100 ou plus récent).</p>
    <label>Nom de l'add-on<input id="nmName" placeholder="Ex : Super Rubis" maxlength="40"></label>
    <label>Ton pseudo<input id="nmAuthor" placeholder="Ex : Steve" maxlength="30"></label>
    <label>Description (facultatif)<input id="nmDesc" placeholder="Ex : Ajoute des rubis partout !" maxlength="120"></label>
    <label>Dossier
      <div class="row"><input id="nmDir" value="${esc(info.defaultParent)}"><button type="button" id="nmPick">Changer…</button></div>
    </label>
    <div class="form-error"></div>`;
  const res = await modal('✨ Nouvel add-on', html, {
    okText: 'Créer l\'add-on',
    onOpen: (b) => {
      $('#nmPick', b).onclick = async () => {
        const d = await api.pickFolder('Où créer le mod ?');
        if (d) $('#nmDir', b).value = d;
      };
    },
    collect: async (b) => {
      const modName = $('#nmName', b).value.trim();
      if (!modName) throw new Error('Donne un nom à ton add-on.');
      $('#modalOk').disabled = true;
      $('#modalOk').textContent = 'Création…';
      try {
        return await api.createProject({
          modName,
          author: $('#nmAuthor', b).value.trim(),
          description: $('#nmDesc', b).value.trim(),
          parentDir: $('#nmDir', b).value.trim(),
        });
      } finally {
        $('#modalOk').disabled = false;
        $('#modalOk').textContent = 'Créer l\'add-on';
      }
    },
  });
  if (!res) return;
  enterWorkspace(res);
  toast('Ton add-on est créé ! 🎉', 'ok');
  if (res.warnings && res.warnings.length) setTimeout(() => toast(res.warnings[res.warnings.length - 1], 'warn'), 1500);
}

async function openProjectDialog() {
  const d = await api.pickFolder('Ouvrir le dossier d\'un add-on');
  if (d) openProject(d);
}

async function openProject(root) {
  try {
    enterWorkspace(await api.openProject(root));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ====================== Espace de travail ======================
function enterWorkspace({ root, meta, tree }) {
  state.project = { root, meta };
  state.tree = tree;
  state.tabs.forEach((t) => t.model && t.model.dispose());
  state.tabs = [];
  state.active = null;
  state.expanded = new Set();
  // Déplie les dossiers utiles par défaut
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.dir && /^(BP|RP)(\/(items|blocks|recipes|scripts|textures|texts)(\/(items|blocks))?)?$/.test(n.path)) { state.expanded.add(n.path); walk(n.children); }
  });
  walk(tree);
  $('#projName').textContent = meta.modName;
  document.title = `${meta.modName} — ModCraft Studio`;
  $('#home').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderTree();
  renderTabs();
  showPane('welcome');
  $('#aiLog').querySelectorAll('.msg:not(.intro)').forEach((m) => m.remove());
  api.aiReset().catch(() => {});
  ensureMonaco();
}

async function goHome() {
  if (state.tabs.some((t) => t.dirty)) {
    const ok = await confirmBox('Fichiers non enregistrés', 'Certains fichiers ne sont pas enregistrés. Les enregistrer avant de quitter ?', 'Enregistrer');
    if (ok) await saveAll();
  }
  $('#workspace').classList.add('hidden');
  $('#home').classList.remove('hidden');
  document.title = 'ModCraft Studio';
  refreshHome();
}

// ---------- Arbre de fichiers ----------
function fileIcon(n) {
  if (n.dir && n.name === 'BP') return '⚙️';
  if (n.dir && n.name === 'RP') return '🎨';
  if (n.dir) return state.expanded.has(n.path) ? '📂' : '📁';
  if (n.name.endsWith('.js')) return '📜';
  if (n.name.endsWith('.lang')) return '🌍';
  if (n.name.endsWith('.png')) return '🖼️';
  if (n.name.endsWith('.json')) return '🧾';
  return '📄';
}

function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  const build = (nodes, depth) => {
    nodes.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'tree-row' + (n.path === state.active ? ' active' : '');
      row.style.paddingLeft = 8 + depth * 14 + 'px';
      row.innerHTML = `<span class="ti">${fileIcon(n)}</span><span class="tn">${esc(n.name)}</span>`;
      row.title = n.path;
      row.onclick = () => {
        if (n.dir) {
          if (state.expanded.has(n.path)) state.expanded.delete(n.path);
          else state.expanded.add(n.path);
          renderTree();
        } else openFile(n.path);
      };
      row.oncontextmenu = (e) => { e.preventDefault(); treeMenu(e, n); };
      root.appendChild(row);
      if (n.dir && state.expanded.has(n.path)) build(n.children, depth + 1);
    });
  };
  build(state.tree, 0);
}

async function refreshTree() {
  try {
    state.tree = await api.tree();
    renderTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function treeMenu(e, n) {
  $$('.ctx-menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  m.style.left = e.clientX + 'px';
  m.style.top = e.clientY + 'px';
  const items = [
    ['📁 Afficher dans l\'explorateur', () => api.reveal(n.path)],
    ['✏️ Renommer', async () => {
      const v = await modal('Renommer', `<label>Nouveau nom<input id="rnName" value="${esc(n.name)}"></label><div class="form-error"></div>`, {
        collect: (b) => { const x = $('#rnName', b).value.trim(); if (!x || /[\\/]/.test(x)) throw new Error('Nom invalide'); return x; },
      });
      if (!v) return;
      const to = n.path.split('/').slice(0, -1).concat(v).join('/');
      await api.renameFile(n.path, to).catch((er) => toast(er.message, 'error'));
      closeTab(n.path, true);
      refreshTree();
    }],
    ['🗑 Supprimer', async () => {
      if (!(await confirmBox('Supprimer', `Supprimer « ${n.name} » ? Cette action est définitive.`, 'Supprimer'))) return;
      await api.deleteFile(n.path).catch((er) => toast(er.message, 'error'));
      closeTab(n.path, true);
      refreshTree();
    }],
  ];
  if (!n.dir && n.name.endsWith('.png')) items.unshift(['📥 Remplacer par une image…', async () => { if (await api.importImage(n.path)) reloadTab(n.path); }]);
  items.forEach(([label, fn]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { m.remove(); fn(); };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}

// ---------- Monaco ----------
let monacoReady;
function ensureMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve) => {
    const vs = new URL('../../node_modules/monaco-editor/min/vs', location.href).href;
    require.config({ paths: { vs } });
    // Les "workers" de Monaco sont chargés depuis un blob qui importe les scripts locaux
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob([
        `self.MonacoEnvironment = { baseUrl: '${vs}/../' }; importScripts('${vs}/base/worker/workerMain.js');`,
      ], { type: 'text/javascript' })),
    };
    require(['vs/editor/editor.main'], () => {
      monaco.editor.defineTheme('modcraft', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: { 'editor.background': '#1e2027', 'editor.lineHighlightBackground': '#262933' },
      });
      state.editor = monaco.editor.create($('#monaco'), {
        theme: 'modcraft',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false },
        tabSize: 4,
        insertSpaces: true,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        smoothScrolling: true,
      });
      resolve(state.editor);
    });
  });
  return monacoReady;
}

function langFor(p) {
  if (p.endsWith('.js')) return 'javascript';
  if (p.endsWith('.lang')) return 'ini';
  if (p.endsWith('.mcfunction')) return 'shell';
  if (p.endsWith('.json') || p.endsWith('.mcmeta')) return 'json';
  if (p.endsWith('.gradle')) return 'groovy';
  if (p.endsWith('.properties')) return 'ini';
  if (p.endsWith('.md')) return 'markdown';
  if (p.endsWith('.bat')) return 'bat';
  return 'plaintext';
}

// ---------- Onglets ----------
function showPane(which) {
  $('#welcomePane').classList.toggle('hidden', which !== 'welcome');
  $('#monacoPane').classList.toggle('hidden', which !== 'text');
  $('#pixelPane').classList.toggle('hidden', which !== 'image');
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  state.tabs.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'tab' + (t.path === state.active ? ' active' : '');
    const name = t.path.split('/').pop();
    d.innerHTML = `<span>${esc(name)}${t.dirty ? ' ●' : ''}</span><button class="x" title="Fermer">×</button>`;
    d.title = t.path;
    d.onclick = (e) => { if (!e.target.classList.contains('x')) activate(t.path); };
    $('.x', d).onclick = () => closeTab(t.path);
    el.appendChild(d);
  });
}

async function openFile(p) {
  const existing = state.tabs.find((t) => t.path === p);
  if (existing) return activate(p);
  try {
    if (p.endsWith('.png')) {
      const tab = { path: p, kind: 'image', dirty: false, b64: await api.readBase64(p) };
      state.tabs.push(tab);
    } else {
      const content = await api.readFile(p);
      await ensureMonaco();
      const model = monaco.editor.createModel(content, langFor(p));
      const tab = { path: p, kind: 'text', model, dirty: false, saved: content };
      model.onDidChangeContent(() => {
        const dirty = model.getValue() !== tab.saved;
        if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs(); }
      });
      state.tabs.push(tab);
    }
    activate(p);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function activate(p) {
  const tab = state.tabs.find((t) => t.path === p);
  if (!tab) return;
  if (state.pixel && state.pixel.tabPath !== p) { state.pixel.destroy(); state.pixel = null; }
  state.active = p;
  if (tab.kind === 'text') {
    state.editor.setModel(tab.model);
    showPane('text');
    state.editor.focus();
  } else {
    showPane('image');
    if (!state.pixel || state.pixel.tabPath !== p) {
      state.pixel = new PixelEditor($('#pixelPane'), {
        base64: tab.b64,
        name: p.split('/').pop(),
        onSave: async (b64) => {
          await api.writeBase64(p, b64);
          tab.b64 = b64;
          toast('Texture enregistrée ✔', 'ok');
        },
      });
      state.pixel.onImport = async () => { if (await api.importImage(p)) reloadTab(p); };
      state.pixel.tabPath = p;
    }
  }
  renderTabs();
  renderTree();
}

async function closeTab(p, force = false) {
  const i = state.tabs.findIndex((t) => t.path === p);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (!force && tab.dirty) {
    const ok = await confirmBox('Fichier non enregistré', `« ${p.split('/').pop()} » a des modifications. Les enregistrer ?`, 'Enregistrer');
    if (ok) await saveTab(tab);
  }
  if (tab.model) tab.model.dispose();
  if (state.pixel && state.pixel.tabPath === p) { state.pixel.destroy(); state.pixel = null; }
  state.tabs.splice(i, 1);
  if (state.active === p) {
    const next = state.tabs[Math.max(0, i - 1)];
    if (next) activate(next.path);
    else { state.active = null; showPane('welcome'); }
  }
  renderTabs();
  renderTree();
}

/** Recharge un onglet depuis le disque (après une modif de l'IA). */
async function reloadTab(p) {
  const tab = state.tabs.find((t) => t.path === p);
  if (!tab) return;
  try {
    if (tab.kind === 'text') {
      if (tab.dirty) return; // on n'écrase pas le travail en cours
      const content = await api.readFile(p);
      if (content !== tab.model.getValue()) {
        tab.saved = content;
        tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
      }
      tab.dirty = false;
    } else {
      tab.b64 = await api.readBase64(p);
      if (state.pixel && state.pixel.tabPath === p) state.pixel.load(tab.b64);
    }
  } catch {
    closeTab(p, true); // fichier supprimé
  }
  renderTabs();
}

async function saveTab(tab) {
  if (tab.kind === 'image') {
    if (state.pixel && state.pixel.tabPath === tab.path) await state.pixel.save();
    return;
  }
  const v = tab.model.getValue();
  await api.writeFile(tab.path, v);
  tab.saved = v;
  tab.dirty = false;
  renderTabs();
}

async function saveActive() {
  const tab = state.tabs.find((t) => t.path === state.active);
  if (!tab) return;
  try {
    await saveTab(tab);
    if (tab.kind === 'text') toast('Enregistré ✔', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function saveAll() {
  for (const t of state.tabs) {
    if (t.dirty) await saveTab(t);
    if (t.kind === 'image' && state.pixel && state.pixel.tabPath === t.path && state.pixel.dirty) await state.pixel.save();
  }
}

// ====================== Générateurs ======================
async function addItemDialog() {
  const html = `
    <label>Nom de l'item (en français)<input id="aiName" placeholder="Ex : Rubis"></label>
    <label>Nom en anglais (facultatif)<input id="aiNameEn" placeholder="Ex : Ruby"></label>
    <label>Type
      <select id="aiKind">
        <option value="simple">💎 Simple (gemme, lingot, objet…)</option>
        <option value="food">🍎 Nourriture</option>
        <option value="sword">⚔️ Épée</option>
        <option value="pickaxe">⛏️ Pioche</option>
        <option value="axe">🪓 Hache</option>
        <option value="shovel">🥄 Pelle</option>
      </select>
    </label>
    <div class="opt opt-food hidden">
      <label>Faim rendue (1-20) <input id="aiNut" type="number" min="1" max="20" value="4"></label>
      <label>Saturation (0-2) <input id="aiSat" type="number" min="0" max="2" step="0.1" value="0.6"></label>
    </div>
    <div class="opt opt-tool hidden">
      <label>Matériau
        <select id="aiTier">
          <option value="WOOD">Bois</option><option value="STONE">Pierre</option><option value="IRON" selected>Fer</option>
          <option value="GOLD">Or</option><option value="DIAMOND">Diamant</option><option value="NETHERITE">Netherite</option>
        </select>
      </label>
    </div>
    <div class="opt opt-sword hidden"><label>Dégâts en plus <input id="aiDmg" type="number" min="0" max="50" value="3"></label></div>
    <div class="opt opt-stack"><label>Taille max d'une pile (1-99) <input id="aiStack" type="number" min="1" max="99" value="64"></label></div>
    <div class="form-error"></div>`;
  const r = await modal('➕ Ajouter un item', html, {
    okText: 'Ajouter',
    onOpen: (b) => {
      const upd = () => {
        const k = $('#aiKind', b).value;
        const tool = ['sword', 'pickaxe', 'axe', 'shovel'].includes(k);
        $('.opt-food', b).classList.toggle('hidden', k !== 'food');
        $('.opt-tool', b).classList.toggle('hidden', !tool);
        $('.opt-sword', b).classList.toggle('hidden', k !== 'sword');
        $('.opt-stack', b).classList.toggle('hidden', tool);
      };
      $('#aiKind', b).onchange = upd;
    },
    collect: (b) => {
      const name = $('#aiName', b).value.trim();
      if (!name) throw new Error('Donne un nom à ton item.');
      return api.addItem({
        name, nameFr: name, nameEn: $('#aiNameEn', b).value.trim() || name,
        kind: $('#aiKind', b).value,
        nutrition: +$('#aiNut', b).value, saturation: +$('#aiSat', b).value,
        tier: $('#aiTier', b).value, damage: +$('#aiDmg', b).value, stack: +$('#aiStack', b).value,
      });
    },
  });
  if (r) afterGenerate(r, 'item');
}

async function addBlockDialog() {
  const html = `
    <label>Nom du bloc (en français)<input id="abName" placeholder="Ex : Bloc de rubis"></label>
    <label>Nom en anglais (facultatif)<input id="abNameEn" placeholder="Ex : Ruby Block"></label>
    <label>Dureté : <b id="abHv">3</b> <small class="muted">(terre 0.5, pierre 1.5, fer 5, obsidienne 50)</small>
      <input id="abHard" type="range" min="0.5" max="50" step="0.5" value="3"></label>
    <label>Lumière émise : <b id="abLv">0</b> <small class="muted">(torche 14, glowstone 15)</small>
      <input id="abLight" type="range" min="0" max="15" value="0"></label>
    <label>Son
      <select id="abSound">
        <option value="pierre">Pierre</option><option value="metal">Métal</option><option value="bois">Bois</option>
        <option value="verre">Verre</option><option value="herbe">Herbe</option><option value="laine">Laine</option><option value="sable">Sable</option>
      </select>
    </label>
    <div class="form-error"></div>`;
  const r = await modal('➕ Ajouter un bloc', html, {
    okText: 'Ajouter',
    onOpen: (b) => {
      $('#abHard', b).oninput = (e) => ($('#abHv', b).textContent = e.target.value);
      $('#abLight', b).oninput = (e) => ($('#abLv', b).textContent = e.target.value);
    },
    collect: (b) => {
      const name = $('#abName', b).value.trim();
      if (!name) throw new Error('Donne un nom à ton bloc.');
      return api.addBlock({
        name, nameFr: name, nameEn: $('#abNameEn', b).value.trim() || name,
        hardness: +$('#abHard', b).value, light: +$('#abLight', b).value,
        sound: $('#abSound', b).value,
      });
    },
  });
  if (r) afterGenerate(r, 'bloc');
}

const VANILLA = ['stick', 'iron_ingot', 'gold_ingot', 'diamond', 'emerald', 'redstone', 'coal', 'cobblestone', 'stone', 'oak_planks', 'string', 'leather', 'apple', 'sugar', 'wheat', 'glass', 'obsidian', 'netherite_ingot', 'blaze_powder', 'ender_pearl', 'copper_ingot', 'lapis_lazuli', 'quartz', 'bone', 'slime_ball', 'feather', 'gunpowder', 'amethyst_shard'];

async function addRecipeDialog() {
  let ids = [];
  try { ids = await api.modIds(); } catch { /* ignore */ }
  const opts = [...ids.map((i) => `<option value="${esc(i)}">⭐ ${esc(i)} (ton add-on)</option>`), ...VANILLA.map((v) => `<option value="${v}">${v}</option>`)].join('');
  const cells = Array.from({ length: 9 }, (_, i) => `<input class="cell" list="rcList" data-i="${i}" placeholder="vide">`).join('');
  const html = `
    <datalist id="rcList">${opts}</datalist>
    <p class="muted">Remplis la grille de l'établi. Tape un nom (ex : <code>diamond</code>, <code>stick</code>) ou choisis dans la liste.</p>
    <div class="craft">
      <div class="craft-grid">${cells}</div>
      <div class="craft-arrow">➜</div>
      <div class="craft-result">
        <input id="rcResult" list="rcList" placeholder="résultat" value="${esc(ids[0] || '')}">
        <label>Quantité <input id="rcCount" type="number" min="1" max="64" value="1"></label>
      </div>
    </div>
    <label class="check"><input type="checkbox" id="rcShapeless"> Peu importe la position des ingrédients</label>
    <div class="form-error"></div>`;
  const r = await modal('🧩 Ajouter une recette', html, {
    okText: 'Créer la recette',
    collect: (b) => api.addRecipe({
      grid: $$('.cell', b).map((c) => c.value.trim()),
      result: $('#rcResult', b).value.trim(),
      count: +$('#rcCount', b).value,
      shapeless: $('#rcShapeless', b).checked,
    }),
  });
  if (r) {
    toast('Recette créée ✔', 'ok');
    await refreshTree();
    openFile(r.file);
  }
}

async function afterGenerate(r, what) {
  toast(`Ton ${what} « ${r.id} » est ajouté ! Dessine maintenant sa texture 🎨`, 'ok');
  await refreshTree();
  // Recharge les fichiers ouverts (atlas, traductions…)
  for (const t of state.tabs) if (t.kind === 'text') await reloadTab(t.path);
  revealInTree(r.texture);
  openFile(r.texture);
}

function revealInTree(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
  renderTree();
}

// ====================== Vérification / Test / Export ======================
const consoleEl = () => $('#console');
function openConsole() {
  $('#consoleWrap').classList.remove('collapsed');
  $('#btnConsoleToggle').textContent = '▾ Console';
}
function appendConsole(s) {
  const c = consoleEl();
  const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
  c.textContent = (c.textContent + s).slice(-400000);
  if (atBottom) c.scrollTop = c.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  ['#btnCheck', '#btnRun', '#btnExport'].forEach((id) => ($(id).disabled = busy));
}

function showReport({ ok, text }) {
  openConsole();
  appendConsole(`\n━━━━━━━━ ${new Date().toLocaleTimeString()} ━━━━━━━━\n${text}\n`);
  const st = $('#consoleStatus');
  st.textContent = ok ? '✔ Aucun problème bloquant' : '✖ Erreurs trouvées — clique sur « Demander à l\'IA de corriger »';
  st.className = 'console-status ' + (ok ? 'ok' : 'err');
  $('#btnFixWithAi').classList.toggle('hidden', ok);
}
api.onCheckReport(showReport);

async function doCheck() {
  if (state.busy) return;
  setBusy(true);
  try {
    await saveAll();
    const r = await api.check();
    toast(r.ok ? 'Aucune erreur ✔' : `${r.errors.length} erreur(s) trouvée(s)`, r.ok ? 'ok' : 'error');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function doTest() {
  if (state.busy) return;
  setBusy(true);
  try {
    await saveAll();
    const r = await api.test();
    toast('Add-on copié dans Minecraft ✔ Ouvre ton monde !', 'ok');
    if (r.first) {
      await modal('▶ Première fois ? Voici comment faire', `
        <ol class="steps">
          <li>Dans Minecraft, clique sur <b>Jouer</b> puis <b>Créer un monde</b> (ou modifie un monde existant ✏️).</li>
          <li>Va dans <b>Packs de comportement</b> → onglet <b>Disponibles</b> → active <b>${esc(state.project.meta.modName)} (comportement)</b>.</li>
          <li>Le pack de ressources s'active tout seul avec. Conseil : mets le monde en <b>Créatif</b>.</li>
          <li>Ouvre le monde : tes items sont dans l'inventaire créatif (recherche leur nom).</li>
        </ol>
        <p class="muted">Ensuite, après chaque modification : reclique sur ▶ Tester, puis quitte et rouvre ton monde.</p>`, { okText: 'Compris !', cancelText: '' });
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function doExport() {
  if (state.busy) return;
  setBusy(true);
  try {
    await saveAll();
    const r = await api.exportAddon();
    if (!r) return;
    const ok = await modal('📦 Add-on exporté !', `
      <p>Ton fichier est prêt :</p><p><code>${esc(r.file)}</code></p>
      <p class="muted">Double-clique dessus (sur un PC avec Minecraft Bedrock) pour l'installer. Tu peux aussi l'envoyer à tes amis !</p>`,
    { okText: 'Installer dans Minecraft maintenant', cancelText: 'Fermer' });
    if (ok) await api.openAddonFile(r.file);
    else api.showFile(r.file);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(false);
  }
}

function errorsForAi() {
  const lines = consoleEl().textContent.split('\n');
  const start = lines.map((l) => l.startsWith('━━━━')).lastIndexOf(true);
  return lines.slice(Math.max(0, start + 1)).join('\n').trim();
}

// ====================== Assistant IA ======================
let currentBot = null;
let renderPending = false;

function addMsg(kind, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.innerHTML = html;
  $('#aiLog').appendChild(d);
  $('#aiLog').scrollTop = $('#aiLog').scrollHeight;
  return d;
}

function renderBot() {
  renderPending = false;
  if (!currentBot) return;
  const log = $('#aiLog');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
  currentBot.el.innerHTML = currentBot.segments.map((s) => (s.type === 'tool' ? `<div class="tool-chip">${esc(s.label)}</div>` : renderMarkdown(s.text))).join('')
    + (currentBot.thinking ? '<div class="typing"><span></span><span></span><span></span></div>' : '');
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function scheduleRender() {
  if (!renderPending) { renderPending = true; requestAnimationFrame(renderBot); }
}

api.onAiText((d) => {
  if (!currentBot) return;
  const segs = currentBot.segments;
  if (!segs.length || segs[segs.length - 1].type !== 'text') segs.push({ type: 'text', text: '' });
  segs[segs.length - 1].text += d;
  scheduleRender();
});
api.onAiTool((label) => {
  if (!currentBot) return;
  currentBot.segments.push({ type: 'tool', label });
  scheduleRender();
});
api.onAiStatus((s) => toast(s));
let fileChangeTimer;
api.onAiFileChanged((rel) => {
  clearTimeout(fileChangeTimer);
  fileChangeTimer = setTimeout(async () => {
    await refreshTree();
    for (const t of state.tabs) await reloadTab(t.path);
    if (rel && !state.tabs.find((t) => t.path === rel) && !rel.endsWith('.png')) openFile(rel);
  }, 150);
});

async function sendAi(text) {
  text = (text || '').trim();
  if (!text || state.aiBusy) return;
  if (!state.info || !state.info.hasKey) {
    state.info = await api.info();
    if (!state.info.hasKey) {
      toast('Ajoute ta clé API Claude dans les réglages pour utiliser l\'IA.', 'warn');
      openSettings();
      return;
    }
  }
  try { await saveAll(); } catch (e) { toast(e.message, 'error'); }
  addMsg('user', esc(text).replace(/\n/g, '<br>'));
  const el = addMsg('bot', '');
  currentBot = { el, segments: [], thinking: true };
  renderBot();
  state.aiBusy = true;
  $('#btnAiSend').disabled = true;
  $('#btnAiStop').classList.remove('hidden');
  $('#btnAiUndo').classList.add('hidden');
  try {
    const ctx = $('#aiCtx').checked && state.active ? { openFile: state.active } : null;
    const r = await api.aiSend(text, ctx);
    if (r && r.changed && r.changed.length) $('#btnAiUndo').classList.remove('hidden');
  } catch (e) {
    currentBot.segments.push({ type: 'text', text: '\n\n⚠️ ' + e.message });
  } finally {
    currentBot.thinking = false;
    renderBot();
    currentBot = null;
    state.aiBusy = false;
    $('#btnAiSend').disabled = false;
    $('#btnAiStop').classList.add('hidden');
  }
}

// Boutons sur les blocs de code de l'IA
$('#aiLog').addEventListener('click', (e) => {
  const block = e.target.closest('.codeblock');
  if (block) {
    const code = $('code', block).textContent;
    if (e.target.classList.contains('copy')) {
      navigator.clipboard.writeText(code);
      toast('Copié ✔', 'ok');
    } else if (e.target.classList.contains('insert')) {
      const tab = state.tabs.find((t) => t.path === state.active);
      if (!tab || tab.kind !== 'text') return toast('Ouvre d\'abord un fichier texte.', 'warn');
      const sel = state.editor.getSelection();
      state.editor.executeEdits('ai', [{ range: sel, text: code, forceMoveMarkers: true }]);
      state.editor.focus();
      toast('Code inséré. N\'oublie pas d\'enregistrer 💾', 'ok');
    }
    return;
  }
  const li = e.target.closest('.suggest li');
  if (li) { $('#aiInput').value = li.textContent.replace(/[«»]/g, '').trim(); $('#aiInput').focus(); }
});

// ====================== Réglages ======================
async function openSettings() {
  const info = await api.info();
  const html = `
    <h3>🤖 Assistant IA (Claude)</h3>
    <label>Clé API Anthropic ${info.hasKey ? '<span class="pill ok">enregistrée</span>' : ''}
      <input id="stKey" type="password" placeholder="${info.hasKey ? '•••••••• (laisser vide pour garder)' : 'sk-ant-…'}">
    </label>
    <p class="muted">Pas de clé ? Crée-la gratuitement sur <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Elle reste sur ton PC (chiffrée).</p>
    <label>Modèle
      <select id="stModel">${info.models.map((m) => `<option value="${m.id}" ${m.id === info.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
    </label>
    ${info.hasKey ? '<label class="check"><input type="checkbox" id="stDelKey"> Supprimer la clé enregistrée</label>' : ''}
    <h3>🎮 Minecraft Bedrock</h3>
    <label>Dossier com.mojang (facultatif, si Minecraft n'est pas détecté)
      <div class="row"><input id="stMc" value="${esc(info.comMojang)}" placeholder="Détecté automatiquement"><button type="button" id="stMcPick">Parcourir…</button></div>
    </label>
    <div class="form-error"></div>`;
  const r = await modal('⚙ Réglages', html, {
    okText: 'Enregistrer',
    onOpen: (b) => {
      $('#stMcPick', b).onclick = async () => { const d = await api.pickFolder('Dossier com.mojang de Minecraft'); if (d) $('#stMc', b).value = d; };
    },
    collect: (b) => {
      const s = { model: $('#stModel', b).value, comMojang: $('#stMc', b).value };
      const k = $('#stKey', b).value.trim();
      if (k) s.apiKey = k;
      if ($('#stDelKey', b) && $('#stDelKey', b).checked) s.apiKey = '';
      return api.saveSettings(s);
    },
  });
  if (r) {
    toast('Réglages enregistrés ✔', 'ok');
    state.info = await api.info();
    if (!$('#home').classList.contains('hidden')) refreshHome();
    else checkMinecraft();
  }
}

// ====================== Liaisons ======================
function bind() {
  $('#btnNew').onclick = newModWizard;
  $('#btnOpen').onclick = openProjectDialog;
  $('#btnSettingsHome').onclick = openSettings;
  $('#btnSettings').onclick = openSettings;
  $('#btnHome').onclick = goHome;
  $('#btnSave').onclick = saveActive;
  $('#btnAddItem').onclick = addItemDialog;
  $('#btnAddBlock').onclick = addBlockDialog;
  $('#btnAddRecipe').onclick = addRecipeDialog;
  $('#btnCheck').onclick = doCheck;
  $('#btnRun').onclick = doTest;
  $('#btnExport').onclick = doExport;
  $('#btnRefresh').onclick = refreshTree;
  $('#btnConsoleToggle').onclick = () => {
    const w = $('#consoleWrap');
    w.classList.toggle('collapsed');
    $('#btnConsoleToggle').textContent = (w.classList.contains('collapsed') ? '▸' : '▾') + ' Console';
  };
  $('#btnClearConsole').onclick = () => { consoleEl().textContent = ''; $('#consoleStatus').textContent = ''; };
  $('#btnFixWithAi').onclick = () => sendAi(`La vérification de mon add-on a trouvé des problèmes :\n\n${errorsForAi()}\n\nExplique-moi simplement le problème et corrige-le.`);

  $$('#welcomePane .card').forEach((c) => (c.onclick = () => {
    const a = c.dataset.act;
    if (a === 'item') addItemDialog();
    else if (a === 'block') addBlockDialog();
    else if (a === 'recipe') addRecipeDialog();
    else if (a === 'run') doTest();
    else if (a === 'ai') $('#aiInput').focus();
  }));

  $('#aiForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#aiInput').value;
    $('#aiInput').value = '';
    sendAi(v);
  };
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm').requestSubmit(); }
  });
  $('#btnAiStop').onclick = () => api.aiStop();
  $('#btnAiReset').onclick = async () => {
    await api.aiReset();
    $('#aiLog').querySelectorAll('.msg:not(.intro)').forEach((m) => m.remove());
    $('#btnAiUndo').classList.add('hidden');
    toast('Nouvelle conversation');
  };
  $('#btnAiUndo').onclick = async () => {
    try {
      const restored = await api.aiUndo();
      $('#btnAiUndo').classList.add('hidden');
      await refreshTree();
      for (const t of [...state.tabs]) await reloadTab(t.path);
      toast(`${restored.length} fichier(s) restauré(s) ↩`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
  });
}

bind();
refreshHome();
