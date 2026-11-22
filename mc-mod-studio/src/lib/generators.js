// Générateurs "en un clic" pour Bedrock : items, blocs, recettes (JSON + texture + traductions).
const fs = require('fs');
const path = require('path');
const { placeholderTexture } = require('./png');
const { toModId, parseJsonLoose } = require('./template');

const ITEM_FORMAT = '1.21.100';
const BLOCK_FORMAT = '1.21.60';

// Statistiques façon outils vanilla
const TIERS = {
  WOOD: { label: 'Bois', damage: 4, durability: 59, speed: 2, tag: 'minecraft:wooden_tier' },
  STONE: { label: 'Pierre', damage: 5, durability: 131, speed: 4, tag: 'minecraft:stone_tier' },
  IRON: { label: 'Fer', damage: 6, durability: 250, speed: 6, tag: 'minecraft:iron_tier' },
  GOLD: { label: 'Or', damage: 4, durability: 32, speed: 12, tag: 'minecraft:golden_tier' },
  DIAMOND: { label: 'Diamant', damage: 7, durability: 1561, speed: 8, tag: 'minecraft:diamond_tier' },
  NETHERITE: { label: 'Netherite', damage: 8, durability: 2031, speed: 9, tag: 'minecraft:netherite_tier' },
};
const SOUNDS = { pierre: 'stone', bois: 'wood', metal: 'metal', verre: 'glass', herbe: 'grass', laine: 'cloth', sable: 'sand' };
const TOOL_BLOCKS = {
  pickaxe: "query.any_tag('stone', 'metal', 'rail', 'diamond_pick_diggable', 'iron_pick_diggable', 'stone_pick_diggable', 'gold_pick_diggable')",
  axe: "query.any_tag('wood', 'pumpkin', 'plant')",
  shovel: "query.any_tag('dirt', 'sand', 'gravel', 'grass', 'snow')",
};

const p = (root, ...parts) => path.join(root, ...parts);

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return parseJsonLoose(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeFile(file, content, created) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content);
  if (created && !existed) created.push(file);
}
const json = (o) => JSON.stringify(o, null, 2) + '\n';

/** Ajoute ou remplace une ligne clé=valeur dans les fichiers .lang */
function setLang(root, key, fr, en) {
  for (const [file, value] of [['fr_FR.lang', fr], ['en_US.lang', en || fr]]) {
    const f = p(root, 'RP/texts', file);
    let lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : [];
    lines = lines.filter((l) => l && !l.startsWith(key + '='));
    lines.push(`${key}=${String(value).replace(/[\r\n]/g, ' ')}`);
    writeFile(f, lines.join('\n') + '\n');
  }
}

function addTexture(root, atlasFile, key, texPath) {
  const f = p(root, 'RP/textures', atlasFile);
  const j = readJson(f, { texture_data: {} });
  j.texture_data = j.texture_data || {};
  j.texture_data[key] = { textures: texPath };
  writeFile(f, json(j));
}

function listModIds(root, meta) {
  const ids = [];
  for (const [dir, key] of [['BP/items', 'minecraft:item'], ['BP/blocks', 'minecraft:block']]) {
    const d = p(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const j = readJson(p(d, f), null);
      const id = j && j[key] && j[key].description && j[key].description.identifier;
      if (id && id.startsWith(meta.modId + ':')) ids.push(id.split(':')[1]);
    }
  }
  return [...new Set(ids)];
}

function checkId(root, meta, id) {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Identifiant invalide : "${id}"`);
  if (listModIds(root, meta).includes(id)) throw new Error(`"${id}" existe déjà dans ton add-on.`);
}

/**
 * opts: { name (FR), nameEn?, kind: 'simple'|'food'|'sword'|'pickaxe'|'axe'|'shovel',
 *         stack?, nutrition?, saturation?, tier?, damage? }
 */
function addItem(root, meta, opts) {
  const id = toModId(opts.id || opts.name);
  checkId(root, meta, id);
  const ns = meta.modId;
  const kind = opts.kind || 'simple';
  const tool = ['sword', 'pickaxe', 'axe', 'shovel'].includes(kind);
  const tier = TIERS[opts.tier] ? opts.tier : 'IRON';
  const T = TIERS[tier];
  const texKey = `${ns}_${id}`;
  const langKey = `item.${ns}.${id}.name`;
  const c = {
    'minecraft:icon': texKey,
    'minecraft:display_name': { value: langKey },
  };
  let category = 'items';
  if (kind === 'food') {
    c['minecraft:max_stack_size'] = Math.max(1, Math.min(64, Number(opts.stack) || 64));
    c['minecraft:tags'] = { tags: ['minecraft:is_food'] };
    c['minecraft:use_animation'] = 'eat';
    c['minecraft:use_modifiers'] = { use_duration: 1.6, movement_modifier: 0.35 };
    c['minecraft:food'] = {
      nutrition: Math.max(1, Math.min(20, Math.round(Number(opts.nutrition) || 4))),
      saturation_modifier: Math.max(0, Math.min(2, Number(opts.saturation) || 0.6)),
    };
  } else if (tool) {
    category = 'equipment';
    const extra = kind === 'sword' ? Math.max(0, Math.round(Number(opts.damage) || 0)) : 0;
    const base = { sword: T.damage, pickaxe: T.damage - 4, axe: T.damage - 1, shovel: T.damage - 3 }[kind];
    c['minecraft:max_stack_size'] = 1;
    c['minecraft:hand_equipped'] = true;
    c['minecraft:damage'] = Math.max(1, base + extra);
    c['minecraft:durability'] = { max_durability: T.durability };
    c['minecraft:enchantable'] = { value: 10, slot: kind };
    c['minecraft:tags'] = { tags: [`minecraft:is_${kind}`, T.tag] };
    if (kind !== 'sword') {
      c['minecraft:digger'] = { use_efficiency: true, destroy_speeds: [{ block: { tags: TOOL_BLOCKS[kind] }, speed: T.speed }] };
    }
  } else {
    c['minecraft:max_stack_size'] = Math.max(1, Math.min(64, Number(opts.stack) || 64));
  }
  const created = [];
  const itemFile = p(root, 'BP/items', id + '.json');
  writeFile(itemFile, json({
    format_version: ITEM_FORMAT,
    'minecraft:item': { description: { identifier: `${ns}:${id}`, menu_category: { category } }, components: c },
  }), created);
  addTexture(root, 'item_texture.json', texKey, `textures/items/${id}`);
  const tex = p(root, 'RP/textures/items', id + '.png');
  if (!fs.existsSync(tex)) writeFile(tex, placeholderTexture(id, tool ? 'tool' : kind === 'food' ? 'food' : 'item'), created);
  setLang(root, langKey, opts.nameFr || opts.name || id, opts.nameEn || opts.name || id);
  return { id, file: itemFile, texture: tex, created };
}

/** opts: { name, nameEn?, hardness?, light?, sound? } */
function addBlock(root, meta, opts) {
  const id = toModId(opts.id || opts.name);
  checkId(root, meta, id);
  const ns = meta.modId;
  const hardness = Math.max(0, Math.min(50, Number(opts.hardness) || 3));
  const light = Math.max(0, Math.min(15, Math.round(Number(opts.light) || 0)));
  const sound = SOUNDS[opts.sound] || (Object.values(SOUNDS).includes(opts.sound) ? opts.sound : 'stone');
  const texKey = `${ns}_${id}`;
  const c = {
    'minecraft:geometry': { identifier: 'minecraft:geometry.full_block' },
    'minecraft:material_instances': { '*': { texture: texKey, render_method: 'opaque' } },
    'minecraft:destructible_by_mining': { seconds_to_destroy: Math.round(hardness * 1.5 * 10) / 10 },
    'minecraft:destructible_by_explosion': { explosion_resistance: Math.round(hardness * 3) },
    'minecraft:loot': `loot_tables/blocks/${id}.json`,
  };
  if (light > 0) c['minecraft:light_emission'] = light;
  const created = [];
  const blockFile = p(root, 'BP/blocks', id + '.json');
  writeFile(blockFile, json({
    format_version: BLOCK_FORMAT,
    'minecraft:block': { description: { identifier: `${ns}:${id}`, menu_category: { category: 'construction' } }, components: c },
  }), created);
  writeFile(p(root, 'BP/loot_tables/blocks', id + '.json'), json({
    pools: [{ rolls: 1, entries: [{ type: 'item', name: `${ns}:${id}`, weight: 1 }] }],
  }), created);
  addTexture(root, 'terrain_texture.json', texKey, `textures/blocks/${id}`);
  const bj = readJson(p(root, 'RP/blocks.json'), { format_version: '1.21.40' });
  bj[`${ns}:${id}`] = { sound };
  writeFile(p(root, 'RP/blocks.json'), json(bj));
  const tex = p(root, 'RP/textures/blocks', id + '.png');
  if (!fs.existsSync(tex)) writeFile(tex, placeholderTexture(id, 'block'), created);
  setLang(root, `tile.${ns}:${id}.name`, opts.nameFr || opts.name || id, opts.nameEn || opts.name || id);
  return { id, file: blockFile, texture: tex, created };
}

/**
 * Recette d'établi. grid : 9 identifiants ("" = vide). Sans "namespace:", on cherche d'abord dans l'add-on, sinon minecraft.
 */
function addRecipe(root, meta, { grid, result, count = 1, shapeless = false }) {
  const own = new Set(listModIds(root, meta));
  const resolve = (s) => {
    s = String(s || '').trim();
    if (!s) return '';
    if (s.includes(':')) return s;
    return own.has(s) ? `${meta.modId}:${s}` : `minecraft:${s}`;
  };
  const cells = (grid || []).slice(0, 9).map(resolve);
  while (cells.length < 9) cells.push('');
  const resultId = resolve(result);
  if (!resultId) throw new Error('Choisis le résultat de la recette.');
  if (!cells.some(Boolean)) throw new Error('La grille de fabrication est vide.');
  const n = Math.max(1, Math.min(64, Number(count) || 1));
  const base = resultId.split(':')[1];
  const dir = p(root, 'BP/recipes');
  let name = base;
  for (let i = 2; fs.existsSync(p(dir, name + '.json')); i++) name = `${base}_${i}`;
  const identifier = `${meta.modId}:${name}`;
  const unlock = [{ context: 'AlwaysUnlocked' }];
  let recipe;
  if (shapeless) {
    recipe = {
      format_version: '1.20.10',
      'minecraft:recipe_shapeless': {
        description: { identifier }, tags: ['crafting_table'],
        ingredients: cells.filter(Boolean).map((item) => ({ item })),
        unlock, result: { item: resultId, count: n },
      },
    };
  } else {
    const letters = 'ABCDEFGHI';
    const key = {};
    const map = new Map();
    let rows = [0, 1, 2].map((r) => cells.slice(r * 3, r * 3 + 3).map((c) => {
      if (!c) return ' ';
      if (!map.has(c)) { const L = letters[map.size]; map.set(c, L); key[L] = { item: c }; }
      return map.get(c);
    }).join(''));
    while (rows.length && rows[0].trim() === '') rows.shift();
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
    const colEmpty = (i) => rows.every((r) => r[i] === ' ');
    while (rows[0].length && colEmpty(0)) rows = rows.map((r) => r.slice(1));
    while (rows[0].length && colEmpty(rows[0].length - 1)) rows = rows.map((r) => r.slice(0, -1));
    recipe = {
      format_version: '1.20.10',
      'minecraft:recipe_shaped': { description: { identifier }, tags: ['crafting_table'], pattern: rows, key, unlock, result: { item: resultId, count: n } },
    };
  }
  const file = p(dir, name + '.json');
  writeFile(file, json(recipe));
  return { file, recipe };
}

module.exports = { addItem, addBlock, addRecipe, listModIds, TIERS, SOUNDS };
