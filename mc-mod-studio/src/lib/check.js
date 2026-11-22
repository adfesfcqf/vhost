// Vérification de l'add-on (remplace la "compilation") : JSON valides, textures, traductions, manifests…
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseJsonLoose } = require('./template');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function readLang(file) {
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = l.indexOf('=');
    if (i > 0 && !l.startsWith('##')) keys.add(l.slice(0, i).trim());
  }
  return keys;
}

/** Renvoie { ok, errors: [], warnings: [] } — messages en français, avec le fichier concerné. */
function checkAddon(root, meta) {
  const errors = [];
  const warnings = [];
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const parsed = new Map();

  for (const f of [...walk(path.join(root, 'BP')), ...walk(path.join(root, 'RP'))]) {
    if (!f.endsWith('.json')) continue;
    try {
      parsed.set(rel(f), parseJsonLoose(fs.readFileSync(f, 'utf8')));
    } catch (e) {
      errors.push(`${rel(f)} : JSON invalide (${e.message})`);
    }
  }

  const bpMan = parsed.get('BP/manifest.json');
  const rpMan = parsed.get('RP/manifest.json');
  if (!bpMan) errors.push('BP/manifest.json est manquant ou invalide.');
  if (!rpMan) errors.push('RP/manifest.json est manquant ou invalide.');
  if (bpMan && rpMan) {
    const deps = (m) => (m.dependencies || []).map((d) => d.uuid).filter(Boolean);
    if (!deps(bpMan).includes(rpMan.header.uuid)) warnings.push('Le pack de comportement ne dépend pas du pack de ressources (manifest).');
    if (!deps(rpMan).includes(bpMan.header.uuid)) warnings.push('Le pack de ressources ne dépend pas du pack de comportement (manifest).');
    const uuids = [bpMan.header.uuid, rpMan.header.uuid, ...(bpMan.modules || []).map((m) => m.uuid), ...(rpMan.modules || []).map((m) => m.uuid)];
    if (new Set(uuids).size !== uuids.length) errors.push('Deux UUID identiques dans les manifests : chaque pack et module doit avoir un UUID unique.');
  }

  const itemAtlas = (parsed.get('RP/textures/item_texture.json') || {}).texture_data || {};
  const terrainAtlas = (parsed.get('RP/textures/terrain_texture.json') || {}).texture_data || {};
  const textureExists = (t) => ['.png', '.tga', '.jpg'].some((ext) => fs.existsSync(path.join(root, 'RP', t + ext)));
  for (const [k, v] of Object.entries({ ...itemAtlas, ...terrainAtlas })) {
    const t = typeof v.textures === 'string' ? v.textures : Array.isArray(v.textures) ? v.textures[0] : v.textures && v.textures.path;
    if (t && !textureExists(t)) errors.push(`Texture "${k}" : le fichier RP/${t}.png est introuvable.`);
  }
  const langFr = readLang(path.join(root, 'RP/texts/fr_FR.lang'));
  const langEn = readLang(path.join(root, 'RP/texts/en_US.lang'));
  const known = new Set();

  for (const [file, j] of parsed) {
    if (file.startsWith('BP/items/')) {
      const it = j['minecraft:item'];
      if (!it || !it.description || !it.description.identifier) { errors.push(`${file} : "minecraft:item.description.identifier" manquant.`); continue; }
      const id = it.description.identifier;
      known.add(id);
      if (!id.includes(':')) errors.push(`${file} : l'identifiant "${id}" doit avoir la forme "${meta.modId}:nom".`);
      const comp = it.components || {};
      const icon = comp['minecraft:icon'];
      const iconKey = typeof icon === 'string' ? icon : icon && icon.textures && icon.textures.default;
      if (!iconKey) warnings.push(`${file} : pas d'icône (minecraft:icon), l'item sera invisible dans l'inventaire.`);
      else if (!itemAtlas[iconKey]) errors.push(`${file} : l'icône "${iconKey}" n'existe pas dans RP/textures/item_texture.json.`);
      const dn = comp['minecraft:display_name'];
      const key = dn && dn.value;
      if (key && /^[\w.:-]+$/.test(key) && key.includes('.') && !langFr.has(key)) warnings.push(`${file} : traduction "${key}" absente de fr_FR.lang.`);
      if (!dn && !langEn.has(`item.${id}`) && !langEn.has(`item.${id}.name`)) warnings.push(`${file} : l'item n'a pas de nom (minecraft:display_name).`);
    }
    if (file.startsWith('BP/blocks/')) {
      const b = j['minecraft:block'];
      if (!b || !b.description || !b.description.identifier) { errors.push(`${file} : "minecraft:block.description.identifier" manquant.`); continue; }
      const id = b.description.identifier;
      known.add(id);
      const mi = (b.components || {})['minecraft:material_instances'];
      if (mi) {
        for (const inst of Object.values(mi)) {
          if (inst && inst.texture && !terrainAtlas[inst.texture]) errors.push(`${file} : la texture "${inst.texture}" n'existe pas dans RP/textures/terrain_texture.json.`);
        }
      }
      const loot = (b.components || {})['minecraft:loot'];
      if (loot && !fs.existsSync(path.join(root, 'BP', loot))) errors.push(`${file} : la loot table "BP/${loot}" est introuvable.`);
      if (!langFr.has(`tile.${id}.name`)) warnings.push(`${file} : traduction "tile.${id}.name" absente de fr_FR.lang.`);
    }
  }

  for (const [file, j] of parsed) {
    if (!file.startsWith('BP/recipes/')) continue;
    const r = j['minecraft:recipe_shaped'] || j['minecraft:recipe_shapeless'];
    if (!r) continue;
    const refs = [];
    if (r.key) Object.values(r.key).forEach((k) => refs.push(typeof k === 'string' ? k : k.item));
    if (r.ingredients) r.ingredients.forEach((k) => refs.push(typeof k === 'string' ? k : k.item));
    if (r.result) refs.push(typeof r.result === 'string' ? r.result : r.result.item);
    for (const ref of refs) {
      if (ref && ref.startsWith(meta.modId + ':') && !known.has(ref)) errors.push(`${file} : "${ref}" n'existe pas dans ton add-on.`);
    }
    if (r.pattern) {
      const used = new Set(r.pattern.join('').replace(/ /g, ''));
      for (const ch of used) if (!r.key || !r.key[ch]) errors.push(`${file} : la lettre "${ch}" du motif n'est pas définie dans "key".`);
      if (r.pattern.length > 3 || r.pattern.some((row) => row.length > 3)) errors.push(`${file} : le motif dépasse 3×3.`);
    }
  }

  // Scripts : vérification de syntaxe JavaScript
  for (const f of walk(path.join(root, 'BP/scripts'))) {
    if (!f.endsWith('.js')) continue;
    const code = fs.readFileSync(f, 'utf8')
      .replace(/^\s*import\s[^;]*?from\s*["'][^"']+["'];?/gms, '')
      .replace(/^\s*import\s*["'][^"']+["'];?/gm, '')
      .replace(/^\s*export\s+(default\s+)?/gm, '');
    try {
      new vm.Script(`(async () => {\n${code}\n})`, { filename: rel(f) });
    } catch (e) {
      const line = e.stack && (e.stack.match(/:(\d+)\n/) || [])[1];
      errors.push(`${rel(f)}${line ? ' ligne ' + (Number(line) - 1) : ''} : erreur de syntaxe JavaScript (${e.message}).`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function formatReport(r) {
  if (r.ok && !r.warnings.length) return '✔ Aucun problème trouvé : ton add-on est prêt à être testé !';
  const lines = [];
  if (r.errors.length) lines.push(`✖ ${r.errors.length} erreur(s) :`, ...r.errors.map((e) => '  • ' + e));
  if (r.warnings.length) lines.push(`⚠ ${r.warnings.length} avertissement(s) :`, ...r.warnings.map((e) => '  • ' + e));
  if (r.ok) lines.unshift('✔ Pas d\'erreur bloquante.');
  return lines.join('\n');
}

module.exports = { checkAddon, formatReport };
