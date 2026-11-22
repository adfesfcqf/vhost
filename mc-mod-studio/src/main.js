// ModCraft Studio (Bedrock) — processus principal Electron.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const files = require('./lib/files');
const template = require('./lib/template');
const gen = require('./lib/generators');
const { checkAddon, formatReport } = require('./lib/check');
const mc = require('./lib/minecraft');
const { Assistant, MODELS, DEFAULT_MODEL } = require('./lib/agent');

let win;
let project = null; // { root, meta }
let assistant = null;

// ---------- Réglages ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { model: DEFAULT_MODEL, recent: [] };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}
function getApiKey() {
  const s = loadSettings();
  if (!s.apiKeyEnc) return process.env.ANTHROPIC_API_KEY || '';
  try {
    const buf = Buffer.from(s.apiKeyEnc, 'base64');
    return s.apiKeyPlain ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}
function setApiKey(key) {
  const s = loadSettings();
  if (!key) {
    delete s.apiKeyEnc;
    delete s.apiKeyPlain;
  } else if (safeStorage.isEncryptionAvailable()) {
    s.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
    delete s.apiKeyPlain;
  } else {
    s.apiKeyEnc = Buffer.from(key, 'utf8').toString('base64');
    s.apiKeyPlain = true;
  }
  saveSettings(s);
  assistant = null;
}
function addRecent(root, meta) {
  const s = loadSettings();
  s.recent = [{ root, name: meta.modName }, ...(s.recent || []).filter((r) => r.root !== root)].slice(0, 8);
  saveSettings(s);
}

// ---------- Fenêtre ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#1b1d23',
    title: 'ModCraft Studio',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function requireProject() {
  if (!project) throw new Error('Aucun add-on ouvert.');
  return project;
}

function openProject(root) {
  const meta = template.readMeta(root);
  if (!meta) throw new Error('Ce dossier ne contient pas d\'add-on Bedrock (BP/manifest.json introuvable).');
  project = { root, meta };
  assistant = null;
  addRecent(root, meta);
  return { root, meta, tree: files.tree(root) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function runCheck() {
  const { root, meta } = requireProject();
  const r = checkAddon(root, meta);
  const text = formatReport(r);
  send('check:report', { ok: r.ok, text });
  return { ...r, text };
}

function registerIpc() {
  handle('app:info', async () => {
    const s = loadSettings();
    return {
      version: app.getVersion(),
      hasKey: !!getApiKey(),
      model: s.model || DEFAULT_MODEL,
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
      comMojang: s.comMojang || '',
      recent: (s.recent || []).filter((r) => fs.existsSync(r.root)),
      defaultParent: path.join(app.getPath('documents'), 'ModCraft'),
      platform: process.platform,
    };
  });
  handle('app:minecraft', async () => {
    const found = mc.findComMojang(loadSettings().comMojang);
    return found
      ? { ok: true, path: found, message: 'Minecraft Bedrock détecté ✔' }
      : { ok: false, message: process.platform === 'win32' ? 'Minecraft Bedrock introuvable' : 'Minecraft Bedrock : Windows uniquement (export .mcaddon possible)' };
  });
  handle('app:saveSettings', async ({ apiKey, model, comMojang }) => {
    if (apiKey !== undefined) setApiKey(apiKey.trim());
    const s = loadSettings();
    if (model && MODELS[model]) s.model = model;
    if (comMojang !== undefined) s.comMojang = comMojang.trim();
    saveSettings(s);
    assistant = null;
    return true;
  });
  handle('app:openExternal', async (url) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  });
  handle('dialog:pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choisir un dossier', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('project:create', async (opts) => {
    const parentDir = opts.parentDir || path.join(app.getPath('documents'), 'ModCraft');
    fs.mkdirSync(parentDir, { recursive: true });
    const r = await template.createProject({ ...opts, parentDir });
    return { ...openProject(r.root), warnings: r.warnings };
  });
  handle('project:open', async (root) => openProject(root));
  handle('project:tree', async () => files.tree(requireProject().root));
  handle('project:reveal', async (rel) => {
    shell.showItemInFolder(files.resolveInside(requireProject().root, rel || '.'));
  });

  handle('file:read', async (rel) => files.readText(requireProject().root, rel));
  handle('file:write', async (rel, content) => { files.writeText(requireProject().root, rel, content); return true; });
  handle('file:readBase64', async (rel) => files.readBase64(requireProject().root, rel));
  handle('file:writeBase64', async (rel, b64) => { files.writeBase64(requireProject().root, rel, b64); return true; });
  handle('file:delete', async (rel) => { files.remove(requireProject().root, rel); return true; });
  handle('file:rename', async (from, to) => { files.rename(requireProject().root, from, to); return true; });
  handle('file:importImage', async (rel) => {
    const r = await dialog.showOpenDialog(win, { title: 'Importer une image PNG', filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['openFile'] });
    if (r.canceled) return false;
    fs.copyFileSync(r.filePaths[0], files.resolveInside(requireProject().root, rel));
    return true;
  });

  const genResult = (root, r) => ({ id: r.id, texture: files.toRel(root, r.texture), file: files.toRel(root, r.file) });
  handle('gen:item', async (opts) => { const { root, meta } = requireProject(); return genResult(root, gen.addItem(root, meta, opts)); });
  handle('gen:block', async (opts) => { const { root, meta } = requireProject(); return genResult(root, gen.addBlock(root, meta, opts)); });
  handle('gen:recipe', async (opts) => {
    const { root, meta } = requireProject();
    return { file: files.toRel(root, gen.addRecipe(root, meta, opts).file) };
  });
  handle('gen:ids', async () => { const { root, meta } = requireProject(); return gen.listModIds(root, meta); });

  handle('mc:check', async () => runCheck());
  handle('mc:test', async () => {
    const { root, meta } = requireProject();
    const r = checkAddon(root, meta);
    if (!r.ok) {
      runCheck();
      throw new Error('Ton add-on a des erreurs : corrige-les d\'abord (voir la console).');
    }
    const d = mc.deployDev(root, meta, loadSettings().comMojang);
    send('check:report', { ok: true, text: `✔ Packs copiés dans Minecraft :\n  ${d.bp}\n  ${d.rp}\nOuvre (ou recharge) ton monde pour voir les changements.` });
    try { await shell.openExternal('minecraft://'); } catch { /* Minecraft pas lancé automatiquement */ }
    const s = loadSettings();
    const first = !s.testedOnce;
    s.testedOnce = true;
    saveSettings(s);
    return { ...d, first };
  });
  handle('mc:export', async () => {
    const { root, meta } = requireProject();
    const r = checkAddon(root, meta);
    if (!r.ok) {
      runCheck();
      throw new Error('Ton add-on a des erreurs : corrige-les d\'abord (voir la console).');
    }
    const def = path.join(app.getPath('documents'), 'ModCraft', `${meta.modId}.mcaddon`);
    const res = await dialog.showSaveDialog(win, { title: 'Exporter l\'add-on', defaultPath: def, filters: [{ name: 'Add-on Minecraft', extensions: ['mcaddon'] }] });
    if (res.canceled || !res.filePath) return null;
    return { file: mc.exportMcaddon(root, meta, res.filePath) };
  });
  handle('mc:openFile', async (file) => {
    if (!/\.mcaddon$/i.test(file) || !fs.existsSync(file)) throw new Error('Fichier introuvable');
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return true;
  });
  handle('mc:showFile', async (file) => { shell.showItemInFolder(file); return true; });

  handle('ai:send', async (text, context) => {
    const proj = requireProject();
    const key = getApiKey();
    if (!key) throw new Error('Ajoute ta clé API Claude dans ⚙ Réglages pour utiliser l\'assistant.');
    if (!assistant || assistant.project.root !== proj.root) {
      assistant = new Assistant({ apiKey: key, model: loadSettings().model, project: proj, runCheck: async () => runCheck().text });
    }
    return assistant.send(text, context, {
      text: (d) => send('ai:text', d),
      tool: (label) => send('ai:tool', label),
      status: (s) => send('ai:status', s),
      fileChanged: (rel) => send('ai:fileChanged', rel),
    });
  });
  handle('ai:stop', async () => { if (assistant) assistant.stop(); return true; });
  handle('ai:reset', async () => { if (assistant) assistant.reset(); return true; });
  handle('ai:undo', async () => (assistant ? assistant.undoLastTurn() : []));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
