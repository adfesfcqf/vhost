// Génère un add-on Minecraft Bedrock (pack de comportement BP + pack de ressources RP).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { placeholderTexture } = require('./png');

const MIN_ENGINE = [1, 21, 100];
const SCRIPT_API = '2.0.0'; // @minecraft/server (stable)

function toModId(name) {
  const id = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = /^[a-z]/.test(id) ? id : 'mod_' + id;
  return safe.slice(0, 40) || 'mon_mod';
}

function json(o) {
  return JSON.stringify(o, null, 2) + '\n';
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function projectFiles({ modId, modName, author, description }) {
  const ids = {
    bp: crypto.randomUUID(), bpData: crypto.randomUUID(), bpScript: crypto.randomUUID(),
    rp: crypto.randomUUID(), rpRes: crypto.randomUUID(),
  };
  const desc = description || `${modName}, créé avec ModCraft Studio.`;
  const files = {};

  files['BP/manifest.json'] = json({
    format_version: 2,
    header: { name: `${modName} (comportement)`, description: desc, uuid: ids.bp, version: [1, 0, 0], min_engine_version: MIN_ENGINE },
    modules: [
      { description: 'Comportement', type: 'data', uuid: ids.bpData, version: [1, 0, 0] },
      { description: 'Scripts', language: 'javascript', type: 'script', uuid: ids.bpScript, version: [1, 0, 0], entry: 'scripts/main.js' },
    ],
    dependencies: [
      { module_name: '@minecraft/server', version: SCRIPT_API },
      { uuid: ids.rp, version: [1, 0, 0] },
    ],
    metadata: { authors: [author || 'Moi'], generated_with: { modcraft_studio: ['2.0.0'] } },
  });

  files['RP/manifest.json'] = json({
    format_version: 2,
    header: { name: `${modName} (ressources)`, description: desc, uuid: ids.rp, version: [1, 0, 0], min_engine_version: MIN_ENGINE },
    modules: [{ description: 'Ressources', type: 'resources', uuid: ids.rpRes, version: [1, 0, 0] }],
    dependencies: [{ uuid: ids.bp, version: [1, 0, 0] }],
    metadata: { authors: [author || 'Moi'] },
  });

  files['BP/scripts/main.js'] = `// Scripts de ton add-on (JavaScript, API @minecraft/server ${SCRIPT_API}).
// Demande à l'assistant IA d'ajouter des comportements ici !
import { world } from "@minecraft/server";

world.afterEvents.playerSpawn.subscribe((event) => {
  if (event.initialSpawn) {
    event.player.sendMessage("§a${modName.replace(/["\\]/g, '')} est chargé !");
  }
});
`;

  files['RP/textures/item_texture.json'] = json({ resource_pack_name: modId, texture_name: 'atlas.items', texture_data: {} });
  files['RP/textures/terrain_texture.json'] = json({ resource_pack_name: modId, texture_name: 'atlas.terrain', padding: 8, num_mip_levels: 4, texture_data: {} });
  files['RP/blocks.json'] = json({ format_version: '1.21.40' });
  files['RP/texts/languages.json'] = json(['fr_FR', 'en_US']);
  files['RP/texts/fr_FR.lang'] = `pack.name=${modName}\npack.description=${desc}\n`;
  files['RP/texts/en_US.lang'] = `pack.name=${modName}\npack.description=${desc}\n`;
  files['BP/pack_icon.png'] = placeholderTexture(modId, 'block');
  files['RP/pack_icon.png'] = placeholderTexture(modId, 'block');

  files['MODCRAFT.json'] = json({ tool: 'ModCraft Studio', edition: 'bedrock', modId, modName, minEngine: MIN_ENGINE.join('.') });
  return files;
}

async function createProject(opts) {
  const modName = (opts.modName || '').trim() || 'Mon Mod';
  const modId = toModId(opts.modId || modName);
  const root = path.join(opts.parentDir, modId);
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    throw new Error(`Le dossier "${root}" existe déjà et n'est pas vide.`);
  }
  const files = projectFiles({ modId, modName, author: opts.author, description: opts.description });
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return { root, meta: JSON.parse(files['MODCRAFT.json']), warnings: [] };
}

/** Lit un JSON Bedrock (les commentaires // et /* *\/ sont autorisés). */
function parseJsonLoose(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] || ''; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readMeta(root) {
  const p = path.join(root, 'MODCRAFT.json');
  if (fs.existsSync(p)) {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m.edition === 'bedrock') return m;
  }
  // Add-on existant non créé par l'appli : on devine depuis le manifest
  const bp = path.join(root, 'BP/manifest.json');
  if (!fs.existsSync(bp)) return null;
  const man = parseJsonLoose(fs.readFileSync(bp, 'utf8'));
  let modId = null;
  const itemsDir = path.join(root, 'BP/items');
  if (fs.existsSync(itemsDir)) {
    for (const f of fs.readdirSync(itemsDir)) {
      try {
        const j = parseJsonLoose(fs.readFileSync(path.join(itemsDir, f), 'utf8'));
        const id = j['minecraft:item'].description.identifier;
        modId = id.split(':')[0];
        break;
      } catch { /* suivant */ }
    }
  }
  const name = String(man.header.name || 'Add-on').replace(/\s*\(comportement\)$/, '');
  return { tool: 'external', edition: 'bedrock', modId: modId || toModId(name), modName: name, minEngine: (man.header.min_engine_version || []).join('.') };
}

module.exports = { createProject, readMeta, toModId, parseJsonLoose, MIN_ENGINE, SCRIPT_API };
