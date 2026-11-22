// Génère un projet de mod Fabric (Minecraft 1.21.1, mappings officiels Mojang).
const fs = require('fs');
const path = require('path');
const { placeholderTexture } = require('./png');

const MC_VERSION = '1.21.1';
const GRADLE_VERSION = '8.14.3';
const LOOM_VERSION = '1.10-SNAPSHOT';
// Versions de secours si internet n'est pas disponible au moment de la création.
const FALLBACK = { loader: '0.16.14', fabricApi: '0.116.6+1.21.1' };

function toModId(name) {
  const id = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = /^[a-z]/.test(id) ? id : 'mod_' + id;
  return safe.slice(0, 63) || 'mon_mod';
}

function toClassName(name) {
  const base = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const c = /^[A-Za-z]/.test(base) ? base : 'Mod' + base;
  return (c || 'MonMod') + (c.endsWith('Mod') ? '' : 'Mod');
}

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBinary(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/** Récupère les dernières versions stables du loader et de Fabric API pour 1.21.1. */
async function resolveVersions(log = () => {}) {
  const v = { ...FALLBACK };
  try {
    const loaders = JSON.parse(await fetchText('https://meta.fabricmc.net/v2/versions/loader'));
    const stable = loaders.find((l) => l.stable);
    if (stable) v.loader = stable.version;
  } catch (e) {
    log(`(versions) loader par défaut utilisé : ${e.message}`);
  }
  try {
    const xml = await fetchText('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml');
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter((x) => x.endsWith('+' + MC_VERSION));
    if (all.length) v.fabricApi = all[all.length - 1];
  } catch (e) {
    log(`(versions) Fabric API par défaut utilisée : ${e.message}`);
  }
  return v;
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function projectFiles({ modId, modName, className, author, description, pkg, versions }) {
  const pkgPath = pkg.replace(/\./g, '/');
  const files = {};

  files['settings.gradle'] = `pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = '${modId}'
`;

  files['gradle.properties'] = `# Réglages Gradle
org.gradle.jvmargs=-Xmx2G
org.gradle.parallel=true

# Versions Minecraft / Fabric
minecraft_version=${MC_VERSION}
loader_version=${versions.loader}
fabric_version=${versions.fabricApi}

# Ton mod
mod_version=1.0.0
maven_group=${pkg}
archives_base_name=${modId}
`;

  files['build.gradle'] = `plugins {
    id 'fabric-loom' version '${LOOM_VERSION}'
}

version = project.mod_version
group = project.maven_group

base {
    archivesName = project.archives_base_name
}

repositories {
}

dependencies {
    minecraft "com.mojang:minecraft:\${project.minecraft_version}"
    mappings loom.officialMojangMappings()
    modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
    modImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}"
}

processResources {
    inputs.property "version", project.version
    filesMatching("fabric.mod.json") {
        expand "version": inputs.properties.version
    }
}

tasks.withType(JavaCompile).configureEach {
    it.options.release = 21
    it.options.encoding = "UTF-8"
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}
`;

  files['gradle/wrapper/gradle-wrapper.properties'] = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

  files['.gitignore'] = `.gradle/
build/
run/
out/
*.iml
.idea/
`;

  files['src/main/resources/fabric.mod.json'] = JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version: '${version}',
    name: modName,
    description: description || `${modName}, créé avec ModCraft Studio.`,
    authors: [author || 'Moi'],
    license: 'MIT',
    icon: `assets/${modId}/icon.png`,
    environment: '*',
    entrypoints: { main: [`${pkg}.${className}`] },
    depends: {
      fabricloader: '>=0.16.0',
      minecraft: '~' + MC_VERSION,
      java: '>=21',
      'fabric-api': '*',
    },
  }, null, 2) + '\n';

  files[`src/main/java/${pkgPath}/${className}.java`] = `package ${pkg};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ${className} implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        ModItems.init();
        ModBlocks.init();
        ModTab.init();
        LOGGER.info("${modName.replace(/"/g, '')} est chargé !");
    }
}
`;

  files[`src/main/java/${pkgPath}/ModItems.java`] = `package ${pkg};

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.*;

/** Tous les items du mod. Les boutons "+ Item" de ModCraft Studio ajoutent des lignes ici. */
public class ModItems {
    /** Liste utilisée par l'onglet créatif du mod. */
    public static final List<Item> ALL = new ArrayList<>();

    // @modcraft:items (ne pas supprimer ce commentaire)

    public static Item register(String name, Item item) {
        Item registered = Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(${className}.MOD_ID, name), item);
        ALL.add(registered);
        return registered;
    }

    public static void init() {
    }
}
`;

  files[`src/main/java/${pkgPath}/ModBlocks.java`] = `package ${pkg};

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;

/** Tous les blocs du mod. Les boutons "+ Bloc" de ModCraft Studio ajoutent des lignes ici. */
public class ModBlocks {

    // @modcraft:blocks (ne pas supprimer ce commentaire)

    public static Block register(String name, Block block) {
        Block registered = Registry.register(BuiltInRegistries.BLOCK, ResourceLocation.fromNamespaceAndPath(${className}.MOD_ID, name), block);
        ModItems.register(name, new BlockItem(registered, new Item.Properties()));
        return registered;
    }

    public static void init() {
    }
}
`;

  files[`src/main/java/${pkgPath}/ModTab.java`] = `package ${pkg};

import net.fabricmc.fabric.api.itemgroup.v1.FabricItemGroup;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

/** Onglet du mode créatif qui contient automatiquement tous les items du mod. */
public class ModTab {
    public static void init() {
        CreativeModeTab tab = FabricItemGroup.builder()
            .icon(() -> new ItemStack(ModItems.ALL.isEmpty() ? Items.GRASS_BLOCK : ModItems.ALL.get(0)))
            .title(Component.translatable("itemGroup.${modId}"))
            .displayItems((params, output) -> ModItems.ALL.forEach(output::accept))
            .build();
        Registry.register(BuiltInRegistries.CREATIVE_MODE_TAB, ResourceLocation.fromNamespaceAndPath(${className}.MOD_ID, "main"), tab);
    }
}
`;

  const lang = { [`itemGroup.${modId}`]: modName };
  files[`src/main/resources/assets/${modId}/lang/en_us.json`] = JSON.stringify(lang, null, 2) + '\n';
  files[`src/main/resources/assets/${modId}/lang/fr_fr.json`] = JSON.stringify(lang, null, 2) + '\n';
  files[`src/main/resources/assets/${modId}/icon.png`] = placeholderTexture(modId, 'block');

  files['MODCRAFT.json'] = JSON.stringify({
    tool: 'ModCraft Studio', loader: 'fabric', minecraft: MC_VERSION, modId, modName, className, package: pkg,
  }, null, 2) + '\n';

  return files;
}

/**
 * Crée le projet. `download` permet de remplacer le téléchargement (tests).
 * Retourne { root, meta, warnings }.
 */
async function createProject(opts, { log = () => {}, download = fetchBinary, offline = false } = {}) {
  const modName = (opts.modName || '').trim() || 'Mon Mod';
  const modId = toModId(opts.modId || modName);
  const className = toClassName(modName);
  const authorSlug = toModId(opts.author || 'moi').replace(/_/g, '');
  const pkg = `com.${authorSlug || 'moi'}.${modId}`;
  const root = path.join(opts.parentDir, modId);
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    throw new Error(`Le dossier "${root}" existe déjà et n'est pas vide.`);
  }
  const warnings = [];
  log('Recherche des dernières versions de Fabric…');
  const versions = offline ? { ...FALLBACK } : await resolveVersions((m) => { warnings.push(m); log(m); });
  log(`Fabric Loader ${versions.loader}, Fabric API ${versions.fabricApi}`);

  const files = projectFiles({ modId, modName, className, author: opts.author, description: opts.description, pkg, versions });
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);

  // Script Gradle Wrapper (gradlew, gradlew.bat, gradle-wrapper.jar)
  if (!offline) {
    log('Téléchargement de Gradle Wrapper…');
    const base = `https://raw.githubusercontent.com/gradle/gradle/v${GRADLE_VERSION}`;
    try {
      write(root, 'gradlew', await download(`${base}/gradlew`));
      write(root, 'gradlew.bat', await download(`${base}/gradlew.bat`));
      write(root, 'gradle/wrapper/gradle-wrapper.jar', await download(`${base}/gradle/wrapper/gradle-wrapper.jar`));
      try { fs.chmodSync(path.join(root, 'gradlew'), 0o755); } catch { /* Windows */ }
    } catch (e) {
      const msg = `Impossible de télécharger Gradle Wrapper (${e.message}). Vérifie ta connexion puis utilise "Réparer Gradle".`;
      warnings.push(msg);
      log(msg);
    }
  }

  return { root, meta: JSON.parse(files['MODCRAFT.json']), warnings };
}

/** Réinstalle le wrapper Gradle (bouton "Réparer Gradle"). */
async function repairWrapper(root, { download = fetchBinary } = {}) {
  const base = `https://raw.githubusercontent.com/gradle/gradle/v${GRADLE_VERSION}`;
  write(root, 'gradlew', await download(`${base}/gradlew`));
  write(root, 'gradlew.bat', await download(`${base}/gradlew.bat`));
  write(root, 'gradle/wrapper/gradle-wrapper.jar', await download(`${base}/gradle/wrapper/gradle-wrapper.jar`));
  try { fs.chmodSync(path.join(root, 'gradlew'), 0o755); } catch { /* Windows */ }
}

function readMeta(root) {
  const p = path.join(root, 'MODCRAFT.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  // Projet Fabric existant non créé par l'app : on devine ce qu'on peut.
  const fmj = path.join(root, 'src/main/resources/fabric.mod.json');
  if (!fs.existsSync(fmj)) return null;
  const j = JSON.parse(fs.readFileSync(fmj, 'utf8'));
  const main = (j.entrypoints && j.entrypoints.main && j.entrypoints.main[0]) || '';
  const entry = typeof main === 'string' ? main : main.value || '';
  const idx = entry.lastIndexOf('.');
  return {
    tool: 'external', loader: 'fabric', minecraft: (j.depends && j.depends.minecraft) || '?',
    modId: j.id, modName: j.name || j.id, className: entry.slice(idx + 1), package: entry.slice(0, idx),
  };
}

module.exports = { createProject, repairWrapper, readMeta, toModId, toClassName, MC_VERSION, GRADLE_VERSION };
