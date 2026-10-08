// ── discordBotHostManager.js ─────────────────────────────────────────
// Hébergement du VRAI bot Discord de chaque client : le client envoie
// son propre code (index.js, package.json, node_modules éventuels…)
// dans l'onglet "Fichiers", et cette classe le lance/l'arrête/le
// redémarre comme un process Node classique — exactement le même
// principe que minecraftManager.js pour le serveur Minecraft, mais pour
// un bot Discord "boîte noire" écrit par le client.
//
// À ne pas confondre avec lib/botManager.js : ce dernier gère le bot de
// TICKETS intégré au dashboard (celui dont le client fournit juste le
// token dans "Connexion bot"). Les deux sont totalement indépendants et
// peuvent tourner en même temps.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const fileManager = require('./fileManager');
const processStats = require('./processStats');

const NODE_BIN = process.env.NODE_BIN || process.execPath;
const MAX_LOG_LINES = 500;

// Anti-rafale : évite qu'un crash-loop (bot qui plante instantanément à
// chaque tentative) ne déclenche des dizaines de redémarrages par
// seconde si "Redémarrage automatique" est activé.
const MIN_AUTO_RESTART_INTERVAL_MS = 5_000;

class DiscordBotHostController extends EventEmitter {
  constructor(tenantId, store) {
    super();
    this.tenantId = tenantId;
    this.store = store;
    this.process = null;
    this.status = 'stopped'; // stopped | starting | running | stopping | crashed | error
    this.logs = [];
    this.lastError = null;
    this.startedAt = null;
    this.entryFile = 'index.js';
    this._lastAutoRestartAt = 0;
  }

  get dir() {
    return fileManager.rootForService(this.tenantId, 'discord');
  }

  // ── Auto-détection du fichier de démarrage ────────────────────────
  // Ordre de préférence : le fichier explicitement configuré (s'il
  // existe) > le champ "main" de package.json > quelques noms usuels.
  // Permet au client de juste déposer son code sans rien régler à la
  // main dans la plupart des cas.
  _resolveEntryFile(preferred) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    try {
      const pkgPath = path.join(this.dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.main) candidates.push(pkg.main);
      }
    } catch {
      // package.json invalide/illisible — on continue avec les autres candidats.
    }
    candidates.push('index.js', 'bot.js', 'main.js', 'app.js');
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(path.join(this.dir, candidate))) return candidate;
    }
    return preferred || 'index.js';
  }

  // ── Installation automatique des dépendances ───────────────────────
  // Si un package.json est présent mais que node_modules est absent, on
  // lance "npm install" avant de démarrer le bot — le client n'a jamais
  // besoin d'envoyer node_modules lui-même (gros, lent, et souvent
  // spécifique à l'OS d'origine). Heuristique volontairement simple :
  // dès que node_modules existe, on considère que c'est déjà installé
  // (un "Redémarrer" ne relance pas npm install à chaque fois).
  async _ensureDependencies() {
    const pkgPath = path.join(this.dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    if (fs.existsSync(path.join(this.dir, 'node_modules'))) return;

    this.status = 'installing';
    this._pushLog('📦 package.json détecté — installation des dépendances (npm install)…');
    this.emit('statusChanged', this.getStatus());

    await new Promise((resolve, reject) => {
      // Sur Windows, npm est un script "npm.cmd" — spawn() ne peut pas
      // l'exécuter directement sans passer par un shell (sinon EINVAL/
      // ENOENT selon les versions de Node). shell:true fait passer la
      // commande par cmd.exe, qui sait résoudre les .cmd correctement.
      const isWin = process.platform === 'win32';
      const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: this.dir,
        shell: isWin,
      });
      child.stdout.on('data', (buf) => String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(l)));
      child.stderr.on('data', (buf) => String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(`⚠️ ${l}`)));
      child.on('error', (err) => reject(new Error(`Impossible de lancer npm : ${err.message}`)));
      child.on('exit', (code) => {
        if (code === 0) {
          this._pushLog('✅ Dépendances installées.');
          resolve();
        } else {
          reject(new Error(`npm install a échoué (code ${code}) — vérifie les logs ci-dessus.`));
        }
      });
    });
  }

  _pushLog(line) {
    const stamped = `[${new Date().toLocaleTimeString('fr-FR')}] ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.emit('log', stamped);
  }

  getLogs() {
    return [...this.logs];
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError,
      startedAt: this.startedAt,
      entryFile: this.entryFile,
      pid: this.process?.pid || null,
      hasEntryFile: fs.existsSync(path.join(this.dir, this.entryFile)),
    };
  }

  async start({ entryFile } = {}) {
    if (this.process || this.status === 'installing' || this.status === 'starting') return this.getStatus();

    try {
      await this._ensureDependencies();
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      this._pushLog(`❌ ${err.message}`);
      this.emit('statusChanged', this.getStatus());
      return this.getStatus();
    }

    this.entryFile = this._resolveEntryFile(entryFile || this.entryFile);
    const entryPath = path.join(this.dir, this.entryFile);
    if (!fs.existsSync(entryPath)) {
      this.status = 'error';
      this.lastError = `Fichier introuvable : "${this.entryFile}". Envoie ton bot (et ce fichier) depuis l'onglet Fichiers, ou corrige le nom du fichier de démarrage.`;
      this._pushLog(`❌ ${this.lastError}`);
      this.emit('statusChanged', this.getStatus());
      return this.getStatus();
    }

    // Le fichier de démarrage a pu être auto-détecté (package.json "main"
    // ou nom usuel) : on persiste le résultat pour que le champ affiché
    // dans le Panel reflète ce qui tourne réellement, sans action manuelle.
    this.store?.setBotHost?.({ entryFile: this.entryFile });

    this.status = 'starting';
    this.lastError = null;
    this._pushLog(`🚀 Démarrage du bot (node ${this.entryFile})…`);
    this.emit('statusChanged', this.getStatus());

    // RAM selon l'offre
    const BOT_PLAN_RAM = {
      bot_standard: 512,
      bot_avance:   2048,
      bot_premium:  4096,
      bot_ultra:    24576,
    };
    const planType = this.store?.getSubscription?.()?.planType || 'bot_standard';
    const maxRam = BOT_PLAN_RAM[planType] || 512;

    const child = spawn(NODE_BIN, [`--max-old-space-size=${maxRam}`, this.entryFile], {
      cwd: this.dir,
      env: { ...process.env },
    });
    this.process = child;
    this.startedAt = Date.now();

    // Pas de motif "prêt" fiable à détecter dans les logs d'un bot
    // arbitraire écrit par le client (contrairement à Minecraft) — on
    // passe donc directement à "running" une fois le process lancé sans
    // erreur immédiate ; un crash rapide bascule sur 'crashed' via 'exit'.
    this.status = 'running';
    try { if (this.store?.setBotHost) this.store.setBotHost({ wasRunning: true }); } catch {}
    this.emit('statusChanged', this.getStatus());

    child.stdout.on('data', (buf) => {
      String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(l));
    });
    child.stderr.on('data', (buf) => {
      String(buf).split('\n').filter(Boolean).forEach((l) => this._pushLog(`⚠️ ${l}`));
    });
    child.on('exit', (code, signal) => {
      this._pushLog(`⏹️ Processus terminé (code ${code}${signal ? `, signal ${signal}` : ''}).`);
      const wasStopping = this.status === 'stopping';
      this.status = wasStopping || code === 0 ? 'stopped' : 'crashed';
      processStats.forgetProcess(child.pid);
      this.process = null;
      this.startedAt = null;
      this.emit('statusChanged', this.getStatus());

      // Redémarrage automatique best-effort si activé et que ce n'est pas
      // un arrêt volontaire (bouton "Stop").
      if (!wasStopping && this.status === 'crashed' && this.store?.getBotHost?.().autoRestart) {
        const now = Date.now();
        if (now - this._lastAutoRestartAt >= MIN_AUTO_RESTART_INTERVAL_MS) {
          this._lastAutoRestartAt = now;
          this._pushLog('🔁 Redémarrage automatique après crash…');
          this.start().catch(() => {});
        } else {
          this._pushLog("⚠️ Redémarrage automatique annulé (le bot vient de crasher trop vite après une précédente tentative — évite une boucle de crash).");
        }
      }
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      this._pushLog(`❌ Impossible de lancer le bot : ${err.message}.`);
      this.status = 'crashed';
      this.process = null;
      this.emit('statusChanged', this.getStatus());
    });

    return this.getStatus();
  }

  async stop() {
    try { if (this.store?.setBotHost) this.store.setBotHost({ wasRunning: false }); } catch {}
    if (!this.process) return this.getStatus();
    this.status = 'stopping';
    this._pushLog('🛑 Arrêt demandé…');
    this.emit('statusChanged', this.getStatus());
    this.process.kill('SIGTERM');
    // Filet de sécurité : si le process ne s'arrête pas de lui-même dans
    // les 10s (bot qui intercepte SIGTERM sans jamais quitter), on le tue.
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, 10_000);
      this.once('statusChanged', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return this.getStatus();
  }

  async restart({ entryFile } = {}) {
    await this.stop();
    return this.start({ entryFile });
  }
}

class DiscordBotHostManager {
  constructor() {
    this._controllers = new Map();
  }

  get(tenantId, store) {
    if (!this._controllers.has(tenantId)) {
      const controller = new DiscordBotHostController(tenantId, store);
      const saved = store?.getBotHost?.()?.entryFile;
      if (saved) controller.entryFile = saved;
      this._controllers.set(tenantId, controller);
    }
    return this._controllers.get(tenantId);
  }

  has(tenantId) {
    return this._controllers.has(tenantId);
  }

  async stopAll() {
    await Promise.all([...this._controllers.values()].map((c) => c.stop().catch(() => {})));
  }
}

module.exports = new DiscordBotHostManager();