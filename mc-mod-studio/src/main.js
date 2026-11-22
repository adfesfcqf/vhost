// ModCraft Studio — processus principal Electron.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const files = require('./lib/files');
const template = require('./lib/template');
const gen = require('./lib/generators');
const { detectJava, GradleRunner, minecraftModsDir, findBuiltJar } = require('./lib/gradle');
const { Assistant, MODELS, DEFAULT_MODEL } = require('./lib/agent');

let win;
let project = null; // { root, meta }
let assistant = null;
const gradle = new GradleRunner();

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
  // Les liens externes s'ouvrent dans le navigateur
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
  if (!project) throw new Error('Aucun mod ouvert.');
  return project;
}

function openProject(root) {
  const meta = template.readMeta(root);
  if (!meta) throw new Error('Ce dossier ne contient pas de mod Fabric (fabric.mod.json introuvable).');
  project = { root, meta };
  assistant = null;
  addRecent(root, meta);
  return { root, meta, tree: files.tree(root) };
}

// Gestion d'erreurs uniforme pour l'IPC : { ok, data } ou { ok:false, error }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

async function runGradle(task) {
  const { root } = requireProject();
  const s = loadSettings();
  send('gradle:start', { task });
  return gradle.run(root, task, {
    javaHome: s.javaHome,
    onData: (d) => send('gradle:data', d),
    onExit: (code) => send('gradle:exit', { task, code }),
  });
}

function registerIpc() {
  handle('app:info', async () => {
    const s = loadSettings();
    return {
      version: app.getVersion(),
      hasKey: !!getApiKey(),
      model: s.model || DEFAULT_MODEL,
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
      javaHome: s.javaHome || '',
      recent: (s.recent || []).filter((r) => fs.existsSync(r.root)),
      defaultParent: path.join(app.getPath('documents'), 'ModCraft'),
      mcVersion: template.MC_VERSION,
    };
  });
  handle('app:java', async () => detectJava(loadSettings().javaHome));
  handle('app:saveSettings', async ({ apiKey, model, javaHome }) => {
    if (apiKey !== undefined) setApiKey(apiKey.trim());
    const s = loadSettings();
    if (model && MODELS[model]) s.model = model;
    if (javaHome !== undefined) s.javaHome = javaHome.trim();
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
    const r = await template.createProject({ ...opts, parentDir }, { log: (m) => send('project:log', m) });
    const opened = openProject(r.root);
    return { ...opened, warnings: r.warnings };
  });
  handle('project:open', async (root) => openProject(root));
  handle('project:tree', async () => files.tree(requireProject().root));
  handle('project:reveal', async (rel) => {
    const { root } = requireProject();
    shell.showItemInFolder(files.resolveInside(root, rel || '.'));
  });
  handle('project:repairGradle', async () => {
    await template.repairWrapper(requireProject().root);
    return true;
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
    const target = files.resolveInside(requireProject().root, rel);
    fs.copyFileSync(r.filePaths[0], target);
    return true;
  });

  handle('gen:item', async (opts) => {
    const { root, meta } = requireProject();
    const r = gen.addItem(root, meta, opts);
    return { id: r.id, texture: files.toRel(root, r.texture), javaFile: files.toRel(root, r.javaFile) };
  });
  handle('gen:block', async (opts) => {
    const { root, meta } = requireProject();
    const r = gen.addBlock(root, meta, opts);
    return { id: r.id, texture: files.toRel(root, r.texture), javaFile: files.toRel(root, r.javaFile) };
  });
  handle('gen:recipe', async (opts) => {
    const { root, meta } = requireProject();
    const r = gen.addRecipe(root, meta, opts);
    return { file: files.toRel(root, r.file) };
  });
  handle('gen:ids', async () => {
    const { root, meta } = requireProject();
    return gen.listModIds(root, meta);
  });

  handle('gradle:run', async (task) => {
    const r = await runGradle(task);
    return { code: r.code };
  });
  handle('gradle:stop', async () => { gradle.stop(); return true; });
  handle('gradle:install', async () => {
    const { root } = requireProject();
    const jar = findBuiltJar(root);
    if (!jar) throw new Error('Aucun .jar trouvé. Clique d\'abord sur "Compiler".');
    const dir = minecraftModsDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(jar));
    fs.copyFileSync(jar, dest);
    return { dest, dir };
  });
  handle('gradle:openJar', async () => {
    const jar = findBuiltJar(requireProject().root);
    if (!jar) throw new Error('Aucun .jar trouvé. Clique d\'abord sur "Compiler".');
    shell.showItemInFolder(jar);
    return true;
  });

  handle('ai:send', async (text, context) => {
    const proj = requireProject();
    const key = getApiKey();
    if (!key) throw new Error('Ajoute ta clé API Claude dans ⚙ Réglages pour utiliser l\'assistant.');
    if (!assistant || assistant.project.root !== proj.root) {
      assistant = new Assistant({
        apiKey: key,
        model: loadSettings().model,
        project: proj,
        runBuild: async () => {
          if (gradle.running) return { code: -1, output: 'Une autre tâche Gradle est déjà en cours.' };
          return runGradle('build');
        },
      });
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
  gradle.stop();
  if (process.platform !== 'darwin') app.quit();
});
