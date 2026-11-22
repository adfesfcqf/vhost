// Pont sécurisé entre l'interface et le processus principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const on = (channel, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('studio', {
  info: () => call('app:info'),
  minecraft: () => call('app:minecraft'),
  saveSettings: (s) => call('app:saveSettings', s),
  openExternal: (url) => call('app:openExternal', url),
  pickFolder: (title) => call('dialog:pickFolder', title),

  createProject: (opts) => call('project:create', opts),
  openProject: (root) => call('project:open', root),
  importAddon: (file) => call('project:import', file || null),
  pendingOpen: () => call('project:pendingOpen'),
  onOpenFile: (cb) => on('project:openFile', cb),
  pathForFile: (file) => webUtils.getPathForFile(file),
  tree: () => call('project:tree'),
  reveal: (rel) => call('project:reveal', rel),

  readFile: (rel) => call('file:read', rel),
  writeFile: (rel, content) => call('file:write', rel, content),
  readBase64: (rel) => call('file:readBase64', rel),
  writeBase64: (rel, b64) => call('file:writeBase64', rel, b64),
  deleteFile: (rel) => call('file:delete', rel),
  renameFile: (from, to) => call('file:rename', from, to),
  importImage: (rel) => call('file:importImage', rel),

  addItem: (o) => call('gen:item', o),
  addBlock: (o) => call('gen:block', o),
  addRecipe: (o) => call('gen:recipe', o),
  modIds: () => call('gen:ids'),

  check: () => call('mc:check'),
  test: () => call('mc:test'),
  exportAddon: () => call('mc:export'),
  openAddonFile: (f) => call('mc:openFile', f),
  showFile: (f) => call('mc:showFile', f),
  onCheckReport: (cb) => on('check:report', cb),

  aiSend: (text, ctx) => call('ai:send', text, ctx),
  aiStop: () => call('ai:stop'),
  aiReset: () => call('ai:reset'),
  aiUndo: () => call('ai:undo'),
  onAiText: (cb) => on('ai:text', cb),
  onAiTool: (cb) => on('ai:tool', cb),
  onAiStatus: (cb) => on('ai:status', cb),
  onAiFileChanged: (cb) => on('ai:fileChanged', cb),
});
