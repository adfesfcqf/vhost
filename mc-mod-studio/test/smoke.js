// Test rapide sans réseau : création de projet, générateurs, outils de l'IA, sécurité des chemins.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProject, readMeta, toModId, toClassName } = require('../src/lib/template');
const gen = require('../src/lib/generators');
const files = require('../src/lib/files');
const { Assistant } = require('../src/lib/agent');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modcraft-'));
  assert.strictEqual(toModId('Super Rubis Été!'), 'super_rubis_ete');
  assert.strictEqual(toClassName('super rubis'), 'SuperRubisMod');

  const fakeDownload = async (url) => Buffer.from('fake:' + url);
  const { root, meta } = await createProject({ modName: 'Super Rubis', author: 'Steve', parentDir: tmp }, { download: fakeDownload, offline: false });
  assert.ok(fs.existsSync(path.join(root, 'gradlew')));
  assert.ok(fs.existsSync(path.join(root, 'gradle/wrapper/gradle-wrapper.jar')));
  assert.deepStrictEqual(readMeta(root), meta);
  assert.strictEqual(meta.package, 'com.steve.super_rubis');

  const build = fs.readFileSync(path.join(root, 'build.gradle'), 'utf8');
  assert.ok(build.includes('${project.minecraft_version}'), 'les variables Gradle doivent rester intactes');
  const fmj = JSON.parse(fs.readFileSync(path.join(root, 'src/main/resources/fabric.mod.json'), 'utf8'));
  assert.strictEqual(fmj.entrypoints.main[0], 'com.steve.super_rubis.SuperRubisMod');

  gen.addItem(root, meta, { name: 'Rubis', nameEn: 'Ruby' });
  gen.addItem(root, meta, { name: 'Tarte au rubis', kind: 'food', nutrition: 8, saturation: 1.2 });
  gen.addItem(root, meta, { name: 'Épée en rubis', kind: 'sword', tier: 'DIAMOND', damage: 4.6 });
  gen.addItem(root, meta, { name: 'Pioche en rubis', kind: 'pickaxe', tier: 'DIAMOND' });
  gen.addBlock(root, meta, { name: 'Bloc de rubis', hardness: 5, light: 7, sound: 'metal' });
  assert.throws(() => gen.addItem(root, meta, { name: 'Rubis' }), /existe déjà/);

  const items = fs.readFileSync(path.join(root, 'src/main/java/com/steve/super_rubis/ModItems.java'), 'utf8');
  assert.ok(items.includes('public static final Item RUBIS = register("rubis", new Item(new Item.Properties()));'));
  assert.ok(items.includes('.nutrition(8).saturationModifier(1.2F)'));
  assert.ok(items.includes('SwordItem.createAttributes(Tiers.DIAMOND, 5, -2.4F)'));
  const blocks = fs.readFileSync(path.join(root, 'src/main/java/com/steve/super_rubis/ModBlocks.java'), 'utf8');
  assert.ok(blocks.includes('lightLevel(state -> 7)') && blocks.includes('SoundType.METAL'));
  // accolades équilibrées
  for (const src of [items, blocks]) assert.strictEqual((src.match(/{/g) || []).length, (src.match(/}/g) || []).length);

  const lang = JSON.parse(fs.readFileSync(path.join(root, 'src/main/resources/assets/super_rubis/lang/en_us.json'), 'utf8'));
  assert.strictEqual(lang['item.super_rubis.rubis'], 'Ruby');
  assert.strictEqual(lang['block.super_rubis.bloc_de_rubis'], 'Bloc de rubis');
  const tag = JSON.parse(fs.readFileSync(path.join(root, 'src/main/resources/data/minecraft/tags/block/mineable/pickaxe.json'), 'utf8'));
  assert.deepStrictEqual(tag.values, ['super_rubis:bloc_de_rubis']);
  const png = fs.readFileSync(path.join(root, 'src/main/resources/assets/super_rubis/textures/item/rubis.png'));
  assert.strictEqual(png.slice(1, 4).toString(), 'PNG');

  const r1 = gen.addRecipe(root, meta, { grid: ['rubis', 'rubis', 'rubis', 'rubis', 'rubis', 'rubis', 'rubis', 'rubis', 'rubis'], result: 'bloc_de_rubis' });
  assert.deepStrictEqual(r1.recipe.pattern, ['AAA', 'AAA', 'AAA']);
  assert.deepStrictEqual(r1.recipe.key.A, { item: 'super_rubis:rubis' });
  const r2 = gen.addRecipe(root, meta, { grid: ['', 'rubis', '', '', 'rubis', '', '', 'stick', ''], result: 'epee_en_rubis' });
  assert.deepStrictEqual(r2.recipe.pattern, ['A', 'A', 'B']);
  assert.deepStrictEqual(r2.recipe.key.B, { item: 'minecraft:stick' });
  assert.deepStrictEqual(r2.recipe.result, { id: 'super_rubis:epee_en_rubis', count: 1 });
  assert.deepStrictEqual(gen.listModIds(root, meta).sort(), ['bloc_de_rubis', 'epee_en_rubis', 'pioche_en_rubis', 'rubis', 'tarte_au_rubis']);

  // Sécurité : pas d'accès hors du projet
  assert.throws(() => files.readText(root, '../../etc/passwd'), /en dehors/);
  assert.throws(() => files.writeText(root, '/tmp/x.txt', 'x'), /en dehors/);
  assert.ok(!files.listFlat(root).some((p) => p.startsWith('build/')));

  // Outils de l'assistant (sans appeler l'API)
  const a = new Assistant({ apiKey: 'test', model: 'claude-opus-5-5', project: { root, meta }, runBuild: async () => ({ code: 1, output: 'Foo.java:3: error: cannot find symbol\nFAILURE: Build failed' }) });
  const changed = [];
  const ui = { fileChanged: (p) => changed.push(p) };
  a.turnBackups = new Map();
  const mainRel = 'src/main/java/com/steve/super_rubis/SuperRubisMod.java';
  const before = files.readText(root, mainRel);
  let r = await a.execTool('edit_file', { path: mainRel, old_text: 'est chargé !', new_text: 'est prêt !' }, ui);
  assert.ok(!r.error, r.error);
  r = await a.execTool('write_file', { path: 'src/main/java/com/steve/super_rubis/Nouveau.java', content: 'class Nouveau {}' }, ui);
  assert.ok(!r.error);
  r = await a.execTool('add_item', { name: 'Saphir', name_en: 'Sapphire' }, ui);
  assert.ok(r.content.includes('super_rubis:saphir'));
  r = await a.execTool('read_file', { path: '../secret' }, ui).catch((e) => ({ error: e.message }));
  assert.ok(r.error);
  r = await a.execTool('write_file', { path: 'x.txt' }, ui);
  assert.ok(r.error && r.error.startsWith('INVALID_INPUT'));
  r = await a.execTool('build_mod', {}, ui);
  assert.ok(r.content.includes('cannot find symbol'));
  a.lastBackups = a.turnBackups;
  a.turnBackups = null;
  const restored = a.undoLastTurn();
  assert.ok(restored.includes(mainRel));
  assert.strictEqual(files.readText(root, mainRel), before);
  assert.ok(!fs.existsSync(path.join(root, 'src/main/java/com/steve/super_rubis/Nouveau.java')));
  assert.ok(!fs.readFileSync(path.join(root, 'src/main/java/com/steve/super_rubis/ModItems.java'), 'utf8').includes('SAPHIR'));
  assert.ok(!fs.existsSync(path.join(root, 'src/main/resources/assets/super_rubis/textures/item/saphir.png')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✔ Tous les tests passent');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
