// Installation dans Minecraft Bedrock : packs de développement et export .mcaddon.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createZip, folderEntries } = require('./zip');

/** Dossiers com.mojang possibles (version récente puis ancienne version Microsoft Store). */
function comMojangCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(appData, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang'),
    path.join(local, 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang'),
    path.join(appData, 'Minecraft Bedrock Preview', 'Users', 'Shared', 'games', 'com.mojang'),
  ];
}

function findComMojang(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  return comMojangCandidates().find((p) => fs.existsSync(p)) || null;
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

/** Copie BP et RP dans les dossiers "development" de Minecraft (rechargés à chaque ouverture du monde). */
function deployDev(root, meta, custom) {
  const base = findComMojang(custom);
  if (!base) {
    throw new Error('Minecraft Bedrock est introuvable sur ce PC. Installe-le et lance-le une fois, ou choisis le dossier com.mojang dans ⚙ Réglages. Tu peux aussi utiliser "📦 Exporter".');
  }
  const bp = path.join(base, 'development_behavior_packs', `${meta.modId}_BP`);
  const rp = path.join(base, 'development_resource_packs', `${meta.modId}_RP`);
  copyDir(path.join(root, 'BP'), bp);
  copyDir(path.join(root, 'RP'), rp);
  return { base, bp, rp };
}

/** Crée le fichier .mcaddon (double-clic = installation dans Minecraft). */
function exportMcaddon(root, meta, outFile) {
  const entries = [...folderEntries(path.join(root, 'BP'), `${meta.modId}_BP`), ...folderEntries(path.join(root, 'RP'), `${meta.modId}_RP`)];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, createZip(entries));
  return outFile;
}

module.exports = { comMojangCandidates, findComMojang, deployDev, exportMcaddon };
