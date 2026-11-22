// Générateurs "en un clic" : items, blocs, recettes. Écrit le Java + les JSON + la texture.
const fs = require('fs');
const path = require('path');
const { placeholderTexture } = require('./png');
const { toModId } = require('./template');

const TIERS = ['WOOD', 'STONE', 'IRON', 'GOLD', 'DIAMOND', 'NETHERITE'];
const SOUNDS = { pierre: 'STONE', bois: 'WOOD', metal: 'METAL', verre: 'GLASS', herbe: 'GRASS', laine: 'WOOL', sable: 'SAND' };

function javaDir(root, meta) {
  return path.join(root, 'src/main/java', meta.package.replace(/\./g, '/'));
}
function assets(root, meta) {
  return path.join(root, 'src/main/resources/assets', meta.modId);
}
function data(root, meta, ns = meta.modId) {
  return path.join(root, 'src/main/resources/data', ns);
}
function writeFile(p, content, created) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (created) created.push(p);
}
function constName(id) {
  return id.toUpperCase();
}

function insertAtMarker(file, marker, line) {
  const src = fs.readFileSync(file, 'utf8');
  const idx = src.indexOf(marker);
  if (idx < 0) {
    throw new Error(`Le repère "${marker}" est introuvable dans ${path.basename(file)}. Remets la ligne "// ${marker}" dans la classe.`);
  }
  const lineEnd = src.indexOf('\n', idx);
  const out = src.slice(0, lineEnd + 1) + line + '\n' + src.slice(lineEnd + 1);
  fs.writeFileSync(file, out);
}

function addLang(root, meta, key, en, fr) {
  for (const [file, value] of [['en_us.json', en], ['fr_fr.json', fr || en]]) {
    const p = path.join(assets(root, meta), 'lang', file);
    let j = {};
    if (fs.existsSync(p)) {
      try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { j = {}; }
    }
    j[key] = value;
    writeFile(p, JSON.stringify(j, null, 2) + '\n');
  }
}

function addToTag(root, ns, tagPath, value) {
  const p = path.join(root, 'src/main/resources/data', ns, 'tags', tagPath + '.json');
  let j = { replace: false, values: [] };
  if (fs.existsSync(p)) {
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* recrée */ }
  }
  if (!Array.isArray(j.values)) j.values = [];
  if (!j.values.includes(value)) j.values.push(value);
  writeFile(p, JSON.stringify(j, null, 2) + '\n');
}

function checkId(root, meta, id) {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Identifiant invalide : "${id}"`);
  const itemsSrc = fs.readFileSync(path.join(javaDir(root, meta), 'ModItems.java'), 'utf8');
  const blocksSrc = fs.readFileSync(path.join(javaDir(root, meta), 'ModBlocks.java'), 'utf8');
  if (itemsSrc.includes(`"${id}"`) || blocksSrc.includes(`"${id}"`)) {
    throw new Error(`"${id}" existe déjà dans ton mod.`);
  }
}

/**
 * opts: { name (nom affiché), nameFr?, kind: 'simple'|'food'|'sword'|'pickaxe'|'axe'|'shovel',
 *         stack?, nutrition?, saturation?, tier?, damage? }
 */
function addItem(root, meta, opts) {
  const id = toModId(opts.id || opts.name);
  checkId(root, meta, id);
  const kind = opts.kind || 'simple';
  const stack = Math.max(1, Math.min(99, Number(opts.stack) || 64));
  const tier = TIERS.includes(opts.tier) ? opts.tier : 'IRON';
  let props = 'new Item.Properties()';
  if (stack !== 64 && !['sword', 'pickaxe', 'axe', 'shovel'].includes(kind)) props += `.stacksTo(${stack})`;
  let expr;
  switch (kind) {
    case 'food': {
      const n = Math.max(1, Math.min(20, Number(opts.nutrition) || 4));
      const s = Math.max(0, Math.min(2, Number(opts.saturation) || 0.6));
      expr = `new Item(${props}.food(new FoodProperties.Builder().nutrition(${n}).saturationModifier(${s}F).build()))`;
      break;
    }
    case 'sword': {
      const dmg = Number.isFinite(Number(opts.damage)) ? Math.round(Number(opts.damage)) : 3;
      expr = `new SwordItem(Tiers.${tier}, new Item.Properties().attributes(SwordItem.createAttributes(Tiers.${tier}, ${dmg}, -2.4F)))`;
      break;
    }
    case 'pickaxe':
      expr = `new PickaxeItem(Tiers.${tier}, new Item.Properties().attributes(PickaxeItem.createAttributes(Tiers.${tier}, 1.0F, -2.8F)))`;
      break;
    case 'axe':
      expr = `new AxeItem(Tiers.${tier}, new Item.Properties().attributes(AxeItem.createAttributes(Tiers.${tier}, 6.0F, -3.1F)))`;
      break;
    case 'shovel':
      expr = `new ShovelItem(Tiers.${tier}, new Item.Properties().attributes(ShovelItem.createAttributes(Tiers.${tier}, 1.5F, -3.0F)))`;
      break;
    default:
      expr = `new Item(${props})`;
  }
  const created = [];
  const javaFile = path.join(javaDir(root, meta), 'ModItems.java');
  insertAtMarker(javaFile, '@modcraft:items', `    public static final Item ${constName(id)} = register("${id}", ${expr});`);
  const tool = ['sword', 'pickaxe', 'axe', 'shovel'].includes(kind);
  writeFile(path.join(assets(root, meta), 'models/item', id + '.json'), JSON.stringify({
    parent: tool ? 'minecraft:item/handheld' : 'minecraft:item/generated',
    textures: { layer0: `${meta.modId}:item/${id}` },
  }, null, 2) + '\n', created);
  const tex = path.join(assets(root, meta), 'textures/item', id + '.png');
  if (!fs.existsSync(tex)) writeFile(tex, placeholderTexture(id, tool ? 'tool' : kind === 'food' ? 'food' : 'item'), created);
  addLang(root, meta, `item.${meta.modId}.${id}`, opts.nameEn || opts.name || id, opts.nameFr || opts.name || id);
  return { id, javaFile, texture: tex, created };
}

/** opts: { name, nameFr?, hardness?, light?, sound?, tool?: 'pickaxe'|'axe'|'shovel'|'none' } */
function addBlock(root, meta, opts) {
  const id = toModId(opts.id || opts.name);
  checkId(root, meta, id);
  const hardness = Math.max(0, Math.min(50, Number(opts.hardness) || 3));
  const light = Math.max(0, Math.min(15, Number(opts.light) || 0));
  const sound = SOUNDS[opts.sound] || (Object.values(SOUNDS).includes(opts.sound) ? opts.sound : 'STONE');
  let props = `BlockBehaviour.Properties.of().strength(${hardness}F, ${(hardness * 2).toFixed(1)}F).sound(SoundType.${sound})`;
  if (light > 0) props += `.lightLevel(state -> ${light})`;
  const created = [];
  const javaFile = path.join(javaDir(root, meta), 'ModBlocks.java');
  insertAtMarker(javaFile, '@modcraft:blocks', `    public static final Block ${constName(id)} = register("${id}", new Block(${props}));`);
  const a = assets(root, meta);
  writeFile(path.join(a, 'blockstates', id + '.json'), JSON.stringify({ variants: { '': { model: `${meta.modId}:block/${id}` } } }, null, 2) + '\n', created);
  writeFile(path.join(a, 'models/block', id + '.json'), JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: `${meta.modId}:block/${id}` } }, null, 2) + '\n', created);
  writeFile(path.join(a, 'models/item', id + '.json'), JSON.stringify({ parent: `${meta.modId}:block/${id}` }, null, 2) + '\n', created);
  const tex = path.join(a, 'textures/block', id + '.png');
  if (!fs.existsSync(tex)) writeFile(tex, placeholderTexture(id, 'block'), created);
  // Le bloc se récupère quand on le casse
  writeFile(path.join(data(root, meta), 'loot_table/blocks', id + '.json'), JSON.stringify({
    type: 'minecraft:block',
    pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: `${meta.modId}:${id}` }], conditions: [{ condition: 'minecraft:survives_explosion' }] }],
  }, null, 2) + '\n', created);
  const tool = ['pickaxe', 'axe', 'shovel', 'hoe'].includes(opts.tool) ? opts.tool : (opts.tool === 'none' ? null : 'pickaxe');
  if (tool) addToTag(root, 'minecraft', `block/mineable/${tool}`, `${meta.modId}:${id}`);
  addLang(root, meta, `block.${meta.modId}.${id}`, opts.nameEn || opts.name || id, opts.nameFr || opts.name || id);
  return { id, javaFile, texture: tex, created };
}

function normItem(meta, s) {
  s = String(s || '').trim();
  if (!s) return '';
  return s.includes(':') ? s : `minecraft:${s}`;
}

/**
 * Recette de fabrication. grid: tableau de 9 identifiants ("" = case vide), ex. "mon_mod:rubis" ou "stick".
 * Un identifiant sans "namespace:" est cherché d'abord dans le mod, sinon dans minecraft.
 */
function addRecipe(root, meta, { grid, result, count = 1, shapeless = false }) {
  const ownIds = new Set(listModIds(root, meta));
  const resolve = (s) => {
    s = String(s || '').trim();
    if (!s) return '';
    if (s.includes(':')) return s;
    return ownIds.has(s) ? `${meta.modId}:${s}` : normItem(meta, s);
  };
  const cells = (grid || []).slice(0, 9).map(resolve);
  while (cells.length < 9) cells.push('');
  const resultId = resolve(result);
  if (!resultId) throw new Error('Choisis le résultat de la recette.');
  if (!cells.some(Boolean)) throw new Error('La grille de fabrication est vide.');
  const n = Math.max(1, Math.min(64, Number(count) || 1));
  let recipe;
  if (shapeless) {
    recipe = { type: 'minecraft:crafting_shapeless', ingredients: cells.filter(Boolean).map((item) => ({ item })), result: { id: resultId, count: n } };
  } else {
    const letters = 'ABCDEFGHI';
    const key = {};
    const map = new Map();
    let rows = [0, 1, 2].map((r) => cells.slice(r * 3, r * 3 + 3).map((c) => {
      if (!c) return ' ';
      if (!map.has(c)) { const L = letters[map.size]; map.set(c, L); key[L] = { item: c }; }
      return map.get(c);
    }).join(''));
    // Retire lignes/colonnes vides pour que la recette marche partout dans la grille
    while (rows.length && rows[0].trim() === '') rows.shift();
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
    const colEmpty = (i) => rows.every((r) => r[i] === ' ');
    while (rows[0].length && colEmpty(0)) rows = rows.map((r) => r.slice(1));
    while (rows[0].length && colEmpty(rows[0].length - 1)) rows = rows.map((r) => r.slice(0, -1));
    recipe = { type: 'minecraft:crafting_shaped', pattern: rows, key, result: { id: resultId, count: n } };
  }
  const base = resultId.split(':')[1];
  const dir = path.join(data(root, meta), 'recipe');
  let file = path.join(dir, base + '.json');
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}_${i}.json`);
  writeFile(file, JSON.stringify(recipe, null, 2) + '\n');
  return { file, recipe };
}

/** Liste les identifiants (items + blocs) déclarés dans le mod. */
function listModIds(root, meta) {
  const ids = [];
  for (const f of ['ModItems.java', 'ModBlocks.java']) {
    const p = path.join(javaDir(root, meta), f);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/register\("([a-z0-9_]+)"/g)) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

module.exports = { addItem, addBlock, addRecipe, listModIds, TIERS, SOUNDS };
