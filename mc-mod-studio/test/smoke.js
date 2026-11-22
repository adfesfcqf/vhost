// Tests sans réseau : création d'add-on Bedrock, générateurs, vérification, export, outils de l'IA, sécurité.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProject, readMeta, toModId, parseJsonLoose } = require('../src/lib/template');
const gen = require('../src/lib/generators');
const files = require('../src/lib/files');
const { checkAddon } = require('../src/lib/check');
const mc = require('../src/lib/minecraft');
const { readZip, createZip } = require('../src/lib/zip');
const { importAddon } = require('../src/lib/importer');
const { Assistant } = require('../src/lib/agent');

const J = (root, rel) => parseJsonLoose(fs.readFileSync(path.join(root, rel), 'utf8'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modcraft-'));
  assert.strictEqual(toModId('Super Rubis Été!'), 'super_rubis_ete');
  assert.deepStrictEqual(parseJsonLoose('{ // commentaire\n "a": [1, 2,], /* x */ "b": "http://x" }'), { a: [1, 2], b: 'http://x' });

  const { root, meta } = await createProject({ modName: 'Super Rubis', author: 'Steve', parentDir: tmp });
  assert.deepStrictEqual(readMeta(root), meta);
  const bp = J(root, 'BP/manifest.json');
  const rp = J(root, 'RP/manifest.json');
  assert.strictEqual(bp.dependencies[1].uuid, rp.header.uuid);
  assert.strictEqual(rp.dependencies[0].uuid, bp.header.uuid);
  assert.ok(checkAddon(root, meta).ok, 'un add-on neuf doit être valide');

  gen.addItem(root, meta, { name: 'Rubis', nameEn: 'Ruby' });
  gen.addItem(root, meta, { name: 'Tarte au rubis', kind: 'food', nutrition: 8, saturation: 1.2 });
  gen.addItem(root, meta, { name: 'Épée en rubis', kind: 'sword', tier: 'DIAMOND', damage: 2 });
  gen.addItem(root, meta, { name: 'Pioche en rubis', kind: 'pickaxe', tier: 'DIAMOND' });
  gen.addBlock(root, meta, { name: 'Bloc de rubis', hardness: 5, light: 7, sound: 'metal' });
  assert.throws(() => gen.addItem(root, meta, { name: 'Rubis' }), /existe déjà/);

  const rubis = J(root, 'BP/items/rubis.json')['minecraft:item'];
  assert.strictEqual(rubis.description.identifier, 'super_rubis:rubis');
  assert.strictEqual(rubis.components['minecraft:icon'], 'super_rubis_rubis');
  const food = J(root, 'BP/items/tarte_au_rubis.json')['minecraft:item'].components;
  assert.deepStrictEqual(food['minecraft:food'], { nutrition: 8, saturation_modifier: 1.2 });
  const sword = J(root, 'BP/items/epee_en_rubis.json')['minecraft:item'].components;
  assert.strictEqual(sword['minecraft:damage'], 9);
  assert.strictEqual(sword['minecraft:durability'].max_durability, 1561);
  const pick = J(root, 'BP/items/pioche_en_rubis.json')['minecraft:item'].components;
  assert.ok(pick['minecraft:digger'].destroy_speeds[0].block.tags.includes('stone'));
  const block = J(root, 'BP/blocks/bloc_de_rubis.json')['minecraft:block'].components;
  assert.strictEqual(block['minecraft:light_emission'], 7);
  assert.strictEqual(J(root, 'RP/blocks.json')['super_rubis:bloc_de_rubis'].sound, 'metal');
  assert.ok(J(root, 'RP/textures/item_texture.json').texture_data.super_rubis_rubis);
  assert.ok(J(root, 'RP/textures/terrain_texture.json').texture_data.super_rubis_bloc_de_rubis);
  const langFr = fs.readFileSync(path.join(root, 'RP/texts/fr_FR.lang'), 'utf8');
  const langEn = fs.readFileSync(path.join(root, 'RP/texts/en_US.lang'), 'utf8');
  assert.ok(langFr.includes('item.super_rubis.rubis.name=Rubis'));
  assert.ok(langEn.includes('item.super_rubis.rubis.name=Ruby'));
  assert.ok(langFr.includes('tile.super_rubis:bloc_de_rubis.name=Bloc de rubis'));

  const r1 = gen.addRecipe(root, meta, { grid: Array(9).fill('rubis'), result: 'bloc_de_rubis' });
  const shaped = r1.recipe['minecraft:recipe_shaped'];
  assert.deepStrictEqual(shaped.pattern, ['AAA', 'AAA', 'AAA']);
  assert.deepStrictEqual(shaped.key.A, { item: 'super_rubis:rubis' });
  const r2 = gen.addRecipe(root, meta, { grid: ['', 'rubis', '', '', 'rubis', '', '', 'stick', ''], result: 'epee_en_rubis' });
  assert.deepStrictEqual(r2.recipe['minecraft:recipe_shaped'].pattern, ['A', 'A', 'B']);
  assert.deepStrictEqual(r2.recipe['minecraft:recipe_shaped'].key.B, { item: 'minecraft:stick' });
  assert.deepStrictEqual(gen.listModIds(root, meta).sort(), ['bloc_de_rubis', 'epee_en_rubis', 'pioche_en_rubis', 'rubis', 'tarte_au_rubis']);

  let c = checkAddon(root, meta);
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.deepStrictEqual(c.warnings, []);

  // La vérification trouve les erreurs typiques
  fs.writeFileSync(path.join(root, 'BP/items/casse.json'), '{ "format_version": "1.21.100", "minecraft:item": { ');
  fs.writeFileSync(path.join(root, 'BP/scripts/main.js'), 'import { world } from "@minecraft/server";\nworld.afterEvents.itemUse.subscribe((e) => {\n  e.source.sendMessage("x"\n});\n');
  fs.unlinkSync(path.join(root, 'RP/textures/items/rubis.png'));
  c = checkAddon(root, meta);
  assert.ok(!c.ok);
  assert.ok(c.errors.some((e) => e.includes('casse.json') && e.includes('JSON invalide')));
  assert.ok(c.errors.some((e) => e.includes('main.js') && e.includes('syntaxe')));
  assert.ok(c.errors.some((e) => e.includes('textures/items/rubis.png')));
  fs.unlinkSync(path.join(root, 'BP/items/casse.json'));
  fs.writeFileSync(path.join(root, 'BP/scripts/main.js'), 'import { world } from "@minecraft/server";\nworld.afterEvents.itemUse.subscribe((e) => e.source.sendMessage("ok"));\nawait null;\n');
  fs.writeFileSync(path.join(root, 'RP/textures/items/rubis.png'), require('../src/lib/png').placeholderTexture('rubis'));
  assert.ok(checkAddon(root, meta).ok);

  // Export .mcaddon
  const out = mc.exportMcaddon(root, meta, path.join(tmp, 'export', 'super_rubis.mcaddon'));
  const zip = readZip(fs.readFileSync(out));
  assert.ok(zip['super_rubis_BP/manifest.json'] && zip['super_rubis_RP/manifest.json']);
  assert.deepStrictEqual(JSON.parse(zip['super_rubis_BP/items/rubis.json']), J(root, 'BP/items/rubis.json'));

  // Déploiement dans un faux dossier com.mojang
  const fakeMojang = path.join(tmp, 'com.mojang');
  fs.mkdirSync(fakeMojang);
  const d = mc.deployDev(root, meta, fakeMojang);
  assert.ok(fs.existsSync(path.join(d.bp, 'manifest.json')) && fs.existsSync(path.join(d.rp, 'textures/items/rubis.png')));

  // Sécurité : pas d'accès hors du projet
  assert.throws(() => files.readText(root, '../../etc/passwd'), /en dehors/);
  assert.throws(() => files.writeText(root, '/tmp/x.txt', 'x'), /en dehors/);

  // Outils de l'assistant (sans appeler l'API)
  const a = new Assistant({ apiKey: 'test', model: 'claude-opus-5-5', project: { root, meta }, runCheck: async () => 'RAPPORT' });
  const ui = { fileChanged: () => {} };
  a.turnBackups = new Map();
  const mainRel = 'BP/scripts/main.js';
  const before = files.readText(root, mainRel);
  const langBefore = files.readText(root, 'RP/texts/fr_FR.lang');
  let r = await a.execTool('edit_file', { path: mainRel, old_text: '"ok"', new_text: '"super"' }, ui);
  assert.ok(!r.error, r.error);
  r = await a.execTool('write_file', { path: 'BP/scripts/nouveau.js', content: 'export const x = 1;' }, ui);
  assert.ok(!r.error);
  r = await a.execTool('add_item', { name: 'Saphir', name_en: 'Sapphire' }, ui);
  assert.ok(r.content.includes('super_rubis:saphir'));
  r = await a.execTool('add_block', { name: 'Lampe', light: 15, sound: 'glass' }, ui);
  assert.ok(r.content.includes('super_rubis:lampe'));
  r = await a.execTool('add_recipe', { grid: ['saphir'], result: 'lampe' }, ui);
  assert.ok(!r.error, r.error);
  r = await a.execTool('write_file', { path: 'x.txt' }, ui);
  assert.ok(r.error && r.error.startsWith('INVALID_INPUT'));
  r = await a.execTool('check_addon', {}, ui);
  assert.strictEqual(r.content, 'RAPPORT');
  a.lastBackups = a.turnBackups;
  a.turnBackups = null;
  a.undoLastTurn();
  assert.strictEqual(files.readText(root, mainRel), before);
  assert.strictEqual(files.readText(root, 'RP/texts/fr_FR.lang'), langBefore);
  for (const gone of ['BP/scripts/nouveau.js', 'BP/items/saphir.json', 'BP/blocks/lampe.json', 'RP/textures/items/saphir.png', 'BP/recipes/lampe.json']) {
    assert.ok(!fs.existsSync(path.join(root, gone)), gone + ' aurait dû être supprimé');
  }
  assert.ok(!J(root, 'RP/textures/item_texture.json').texture_data.super_rubis_saphir);
  assert.ok(checkAddon(root, meta).ok);

  // ---- Import de .mcaddon / .mcpack ----
  const imp = path.join(tmp, 'imports');
  fs.mkdirSync(imp);
  // 1) le .mcaddon exporté plus haut se réimporte à l'identique
  const i1 = importAddon(out, imp);
  const m1 = readMeta(i1.root);
  assert.strictEqual(m1.modId, 'super_rubis');
  assert.strictEqual(m1.modName, 'Super Rubis');
  assert.deepStrictEqual(J(i1.root, 'BP/items/rubis.json'), J(root, 'BP/items/rubis.json'));
  assert.ok(checkAddon(i1.root, m1).ok);
  assert.deepStrictEqual(i1.warnings, []);
  // 2) .mcaddon contenant deux .mcpack (format fréquent sur internet), dossiers imbriqués
  const bpZip = createZip(require('../src/lib/zip').folderEntries(path.join(root, 'BP'), 'Mon Pack BP'));
  const rpZip = createZip(require('../src/lib/zip').folderEntries(path.join(root, 'RP'), 'Mon Pack RP'));
  const nested = path.join(tmp, 'nested.mcaddon');
  fs.writeFileSync(nested, createZip([{ name: 'Mon Pack BP.mcpack', data: bpZip }, { name: 'Mon Pack RP.mcpack', data: rpZip }]));
  const i2 = importAddon(nested, imp);
  assert.ok(fs.existsSync(path.join(i2.root, 'BP/manifest.json')) && fs.existsSync(path.join(i2.root, 'RP/textures/items/rubis.png')));
  assert.strictEqual(readMeta(i2.root).modId, 'super_rubis');
  assert.notStrictEqual(i2.root, i1.root, 'pas d\'écrasement d\'un projet existant');
  // 3) .mcpack avec seulement un pack de ressources (manifest à la racine)
  const rpOnly = path.join(tmp, 'textures.mcpack');
  fs.writeFileSync(rpOnly, createZip(require('../src/lib/zip').folderEntries(path.join(root, 'RP'), '.').map((e) => ({ ...e, name: e.name.replace(/^\.\//, '') }))));
  const i3 = importAddon(rpOnly, imp);
  assert.ok(i3.warnings.length === 1);
  const m3 = readMeta(i3.root);
  assert.ok(gen.addItem(i3.root, m3, { name: 'Test' }).id === 'test');
  assert.ok(checkAddon(i3.root, m3).ok, JSON.stringify(checkAddon(i3.root, m3).errors));
  // 4) protection contre les chemins "../" dans l'archive
  const evil = path.join(tmp, 'evil.mcpack');
  fs.writeFileSync(evil, createZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format_version: 2, header: { name: 'Evil', uuid: 'a', version: [1, 0, 0] }, modules: [{ type: 'data', uuid: 'b', version: [1, 0, 0] }] })) },
    { name: '../../echappe.txt', data: Buffer.from('x') },
  ]));
  importAddon(evil, imp);
  assert.ok(!fs.existsSync(path.join(tmp, 'echappe.txt')) && !fs.existsSync(path.join(imp, '..', '..', 'echappe.txt')));
  // 5) fichiers invalides
  fs.writeFileSync(path.join(tmp, 'pasunzip.mcpack'), 'bonjour');
  assert.throws(() => importAddon(path.join(tmp, 'pasunzip.mcpack'), imp), /archive valide/);
  fs.writeFileSync(path.join(tmp, 'vide.mcaddon'), createZip([{ name: 'lisezmoi.txt', data: Buffer.from('x') }]));
  assert.throws(() => importAddon(path.join(tmp, 'vide.mcaddon'), imp), /Aucun pack/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✔ Tous les tests passent');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
