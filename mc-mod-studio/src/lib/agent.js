// Assistant IA : Claude, avec des outils pour lire/modifier le mod et le compiler.
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const files = require('./files');
const gen = require('./generators');

const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5 (le plus intelligent)', fallback: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 (rapide, moins cher)', fallback: true },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 (très rapide, très peu cher)', fallback: false },
};
const DEFAULT_MODEL = 'claude-opus-5-5';

function systemPrompt(meta) {
  return `Tu es l'assistant de ModCraft Studio, un éditeur pour créer des mods Minecraft. Tu aides des débutants (souvent jeunes) à créer leur mod.

Le projet ouvert :
- Mod "${meta.modName}" (identifiant "${meta.modId}"), Fabric pour Minecraft ${meta.minecraft}, Java 21.
- Mappings officiels Mojang (noms comme ResourceLocation, BuiltInRegistries, Item.Properties, BlockBehaviour.Properties, Tiers). N'utilise PAS les noms Yarn (Identifier, Registries, Item.Settings…).
- Package Java : ${meta.package}. Classe principale : ${meta.className}.
- Les items sont dans ModItems.java, les blocs dans ModBlocks.java (qui enregistre aussi le BlockItem), l'onglet créatif dans ModTab.java (il contient automatiquement tout ModItems.ALL).
- Les lignes "// @modcraft:items" et "// @modcraft:blocks" sont des repères utilisés par l'éditeur : ne les supprime jamais.
- Ressources : assets/${meta.modId}/ (lang/en_us.json et fr_fr.json, models, blockstates, textures) et data/${meta.modId}/ (recipe/, loot_table/). En 1.21.1 les dossiers data sont au singulier (recipe, loot_table, tags/block, tags/item) et le résultat d'une recette s'écrit {"id": "...", "count": n}.

Comment travailler :
- Pour un item ou un bloc simple, utilise en priorité les outils add_item / add_block / add_recipe : ils créent le Java, le modèle, la texture, la traduction et la loot table d'un coup.
- Pour le reste (comportements, événements, nouvelles classes), lis les fichiers concernés puis modifie-les avec edit_file (petits changements) ou write_file (nouveau fichier).
- Après des modifications de code Java, lance build_mod pour vérifier que ça compile, et corrige les erreurs s'il y en a.
- Ne touche pas à build.gradle, settings.gradle ou gradle.properties sauf si on te le demande.
- Les textures sont des PNG 16x16 ; tu ne peux pas les dessiner, mais l'utilisateur peut les peindre dans l'éditeur de pixels (double-clic sur le .png).

Réponds toujours en français, simplement, avec des phrases courtes et sans jargon inutile. Quand tu as fini, résume en 2-3 lignes ce que tu as fait et comment le tester (bouton "▶ Tester dans Minecraft").`;
}

const schemas = {
  list_files: z.object({ folder: z.string().optional() }),
  read_file: z.object({ path: z.string().min(1) }),
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  edit_file: z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string() }),
  add_item: z.object({
    name: z.string().min(1), name_en: z.string().optional(),
    kind: z.enum(['simple', 'food', 'sword', 'pickaxe', 'axe', 'shovel']).optional(),
    tier: z.enum(['WOOD', 'STONE', 'IRON', 'GOLD', 'DIAMOND', 'NETHERITE']).optional(),
    nutrition: z.number().optional(), saturation: z.number().optional(), damage: z.number().optional(), stack: z.number().optional(),
  }),
  add_block: z.object({
    name: z.string().min(1), name_en: z.string().optional(),
    hardness: z.number().optional(), light: z.number().optional(),
    sound: z.enum(['STONE', 'WOOD', 'METAL', 'GLASS', 'GRASS', 'WOOL', 'SAND']).optional(),
    tool: z.enum(['pickaxe', 'axe', 'shovel', 'hoe', 'none']).optional(),
  }),
  add_recipe: z.object({
    grid: z.array(z.string()).max(9), result: z.string().min(1), count: z.number().optional(), shapeless: z.boolean().optional(),
  }),
  build_mod: z.object({}),
};

const TOOLS = [
  { name: 'list_files', description: 'Liste les fichiers du projet (ou d\'un sous-dossier).', input_schema: { type: 'object', properties: { folder: { type: 'string', description: 'Sous-dossier relatif, optionnel' } } } },
  { name: 'read_file', description: 'Lit un fichier texte du projet. Chemin relatif à la racine du projet.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Crée ou remplace entièrement un fichier texte du projet.', eager_input_streaming: true, input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Remplace un passage exact (old_text, qui doit apparaître une seule fois) par new_text dans un fichier.', eager_input_streaming: true, input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  {
    name: 'add_item',
    description: 'Ajoute un item complet (Java + modèle + texture + traductions). name = nom affiché en français.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, name_en: { type: 'string', description: 'Nom anglais affiché' },
        kind: { type: 'string', enum: ['simple', 'food', 'sword', 'pickaxe', 'axe', 'shovel'] },
        tier: { type: 'string', enum: ['WOOD', 'STONE', 'IRON', 'GOLD', 'DIAMOND', 'NETHERITE'] },
        nutrition: { type: 'number' }, saturation: { type: 'number' }, damage: { type: 'number' }, stack: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_block',
    description: 'Ajoute un bloc complet (Java + BlockItem + blockstate + modèles + texture + loot table + traductions).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, name_en: { type: 'string' },
        hardness: { type: 'number', description: '0 à 50, pierre = 1.5, fer = 5' }, light: { type: 'number', description: 'Lumière émise 0-15' },
        sound: { type: 'string', enum: ['STONE', 'WOOD', 'METAL', 'GLASS', 'GRASS', 'WOOL', 'SAND'] },
        tool: { type: 'string', enum: ['pickaxe', 'axe', 'shovel', 'hoe', 'none'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_recipe',
    description: 'Ajoute une recette d\'établi. grid = 9 cases (ligne par ligne) avec des identifiants ("" = vide). Un identifiant sans "namespace:" désigne d\'abord un item du mod, sinon minecraft.',
    input_schema: {
      type: 'object',
      properties: { grid: { type: 'array', items: { type: 'string' } }, result: { type: 'string' }, count: { type: 'number' }, shapeless: { type: 'boolean' } },
      required: ['grid', 'result'],
    },
  },
  { name: 'build_mod', description: 'Compile le mod avec Gradle et renvoie le résultat (succès ou erreurs).', input_schema: { type: 'object', properties: {} } },
];

function toolLabel(name, input) {
  const p = input && input.path ? ` ${input.path}` : '';
  switch (name) {
    case 'list_files': return '📂 Regarde les fichiers';
    case 'read_file': return `📖 Lit${p}`;
    case 'write_file': return `✏️ Écrit${p}`;
    case 'edit_file': return `✏️ Modifie${p}`;
    case 'add_item': return `➕ Ajoute l'item « ${input.name} »`;
    case 'add_block': return `➕ Ajoute le bloc « ${input.name} »`;
    case 'add_recipe': return `🧩 Ajoute une recette pour ${input.result}`;
    case 'build_mod': return '🔨 Compile le mod';
    default: return name;
  }
}

function summarizeBuild(code, output) {
  const lines = output.split(/\r?\n/);
  if (code === 0) return 'BUILD SUCCESSFUL : le mod compile sans erreur.';
  const errs = lines.filter((l) => /error:|ERROR|FAILURE|What went wrong|Exception|\.java:\d+/.test(l));
  return `ÉCHEC de la compilation (code ${code}).\nLignes importantes :\n${errs.slice(0, 60).join('\n')}\n\nFin du journal :\n${lines.slice(-60).join('\n')}`;
}

class Assistant {
  constructor({ apiKey, model, project, runBuild }) {
    this.client = new Anthropic({ apiKey });
    this.model = MODELS[model] ? model : DEFAULT_MODEL;
    this.project = project; // { root, meta }
    this.runBuild = runBuild; // async () => {code, output}
    this.messages = [];
    this.abort = null;
    this.lastBackups = null;
  }

  reset() {
    this.messages = [];
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  backup(rel) {
    if (!this.turnBackups) return;
    if (this.turnBackups.has(rel)) return;
    try {
      this.turnBackups.set(rel, files.readText(this.project.root, rel));
    } catch {
      this.turnBackups.set(rel, null); // fichier nouveau
    }
  }

  /** Annule les modifications de fichiers texte du dernier message. */
  undoLastTurn() {
    if (!this.lastBackups || !this.lastBackups.size) return [];
    const restored = [];
    for (const [rel, content] of this.lastBackups) {
      if (content === null) files.remove(this.project.root, rel);
      else files.writeText(this.project.root, rel, content);
      restored.push(rel);
    }
    this.lastBackups = null;
    return restored;
  }

  async execTool(name, rawInput, ui) {
    const schema = schemas[name];
    if (!schema) return { error: 'Outil inconnu : ' + name };
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) return { error: 'INVALID_INPUT: ' + parsed.error.message };
    const input = parsed.data;
    const { root, meta } = this.project;
    const javaFiles = () => ['ModItems.java', 'ModBlocks.java'].map((f) => `src/main/java/${meta.package.replace(/\./g, '/')}/${f}`);
    const langFiles = () => ['en_us.json', 'fr_fr.json'].map((f) => `src/main/resources/assets/${meta.modId}/lang/${f}`);

    switch (name) {
      case 'list_files':
        return { content: files.listFlat(root, input.folder || '.').join('\n') || '(vide)' };
      case 'read_file': {
        const text = files.readText(root, input.path);
        return { content: text.length > 200000 ? text.slice(0, 200000) + '\n…(tronqué)' : text };
      }
      case 'write_file':
        this.backup(input.path);
        files.writeText(root, input.path, input.content);
        ui.fileChanged(input.path);
        return { content: `Fichier écrit : ${input.path}` };
      case 'edit_file': {
        const text = files.readText(root, input.path);
        const n = text.split(input.old_text).length - 1;
        if (n === 0) return { error: 'old_text introuvable dans le fichier. Relis le fichier avec read_file.' };
        if (n > 1) return { error: `old_text apparaît ${n} fois ; ajoute plus de contexte pour qu'il soit unique.` };
        this.backup(input.path);
        files.writeText(root, input.path, text.replace(input.old_text, () => input.new_text));
        ui.fileChanged(input.path);
        return { content: `Fichier modifié : ${input.path}` };
      }
      case 'add_item': {
        [...javaFiles(), ...langFiles()].forEach((f) => this.backup(f));
        const r = gen.addItem(root, meta, { name: input.name, nameFr: input.name, nameEn: input.name_en, kind: input.kind, tier: input.tier, nutrition: input.nutrition, saturation: input.saturation, damage: input.damage, stack: input.stack });
        r.created.forEach((abs) => this.backup(files.toRel(root, abs)));
        ui.fileChanged(null);
        return { content: `Item ajouté : ${meta.modId}:${r.id}. Texture : ${files.toRel(root, r.texture)}` };
      }
      case 'add_block': {
        [...javaFiles(), ...langFiles()].forEach((f) => this.backup(f));
        const r = gen.addBlock(root, meta, { name: input.name, nameFr: input.name, nameEn: input.name_en, hardness: input.hardness, light: input.light, sound: input.sound, tool: input.tool });
        r.created.forEach((abs) => this.backup(files.toRel(root, abs)));
        ui.fileChanged(null);
        return { content: `Bloc ajouté : ${meta.modId}:${r.id}. Texture : ${files.toRel(root, r.texture)}` };
      }
      case 'add_recipe': {
        const r = gen.addRecipe(root, meta, input);
        this.backup(files.toRel(root, r.file));
        this.turnBackups.set(files.toRel(root, r.file), null);
        ui.fileChanged(null);
        return { content: `Recette créée : ${files.toRel(root, r.file)}\n${JSON.stringify(r.recipe)}` };
      }
      case 'build_mod': {
        const r = await this.runBuild();
        return { content: summarizeBuild(r.code, r.output) };
      }
      default:
        return { error: 'Outil inconnu' };
    }
  }

  /**
   * Envoie un message et fait tourner la boucle d'outils.
   * ui: { text(delta), tool(label), fileChanged(rel), status(str) }
   */
  async send(userText, context, ui) {
    let content = userText;
    if (context && context.openFile) {
      content = `[Fichier ouvert dans l'éditeur : ${context.openFile}]\n\n${userText}`;
    }
    this.messages.push({ role: 'user', content });
    this.turnBackups = new Map();
    this.abort = new AbortController();
    const useFallback = MODELS[this.model].fallback;
    let jsonRetries = 0;
    try {
      for (let step = 0; step < 40; step++) {
        const params = {
          model: this.model,
          max_tokens: 64000,
          system: systemPrompt(this.project.meta),
          tools: TOOLS,
          messages: this.messages,
          cache_control: { type: 'ephemeral' },
          output_config: { effort: 'medium' },
        };
        if (useFallback) {
          params.betas = ['server-side-fallback-2026-07-01'];
          params.fallbacks = 'default';
        }
        const stream = this.client.beta.messages.stream(params, { signal: this.abort.signal });
        stream.on('text', (d) => ui.text(d));
        let message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (this.abort.signal.aborted) throw err;
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          ui.status('Connexion interrompue, nouvelle tentative…');
          continue;
        }

        if (message.stop_reason === 'refusal') {
          ui.text('\n\n(Désolé, je ne peux pas aider pour cette demande.)');
          this.messages.push({ role: 'assistant', content: message.content });
          break;
        }
        if (message.stop_reason === 'pause_turn') {
          this.messages.push({ role: 'assistant', content: message.content });
          continue;
        }
        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        this.messages.push({ role: 'assistant', content: message.content });
        if (!toolUses.length) break;
        if (message.stop_reason === 'max_tokens') {
          // Entrée d'outil tronquée : on ne l'exécute pas.
          this.messages.push({
            role: 'user',
            content: toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: 'Réponse coupée (trop longue). Découpe le travail en plus petits morceaux.' })),
          });
          continue;
        }

        const results = [];
        for (const t of toolUses) {
          ui.tool(toolLabel(t.name, t.input || {}));
          let r;
          try {
            r = await this.execTool(t.name, t.input, ui);
          } catch (e) {
            r = { error: e.message };
          }
          results.push(r.error
            ? { type: 'tool_result', tool_use_id: t.id, is_error: true, content: r.error }
            : { type: 'tool_result', tool_use_id: t.id, content: r.content });
        }
        this.messages.push({ role: 'user', content: results });
        ui.text('\n\n');
      }
    } catch (err) {
      // L'historique doit rester valide : si le dernier message est un tool_use sans résultat, on le retire.
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) this.messages.pop();
      if (this.abort.signal.aborted) {
        ui.text('\n\n⏹ Arrêté.');
      } else {
        throw friendlyError(err);
      }
    } finally {
      this.abort = null;
      this.lastBackups = this.turnBackups;
      this.turnBackups = null;
      // Toujours finir sur un message assistant pour pouvoir continuer la conversation
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'user') this.messages.push({ role: 'assistant', content: '(interrompu)' });
    }
    return { changed: this.lastBackups ? [...this.lastBackups.keys()] : [] };
  }
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Clé API invalide. Vérifie-la dans ⚙ Réglages.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('Ta clé API n\'a pas accès à ce modèle. Essaie un autre modèle dans ⚙ Réglages.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Trop de demandes d\'un coup. Attends quelques secondes et réessaie.');
  if (err instanceof Anthropic.BadRequestError) return new Error('Requête refusée par l\'API : ' + err.message);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Pas de connexion à internet (ou l\'API est injoignable).');
  if (err instanceof Anthropic.APIError) return new Error(`Erreur de l'API (${err.status}) : ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

module.exports = { Assistant, MODELS, DEFAULT_MODEL, TOOLS, summarizeBuild };
