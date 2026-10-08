require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { ensureSchema, pool } = require('./lib/db');
const { globalStore, tenantManager } = require('./lib/store');
const botManager = require('./lib/botManager');
const minecraftManager = require('./lib/minecraftManager');
const auditLog = require('./lib/auditLog');
const { startKeepAlive } = require('./lib/keepAlive');

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0';

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException (process maintenu en vie):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection (process maintenu en vie):', reason);
});

// Démarre le bot Discord de CHAQUE tenant "service=discord" qui a un
// token configuré. Les tenants "service=minecraft" n'ont pas de bot à
// démarrer ici — leur serveur de jeu se lance explicitement depuis le
// dashboard (voir /api/minecraft/start), jamais automatiquement au boot.
async function startAllTenantBots() {
  const [rows] = await pool.query("SELECT id FROM tenants WHERE service = 'discord' OR service IS NULL");
  let started = 0;
  for (const row of rows) {
    try {
      const store = await tenantManager.getStore(row.id);
      if (store.getBot().token) {
        const controller = botManager.get(row.id, store);
        await controller.start();
        started += 1;
      }
    } catch (err) {
      console.error(`[ERROR] Échec démarrage bot du tenant ${row.id}:`, err.message);
    }
  }
  console.log(`🤖 ${started} bot(s) client démarré(s) sur ${rows.length} tenant(s) Discord au total.`);
}

// ── Mise à jour automatique des serveurs Minecraft ──────────────────
// Pour chaque tenant "service=minecraft" ayant activé l'option "Mise à
// jour automatique" (voir POST /api/minecraft/auto-update), on vérifie
// si une nouvelle version est disponible et on l'applique tout seul —
// plus besoin de cliquer sur le bouton "Mise à jour" dans le dashboard.
// Ne touche jamais un serveur en cours d'exécution ou déjà occupé
// (démarrage/arrêt/provisioning/update en cours) : il sera repris au
// prochain passage, une fois à l'arrêt.
async function runMinecraftAutoUpdates() {
  // Si l'agent VPS est configuré, les serveurs Minecraft tournent là-bas —
  // pas besoin de chercher en local.
  if (process.env.MINECRAFT_AGENT_URL && process.env.MINECRAFT_AGENT_SECRET) return;
  const [rows] = await pool.query("SELECT id FROM tenants WHERE service = 'minecraft'");
  let updated = 0;
  for (const row of rows) {
    try {
      const store = await tenantManager.getStore(row.id);
      const cfg = store.getMinecraft();
      if (!cfg.created || !cfg.autoUpdate) continue;

      const controller = minecraftManager.get(row.id, store);
      const status = controller.getStatus().status;
      if (status !== 'stopped' && status !== 'crashed') continue;

      let targetVersion = null;
      if (cfg.edition !== 'bedrock') {
        const versions = await minecraftManager.listAvailableVersions();
        targetVersion = versions[0] || null;
        if (targetVersion && targetVersion === cfg.mcVersion) continue; // déjà à jour
      }

      console.log(`⬆️  Mise à jour automatique [tenant ${row.id}]${targetVersion ? ` → ${targetVersion}` : ''}…`);
      const result = await controller.update({ mcVersion: targetVersion || undefined });
      store.setMinecraft({ mcVersion: cfg.edition === 'bedrock' ? '' : result.version });
      auditLog.logAction({ tenantId: row.id, action: 'minecraft.autoupdate.success', target: cfg.name, details: { version: result.version } });
      updated += 1;
    } catch (err) {
      console.error(`[ERROR] Échec mise à jour automatique [tenant ${row.id}]:`, err.message);
      auditLog.logAction({ tenantId: row.id, action: 'minecraft.autoupdate.failed', details: { error: err.message } });
    }
  }
  if (updated) console.log(`⬆️  ${updated} serveur(s) Minecraft mis à jour automatiquement.`);
}

async function startAllHostedBots() {
  const discordBotHostManager = require('./lib/discordBotHostManager');
  const [rows] = await pool.query("SELECT id FROM tenants WHERE service = 'discord' OR service IS NULL");
  let started = 0;
  for (const row of rows) {
    try {
      const store = await tenantManager.getStore(row.id);
      const botHost = store.getBotHost();
      // Ne relance que les bots qui avaient autoRestart activé ou qui étaient marqués comme actifs
      if (!botHost.entryFile) continue;
      if (!botHost.autoRestart && !botHost.wasRunning) continue;
      const controller = discordBotHostManager.get(row.id, store);
      await controller.start({ entryFile: botHost.entryFile });
      started += 1;
    } catch (err) {
      console.error(`[ERROR] Échec redémarrage bot hébergé du tenant ${row.id}:`, err.message);
    }
  }
  if (started) console.log(`🤖 ${started} bot(s) hébergé(s) relancé(s) après reboot.`);
}

async function startAllMinecraftServers() {
  const minecraftAgentUrl  = process.env.MINECRAFT_AGENT_URL;
  const minecraftAgentSecret = process.env.MINECRAFT_AGENT_SECRET;
  if (!minecraftAgentUrl || !minecraftAgentSecret) return;
  const http  = require('http');
  const https = require('https');
  const { URL } = require('url');
  const url = new URL(minecraftAgentUrl + '/startup');
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request({ hostname: url.hostname, port: url.port || 4000, path: '/startup', method: 'POST',
    headers: { 'Authorization': 'Bearer ' + minecraftAgentSecret, 'Content-Type': 'application/json', 'Content-Length': 0 } },
    (res) => { console.log('[MINECRAFT] Agent startup:', res.statusCode); });
  req.on('error', (e) => console.error('[WARNING]  Agent Minecraft startup error:', e.message));
  req.end();
}

async function main() {
  console.log('[DATABASE] Connexion a MySQL et vérification du schéma…');
  await ensureSchema();

  console.log('[CONFIG] Chargement des settings…');
  await globalStore.init();

  // Migration : rattache les tenants créés avant le système "1 appli
  // Discord par client" à l'ancienne appli globale (cf. lib/store.js).
  if (globalStore.hasAuthApp()) {
    await tenantManager.migrateLegacyTenantsWithoutApp(globalStore.getAuthConfig());
  }

  const createDashboardServer = require('./dashboard/server');

  const app = createDashboardServer();
  app.use(cors());
  app.use(express.json());

  const server = app.listen(PORT, HOST, () => {
    console.log(`[SERVER] Dashboard en ligne sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log('[INFO] Chaque client cree son propre espace (bot Discord ou serveur Minecraft) via /signup.');
  });

  startKeepAlive();

  await startAllTenantBots();

  await startAllHostedBots();
  startAllMinecraftServers();

  // Premier passage peu après le démarrage (les serveurs viennent d'être
  // relus depuis MySQL, aucun n'est en cours d'exécution à ce stade côté
  // Minecraft — voir le commentaire au-dessus de startAllTenantBots), puis
  // toutes les 6h.
  runMinecraftAutoUpdates().catch((err) => console.error('[ERROR] Erreur mise à jour automatique Minecraft:', err.message));

  // Terminal SSH staff
  try {
    const { initSSHTerminal } = require('./lib/sshTerminal');
    initSSHTerminal(server);
  } catch(e) {
    console.error('SSH Terminal erreur:', e.message);
  }

  // Bot admin Discord
  try {
    const adminBot = require('./lib/adminBot');
    const { pool: db } = require('./lib/db');
    adminBot.init(minecraftManager, tenantManager, db);
  } catch(e) {
    console.error('[ERROR] AdminBot erreur:', e.message);
  }
  setInterval(() => {
    runMinecraftAutoUpdates().catch((err) => console.error('[ERROR] Erreur mise à jour automatique Minecraft:', err.message));
  }, 6 * 60 * 60 * 1000);

  // ── Watchdog : relance le bot Discord de chaque tenant tombé en erreur.
  // Ne concerne QUE les bots Discord — un serveur Minecraft qui plante
  // reste arrêté tant que l'admin ne relance pas explicitement depuis le
  // dashboard (on ne veut pas relancer un serveur de jeu tout seul en
  // pleine nuit sans supervision). ──────────────────────────────────
  let watchdogBackoffMs = 15_000;
  const scheduleWatchdog = () => {
    setTimeout(async () => {
      let anyRetried = false;
      for (const controller of botManager.allControllers()) {
        const st = controller.getStatus();
        const hasToken = !!controller.store.getBot().token;
        if (st.rateLimitedUntil) continue;
        if (hasToken && (st.status === 'offline' || st.status === 'error')) {
          console.log(`[RELOAD] Watchdog [tenant ${controller.tenantId}] : bot ${st.status}, tentative de reconnexion…`);
          anyRetried = true;
          try {
            await controller.start();
          } catch (err) {
            console.error(`Watchdog [tenant ${controller.tenantId}]: échec de reconnexion:`, err.message);
          }
        }
      }
      watchdogBackoffMs = anyRetried ? Math.min(watchdogBackoffMs * 2, 5 * 60_000) : 15_000;
      scheduleWatchdog();
    }, watchdogBackoffMs);
  };
  scheduleWatchdog();

  const shutdown = async (signal) => {
    console.log(`\n👋 Signal ${signal} reçu, arrêt en cours…`);
    server.close();
    await botManager.stopAll();
    const minecraftManager = require('./lib/minecraftManager');
    await minecraftManager.stopAll();
    const discordBotHostManager = require('./lib/discordBotHostManager');
    await discordBotHostManager.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[FATAL] Echec au demarrage:', err);
  process.exit(1);
});