// Importe un .mcaddon / .mcpack (ou un dossier de pack) en projet ModCraft Studio.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip } = require('./zip');
const { parseJsonLoose, toModId } = require('./template');

const SUPPORTED = /\.(mcaddon|mcpack|zip)$/i;

/** Décompresse récursivement : les .mcpack contenus dans un .mcaddon sont aussi ouverts. */
function expand(files, prefix = '', depth = 0) {
  const out = {};
  for (const [name, data] of Object.entries(files)) {
    if (depth < 3 && /\.(mcpack|zip)$/i.test(name)) {
      const sub = expand(readZip(data), prefix + name.replace(/\.(mcpack|zip)$/i, '') + '/', depth + 1);
      Object.assign(out, sub);
    } else {
      out[prefix + name] = data;
    }
  }
  return out;
}

/** Repère les packs (dossiers qui contiennent un manifest.json) et leur type. */
function findPacks(files) {
  const roots = Object.keys(files)
    .filter((n) => /(^|\/)manifest\.json$/i.test(n) && !/(^|\/)subpacks\//i.test(n))
    .map((n) => n.slice(0, n.length - 'manifest.json'.length))
    .sort((a, b) => a.length - b.length);
  const packs = [];
  for (const root of roots) {
    if (packs.some((p) => root !== p.root && root.startsWith(p.root))) continue; // pack imbriqué
    let manifest;
    try {
      manifest = parseJsonLoose(files[root + 'manifest.json'].toString('utf8').replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`Le manifest.json de "${root || 'l\'archive'}" est invalide : ${e.message}`);
    }
    const types = (manifest.modules || []).map((m) => m.type);
    let kind = null;
    if (types.includes('resources')) kind = 'RP';
    else if (types.some((t) => t === 'data' || t === 'script' || t === 'javascript')) kind = 'BP';
    else if (types.includes('world_template')) throw new Error('C\'est un modèle de monde (.mctemplate), pas un add-on : il ne peut pas être modifié ici.');
    else if (types.includes('skin_pack')) throw new Error('C\'est un pack de skins, pas un add-on : il ne peut pas être modifié ici.');
    if (kind) packs.push({ root, kind, manifest });
  }
  return packs;
}

function cleanName(n) {
  return String(n || '')
    .replace(/§./g, '')
    .replace(/\s*[([]?\s*(BP|RP|behaviou?r(s)?( pack)?|resources?( pack)?|comportement|ressources)\s*[)\]]?\s*$/i, '')
    .trim();
}

/** Devine l'espace de noms (ex : "super_rubis") à partir des identifiants du pack de comportement. */
function guessNamespace(files, bpRoot) {
  const counts = {};
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith(bpRoot) || !/\/(items|blocks|entities)\/.*\.json$/i.test('/' + name.slice(bpRoot.length))) continue;
    try {
      const j = parseJsonLoose(data.toString('utf8').replace(/^﻿/, ''));
      const node = j['minecraft:item'] || j['minecraft:block'] || j['minecraft:entity'];
      const id = node && node.description && node.description.identifier;
      if (id && id.includes(':') && !id.startsWith('minecraft:')) {
        const ns = id.split(':')[0];
        counts[ns] = (counts[ns] || 0) + 1;
      }
    } catch { /* fichier ignoré */ }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

function writeTree(files, srcRoot, destDir) {
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith(srcRoot)) continue;
    const rel = name.slice(srcRoot.length);
    if (!rel) continue;
    const target = path.resolve(destDir, rel);
    const r = path.relative(destDir, target);
    if (r.startsWith('..') || path.isAbsolute(r)) continue; // protège contre les chemins "../"
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

function emptyPack(kind, name, otherManifest) {
  const files = {};
  const dep = otherManifest ? [{ uuid: otherManifest.header.uuid, version: otherManifest.header.version || [1, 0, 0] }] : [];
  const header = { name: `${name} (${kind === 'RP' ? 'ressources' : 'comportement'})`, description: 'Créé par ModCraft Studio', uuid: crypto.randomUUID(), version: [1, 0, 0], min_engine_version: [1, 21, 100] };
  const module = kind === 'RP' ? { type: 'resources', uuid: crypto.randomUUID(), version: [1, 0, 0] } : { type: 'data', uuid: crypto.randomUUID(), version: [1, 0, 0] };
  files['manifest.json'] = Buffer.from(JSON.stringify({ format_version: 2, header, modules: [module], dependencies: dep }, null, 2) + '\n');
  return files;
}

/**
 * Importe `file` (.mcaddon/.mcpack) ou un dossier dans `parentDir`.
 * Renvoie { root, warnings }.
 */
function importAddon(file, parentDir) {
  let files;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    files = {};
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, rel + e.name + '/');
        else files[rel + e.name] = fs.readFileSync(abs);
      }
    };
    walk(file, '');
  } else {
    if (!SUPPORTED.test(file)) throw new Error('Choisis un fichier .mcaddon ou .mcpack.');
    if (/\.mcworld$/i.test(file)) throw new Error('Les mondes (.mcworld) ne sont pas pris en charge.');
    files = expand(readZip(fs.readFileSync(file)));
  }

  const packs = findPacks(files);
  if (!packs.length) throw new Error('Aucun pack Minecraft trouvé dans ce fichier (pas de manifest.json).');
  const warnings = [];
  const bp = packs.find((p) => p.kind === 'BP');
  const rp = packs.find((p) => p.kind === 'RP');
  if (packs.filter((p) => p.kind === 'BP').length > 1 || packs.filter((p) => p.kind === 'RP').length > 1) {
    warnings.push('Ce fichier contient plusieurs packs du même type : seul le premier de chaque type a été importé.');
  }

  const baseName = cleanName((bp || rp).manifest.header && (bp || rp).manifest.header.name) || path.basename(file).replace(/\.[^.]+$/, '');
  const modId = (bp && guessNamespace(files, bp.root)) || toModId(baseName);
  let root = path.join(parentDir, toModId(baseName));
  for (let i = 2; fs.existsSync(root); i++) root = path.join(parentDir, `${toModId(baseName)}_${i}`);
  fs.mkdirSync(root, { recursive: true });

  if (bp) writeTree(files, bp.root, path.join(root, 'BP'));
  else {
    writeTree(emptyPack('BP', baseName, rp.manifest), '', path.join(root, 'BP'));
    warnings.push('Ce fichier n\'avait qu\'un pack de ressources : un pack de comportement vide a été ajouté (pour créer des items et des blocs).');
  }
  if (rp) writeTree(files, rp.root, path.join(root, 'RP'));
  else {
    writeTree(emptyPack('RP', baseName, bp.manifest), '', path.join(root, 'RP'));
    warnings.push('Ce fichier n\'avait qu\'un pack de comportement : un pack de ressources vide a été ajouté (pour les textures et les noms).');
  }

  const minEngine = ((bp || rp).manifest.header.min_engine_version || []).join('.');
  fs.writeFileSync(path.join(root, 'MODCRAFT.json'), JSON.stringify({
    tool: 'ModCraft Studio', edition: 'bedrock', modId, modName: baseName, minEngine, importedFrom: path.basename(file),
  }, null, 2) + '\n');
  return { root, warnings };
}

module.exports = { importAddon, findPacks, expand, SUPPORTED };
