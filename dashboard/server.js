const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const { globalStore, tenantManager, TenantStore } = require('../lib/store');
const botManager = require('../lib/botManager');
const minecraftManager = require('../lib/minecraftManager');
const minecraftAgent   = require('../lib/minecraftAgent');
const discordBotHostManager = require('../lib/discordBotHostManager');
const { getLeaderboard: getDayzLeaderboard } = require('../lib/dayzManager');
const nitradoApi = require('../lib/nitradoApi');
const fileManager = require('../lib/fileManager');
const musicManager = require('../lib/musicManager');
const { pool: db } = require('../lib/db');
const { isValidEmoji } = require('../lib/config');
const customerCodes = require('../lib/customerCodes');
const stripeCheckout = require('../lib/stripeCheckout');

// ── Stripe : charger le store d'un tenant à la demande ─────────────────
// Permet à stripeCheckout de mettre à jour l'abonnement via le webhook
// sans avoir à connaître l'implémentation interne du Store.
stripeCheckout.setStoreLoader(async (tenantId) => {
  const [rows] = await require('../lib/db').pool.query(
    'SELECT id FROM tenants WHERE id = ?', [tenantId]
  );
  if (!rows.length) return null;
  const Store = require('../lib/store');
  return Store.load(tenantId);
});
const { fetchServerStatus } = require('../lib/cfxApi');
const { hashPassword, verifyPassword, validateUsername, validatePassword, validateEmail } = require('../lib/auth');
const auditLog = require('../lib/auditLog');
const playerLog = require('../lib/playerLog');
const processStats = require('../lib/processStats');

const VIEWS_DIR = __dirname;
const DISCORD_API = 'https://discord.com/api/v10';

const sessionStore = new MySQLStore({}, db);

function readView(name) {
  return fs.readFileSync(path.join(VIEWS_DIR, 'public', name), 'utf8');
}

// ── Auth : vérifie juste qu'on a une session Discord + un tenantId ──
function requireAuth(req, res, next) {
  if (req.session && req.session.discordUser && req.session.tenantId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

// ── Résout le TenantStore + le BotController DU TENANT DE LA SESSION ──
async function resolveTenant(req, res, next) {
  try {
    const tenantId = req.session.tenantId;
    if (!tenantId) return res.status(401).json({ error: 'unauthorized' });

    const store = await tenantManager.getStore(tenantId);
    if (!store.isAdmin(req.session.discordUser.id)) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.tenantStore = store;
    req.tenantId = tenantId;
    req.adminRole = store.getAdminRole(req.session.discordUser.id);
    req.tenantService = await tenantManager.getService(tenantId);
    if (req.tenantService === 'minecraft') {
      if (minecraftAgent.isConfigured()) {
        // ── Mode VPS : toutes les opérations passent par l'agent distant.
        // req.minecraft expose la même interface que MinecraftController
        // mais redirige chaque appel vers l'API de l'agent via Tailscale.
        req.minecraft = {
          getStatus:   ()      => { throw new Error('Utilise /api/minecraft pour le statut.'); },
          getLogs:     ()      => [],
          start:       ()      => minecraftAgent.start(tenantId),
          stop:        ()      => minecraftAgent.stop(tenantId),
          restart:     async () => { await minecraftAgent.stop(tenantId); return minecraftAgent.start(tenantId); },
          sendCommand: (cmd)   => minecraftAgent.sendCommand(tenantId, cmd),
          wipe:        ()      => minecraftAgent.deleteServer(tenantId),
          provision:   (opts)  => minecraftAgent.provision(tenantId, opts),
          on:  () => {}, off: () => {},
          // Propriétés lues par quelques routes (provision/update) :
          mcVersion: store.getMinecraft().mcVersion || '',
          loader: store.getMinecraft().loader || 'paper',
        };
      } else {
        // ── Mode local (historique) : le process Java tourne sur cette machine.
        const isNewController = !minecraftManager.has(tenantId);
        req.minecraft = minecraftManager.get(tenantId, store);
        if (isNewController) {
          req.minecraft.on('statusChanged', (status) => {
            if (status.status === 'running') {
              musicManager.autoStartIfEnabled(tenantId, store, req.minecraft);
            } else if (status.status === 'stopped' || status.status === 'crashed') {
              musicManager.stopPlaylist(tenantId);
            }
          });
        }
      }
    } else {
      req.bot = botManager.get(tenantId, store);
      // Bot Discord "hébergé" (fichiers propres au client, cf. onglet
      // Fichiers) — totalement séparé du bot de tickets ci-dessus.
      req.botHost = discordBotHostManager.get(tenantId, store);
    }
    next();
  } catch (err) {
    console.error('Erreur resolveTenant:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ── Contrôle d'accès par rôle ──
function requireRole(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.adminRole)) return next();
    return res.status(403).json({ error: 'Accès refusé pour ton rôle.' });
  };
}

// ── Isolation par service : un tenant Minecraft n'a accès qu'aux routes
// Minecraft, un tenant Discord qu'aux routes Discord (bot/tickets/dayz/
// musique...). Miroir de requireMinecraft (voir plus bas) — 404 plutôt
// que 403 pour ne pas laisser deviner l'existence de la route à un tenant
// qui n'a pas ce service.
function requireDiscord(req, res, next) {
  if (req.tenantService === 'minecraft') return res.status(404).json({ error: 'Service indisponible.' });
  next();
}

async function readTickets(tenantId) {
  try {
    const [rows] = await db.query('SELECT data FROM tickets WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
    return rows.map((r) => JSON.parse(r.data));
  } catch (err) {
    console.error('Erreur lecture tickets MySQL:', err.message);
    return [];
  }
}

async function computeStats(tenantId) {
  const tickets = await readTickets(tenantId);
  const total = tickets.length;
  const open = tickets.filter((t) => t.status === 'open').length;
  const closed = tickets.filter((t) => t.status === 'closed').length;

  const byType = {};
  for (const t of tickets) {
    byType[t.typeId] = (byType[t.typeId] || 0) + 1;
  }

  const closedWithDuration = tickets.filter((t) => t.status === 'closed' && t.createdAt && t.closedAt);
  const avgResolutionMs = closedWithDuration.length
    ? closedWithDuration.reduce((sum, t) => sum + (t.closedAt - t.createdAt), 0) / closedWithDuration.length
    : null;

  const claimedCount = tickets.filter((t) => t.claimedBy).length;
  const unclaimedOpen = tickets.filter((t) => t.status === 'open' && !t.claimedBy).length;

  const recent = [...tickets]
    .sort((a, b) => (b.closedAt || b.createdAt || 0) - (a.closedAt || a.createdAt || 0))
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      userTag: t.userTag,
      typeId: t.typeId,
      status: t.status,
      createdAt: t.createdAt,
      closedAt: t.closedAt || null,
      claimedByTag: t.claimedByTag || null,
    }));

  return { total, open, closed, byType, avgResolutionMs, claimedCount, unclaimedOpen, recent };
}

function toCsv(tickets) {
  const headers = ['id', 'userTag', 'userId', 'typeId', 'status', 'claimedByTag', 'createdAt', 'closedAt', 'closedBy'];
  const rows = tickets.map((t) =>
    headers
      .map((h) => {
        const v = t[h] ?? '';
        const s = String(v).replace(/"/g, '""');
        return `"${s}"`;
      })
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function mapTicketMessage(m) {
  const time = m.createdAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  if (!m.author.bot) {
    return { sender: m.author.username, text: m.content, time, from: 'staff' };
  }

  if (m.content.startsWith('**[Dashboard]')) {
    const match = m.content.match(/^\*\*\[Dashboard\]\s*(.+?)\s*:\*\*\s*([\s\S]*)$/);
    return {
      sender: match ? `Staff (Dashboard) · ${match[1]}` : 'Staff (Dashboard)',
      text: match ? match[2] : m.content,
      time,
      from: 'staff',
    };
  }

  const embed = m.embeds?.[0];
  if (embed?.author?.name) {
    const isStaffRelay = embed.author.name.startsWith('Staff · ');
    return {
      sender: isStaffRelay ? embed.author.name : `${embed.author.name} (joueur)`,
      text: embed.description || '*[pièce jointe uniquement]*',
      time,
      from: isStaffRelay ? 'staff' : 'user',
    };
  }

  if (embed) {
    return { sender: 'Système', text: embed.title || embed.description || '[notification]', time, from: 'system' };
  }

  return { sender: 'Bot', text: m.content || '[message vide]', time, from: 'system' };
}

function createDashboardServer() {
  const app = express();
  app.set('trust proxy', 1);

  // ── Stripe : webhook (corps BRUT requis pour vérifier la signature, donc
  // déclaré AVANT express.json). Génère le code dès que le paiement est confirmé.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripeCheckout.isConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Stripe non configuré');
    }
    let event;
    try {
      event = stripeCheckout.getStripe().webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Signature invalide : ${err.message}`);
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      try {
        // Mode subscription : génère le code ET active l'abonnement dans le store
        // Envoyer email d'activation si email disponible
        if (session.customer_details?.email && !session.metadata?.tokens) {
          try {
            const mailer = require('../lib/mailer');
            await mailer.sendActivationEmail({
              to: session.customer_details.email,
              code: session.metadata?.code || '—',
              planType: session.metadata?.planType || '',
              service: session.metadata?.service || 'discord',
            });
            console.log('[OK] Email activation envoyé à', session.customer_details.email);
          } catch(mailErr) {
            console.error('[ERR] Erreur email:', mailErr.message);
          }
        }
        if (session.metadata?.tokens) {
          // Session tokens IA
          const tenantId = session.metadata.tenantId;
          const tokens = parseInt(session.metadata.tokens || '0');
          if (tenantId && tokens > 0) {
            const pool = db.pool.promise ? db.pool.promise() : db.pool;
            const [rows] = await pool.query('SELECT balance FROM ai_tokens WHERE tenant_id = ?', [tenantId]);
            if (rows.length) {
              await pool.query('UPDATE ai_tokens SET balance = balance + ? WHERE tenant_id = ?', [tokens, tenantId]);
            } else {
              await pool.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, ?)', [tenantId, tokens]);
            }
            console.log('[OK] Tokens crédités:', tokens, 'pour tenant', tenantId);
          }
        } else if (session.mode === 'subscription') {
          await stripeCheckout.fulfillSubscriptionSession(session);
        } else {
          await stripeCheckout.fulfillSession(session);
        }
      } catch (err) {
        console.error('Stripe webhook checkout :', err.message);
        return res.status(500).send('Erreur serveur');
      }
    } else if (event.type === 'invoice.payment_succeeded') {
      try { await stripeCheckout.handleInvoicePaid(event.data.object); } catch {}
    } else if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
      try { await stripeCheckout.handleSubscriptionCancelled(event.data.object); } catch {}
    }
    res.json({ received: true });
  });
  // Limite globale relevée à 100mb : les pistes musicales et les uploads
  // de fichiers (base64) peuvent dépasser 2mb — avec un middleware global
  // trop restrictif, ces requêtes étaient rejetées (413) avant même
  // d'atteindre la limite plus permissive déclarée sur ces routes.
  app.use(express.json({ limit: '100mb' }));
  app.use(
    session({
      store: sessionStore,
      secret: globalStore.getSessionSecret(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
        httpOnly: true,
        sameSite: 'lax',
      },
    })
  );

  // ── DEV ONLY : bypass de connexion pour tester le dashboard sans Discord ──
  // Actif seulement si DEV_BYPASS_AUTH=true dans l'environnement (jamais en prod).
  // Dès qu'une requête arrive sans session valide, on crée/réutilise un tenant
  // de test et on connecte automatiquement un faux compte "dev" dessus.
  if (process.env.DEV_BYPASS_AUTH === 'true') {
    console.warn('[WARN]  DEV_BYPASS_AUTH activé : la connexion Discord est court-circuitée. Ne JAMAIS activer ça en prod.');
    const DEV_DISCORD_ID = process.env.DEV_DISCORD_ID || 'dev-000000000000000';

    app.use(async (req, res, next) => {
      if (req.session.discordUser && req.session.tenantId) return next();
      try {
        let tenantId = await tenantManager.findTenantIdForDiscordUser(DEV_DISCORD_ID);
        if (!tenantId) {
          tenantId = await tenantManager.createTenantForDiscordUser(DEV_DISCORD_ID, 'Tenant de test (dev)');
        }

        req.session.discordUser = {
          id: DEV_DISCORD_ID,
          username: 'Dev Tester',
          handle: 'Dev Tester',
          avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
        };
        req.session.tenantId = tenantId;

        try {
          await db.query(
            `INSERT INTO users (discord_id, username, tenant_id) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE username = VALUES(username), tenant_id = VALUES(tenant_id)`,
            [DEV_DISCORD_ID, 'Dev Tester', tenantId]
          );
          const [userRows] = await db.query('SELECT id FROM users WHERE discord_id = ?', [DEV_DISCORD_ID]);
          if (userRows.length) req.session.discordUser.dbId = userRows[0].id;
        } catch (sqlErr) {
          console.error('DEV_BYPASS_AUTH: erreur upsert users:', sqlErr.message);
        }
      } catch (err) {
        console.error('DEV_BYPASS_AUTH: impossible de créer/récupérer le tenant de test:', err.message);
      }
      next();
    });
  }

  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, tenants: botManager.allControllers().length, uptime: process.uptime() });
  });

  app.get('/accueil', (req, res) => {
    res.type('html').send(readView('index.html'));
  });

  // ── Achat par carte (Stripe) ────────────────────────────────────────
  function publicBaseUrl(req) {
    const fromEnv = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    return fromEnv || `${req.protocol}://${req.get('host')}`;
  }

  app.post('/api/stripe/checkout', async (req, res) => {
    if (!stripeCheckout.isConfigured()) {
      return res.status(503).json({ error: 'Le paiement par carte est indisponible pour le moment.' });
    }
    const planId = String((req.body && req.body.planId) || '');
    if (!stripeCheckout.PLAN_CATALOG[planId]) {
      return res.status(400).json({ error: 'Offre inconnue.' });
    }
    try {
      const tenantId = req.session?.tenantId || null;
      const session = await stripeCheckout.createCheckoutSession(planId, publicBaseUrl(req), tenantId);
      res.json({ url: session.url });
    } catch (err) {
      console.error('Stripe checkout :', err.message);
      res.status(500).json({ error: 'Impossible de démarrer le paiement, réessaie dans un instant.' });
    }
  });

  // Offre combinée Discord + Minecraft
  app.post('/api/stripe/checkout-combo', async (req, res) => {
    try {
      const { botPlan, mcPlan } = req.body || {};
      const PLAN_PRICES = { bot_standard:0.99, bot_avance:2.49, bot_premium:4.99, bot_ultra:9.99, minecraft_std:6.99, minecraft_pro:12.99 };
      const botPrice = PLAN_PRICES[botPlan] || 0.99;
      const mcPrice = PLAN_PRICES[mcPlan] || 6.99;
      const totalCents = Math.round((botPrice + mcPrice) * 0.85 * 100);
      const tenantId = req.session?.tenantId || null;
      if (totalCents <= 0) {
        return res.json({ url: publicBaseUrl(req)+'/achat/confirmation?combo=1&free=1&botPlan='+botPlan+'&mcPlan='+mcPlan });
      }
      if (!stripeCheckout.isConfigured()) return res.status(503).json({ error: 'Paiement indisponible.' });
      const stripe = stripeCheckout.getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        managed_payments: { enabled: false },
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: totalCents,
            product_data: {
              name: 'Pack Complet VHOST — Bot '+botPlan+' + Minecraft '+mcPlan,
              description: 'Bundle Discord + Minecraft avec remise 15%',
              tax_code: 'txcd_10000000',
            },
          },
          quantity: 1,
        }],
        metadata: { planId: 'combo', botPlan, mcPlan, tenantId: String(tenantId||'') },
        success_url: publicBaseUrl(req)+'/achat/confirmation?session_id={CHECKOUT_SESSION_ID}&combo=1',
        cancel_url: publicBaseUrl(req)+'/#offre-combo',
      });
      res.json({ url: session.url });
    } catch(e) {
      console.error('checkout-combo:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Envoyer credentials par DM Discord
  app.post('/api/send-credentials', async (req, res) => {
    try {
      const { discordId, username, password, planLabel, planType, botPlan, mcPlan } = req.body || {};
      if (!discordId || !username || !password) return res.status(400).json({ error: 'Données manquantes.' });
      const token = process.env.DISCORD_TOKEN;
      if (!token) return res.status(503).json({ error: 'Bot Discord non configuré.' });

      // Créer DM channel
      const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { 'Authorization': 'Bot '+token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: discordId })
      });
      if (!dmRes.ok) return res.status(400).json({ error: 'Impossible d\'ouvrir un DM. Verifie ton ID Discord et que tu autorises les MPs.' });
      const dm = await dmRes.json();

      // Envoyer le message
      // Hasher et sauvegarder le mot de passe en base
      const { hashPassword } = require('../lib/auth');
      const passwordHash = hashPassword(password);

      // Chercher si un user existe deja pour cet ID Discord
      const [existing] = await db.query('SELECT id, tenant_id FROM users WHERE discord_id = ? OR username = ?', [discordId, username]);
      let tenantId = null;
      let dbUserId = null;

      if (existing.length > 0) {
        tenantId = existing[0].tenant_id;
        dbUserId = existing[0].id;
        await db.query('UPDATE users SET username = ?, password_hash = ?, discord_id = ? WHERE id = ?', [username, passwordHash, discordId, dbUserId]);
      } else {
        // Creer un nouveau user
        const [result] = await db.query(
          'INSERT INTO users (discord_id, username, password_hash, email) VALUES (?, ?, ?, ?)',
          [discordId, username, passwordHash, discordId+'@vhost.local']
        );
        dbUserId = result.insertId;
      }

      // Creer le tenant si pas encore fait
      if (!tenantId) {
        const identity = discordId;
        if (planType === 'combo' && botPlan && mcPlan) {
          // Creer tenant Minecraft
          tenantId = await tenantManager.createTenantForDiscordUser(identity, username+'-mc', 'minecraft');
          const storeMc = await tenantManager.getStore(tenantId);
          storeMc.setSubscription({ planType: mcPlan, active: true });
          await db.query('UPDATE users SET tenant_id = ?, discord_id = ? WHERE id = ?', [tenantId, discordId, dbUserId]);
          // Creer tenant Discord
          const tenantIdDiscord = await tenantManager.createTenantForDiscordUser(identity+'_bot', username+'-bot', 'discord');
          const storeBot = await tenantManager.getStore(tenantIdDiscord);
          storeBot.setSubscription({ planType: botPlan, active: true });
          await tenantManager.addAdminToTenant(tenantIdDiscord, discordId, 'administrateur');
          // Lier les deux tenants
          await db.query('UPDATE users SET linked_tenant_id = ? WHERE id = ?', [tenantIdDiscord, dbUserId]);
        } else {
          const service = (planType||'').startsWith('bot') ? 'discord' : 'minecraft';
          tenantId = await tenantManager.createTenantForDiscordUser(identity, username, service);
          await db.query('UPDATE users SET tenant_id = ?, discord_id = ? WHERE id = ?', [tenantId, discordId, dbUserId]);
          const store = await tenantManager.getStore(tenantId);
          store.setSubscription({ planType: planType||'minecraft_custom', active: true });
          const PLAN_RAM = { minecraft_std: 7168, minecraft_pro: 15360 };
          const planRam = PLAN_RAM[planType];
          if (planRam && service === 'minecraft') {
            if (!store.settings.minecraft) store.settings.minecraft = {};
            store.settings.minecraft.memoryMb = planRam;
            store.save();
            // Sync dans _agent_config.json
            try {
              const fs2 = require('fs');
              const cfgPath = '/opt/mc-agent/data/'+tenantId+'/_agent_config.json';
              if (fs2.existsSync(cfgPath)) {
                const cfg2 = JSON.parse(fs2.readFileSync(cfgPath,'utf8'));
                cfg2.memoryMb = planRam;
                fs2.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2));
              }
            } catch {}
          }
        }
      } else {
        // S'assurer que l'user est admin de son tenant
        await tenantManager.addAdminToTenant(tenantId, discordId, 'administrateur');
        await db.query('UPDATE users SET discord_id = ? WHERE id = ?', [discordId, dbUserId]);
        // Si combo et pas encore de linked_tenant, creer le second service
        if (planType === 'combo' && botPlan && mcPlan) {
          const [uu] = await db.query('SELECT linked_tenant_id FROM users WHERE id = ?', [dbUserId]);
          if (!uu[0]?.linked_tenant_id) {
            const identity = discordId;
            const tenantIdDiscord = await tenantManager.createTenantForDiscordUser(identity+'_bot', username+'-bot', 'discord');
            const storeBot = await tenantManager.getStore(tenantIdDiscord);
            storeBot.setSubscription({ planType: botPlan, active: true });
            await tenantManager.addAdminToTenant(tenantIdDiscord, discordId, 'administrateur');
            await db.query('UPDATE users SET linked_tenant_id = ? WHERE id = ?', [tenantIdDiscord, dbUserId]);
          }
        }
      }

      const msgRes = await fetch('https://discord.com/api/v10/channels/'+dm.id+'/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot '+token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content:
          '🎉 **Bienvenue sur VHOST !**\n\n'+
          'Ton service **'+planLabel+'** est pret.\n\n'+
          '**Identifiant :** `'+username+'`\n'+
          '**Mot de passe :** `'+password+'`\n\n'+
          '🔗 Connecte-toi sur <https://vhoste.cloud/login>\n'+
          '[WARN] Change ton mot de passe apres ta premiere connexion.'
        })
      });
      if (!msgRes.ok) return res.status(400).json({ error: 'Impossible d\'envoyer le MP. Active les MPs de la part des bots.' });
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Offre personnalisée Minecraft
  app.post('/api/stripe/checkout-custom', async (req, res) => {
    try {
      const { ram, players, months, days } = req.body || {};
      const nbDays = days ? Math.min(Math.max(parseInt(days)||3, 1), 30) : null;
      const ramGo = Math.min(Math.max(parseInt(ram)||2, 2), 32);
      const nbPlayers = Math.min(Math.max(parseInt(players)||5, 5), 100);
      const nbMonths = nbDays ? null : ([1,3,6,12].includes(parseInt(months)) ? parseInt(months) : 1);
      // Prix : 1.5€/Go RAM + 0.3€ par tranche de 5 joueurs, x mois, avec remise durée
      const discount = nbDays ? 1 : (nbMonths >= 12 ? 0.8 : nbMonths >= 6 ? 0.88 : nbMonths >= 3 ? 0.94 : 1);
      const pricePerMonth = parseFloat(((ramGo * 0.5) + (nbPlayers * 0.5)).toFixed(2));
      const durationMultiplier = nbDays ? nbDays/30 : nbMonths;
      const totalCents = Math.round(pricePerMonth * durationMultiplier * discount * 100);
      const tenantId = req.session?.tenantId || null;
      // Pour les tests : si total <= 0 on bypass
      if (totalCents <= 0) {
        return res.json({ url: publicBaseUrl(req)+'/achat/confirmation?custom=1&free=1&ram='+ramGo+'&players='+nbPlayers+'&months='+nbMonths });
      }
      if (!stripeCheckout.isConfigured()) return res.status(503).json({ error: 'Paiement indisponible.' });
      const stripe = stripeCheckout.getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: totalCents,
            product_data: {
              name: 'Minecraft Personnalise — '+ramGo+'Go RAM / '+nbPlayers+' joueurs / '+(nbDays?nbDays+' jours':nbMonths+' mois'),
              description: 'Offre sur mesure VHOST Minecraft Java',
              tax_code: 'txcd_10000000',
            },
          },
          quantity: 1,
        }],
        payment_method_types: ['card'],
        managed_payments: { enabled: false },
        metadata: { planId: 'minecraft_custom', tenantId: String(tenantId||''), ram: String(ramGo), players: String(nbPlayers), months: String(nbMonths) },
        success_url: publicBaseUrl(req)+'/achat/confirmation?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: publicBaseUrl(req)+'/#minecraft-custom',
      });
      res.json({ url: session.url });
    } catch(e) {
      console.error('checkout-custom:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Appelée par la page de confirmation : vérifie auprès de Stripe que la
  // session est bien payée, puis renvoie (ou crée) le code d'achat.
  app.get('/api/stripe/order', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sessionId = String(req.query.session_id || '');
    if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId) || !stripeCheckout.isConfigured()) {
      return res.status(400).json({ error: 'Session de paiement invalide.' });
    }
    try {
      const session = await stripeCheckout.getStripe().checkout.sessions.retrieve(sessionId);
      const isPaid = session.payment_status === 'paid' || session.status === 'complete';
      if (!isPaid) return res.json({ status: 'pending' });
      let order;
      if (session.mode === 'subscription') {
        order = await stripeCheckout.fulfillSubscriptionSession(session);
      } else {
        order = await stripeCheckout.fulfillSession(session);
      }
      if (!order) return res.json({ status: 'pending' });
      const plan = stripeCheckout.PLAN_CATALOG[order.plan_type];
      res.json({ status: 'paid', code: order.code, planLabel: plan ? plan.label : order.plan_type });
    } catch (err) {
      console.error('Stripe order :', err.message);
      res.status(500).json({ error: 'Impossible de récupérer ton code pour le moment.' });
    }
  });

  // ── VHOST IA ──────────────────────────────────────────────────────────
  app.get('/api/ai/tokens', requireAuth, resolveTenant, async (req, res) => {
    try {
      const tenantId = req.tenantId || req.session?.tenantId;
      const pool = db.pool.promise ? db.pool.promise() : db.pool;
      const [rows] = await pool.query('SELECT balance, total_used FROM ai_tokens WHERE tenant_id = ?', [tenantId]);
      if (!rows.length) {
        await pool.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, 50)', [tenantId]);
        return res.json({ balance: 50, total_used: 0 });
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/ai/chat', requireAuth, resolveTenant, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ error: 'Message requis.' });
      const tenantId = req.tenantId || req.session?.tenantId;
      const pool2 = db.pool.promise ? db.pool.promise() : db.pool;
      // Vérifier les tokens
      const [rows] = await pool2.query('SELECT balance FROM ai_tokens WHERE tenant_id = ?', [tenantId]);
      let balance = 50;
      if (!rows.length) {
        await pool2.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, 50)', [tenantId]);
      } else {
        balance = rows[0].balance;
      }
      if (balance <= 0) return res.status(402).json({ error: 'Solde de tokens insuffisant. Rechargez votre compte dans l\'onglet Crédits tokens.' });
      if (balance < 7) { const pool3 = db.pool.promise ? db.pool.promise() : db.pool; const [fresh] = await pool3.query('SELECT balance FROM ai_tokens WHERE tenant_id = ?', [tenantId]); if (fresh[0]?.balance <= 0) return res.status(402).json({ error: 'Solde insuffisant.' }); }

      // Coût calculé après la réponse
      let cost = 1;

      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash-image-preview', 'gemini-flash-latest'];
      let reply = '';
      for (const modelName of MODELS) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: `Tu es VHOST IA, l'assistant intelligent de la plateforme VHOST (vhoste.cloud). Tu aides les clients avec leur hébergement Discord et Minecraft. Tu réponds en français, de manière concise et professionnelle. Tu connais : l'hébergement de bots Discord (offres Standard 0.99€, Avancé 2.49€, Premium 4.99€, Ultra 9.99€), l'hébergement de serveurs Minecraft Bedrock (offres Standard 6.99€ 2Go RAM, Pro 12.99€ 4Go RAM), la configuration des serveurs, les commandes Minecraft et Discord, le dashboard VHOST sur vhoste.cloud. Tu ne peux PAS accéder aux données des serveurs en temps réel. Si tu ne sais pas, dis-le honnêtement.`,
          });
          const chat = model.startChat({
            history: (history || []).map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
          });
          const result = await chat.sendMessage(message);
          reply = result.response.text();
          break;
        } catch(modelErr) {
          if (modelName === MODELS[MODELS.length - 1]) throw modelErr;
        }
      }

      const words = reply.trim().split(/\s+/).length;
      cost = words < 50 ? 2 : words < 150 ? 4 : 7;

      await pool2.query(
        'UPDATE ai_tokens SET balance = balance - ?, total_used = total_used + ? WHERE tenant_id = ?',
        [cost, cost, tenantId]
      );

      res.json({ reply, cost, balance: balance - cost });
    } catch (err) {
      console.error('Gemini error:', err.message);
      res.status(500).json({ error: 'Erreur IA : ' + err.message });
    }
  });

  // ── VHOST IA ──────────────────────────────────────────────────────────
  app.get('/api/ai/tokens', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.pool.query('SELECT balance, total_used FROM ai_tokens WHERE tenant_id = ?', [req.tenantId]);
      if (!rows.length) {
        await pool2.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, 50)', [tenantId]);
        return res.json({ balance: 50, total_used: 0 });
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/ai/chat', requireAuth, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ error: 'Message requis.' });

      // Vérifier les tokens
      const [rows] = await db.pool.query('SELECT balance FROM ai_tokens WHERE tenant_id = ?', [req.tenantId]);
      let balance = 50;
      if (!rows.length) {
        await pool2.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, 50)', [tenantId]);
      } else {
        balance = rows[0].balance;
      }
      if (balance <= 0) return res.status(402).json({ error: 'Solde de tokens insuffisant. Rechargez votre compte.' });
      const words = reply.trim().split(/\s+/).length;
      cost = words < 100 ? 1 : words < 300 ? 2 : 3;

      // Déduire les tokens
      await pool2.query(
        'UPDATE ai_tokens SET balance = balance - ?, total_used = total_used + ? WHERE tenant_id = ?',
        [cost, cost, tenantId]
      );

      res.json({ reply, cost, balance: balance - cost });
    } catch (err) {
      console.error('Gemini error:', err.message);
      res.status(500).json({ error: 'Erreur IA : ' + err.message });
    }
  });

  // ── Checkout tokens IA
  app.post('/api/ai/checkout', requireAuth, resolveTenant, async (req, res) => {
    try {
      const { priceId } = req.body || {};
      const PACKS = {
        'tokens_100':  { amount: 100,  price: 100,  label: '100 tokens VHOST IA' },
        'tokens_500':  { amount: 500,  price: 400,  label: '500 tokens VHOST IA' },
        'tokens_1200': { amount: 1200, price: 800,  label: '1200 tokens VHOST IA' },
      };
      const pack = PACKS[priceId];
      if (!pack) return res.status(400).json({ error: 'Pack invalide.' });
      const stripe = stripeCheckout.getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: pack.price,
            product_data: { name: pack.label, tax_code: 'txcd_10000000' },
          },
          quantity: 1,
        }],
        success_url: process.env.PUBLIC_BASE_URL + '/dashboard?tokens_ok=' + pack.amount + '&tenant=' + req.tenantId,
        cancel_url: process.env.PUBLIC_BASE_URL + '/dashboard',
        metadata: { tenantId: String(req.tenantId), tokens: String(pack.amount) },
      });
      res.json({ url: session.url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Webhook Stripe pour tokens IA
  app.post('/api/ai/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const stripe = stripeCheckout.getStripe();
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_AI_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        return res.status(400).json({ error: 'Webhook invalide: ' + err.message });
      }
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const tenantId = session.metadata?.tenantId;
        const tokens = parseInt(session.metadata?.tokens || '0');
        if (tenantId && tokens > 0) {
          const pool = db.pool.promise ? db.pool.promise() : db.pool;
          const [rows] = await pool.query('SELECT balance FROM ai_tokens WHERE tenant_id = ?', [tenantId]);
          if (rows.length) {
            await pool.query('UPDATE ai_tokens SET balance = balance + ? WHERE tenant_id = ?', [tokens, tenantId]);
          } else {
            await pool.query('INSERT INTO ai_tokens (tenant_id, balance) VALUES (?, ?)', [tenantId, tokens]);
          }
          console.log('[OK] Tokens crédités:', tokens, 'pour tenant', tenantId);
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error('Webhook tokens error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Panel Staff ─────────────────────────────────────────────────────
  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: https://vhoste.cloud/sitemap.xml\n');
  });

  // Logout demo
  app.get('/demo/logout', (req, res) => {
    if (req.session?.discordUser?.isDemo) {
      req.session.destroy(() => {});
    }
    res.redirect('/');
  });

  // Route page report
  app.get('/report', (req, res) => {
    res.type('html').send(require('fs').readFileSync(__dirname+'/public/report.html','utf8'));
  });

  // API report bug -> Discord
  app.post('/api/report-bug', async (req, res) => {
    try {
      const { title, desc, steps, user, category, severity } = req.body || {};
      if (!title || !desc) return res.status(400).json({ error: 'Champs manquants.' });
      const sevColor = severity === 'Critique' ? 0xe5484d : severity === 'Moyen' ? 0xf5a524 : 0x16a34a;
      const sevEmoji = severity === 'Critique' ? '🔴' : severity === 'Moyen' ? '🟡' : '🟢';
      const embed = {
        title: '🐛 Nouveau bug signalé',
        color: sevColor,
        fields: [
          { name: 'Titre', value: title.slice(0,256), inline: false },
          { name: 'Catégorie', value: category||'Non précisée', inline: true },
          { name: 'Sévérité', value: sevEmoji+' '+(severity||'Faible'), inline: true },
          { name: 'Utilisateur', value: user||'Anonyme', inline: true },
          { name: 'Description', value: desc.slice(0,1000), inline: false },
          ...(steps ? [{ name: 'Étapes pour reproduire', value: steps.slice(0,500), inline: false }] : []),
        ],
        footer: { text: 'VHOST Bug Report • '+new Date().toLocaleString('fr-FR') },
        timestamp: new Date().toISOString()
      };
      const TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
      const r = await fetch('https://discord.com/api/v10/channels/1557872437138432060/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!r.ok) {
        const err = await r.text();
        console.error('[BugReport] Discord error:', err);
        return res.status(500).json({ error: 'Erreur Discord.' });
      }
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/demo', (req, res) => {
    res.type('html').send(require('fs').readFileSync(__dirname+'/public/demo.html','utf8'));
  });

  app.get('/demo/minecraft', async (req, res) => {
    try {
      const [rows] = await db.query("SELECT * FROM users WHERE username='demo_minecraft'");
      const user = rows[0];
      if (!user) return res.redirect('/demo');
      req.session.discordUser = {
        id: user.discord_id,
        username: 'Demo Minecraft',
        handle: 'demo_minecraft',
        email: 'demo@vhost.local',
        avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
        dbId: user.id,
        isDemo: true,
      };
      req.session.tenantId = user.tenant_id;
      res.redirect('/dashboard');
    } catch(e) { res.redirect('/demo'); }
  });

  app.get('/demo/discord', async (req, res) => {
    try {
      const [rows] = await db.query("SELECT * FROM users WHERE username='demo_discord'");
      const user = rows[0];
      if (!user) return res.redirect('/demo');
      req.session.discordUser = {
        id: user.discord_id,
        username: 'Demo Discord',
        handle: 'demo_discord',
        email: 'demo@vhost.local',
        avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
        dbId: user.id,
        isDemo: true,
      };
      req.session.tenantId = user.tenant_id;
      res.redirect('/dashboard');
    } catch(e) { res.redirect('/demo'); }
  });

  app.get('/recrutement', (req, res) => {
    res.type('html').send(require('fs').readFileSync(__dirname+'/public/recrutement.html','utf8'));
  });

  app.post('/api/recrutement', async (req, res) => {
    try {
      const { poste, prenom, age, discordId, discordPseudo, timezone, dispo, motivation, experience, ancienStaff, ancienStaffDetail, complement, github, nbProjets, liensProjets, screensDesc, techs } = req.body || {};
      if (!poste || !prenom || !age || !discordId || !discordPseudo || !motivation || !experience) {
        return res.status(400).json({ error: 'Tous les champs obligatoires doivent etre remplis.' });
      }
      const token = process.env.DISCORD_TOKEN;
      const CHANNEL_ID = '1556625037447135284';
      const ALLOWED = ['1238992343219310643', '377102187408392193'];

      // Envoyer l embed dans le salon recrutement
      const color = poste === 'Support' ? 0x8b5cf6 : 0x3b82f6;
      const embed = {
        title: 'Nouvelle candidature — '+poste,
        color,
        fields: [
          { name: 'Prénom', value: prenom, inline: true },
          { name: 'Age', value: String(age), inline: true },
          { name: 'Discord', value: discordPseudo+' ('+discordId+')', inline: false },
          { name: 'Fuseau horaire', value: timezone||'Non précisé', inline: true },
          { name: 'Disponibilité', value: dispo||'Non précisé', inline: true },
          { name: 'Ancien staff', value: ancienStaff+(ancienStaffDetail?'\n'+ancienStaffDetail:''), inline: false },
          { name: 'Motivation', value: motivation.slice(0,1000), inline: false },
          { name: 'Expériences', value: experience.slice(0,1000), inline: false },
          ...(complement ? [{ name: 'Complement', value: complement.slice(0,500), inline: false }] : []),
          ...(poste === 'Developpeur' || poste === 'Développeur' ? [
            { name: 'GitHub', value: github||'Non fourni', inline: false },
            { name: 'Nb projets', value: nbProjets||'Non precise', inline: true },
            { name: 'Technologies', value: techs||'Non precisees', inline: true },
            ...(liensProjets ? [{ name: 'Liens projets', value: liensProjets.slice(0,500), inline: false }] : []),
            ...(screensDesc ? [{ name: 'Screenshots / Description visuelle', value: screensDesc.slice(0,500), inline: false }] : []),
          ] : []),
        ],
        footer: { text: 'VHOST Recrutement • '+new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'}) },
        timestamp: new Date().toISOString(),
      };

      const components = [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Entretien', custom_id: 'recru_entretien_'+discordId+'_'+poste.replace(/ /g,'_') },
          { type: 2, style: 4, label: 'Refuser', custom_id: 'recru_refus_'+discordId+'_'+poste.replace(/ /g,'_') },
        ]
      }];

      const msgRes = await fetch('https://discord.com/api/v10/channels/'+CHANNEL_ID+'/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot '+token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], components })
      });

      if (!msgRes.ok) {
        const e = await msgRes.json();
        return res.status(500).json({ error: 'Erreur Discord: '+JSON.stringify(e) });
      }

      // Prevenir le candidat par MP
      try {
        const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
          method: 'POST',
          headers: { 'Authorization': 'Bot '+token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient_id: discordId })
        });
        if (dmRes.ok) {
          const dm = await dmRes.json();
          await fetch('https://discord.com/api/v10/channels/'+dm.id+'/messages', {
            method: 'POST',
            headers: { 'Authorization': 'Bot '+token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content:
              '📨 **Candidature reçue — VHOST**\n\n'+
              'Bonjour **'+prenom+'**, ta candidature pour le poste de **'+poste+'** a bien été reçue.\n\n'+
              'Notre équipe va l\'étudier et te contactera ici par MP pour la suite du processus.\n\n'+
              '[OK] Reste disponible sur Discord !'
            })
          });
        }
      } catch {}

      res.json({ ok: true });
    } catch(e) {
      console.error('Recrutement:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/legal', (req, res) => {
    res.type('html').send(require('fs').readFileSync(__dirname+'/public/legal.html','utf8'));
  });

  // Middleware auth staff
  const STAFF_CREDENTIALS = {
    'petitloup91': 'Vh0st3#C30_2026!',
    'mishima':     'jpsa-b34a-fku3',
  };

  function requireStaff(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const b64 = auth.startsWith('Basic ') ? auth.slice(6) : null;
    if (b64) {
      const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
      if (STAFF_CREDENTIALS[user] && STAFF_CREDENTIALS[user] === pass) return next();
    }
    // Verifier aussi la session staff
    if (req.session?.staffUser && STAFF_CREDENTIALS[req.session.staffUser]) return next();
    if (req.path.startsWith('/api/staff')) return res.status(401).json({ error: 'Non autorise.' });
    return res.redirect('/staff');
  }

  // Token temporaire pour le terminal SSH
  const sshTokens = new Map();
  global._sshTokens = sshTokens;
  app.post('/api/staff/ssh-token', (req, res) => {
    if (!req.session?.staffUser) return res.status(401).json({ error: 'Non autorise.' });
    if (req.session.staffUser !== 'mishima') return res.status(403).json({ error: 'Acces refuse.' });
    const token = require('crypto').randomBytes(32).toString('hex');
    sshTokens.set(token, req.session.staffUser);
    setTimeout(() => sshTokens.delete(token), 30000); // expire apres 30s
    res.json({ token });
  });

  app.post('/api/staff/login', (req, res) => {
    const { username, password } = req.body || {};
    if (STAFF_CREDENTIALS[username] && STAFF_CREDENTIALS[username] === password) {
      req.session.staffUser = username;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Identifiants incorrects.' });
  });

  app.get('/staff', (req, res) => {
    res.type('html').send(readView('staff.html'));
  });

  // API overview : liste tous les tenants avec leurs infos clés
  app.get('/api/staff/overview', requireStaff, async (req, res) => {
    try {
      const [rows] = await require('../lib/db').pool.query(
        'SELECT id, name, slug, service, owner_discord_id, created_at FROM tenants ORDER BY id DESC'
      );
      const tenants = [];
      for (const row of rows) {
        let sub = {}, mc = {}, status = 'unknown';
        try {
          const [kvRows] = await require('../lib/db').pool.query(
            'SELECT value FROM kv_store WHERE `key` = ?', ['tenant:' + row.id]
          );
          if (kvRows.length) {
            const settings = JSON.parse(kvRows[0].value);
            sub = settings.subscription || {};
            mc  = settings.minecraft    || {};
          }
        } catch {}
        // Statut simplifié
        if (row.service === 'minecraft') {
          status = mc.created ? 'stopped' : 'not_installed';
        } else {
          status = 'stopped';
        }
        tenants.push({ ...row, sub, mc, status });
      }
      res.json({ tenants });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API logs : renvoie les dernières lignes de log PM2 (placeholder)
  // Staff — actions sur services
  app.post('/api/staff/service/:tenantId/start', requireStaff, async (req, res) => {
    try {
      const tid = parseInt(req.params.tenantId);
      const store = await tenantManager.getStore(tid);
      const mc = store.getMinecraft();
      const sub = store.getSubscription();
      const PLAN_RAM = { minecraft_std: 7168, minecraft_pro: 15360 };
      const planRam = PLAN_RAM[sub?.planType] || mc?.memoryMb || 1024;
      const ctrl = minecraftManager.get(tid, store);
      if (mc && mc.created) {
        await ctrl.start({ memoryMb: planRam });
        return res.json({ ok: true });
      }
      const disc = store.getDiscord();
      if (disc) {
        const r = await fetch(process.env.MINECRAFT_AGENT_URL+'/tenants/'+tid+'/bot/start', { method:'POST', headers:{'x-agent-secret':process.env.MINECRAFT_AGENT_SECRET,'content-type':'application/json'}, body: JSON.stringify({}) });
        return res.json({ ok: r.ok });
      }
      res.status(400).json({ error: 'service inconnu' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/staff/service/:tenantId/stop', requireStaff, async (req, res) => {
    try {
      const tid = parseInt(req.params.tenantId);
      const store = await tenantManager.getStore(tid);
      const mc = store.getMinecraft();
      if (mc && mc.created) {
        const ctrl = minecraftManager.get(tid, store);
        await ctrl.stop();
        return res.json({ ok: true });
      }
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/staff/service/:tenantId/restart', requireStaff, async (req, res) => {
    try {
      const tid = parseInt(req.params.tenantId);
      const store = await tenantManager.getStore(tid);
      const mc = store.getMinecraft();
      if (mc && mc.created) {
        const ctrl = minecraftManager.get(tid, store);
        await ctrl.stop();
        setTimeout(async () => {
          try { await ctrl.start({ memoryMb: mc.memoryMb }); } catch {}
        }, 3000);
        return res.json({ ok: true });
      }
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/staff/service/:tenantId', requireStaff, async (req, res) => {
    try {
      const tid = parseInt(req.params.tenantId);
      const store = await tenantManager.getStore(tid);
      const ctrl = minecraftManager.get(tid, store);
      await ctrl.deleteServer();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Staff — fichiers d'un tenant
  app.get('/api/staff/service/:tenantId/files', requireStaff, async (req, res) => {
    try {
      const tid = req.params.tenantId;
      const fs2 = require('fs');
      const path2 = require('path');
      const baseDir = '/opt/mc-agent/data/'+tid;
      const folders = ['plugins', 'mods', 'world'];
      const files = [];
      for (const folder of folders) {
        const dir = path2.join(baseDir, folder);
        if (!fs2.existsSync(dir)) continue;
        const items = fs2.readdirSync(dir);
        for (const item of items) {
          const fp = path2.join(dir, item);
          try {
            const stat = fs2.statSync(fp);
            if (stat.isFile()) files.push({ name: item, folder, path: folder+'/'+item, size: stat.size, mtime: stat.mtime });
          } catch {}
        }
      }
      res.json({ files });
    } catch(e) { res.status(500).json({ error: e.message, files: [] }); }
  });

  app.get('/api/staff/service/:tenantId/files/download', requireStaff, async (req, res) => {
    try {
      const tid = req.params.tenantId;
      const file = req.query.file;
      if (!file || file.includes('..')) return res.status(400).json({ error: 'invalid' });
      const fp = '/opt/mc-agent/data/'+tid+'/'+file;
      if (!require('fs').existsSync(fp)) return res.status(404).json({ error: 'not found' });
      res.download(fp);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Staff — joueurs connectes
  app.get('/api/staff/service/:tenantId/players', requireStaff, async (req, res) => {
    try {
      const tid = parseInt(req.params.tenantId);
      const store = await tenantManager.getStore(tid);
      const ctrl = minecraftManager.get(tid, store);
      const players = ctrl.getPlayers ? ctrl.getPlayers() : (ctrl.players || []);
      res.json({ players });
    } catch(e) { res.status(500).json({ error: e.message, players: [] }); }
  });

  app.get('/api/staff/logs', requireStaff, (req, res) => {
    res.json({ lines: [] });
  });

  app.get('/achat/confirmation', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(readView('achat-confirmation.html'));
  });

  const DISCORD_BTN_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.211.375-.457.881-.626 1.283a18.27 18.27 0 0 0-5.865 0C9.898 3.881 9.646 3.375 9.434 3a19.736 19.736 0 0 0-3.762 1.37C2.913 7.99 2.157 11.53 2.42 15.02a19.9 19.9 0 0 0 6.031 3.049c.486-.657.918-1.354 1.29-2.087a12.9 12.9 0 0 1-2.032-.98c.171-.124.338-.253.5-.386a14.16 14.16 0 0 0 12.062 0c.164.133.331.262.5.386-.646.383-1.325.71-2.033.98.372.734.804 1.43 1.29 2.087a19.86 19.86 0 0 0 6.033-3.05c.309-4.06-.548-7.567-2.744-11.65ZM9.5 13.14c-1.08 0-1.96-1.005-1.96-2.24s.862-2.24 1.96-2.24 1.982 1.014 1.963 2.24c0 1.235-.865 2.24-1.963 2.24Zm7.02 0c-1.08 0-1.96-1.005-1.96-2.24s.862-2.24 1.96-2.24 1.982 1.014 1.963 2.24c0 1.235-.865 2.24-1.963 2.24Z"/></svg>`;

  // Rend login.html en injectant CÔTÉ SERVEUR le bon lien Discord (avec le
  // slug déjà résolu) ou le petit formulaire pour saisir l'identifiant
  // d'espace — plutôt que de faire deviner le slug au JS du navigateur
  // depuis l'URL (source de bugs : cache, script bloqué, etc.).
  function renderLogin(slug) {
    let html = readView('login.html');
    if (slug) {
      html = html
        .replace('__SUB_TEXT__', `Connecte-toi avec le compte Discord autorisé sur ton espace.`)
        .replace('__SLUG_FORM__', '')
        .replace(
          '__DISCORD_BTN__',
          `<a href="/api/auth/discord/${encodeURIComponent(slug)}" class="btn-discord">${DISCORD_BTN_SVG}Se connecter avec Discord</a>
           <p class="sub" style="margin-top:16px;"><a href="/login">Ce n'est pas ton code ? Recommencer</a></p>`
        );
    } else {
      html = html
        .replace('__SUB_TEXT__', 'Connecte-toi avec le compte Discord autorisé pour gérer ton bot de tickets.')
        .replace(
          '__SLUG_FORM__',
          `<form id="slug-form">
             <div class="field">
               <label for="slug-input">Code client</label>
               <input type="text" id="slug-input" class="mono" placeholder="TCKT-XXXX-XXXX-XXXX" required autocomplete="off">
               <p class="field-hint">Le code reçu à l'achat, il te sert aussi à te connecter. Pas encore de compte ? <a href="/accueil">Voir les offres</a>.</p>
             </div>
             <button type="submit" class="btn-primary" style="width:100%">Continuer</button>
           </form>`
        )
        .replace('__DISCORD_BTN__', '');
    }
    return html;
  }

  app.get('/', (req, res) => {
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    return res.redirect('/intro');
  });

  app.get('/intro', (req, res) => {
    res.type('html').send(readView('intro.html'));
  });

  // ── Comptes locaux : nom d'utilisateur + mot de passe + identifiant
  // d'achat (remplace le formulaire de connexion par défaut). Le code
  // d'achat sert à créer/relier l'espace (tenant) du client, exactement
  // comme avant, mais l'identité de connexion n'est plus le compte
  // Discord : c'est un identifiant interne "local:<id utilisateur>"
  // stocké dans les mêmes colonnes que l'ancien discord_id, pour
  // réutiliser tel quel tout le système d'admin/rôles existant.
  app.get('/signup', (req, res) => { res.redirect('/'); });
  app.get('/signup_disabled', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    res.type('html').send(readView('signup.html'));
  });

  app.post('/api/signup', async (req, res) => {
    const { username: rawUsername, email: rawEmail, password: rawPassword, code, service: rawService } = req.body || {};
    const service = rawService === 'minecraft' ? 'minecraft' : 'discord';

    const usernameCheck = validateUsername(rawUsername);
    if (!usernameCheck.ok) return res.status(400).json({ error: usernameCheck.error });
    const emailCheck = validateEmail(rawEmail);
    if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
    const passwordCheck = validatePassword(rawPassword);
    if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });
    const username = usernameCheck.username;
    const email = emailCheck.email;

    try {
      const check = await customerCodes.checkCode(code);
      if (!check.valid) {
        const messages = {
          not_found: "Cet identifiant d'achat n'existe pas. Vérifie ta saisie.",
          already_used: 'Cet identifiant a déjà été utilisé.',
          empty: "Merci de saisir ton identifiant d'achat.",
        };
        return res.status(400).json({ error: messages[check.reason] || 'Identifiant invalide.' });
      }

      const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
      if (existing.length) {
        return res.status(400).json({ error: "Ce nom d'utilisateur est déjà pris." });
      }
      const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existingEmail.length) {
        return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée par un compte.' });
      }

      const passwordHash = hashPassword(passwordCheck.password);
      const [insertResult] = await db.query(
        'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
        [username, email, passwordHash]
      );
      const dbUserId = insertResult.insertId;
      const identity = `local:${dbUserId}`;

      try {
        const tenantId = await tenantManager.createTenantForDiscordUser(identity, username, service);

        const redeemed = await customerCodes.redeemCode(code, identity, username);
        if (!redeemed.ok) {
          // Le code a été pris entre le check et le redeem (course) : on
          // annule la création du compte/espace pour ne rien laisser de
          // "gratuit" derrière un code invalide.
          await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
          await db.query('DELETE FROM users WHERE id = ?', [dbUserId]);
          return res.status(400).json({ error: 'Cet identifiant a déjà été utilisé.' });
        }

        const store = await tenantManager.getStore(tenantId);
        if (redeemed.planType) {
          store.setSubscription({ planType: redeemed.planType, active: true });
        }
        await db.query('UPDATE customer_codes SET tenant_id = ? WHERE code = ?', [tenantId, customerCodes.normalizeCode(code)]);
        await db.query('UPDATE users SET discord_id = ?, tenant_id = ? WHERE id = ?', [identity, tenantId, dbUserId]);

        req.session.discordUser = {
          id: identity,
          username,
          handle: username,
          email,
          avatar: `https://cdn.discordapp.com/embed/avatars/${dbUserId % 5}.png`,
          dbId: dbUserId,
        };
        req.session.tenantId = tenantId;

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
          [dbUserId, ip, req.headers['user-agent'] || '']
        );

        res.json({ ok: true });
      } catch (err) {
        await db.query('DELETE FROM users WHERE id = ?', [dbUserId]);
        throw err;
      }
    } catch (err) {
      console.error('Erreur création de compte:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const username = String(req.body?.username || req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }

    try {
      const [rows] = await db.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
      const user = rows[0];
      if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
      }

      const tenantId = user.tenant_id || (await tenantManager.findTenantIdForDiscordUser(user.discord_id));
      if (!tenantId) {
        return res.status(400).json({ error: "Ce compte n'est relié à aucun espace." });
      }

      req.session.discordUser = {
        id: user.discord_id,
        username: user.username,
        handle: user.username,
        email: user.email,
        avatar: user.avatar_url || `https://cdn.discordapp.com/embed/avatars/${user.id % 5}.png`,
        dbId: user.id,
      };
      req.session.tenantId = tenantId;

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      await db.query(
        `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
        [user.id, ip, req.headers['user-agent'] || '']
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('Erreur connexion:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  // ── Création d'un nouvel espace client (sa propre appli Discord) ──
  app.get('/setup', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(readView('setup.html'));
  });

  function defaultRedirectUri(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${req.get('host')}/api/auth/discord/callback`;
  }

  app.get('/api/setup/default-redirect', (req, res) => {
    res.json({ redirectUri: defaultRedirectUri(req) });
  });

  app.post('/api/setup', async (req, res) => {
    const { code, name, clientId, clientSecret } = req.body || {};
    if (!code || !name || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'Code client, nom, Client ID et Client Secret sont obligatoires.' });
    }

    try {
      const check = await customerCodes.checkCode(code);
      if (!check.valid) {
        const messages = {
          not_found: "Ce code client n'existe pas. Vérifie ta saisie.",
          already_used: 'Ce code a déjà été utilisé.',
          empty: 'Merci de saisir ton code client.',
        };
        return res.status(400).json({ error: messages[check.reason] || 'Code invalide.' });
      }

      const { tenantId, slug } = await tenantManager.createTenantWithApp({
        name: name.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        loginCode: code,
      });

      const redeemed = await customerCodes.redeemCode(code, null, null);
      if (!redeemed.ok) {
        // Le code a été pris entre le check et le redeem (course) : on
        // annule la création du tenant pour ne pas laisser d'espace
        // "gratuit" derrière un code invalide.
        await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
        return res.status(400).json({ error: 'Ce code a déjà été utilisé.' });
      }

      const store = await tenantManager.getStore(tenantId);
      if (redeemed.planType) {
        store.setSubscription({ planType: redeemed.planType, active: true });
      }
      await db.query('UPDATE customer_codes SET tenant_id = ? WHERE code = ?', [tenantId, customerCodes.normalizeCode(code)]);

      res.json({ ok: true, slug, loginUrl: `/login/${slug}` });
    } catch (err) {
      console.error('Erreur création espace client:', err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  // ── Login via Discord OAuth2 (une appli Discord PAR client) ───────
  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    res.type('html').send(readView('login.html'));
  });

  app.get('/login/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.discordUser && req.session.tenantId) return res.redirect('/dashboard');
    const tenant = await tenantManager.findTenantByLoginCode(req.params.slug);
    if (!tenant || !tenant.client_id) {
      return res.redirect('/login?error=' + encodeURIComponent("Espace introuvable. Vérifie ton code."));
    }
    res.type('html').send(renderLogin(req.params.slug));
  });

  app.get('/api/auth/discord/:slug', async (req, res) => {
    const tenant = await tenantManager.findTenantByLoginCode(req.params.slug);
    if (!tenant || !tenant.client_id) {
      return res.redirect('/login?error=' + encodeURIComponent('Espace introuvable.'));
    }

    // Réinitialise la session pour éviter les conflits d'état
    req.session.oauthState = null;
    req.session.oauthTenantId = null;

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    req.session.oauthTenantId = tenant.id;

    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', tenant.client_id);
    url.searchParams.set('redirect_uri', defaultRedirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  });

  app.get('/api/auth/discord/callback', async (req, res) => {
    const { code, state } = req.query;
    const tenantId = req.session.oauthTenantId;
    if (!code || !state || state !== req.session.oauthState || !tenantId) {
      return res.redirect('/login?error=' + encodeURIComponent('Requête invalide ou expirée, réessaie de te connecter.'));
    }
    delete req.session.oauthState;
    delete req.session.oauthTenantId;

    const tenant = await tenantManager.findTenantById(tenantId);
    if (!tenant || !tenant.client_id || !tenant.client_secret) {
      return res.redirect('/login?error=' + encodeURIComponent('Espace introuvable.'));
    }
    const loginUrl = `/login/${tenant.slug}`;

    try {
      // Authentification Basic Auth + URLSearchParams encodé en chaîne de caractères
      const credentials = Buffer.from(`${tenant.client_id}:${tenant.client_secret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: defaultRedirectUri(req),
      });

      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const errorData = await tokenRes.json().catch(() => ({}));
        console.error('Erreur détaillée échange token Discord :', errorData);
        throw new Error(`Échange du code refusé par Discord (${tokenRes.status})`);
      }

      const tokenData = await tokenRes.json();

      const userRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) throw new Error("Impossible de récupérer ton profil Discord.");
      const user = await userRes.json();

      const discordProfile = {
        id: user.id,
        username: user.global_name || user.username,
        handle: user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username,
        avatar: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`,
      };

      // Le tenant a-t-il déjà un propriétaire ?
      let authorized = false;
      if (!tenant.owner_discord_id) {
        // Première connexion sur cet espace : ce compte en devient le
        // propriétaire (opération atomique, protège contre le double-clic).
        authorized = await tenantManager.claimTenant(tenant.id, user.id);
      } else {
        const store = await tenantManager.getStore(tenant.id);
        authorized = store.isAdmin(user.id);
      }

      if (!authorized) {
        return res.redirect(loginUrl + '?error=' + encodeURIComponent("Ce compte Discord n'a pas accès à cet espace."));
      }

      req.session.discordUser = discordProfile;
      req.session.tenantId = tenant.id;

      try {
        await db.query(
          `INSERT INTO users (discord_id, username, tenant_id) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE username = VALUES(username), tenant_id = VALUES(tenant_id)`,
          [user.id, user.global_name || user.username, tenant.id]
        );

        const [userRows] = await db.query('SELECT id FROM users WHERE discord_id = ?', [user.id]);
        const dbUserId = userRows[0].id;
        req.session.discordUser.dbId = dbUserId;

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGIN', ?, ?)`,
          [dbUserId, ip, req.headers['user-agent'] || '']
        );
      } catch (sqlErr) {
        console.error('Erreur SQL lors de la connexion :', sqlErr.message);
      }

      res.redirect('/dashboard');
    } catch (err) {
      console.error('Erreur OAuth Discord:', err.message);
      res.redirect(loginUrl + '?error=' + encodeURIComponent('Connexion Discord échouée, réessaie.'));
    }
  });

  app.get('/api/admin/customer-codes', requireAuth, resolveTenant, requireRole('administrateur'), async (req, res) => {
    try {
      const codes = await customerCodes.listCodes();
      res.json({ codes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logout', async (req, res) => {
    if (req.session.discordUser && req.session.discordUser.dbId) {
      try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await db.query(
          `INSERT INTO connection_logs (user_id, event_type, ip_address, user_agent) VALUES (?, 'LOGOUT', ?, ?)`,
          [req.session.discordUser.dbId, ip, req.headers['user-agent'] || '']
        );
      } catch (sqlErr) {
        console.error('Erreur SQL Déconnexion :', sqlErr.message);
      }
    }
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ── Dashboard ──────────
  app.get('/dashboard', requireAuth, (req, res) => {
    res.type('html').send(readView('dashboard.html'));
  });

  const api = express.Router();

  // ── Abonnement Stripe : infos + portail client ───────────────────────
  api.get('/subscription', resolveTenant, async (req, res) => {
    const sub = req.tenantStore.getSubscription();
    const plan = stripeCheckout.PLAN_CATALOG[sub.planType] || null;
    let stripeData = null;
    if (sub.stripeSubId && stripeCheckout.isConfigured()) {
      try {
        const stripeSub = await stripeCheckout.getStripe()
          .subscriptions.retrieve(sub.stripeSubId, { expand: ['customer'] });
        stripeData = {
          status:            stripeSub.status,
          currentPeriodEnd:  stripeSub.current_period_end,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
          customerEmail:     stripeSub.customer?.email || null,
          customerName:      stripeSub.customer?.name  || null,
        };
      } catch (err) { console.error('Stripe sub retrieve:', err.message); }
    }
    res.json({
      active: sub.active || false, planType: sub.planType || null,
      planLabel: plan?.label || null, stripeSubId: sub.stripeSubId || null,
      renewedAt: sub.renewedAt || null, cancelAt: sub.cancelAt || null,
      stripe: stripeData,
    });
  });

  api.post('/subscription/portal', async (req, res) => {
    const sub = req.tenantStore.getSubscription();
    if (!sub.stripeCustomer) return res.status(400).json({ error: 'Aucun abonnement Stripe lié.' });
    if (!stripeCheckout.isConfigured()) return res.status(503).json({ error: 'Stripe non configuré.' });
    try {
      const baseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
      const session = await stripeCheckout.getStripe().billingPortal.sessions.create({
        customer: sub.stripeCustomer, return_url: `${baseUrl}/dashboard`,
      });
      res.json({ url: session.url });
    } catch (err) { console.error('Stripe portal:', err.message); res.status(500).json({ error: 'Erreur portail.' }); }
  });
  // Bloquer les actions en mode demo
  api.use((req, res, next) => {
    if (req.session?.discordUser?.isDemo) {
      const blocked = ['POST','DELETE','PUT','PATCH'];
      const allowedGet = ['/me', '/service', '/server/stats', '/minecraft', '/subscription'];
      if (blocked.includes(req.method)) {
        return res.status(403).json({ error: 'Mode demonstration — actions desactivees. Achetez un service pour acceder a toutes les fonctionnalites.' });
      }
    }
    next();
  });

  api.use(requireAuth, resolveTenant);

  api.get('/me', async (req, res) => {
    try {
      const userId = req.session.discordUser?.dbId;
      let linkedTenantId = null;
      if (userId) {
        const [rows] = await db.query('SELECT linked_tenant_id FROM users WHERE id = ?', [userId]);
        linkedTenantId = rows[0]?.linked_tenant_id || null;
      }
      const sub = req.tenantStore.getSubscription();
      res.json({
        user: req.session.discordUser,
        admins: req.tenantStore.getAdminIds(),
        role: req.adminRole,
        linkedTenantId,
        service: req.tenantService,
        planType: sub?.planType || null,
      });
    } catch(e) {
      res.json({ user: req.session.discordUser, admins: req.tenantStore.getAdminIds(), role: req.adminRole });
    }
  });

  // ── Paramètres du compte : photo de profil ─────────────────────
  const MAX_AVATAR_DATA_URL_LENGTH = 1.5 * 1024 * 1024; // ~1.5 Mo en base64

  api.post('/profile/avatar', async (req, res) => {
    const avatar = String(req.body?.avatar || '');
    if (!avatar) return res.status(400).json({ error: 'Aucune image fournie.' });
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(avatar)) {
      return res.status(400).json({ error: 'Format d\'image non supporté.' });
    }
    if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) {
      return res.status(400).json({ error: 'Image trop lourde (2 Mo maximum).' });
    }

    const dbUserId = req.session.discordUser?.dbId;
    if (!dbUserId) return res.status(400).json({ error: "Compte introuvable." });

    try {
      await db.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar, dbUserId]);
      req.session.discordUser.avatar = avatar;
      res.json({ ok: true, avatar });
    } catch (err) {
      console.error('Erreur sauvegarde avatar:', err.message);
      res.status(500).json({ error: 'Impossible d\'enregistrer la photo de profil.' });
    }
  });

  // ── Paramètres du compte : nom d'utilisateur ────────────────────
  // Uniquement pour les comptes locaux (identifiant "local:<id>", créés via
  // /signup avec mot de passe) : pour un compte connecté via Discord, le
  // pseudo est resynchronisé depuis Discord à CHAQUE connexion (voir le
  // callback OAuth plus haut, `ON DUPLICATE KEY UPDATE username = ...`), donc
  // le laisser modifiable ici serait un changement qui s'annule tout seul
  // à la prochaine connexion — mieux vaut refuser clairement que de laisser
  // croire que ça a marché.
  api.post('/profile/username', async (req, res) => {
    const dbUserId = req.session.discordUser?.dbId;
    const accountId = String(req.session.discordUser?.id || '');
    if (!dbUserId) return res.status(400).json({ error: 'Compte introuvable.' });
    if (!accountId.startsWith('local:')) {
      return res.status(400).json({
        error: "Ce compte est connecté via Discord : le nom d'utilisateur est synchronisé automatiquement depuis ton profil Discord et ne peut pas être changé ici.",
      });
    }

    const check = validateUsername(req.body?.username);
    if (!check.ok) return res.status(400).json({ error: check.error });

    try {
      const [existing] = await db.query('SELECT id FROM users WHERE username = ? AND id != ?', [check.username, dbUserId]);
      if (existing.length) return res.status(400).json({ error: "Ce nom d'utilisateur est déjà pris." });

      await db.query('UPDATE users SET username = ? WHERE id = ?', [check.username, dbUserId]);
      req.session.discordUser.username = check.username;
      req.session.discordUser.handle = check.username;
      res.json({ ok: true, username: check.username });
    } catch (err) {
      console.error('Erreur sauvegarde username:', err.message);
      res.status(500).json({ error: "Impossible d'enregistrer le nom d'utilisateur." });
    }
  });

  // ── Paramètres du compte : e-mail ────────────────────────────────
  // Comme pour le pseudo, réservé aux comptes locaux : c'est l'e-mail qui
  // sert d'identifiant de connexion pour ces comptes, un compte Discord
  // n'en a pas.
  api.post('/profile/email', async (req, res) => {
    const dbUserId = req.session.discordUser?.dbId;
    const accountId = String(req.session.discordUser?.id || '');
    if (!dbUserId) return res.status(400).json({ error: 'Compte introuvable.' });
    if (!accountId.startsWith('local:')) {
      return res.status(400).json({
        error: "Ce compte est connecté via Discord et n'a pas d'e-mail associé sur ce dashboard.",
      });
    }

    const check = validateEmail(req.body?.email);
    if (!check.ok) return res.status(400).json({ error: check.error });

    try {
      const [existing] = await db.query('SELECT id FROM users WHERE email = ? AND id != ?', [check.email, dbUserId]);
      if (existing.length) return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée par un autre compte.' });

      await db.query('UPDATE users SET email = ? WHERE id = ?', [check.email, dbUserId]);
      req.session.discordUser.email = check.email;
      res.json({ ok: true, email: check.email });
    } catch (err) {
      console.error('Erreur sauvegarde e-mail:', err.message);
      res.status(500).json({ error: "Impossible d'enregistrer l'adresse e-mail." });
    }
  });

  api.get('/fivem/config', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const [rows] = await db.query('SELECT fivem_enabled, fivem_url, blur_val FROM user_configs WHERE user_id = ?', [dbUserId]);
      if (rows.length > 0) {
        return res.json({
          enabled: Boolean(rows[0].fivem_enabled),
          url: rows[0].fivem_url,
          blurVal: rows[0].blur_val
        });
      }
      res.json({ enabled: false, url: '', blurVal: 5 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erreur serveur lors de la récupération SQL." });
    }
  });

  api.post('/fivem/config', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const { enabled, url } = req.body;

      await db.query(`
        INSERT INTO user_configs (user_id, fivem_enabled, fivem_url)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE fivem_enabled = VALUES(fivem_enabled), fivem_url = VALUES(fivem_url)
      `, [dbUserId, enabled ? 1 : 0, url || '']);

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Impossible d'enregistrer la configuration dans MySQL." });
    }
  });

  api.get('/fivem/bans', async (req, res) => {
    try {
      const dbUserId = req.session.discordUser.dbId;
      const [rows] = await db.query('SELECT fivem_url FROM user_configs WHERE user_id = ?', [dbUserId]);
      if (!rows.length || !rows[0].fivem_url) return res.json([]);
      res.json([]);
    } catch (err) {
      res.status(500).json({ error: "Erreur lors de la récupération des bannis." });
    }
  });

  api.get('/status', async (req, res) => {
    if (req.tenantService === 'minecraft') {
      if (minecraftAgent.isConfigured()) {
        try {
          const r = await minecraftAgent.getStatus(req.tenantId);
          return res.json(r.status || { status: 'stopped' });
        } catch (err) {
          return res.json({ status: 'stopped', lastError: err.message });
        }
      }
      try { return res.json(req.minecraft.getStatus()); } catch { return res.json({ status: 'stopped' }); }
    }
    res.json(req.bot.getStatus());
  });

  // ── Service du tenant courant : détermine ce que le front affiche ──
  // Fixé définitivement au choix fait à l'inscription (voir /api/signup) :
  // pas de route pour en changer, un tenant Minecraft n'a jamais accès aux
  // fonctionnalités Discord et inversement.
  // Switcher de service (bundle)
  api.post('/switch-service', async (req, res) => {
    try {
      const userId = req.session.discordUser?.dbId;
      if (!userId) return res.status(401).json({ error: 'Non authentifie.' });
      const [rows] = await db.query('SELECT linked_tenant_id, tenant_id FROM users WHERE id = ?', [userId]);
      if (!rows.length || !rows[0].linked_tenant_id) return res.status(400).json({ error: 'Pas de service lie.' });
      const current = req.session.tenantId;
      const linked = rows[0].linked_tenant_id;
      const main = rows[0].tenant_id;
      // Switcher vers l'autre tenant
      const next = current === main ? linked : main;
      req.session.tenantId = next;
      res.json({ ok: true, tenantId: next });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Souscrire addon sous-domaine
  api.post('/subdomain/subscribe', async (req, res) => {
    try {
      if (!stripeCheckout.isConfigured()) return res.status(503).json({ error: 'Paiement indisponible.' });
      const store = req.tenantStore;
      const sub = store.getSubscription();
      if (!sub || !sub.active) return res.status(400).json({ error: 'Abonnement actif requis.' });
      if (sub.subdomainActive) return res.status(400).json({ error: 'Option deja activee.' });
      const session = await stripeCheckout.getStripe().checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: 'price_1UMOHFFbO0HnEMFJUohPW74i', quantity: 1 }],
        metadata: { planId: 'subdomain_addon', tenantId: String(req.tenantId) },
        subscription_data: { metadata: { planId: 'subdomain_addon', tenantId: String(req.tenantId) } },
        success_url: publicBaseUrl(req)+'/dashboard?subdomain_success=1',
        cancel_url: publicBaseUrl(req)+'/dashboard',
      });
      res.json({ url: session.url });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Sous-domaine Cloudflare
  api.get('/subdomain', async (req, res) => {
    try {
      const store = req.tenantStore;
      const mc = store.getMinecraft();
      const sub = store.settings.subdomain || null;
      const subData = store.getSubscription() || {};
      const subActive = subData.subdomainActive || false;
      const planT = subData.planType || '';
      const subFree = ['minecraft_pro','minecraft_custom','combo'].some(p => planT.includes(p));
      res.json({ subdomain: sub, port: mc?.port || null, subdomainActive: subActive, subdomainFree: subFree });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  api.post('/subdomain', async (req, res) => {
    try {
      const { slug } = req.body || {};
      if (!slug) return res.status(400).json({ error: 'Nom requis.' });
      const cf = require('../lib/cloudflare');
      const store = req.tenantStore;
      const existing = store.settings.subdomain;
      if (existing && existing.recordId) return res.status(400).json({ error: 'Sous-domaine deja configure : '+existing.hostname });
      const sub = store.getSubscription();
      const freeSubdomainPlans = ['minecraft_pro', 'minecraft_custom', 'combo'];
      const planType = sub?.planType || '';
      const isFree = freeSubdomainPlans.some(p => planType.startsWith(p)) || planType.includes('pro') || planType.includes('custom') || planType.includes('combo');
      if (!isFree && !sub?.subdomainActive) return res.status(402).json({ error: 'Option sous-domaine non activee.', upgrade: true });
      const mc = store.getMinecraft();
      if (!mc) return res.status(400).json({ error: 'Serveur Minecraft requis.' });
      const result = await cf.createMinecraftSubdomain(slug, mc.port);
      store.settings.subdomain = { ...result, slug, port: mc.port };
      store.save();
      res.json({ ok: true, ...result });
    } catch(e) { res.status(400).json({ error: e.message }); }
  });

  api.delete('/subdomain', async (req, res) => {
    try {
      const cf = require('../lib/cloudflare');
      const store = req.tenantStore;
      const existing = store.settings.subdomain;
      if (!existing) return res.status(400).json({ error: 'Aucun sous-domaine configure.' });
      await cf.deleteSubdomain(existing.recordId, existing.srvRecordId);
      store.settings.subdomain = null;
      store.save();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  api.get('/subdomain/check', async (req, res) => {
    try {
      const { slug } = req.query;
      if (!slug) return res.status(400).json({ error: 'Slug requis.' });
      const cf = require('../lib/cloudflare');
      const available = await cf.isSlugAvailable(slug);
      res.json({ available });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Systeme de parrainage
  api.get('/referral', async (req, res) => {
    try {
      const tenantId = req.tenantId;
      const code = 'VHOST-'+Buffer.from(String(tenantId)).toString('base64').replace(/=/g,'').toUpperCase().slice(0,8);
      const [rows] = await db.query("SELECT COUNT(*) as n FROM users WHERE referral_code=?", [code]);
      const count = rows[0]?.n || 0;
      const store = req.tenantStore;
      const bonusMonths = store.settings.referralBonus || 0;
      res.json({ code, count, bonusMonths });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  api.get('/service', (req, res) => {
    res.json({ service: req.tenantService });
  });

  // ── Console du serveur : conso CPU/RAM réelle (hôte + process suivi) ──
  // Le "process suivi" dépend du service actif du tenant : le vrai PID du
  // serveur Minecraft (lu via /proc) s'il tourne, sinon le process Node du
  // dashboard lui-même (qui héberge aussi le bot Discord en in-process).
  api.get('/server/stats', (req, res) => {
    const host = processStats.hostStats();
    let proc = null;
    if (req.tenantService === 'minecraft' && req.minecraft?.process?.pid && req.minecraft.status === 'running') {
      // sampleChildProcess() renvoie null si /proc est indisponible (ex: hôte
      // Windows) — le process Minecraft tourne quand même. On garde `running:
      // true` et on marque juste les métriques comme indisponibles plutôt que
      // de renvoyer `proc = null`, ce qui faisait passer la carte à "Hors
      // ligne" alors que le serveur est bel et bien en ligne.
      const sample = processStats.sampleChildProcess(req.minecraft.process.pid);
      proc = {
        label: 'Serveur Minecraft',
        pid: req.minecraft.process.pid,
        running: true,
        cpuPercent: sample ? sample.cpuPercent : null,
        memMb: sample ? sample.memMb : null,
        statsUnavailable: !sample,
      };
    } else if (req.tenantService === 'minecraft') {
      proc = { label: 'Serveur Minecraft', running: false, cpuPercent: 0, memMb: 0 };
    } else if (req.botHost?.process?.pid && req.botHost.status === 'running') {
      // Le vrai bot hébergé (fichiers du client) est en cours d'exécution :
      // on suit CE process plutôt que le process du dashboard lui-même,
      // beaucoup plus pertinent pour un client qui héberge son propre bot.
      const sample = processStats.sampleChildProcess(req.botHost.process.pid);
      proc = {
        label: 'Bot hébergé',
        pid: req.botHost.process.pid,
        running: true,
        cpuPercent: sample ? sample.cpuPercent : null,
        memMb: sample ? sample.memMb : null,
        statsUnavailable: !sample,
      };
    } else {
      const sample = processStats.sampleSelfProcess();
      proc = {
        label: 'Bot Discord',
        pid: process.pid,
        running: req.bot?.getStatus?.().status === 'online',
        cpuPercent: sample ? sample.cpuPercent : null,
        memMb: sample ? sample.memMb : null,
        statsUnavailable: !sample,
      };
    }
    res.json({ host, process: proc });
  });

  api.get('/settings', requireDiscord, requireRole('administrateur'), (req, res) => {
    const b = req.tenantStore.getBot();
    res.json({
      bot: { ...b, token: b.token ? maskToken(b.token) : '' },
      hasToken: !!b.token,
      ticketTypes: req.tenantStore.getTicketTypes(),
    });
  });

  api.post('/settings/bot', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const patch = { ...req.body };
    const isTokenChange = !!(patch.token && !patch.token.includes('•'));
    if (patch.token && patch.token.includes('•')) delete patch.token;
    const updated = req.tenantStore.setBot(patch);
    auditLog.logFromRequest(req, 'settings.bot.update', null, {
      fieldsChanged: Object.keys(patch),
      tokenChanged: isTokenChange,
    });

    let panel = null;
    if (!isTokenChange) {
      panel = await req.bot.refreshPanel();
    } else if (patch.token) {
      // Ne PAS attendre la reconnexion complète ici : login() peut prendre
      // plusieurs secondes (voire rester bloqué en cas de souci réseau côté
      // Discord), ce qui gelait toute la requête et donnait l'impression
      // que le dashboard était bloqué sur "connexion en cours". On lance la
      // reconnexion en tâche de fond et on répond tout de suite ; le front
      // suit la progression via le polling de /api/status.
      req.bot.restart().catch((err) => {
        console.error(`Erreur reconnexion bot (tenant ${req.tenantId}):`, err.message);
      });
    }

    res.json({
      ok: true,
      bot: { ...updated, token: updated.token ? maskToken(updated.token) : '' },
      panel,
    });
  });

  // ── Playlist musicale (Configuration générale) ────────────────────
  // Upload de pistes (tous formats acceptés : .mp3, .wav, .mp4, .ogg...)
  // + lecture en boucle sur le serveur Minecraft du tenant, quand il en
  // a un (voir lib/musicManager.js pour la limite technique honnête sur
  // ce que "jouer" une piste veut vraiment dire en jeu).
  api.get('/music', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const config = req.tenantStore.getMusicPlaylist();
    res.json({
      ...config,
      playing: musicManager.isPlaying(req.tenantId),
      currentTrackId: musicManager.currentTrackId(req.tenantId),
      hasLinkedServer: req.tenantService === 'minecraft',
    });
  });

  api.post('/music/config', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const { enabled, volume, loop, trackDurationSec } = req.body || {};
    const patch = {};
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (volume !== undefined) patch.volume = Math.max(0, Math.min(100, Number(volume) || 0));
    if (loop !== undefined) patch.loop = !!loop;
    if (trackDurationSec !== undefined) patch.trackDurationSec = Math.max(5, Number(trackDurationSec) || 180);
    const updated = req.tenantStore.setMusicPlaylist(patch);
    auditLog.logFromRequest(req, 'music.config.update', null, { fieldsChanged: Object.keys(patch) });

    // La playlist se lance/coupe toute seule au démarrage/arrêt du
    // serveur (voir resolveTenant + musicManager.autoStartIfEnabled) —
    // mais si l'admin active/désactive la case "Diffusion automatique"
    // alors que le serveur tourne déjà, on applique l'effet tout de suite
    // plutôt que d'attendre le prochain redémarrage.
    if (patch.enabled !== undefined && req.tenantService === 'minecraft' && req.minecraft) {
      if (patch.enabled && req.minecraft.status === 'running') {
        try {
          musicManager.startPlaylist(req.tenantId, req.tenantStore, req.minecraft);
        } catch {
          // Playlist vide, etc. — pas bloquant, l'admin verra l'erreur au
          // prochain ajout de piste / passage à "running".
        }
      } else if (!patch.enabled) {
        musicManager.stopPlaylist(req.tenantId);
      }
    }

    res.json(updated);
  });

  api.post('/music/tracks', requireMinecraft, requireRole('administrateur'), express.json({ limit: '90mb' }), async (req, res) => {
    try {
      const track = await musicManager.saveTrack(req.tenantId, {
        name: req.body?.name,
        base64: req.body?.base64,
      });
      const config = req.tenantStore.getMusicPlaylist();
      const updated = req.tenantStore.setMusicPlaylist({ tracks: [...config.tracks, track] });
      auditLog.logFromRequest(req, 'music.track.add', null, { name: track.name });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/music/tracks/delete', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const trackId = req.body?.id;
      const config = req.tenantStore.getMusicPlaylist();
      const track = config.tracks.find((t) => t.id === trackId);
      if (!track) return res.status(404).json({ error: 'Piste introuvable.' });
      await musicManager.deleteTrack(req.tenantId, track.filename);
      const updated = req.tenantStore.setMusicPlaylist({ tracks: config.tracks.filter((t) => t.id !== trackId) });
      auditLog.logFromRequest(req, 'music.track.delete', null, { name: track.name });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/music/tracks/reorder', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    const config = req.tenantStore.getMusicPlaylist();
    const byId = new Map(config.tracks.map((t) => [t.id, t]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    // Sécurité : si l'ordre reçu ne couvre pas toutes les pistes (bug front,
    // requête tronquée...), on complète avec celles manquantes plutôt que
    // de silencieusement en perdre.
    for (const t of config.tracks) if (!order.includes(t.id)) reordered.push(t);
    const updated = req.tenantStore.setMusicPlaylist({ tracks: reordered });
    res.json(updated);
  });

  api.post('/music/play', requireMinecraft, requireRole('administrateur'), (req, res) => {
    if (req.tenantService !== 'minecraft' || !req.minecraft) {
      return res.status(400).json({ error: "Aucun serveur Minecraft n'est lié à ce compte." });
    }
    try {
      const result = musicManager.startPlaylist(req.tenantId, req.tenantStore, req.minecraft, {
        fromTrackId: req.body?.id,
      });
      req.tenantStore.setMusicPlaylist({ enabled: true });
      auditLog.logFromRequest(req, 'music.play', null, {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/music/stop', requireMinecraft, requireRole('administrateur'), (req, res) => {
    musicManager.stopPlaylist(req.tenantId);
    req.tenantStore.setMusicPlaylist({ enabled: false });
    auditLog.logFromRequest(req, 'music.stop', null, {});
    res.json({ playing: false });
  });

  api.post('/music/resource-pack', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const result = await musicManager.buildResourcePack(req.tenantId, req.tenantStore, req.minecraft);
      auditLog.logFromRequest(req, 'music.resourcepack.build', null, result);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/music/resource-pack/download', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const filePath = musicManager.resourcePackDownloadPath(req.tenantId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Génère le resource pack avant de le télécharger.' });
    res.download(filePath, 'playlist-musicale.mcpack');
  });

  // ── Module DayZ (économie / safe zones / classements) ────────────
  // Réservé aux administrateurs du dashboard (la whitelist "staff DayZ"
  // pour /dayz-give et /dayz-link est une notion séparée, gérée via ces
  // mêmes routes mais consommée côté Discord par store.isDayzStaff()).
  api.get('/dayz/settings', requireDiscord, requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    res.json({ ...dayzConfig, rcon: { ...dayzConfig.rcon, password: dayzConfig.rcon.password ? '••••••••' : '' } });
  });

  api.post('/dayz/settings', requireDiscord, requireRole('administrateur'), (req, res) => {
    const patch = { ...req.body };
    if (patch.rcon && typeof patch.rcon.password === 'string' && patch.rcon.password.includes('•')) {
      delete patch.rcon.password; // champ masqué renvoyé tel quel -> on ne l'écrase pas
    }
    const updated = req.tenantStore.setDayz(patch);
    auditLog.logFromRequest(req, 'settings.dayz.update', null, { fieldsChanged: Object.keys(patch) });
    res.json({ ok: true, dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' } } });
  });

  // ── Liaison compte Nitrado : récupère automatiquement les accès RCon
  // + le dossier de logs ADM depuis le token API Nitrado du client, sans
  // qu'il ait besoin de connaître ces infos (utile en particulier pour
  // un serveur PS4/PS5 où il n'y a pas d'accès FTP/RCon direct).
  api.get('/dayz/nitrado', requireDiscord, requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const n = dayzConfig.nitrado || {};
    res.json({ ...n, token: n.token ? '••••••••' : '' });
  });

  // Étape 1 : le client colle son token API Nitrado -> on vérifie qu'il
  // est valide et on renvoie la liste de ses services pour qu'il
  // choisisse lequel est son serveur DayZ (sans rien enregistrer tant
  // que le choix n'est pas fait, cf. /dayz/nitrado/select).
  api.post('/dayz/nitrado/link', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token API Nitrado requis.' });
    try {
      const services = await nitradoApi.listServices(token);
      res.json({ ok: true, services });
    } catch (err) {
      res.status(400).json({ error: `Token Nitrado invalide ou API injoignable : ${err.message}` });
    }
  });

  // Étape 2 : le client choisit son service DayZ parmi la liste -> on
  // enregistre token + serviceId, puis on synchronise tout de suite.
  api.post('/dayz/nitrado/select', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const serviceId = String(req.body?.serviceId || '').trim();
    if (!token || !serviceId) return res.status(400).json({ error: 'token et serviceId requis.' });

    req.tenantStore.setDayz({ nitrado: { token, serviceId, linked: true } });

    try {
      const result = await nitradoApi.fetchRconAndLogConfig(token, serviceId);
      const dayzPatch = {
        nitrado: { lastSyncAt: Date.now(), lastSyncError: result.missing.length ? result.missing.join(', ') : null },
      };
      if (result.host) dayzPatch.rcon = { ...dayzPatch.rcon, host: result.host };
      if (result.port) dayzPatch.rcon = { ...dayzPatch.rcon, port: result.port };
      if (result.password) dayzPatch.rcon = { ...dayzPatch.rcon, password: result.password };
      if (result.admLogDir) dayzPatch.admLogDir = result.admLogDir;
      const updated = req.tenantStore.setDayz(dayzPatch);
      res.json({
        ok: true,
        dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' }, nitrado: { ...updated.nitrado, token: '••••••••' } },
        missing: result.missing,
      });
    } catch (err) {
      req.tenantStore.setDayz({ nitrado: { lastSyncError: err.message } });
      res.status(200).json({
        ok: true,
        dayz: req.tenantStore.getDayz(),
        warning: `Serveur lié, mais synchro auto impossible (${err.message}). Renseigne le RCon manuellement ci-dessous.`,
      });
    }
  });

  // Resynchronise à la demande (ex: le client a changé son mot de passe
  // RCon côté Nitrado et veut que le dashboard le retrouve tout seul).
  api.post('/dayz/nitrado/sync', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const n = dayzConfig.nitrado || {};
    if (!n.linked || !n.token || !n.serviceId) {
      return res.status(400).json({ error: 'Aucun compte Nitrado lié.' });
    }
    try {
      const result = await nitradoApi.fetchRconAndLogConfig(n.token, n.serviceId);
      const dayzPatch = { nitrado: { lastSyncAt: Date.now(), lastSyncError: result.missing.length ? result.missing.join(', ') : null } };
      if (result.host) dayzPatch.rcon = { ...dayzPatch.rcon, host: result.host };
      if (result.port) dayzPatch.rcon = { ...dayzPatch.rcon, port: result.port };
      if (result.password) dayzPatch.rcon = { ...dayzPatch.rcon, password: result.password };
      if (result.admLogDir) dayzPatch.admLogDir = result.admLogDir;
      const updated = req.tenantStore.setDayz(dayzPatch);
      res.json({ ok: true, dayz: { ...updated, rcon: { ...updated.rcon, password: updated.rcon.password ? '••••••••' : '' }, nitrado: { ...updated.nitrado, token: '••••••••' } }, missing: result.missing });
    } catch (err) {
      req.tenantStore.setDayz({ nitrado: { lastSyncError: err.message } });
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/dayz/nitrado', requireDiscord, requireRole('administrateur'), (req, res) => {
    const updated = req.tenantStore.setDayz({ nitrado: { token: '', serviceId: '', linked: false, lastSyncAt: null, lastSyncError: null } });
    res.json({ ok: true, dayz: updated });
  });

  api.post('/dayz/safezones', requireDiscord, requireRole('administrateur'), (req, res) => {
    const { name, x, z, radius } = req.body || {};
    if (!name || typeof x !== 'number' || typeof z !== 'number' || typeof radius !== 'number') {
      return res.status(400).json({ error: 'Champs requis : name (texte), x, z, radius (nombres).' });
    }
    const zones = req.tenantStore.addDayzSafeZone({ name, x, z, radius });
    res.json({ ok: true, safeZones: zones });
  });

  api.delete('/dayz/safezones/:id', requireDiscord, requireRole('administrateur'), (req, res) => {
    const zones = req.tenantStore.removeDayzSafeZone(req.params.id);
    res.json({ ok: true, safeZones: zones });
  });

  // Staff DayZ (autorisé à /dayz-give et /dayz-link côté Discord, sans
  // forcément avoir accès au dashboard lui-même).
  api.post('/dayz/staff', requireDiscord, requireRole('administrateur'), (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{15,25}$/.test(discordId)) return res.status(400).json({ error: 'ID Discord invalide.' });
    const dayzConfig = req.tenantStore.getDayz();
    if (!dayzConfig.staffWhitelist.includes(discordId)) dayzConfig.staffWhitelist.push(discordId);
    const updated = req.tenantStore.setDayz({ staffWhitelist: dayzConfig.staffWhitelist });
    res.json({ ok: true, staffWhitelist: updated.staffWhitelist });
  });

  api.delete('/dayz/staff/:discordId', requireDiscord, requireRole('administrateur'), (req, res) => {
    const dayzConfig = req.tenantStore.getDayz();
    const staffWhitelist = dayzConfig.staffWhitelist.filter((id) => id !== req.params.discordId);
    const updated = req.tenantStore.setDayz({ staffWhitelist });
    res.json({ ok: true, staffWhitelist: updated.staffWhitelist });
  });

  api.get('/dayz/leaderboard', requireDiscord, async (req, res) => {
    const type = ['money', 'kills', 'ratio'].includes(req.query.type) ? req.query.type : 'money';
    const rows = await getDayzLeaderboard(req.tenantId, type, 20);
    res.json({ type, rows });
  });

  api.get('/dayz/ban-log', requireDiscord, requireRole('administrateur', 'moderateur'), async (req, res) => {
    const [rows] = await db.query(
      'SELECT * FROM dayz_ban_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100',
      [req.tenantId]
    );
    res.json({ rows });
  });

  // ── Bot Discord hébergé (fichiers propres au client, cf. onglet
  // Fichiers) : start/stop/restart d'un process Node arbitraire, comme le
  // fait minecraftManager pour le serveur Minecraft. N'a rien à voir avec
  // le bot de tickets (/api/settings/bot, /api/status, botManager). ────
  api.get('/bot-host', requireDiscord, requireRole('administrateur'), (req, res) => {
    res.json({ config: req.tenantStore.getBotHost(), runtime: req.botHost.getStatus() });
  });

  api.post('/bot-host/settings', requireDiscord, requireRole('administrateur'), (req, res) => {
    const { entryFile, autoRestart } = req.body || {};
    const patch = {};
    if (typeof entryFile === 'string' && entryFile.trim()) patch.entryFile = entryFile.trim();
    if (autoRestart !== undefined) patch.autoRestart = !!autoRestart;
    const updated = req.tenantStore.setBotHost(patch);
    if (updated.entryFile) req.botHost.entryFile = updated.entryFile;
    auditLog.logFromRequest(req, 'bothost.settings', updated.entryFile);
    res.json({ ok: true, config: updated });
  });

  api.post('/bot-host/start', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getBotHost();
    auditLog.logFromRequest(req, 'bothost.start.launched', cfg.entryFile);
    try {
      const result = await req.botHost.start({ entryFile: cfg.entryFile });
      res.json(result);
      auditLog.logFromRequest(req, 'bothost.start.success', cfg.entryFile);
    } catch (err) {
      res.status(400).json({ error: err.message });
      auditLog.logFromRequest(req, 'bothost.start.failed', cfg.entryFile, { error: err.message });
    }
  });

  api.post('/bot-host/stop', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getBotHost();
    res.json(await req.botHost.stop());
    auditLog.logFromRequest(req, 'bothost.stop', cfg.entryFile);
  });

  api.post('/bot-host/restart', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getBotHost();
    auditLog.logFromRequest(req, 'bothost.restart.launched', cfg.entryFile);
    try {
      const result = await req.botHost.restart({ entryFile: cfg.entryFile });
      res.json(result);
      auditLog.logFromRequest(req, 'bothost.restart.success', cfg.entryFile);
    } catch (err) {
      res.status(400).json({ error: err.message });
      auditLog.logFromRequest(req, 'bothost.restart.failed', cfg.entryFile, { error: err.message });
    }
  });

  api.get('/bot-host/logs', requireDiscord, requireRole('administrateur'), (req, res) => {
    res.json({ logs: req.botHost.getLogs() });
  });

  // ── Serveur Minecraft (routes actives uniquement pour un tenant de
  // service "minecraft" — 404 sinon, pour ne pas exposer de surface
  // inutile aux tenants Discord). ──────────────────────────────────
  function requireMinecraft(req, res, next) {
    if (req.tenantService !== 'minecraft') return res.status(404).json({ error: 'Service indisponible.' });
    next();
  }

  api.get('/minecraft', requireMinecraft, async (req, res) => {
    const config = req.tenantStore.getMinecraft();
    let runtime = { status: 'stopped' };
    let connection = null;
    if (minecraftAgent.isConfigured()) {
      try {
        const r = await minecraftAgent.getStatus(req.tenantId);
        runtime = r.status || runtime;
      } catch (err) {
        runtime = { status: 'stopped', lastError: 'Agent injoignable : ' + err.message };
      }
      if (config.created) {
        try {
          const info = await minecraftAgent.call('GET', `/tenants/${req.tenantId}/info`);
          connection = { publicIp: info.publicIp, port: info.port, address: info.address };
        } catch {
          const port = config.port || (config.edition === 'bedrock' ? 19132 : 25565);
          connection = { publicIp: '103.102.135.92', port, address: '103.102.135.92:' + port };
        }
      }
    } else {
      try { const r = await minecraftAgent.getStatus(req.tenantId); runtime = r.status || { status: 'stopped' }; } catch (e) { runtime = { status: 'stopped', lastError: e.message }; }
      if (config.created) {
        try { connection = await minecraftManager.getConnectionInfo(config.port); } catch {}
      }
    }
    // Enrichir config avec le loader depuis l'agent
    if (minecraftAgent.isConfigured() && config.created) {
      try {
        const agentCfg = await minecraftAgent.call('GET', '/tenants/' + req.tenantId + '/properties');
        if (agentCfg.loader) config.loader = agentCfg.loader;
      } catch {}
    }
    res.json({ config, runtime, connection });
  });

  // Les versions listées viennent de l'API PaperMC : ça ne concerne que
  // l'édition Java (Bedrock n'a qu'un seul build officiel toujours à jour,
  // pas de choix de version côté hébergement).
  api.get('/minecraft/versions', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      if (minecraftAgent.isConfigured()) {
        const versions = await minecraftAgent.call('GET', '/versions');
        res.json(versions);
      } else {
        res.json(await minecraftManager.listAvailableVersions());
      }
    } catch (err) {
      res.status(500).json({ error: `Impossible de récupérer les versions PaperMC : ${err.message}` });
    }
  });

  api.get('/minecraft/versions/forge', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const data = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').then(r=>r.json());
      const versions = [...new Set(Object.keys(data.promos).map(k=>k.split('-')[0]))].filter(v=>{
        const parts = v.split(".").map(Number); return (parts[0]===1&&parts[1]>=18)||parts[0]>=21;
      }).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
      res.json(versions);
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

  api.get('/minecraft/versions/fabric', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const data = await fetch('https://meta.fabricmc.net/v2/versions/game').then(r=>r.json());
      const versions = data.filter(v=>v.stable).map(v=>v.version).filter(v=>{
        const parts = v.split(".").map(Number); return (parts[0]===1&&parts[1]>=18)||parts[0]>=21;
      });
      res.json(versions);
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

  api.get('/minecraft/versions/vanilla', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const data = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json').then(r=>r.json());
      const versions = data.versions.filter(v=>v.type==='release').map(v=>v.id).filter(v=>{
        const parts = v.split(".").map(Number); return (parts[0]===1&&parts[1]>=18)||parts[0]>=21;
      });
      res.json(versions);
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

  // Mapping offre → ressources allouées (défini CÔTÉ SERVEUR, non falsifiable)
  const MC_PLAN_RESOURCES = {
    minecraft_std: { memoryMb: 10240, maxPlayers: 10 },
    minecraft_pro: { memoryMb: 15360, maxPlayers: 25 },
    default:       { memoryMb: 1024,  maxPlayers:  5 },
  };

  api.post('/minecraft/create', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const { name, mcVersion, port, edition, bedrockConfig, javaConfig, loader } = req.body || {};
    const safeEdition = minecraftManager.normalizeEdition(edition);
    if (safeEdition === 'java' && !mcVersion) {
      return res.status(400).json({ error: 'Version Minecraft requise.' });
    }
    const defaultPort = safeEdition === 'bedrock' ? 19132 : 25565;

    // RAM forcée par l'offre souscrite (le client ne peut pas la changer)
    const sub = req.tenantStore.getSubscription();
    const planRes = MC_PLAN_RESOURCES[sub.planType] || MC_PLAN_RESOURCES.default;
    const memoryMb = planRes.memoryMb;
    const maxPlayers = planRes.maxPlayers;

    res.json({ ok: true, provisioning: true });

    if (minecraftAgent.isConfigured()) {
      try {
        await minecraftAgent.provision(req.tenantId, { mcVersion, port: Number(port) || defaultPort, edition: safeEdition, memoryMb, maxPlayers, name, bedrockConfig, javaConfig, loader: loader || 'paper' });
        req.tenantStore.setMinecraft({
          name: name || 'Mon serveur', edition: safeEdition,
          mcVersion: safeEdition === 'bedrock' ? '' : mcVersion,
          memoryMb: Number(memoryMb) || 1024,
          port: Number(port) || defaultPort,
          eulaAccepted: true, created: true,
        });
        auditLog.logFromRequest(req, 'minecraft.create', name || 'Mon serveur', { edition: safeEdition });
      } catch (err) {
        console.error('Agent provision error:', err.message);
      }
    } else {
      try {
        await req.minecraft.provision({ mcVersion, port, edition: safeEdition });
        req.tenantStore.setMinecraft({
          name: name || 'Mon serveur', edition: safeEdition,
          mcVersion: safeEdition === 'bedrock' ? '' : mcVersion,
          memoryMb: Number(memoryMb) || 1024,
          port: Number(port) || defaultPort,
          eulaAccepted: true, created: true,
        });
        auditLog.logFromRequest(req, 'minecraft.create', name || 'Mon serveur', { edition: safeEdition });
      } catch {}
    }
  });

  // ── Mise à jour vers la dernière version Minecraft disponible.
  // Réponse immédiate (comme /minecraft/create) car le téléchargement peut
  // prendre du temps — le front suit la progression via les logs + le
  // statut 'updating' renvoyé par GET /api/minecraft. ─────────────────
  api.post('/minecraft/update', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    let currentStatus = 'stopped';
    if (minecraftAgent.isConfigured()) {
      try { const r = await minecraftAgent.getStatus(req.tenantId); currentStatus = r.status?.status || 'stopped'; } catch {}
    } else {
      try { const r = await minecraftAgent.getStatus(req.tenantId); currentStatus = r.status?.status || 'stopped'; } catch { currentStatus = 'stopped'; }
    }
    if (currentStatus === 'provisioning' || currentStatus === 'updating') {
      return res.status(409).json({ error: 'Une opération est déjà en cours pour ce serveur.' });
    }
    if (currentStatus !== 'stopped' && currentStatus !== 'crashed') {
      return res.status(409).json({ error: 'Arrête le serveur avant de le mettre à jour.' });
    }

    res.json({ ok: true, updating: true });

    auditLog.logFromRequest(req, 'minecraft.update.launched', cfg.name);
    try {
      const result = await req.minecraft.update({ mcVersion: req.body?.mcVersion });
      req.tenantStore.setMinecraft({ mcVersion: cfg.edition === 'bedrock' ? '' : result.version });
      auditLog.logFromRequest(req, 'minecraft.update.success', cfg.name, { version: result.version });
    } catch (err) {
      auditLog.logFromRequest(req, 'minecraft.update.failed', cfg.name, { error: err.message });
    }
  });

  // ── Mise à jour automatique : quand activée, le serveur passe à la
  // dernière version disponible tout seul (voir runMinecraftAutoUpdates
  // dans index.js), dès qu'il est à l'arrêt — plus besoin de cliquer sur
  // "Mise à jour" à chaque nouvelle release. ─────────────────────────
  api.post('/minecraft/auto-update', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const updated = req.tenantStore.setMinecraft({ autoUpdate: !!req.body?.enabled });
    auditLog.logFromRequest(req, 'minecraft.autoupdate.toggle', updated.name, { enabled: updated.autoUpdate });
    res.json({ ok: true, autoUpdate: updated.autoUpdate });
  });

  api.post('/minecraft/start', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    const sub = req.tenantStore.getSubscription();
    const PLAN_RAM = { minecraft_std: 7168, minecraft_pro: 15360 };
    if (sub?.planType && PLAN_RAM[sub.planType]) {
      cfg.memoryMb = PLAN_RAM[sub.planType];
    }
    auditLog.logFromRequest(req, 'minecraft.start.launched', cfg.name);
    try {
      const result = await req.minecraft.start({ memoryMb: cfg.memoryMb, edition: cfg.edition });
      res.json(result);
      auditLog.logFromRequest(req, 'minecraft.start.success', cfg.name);
    } catch (err) {
      res.status(400).json({ error: err.message });
      auditLog.logFromRequest(req, 'minecraft.start.failed', cfg.name, { error: err.message });
    }
  });

  api.post('/minecraft/stop', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    res.json(await req.minecraft.stop());
    auditLog.logFromRequest(req, 'minecraft.stop', cfg.name);
  });

  api.post('/minecraft/restart', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    auditLog.logFromRequest(req, 'minecraft.restart.launched', cfg.name);
    try {
      await req.minecraft.stop();
      const result = await req.minecraft.start({ memoryMb: cfg.memoryMb, edition: cfg.edition });
      res.json(result);
      auditLog.logFromRequest(req, 'minecraft.restart.success', cfg.name);
    } catch (err) {
      res.status(400).json({ error: err.message });
      auditLog.logFromRequest(req, 'minecraft.restart.failed', cfg.name, { error: err.message });
    }
  });

  api.post('/minecraft/command', requireMinecraft, requireRole('administrateur'), (req, res) => {
    try {
      req.minecraft.sendCommand(String(req.body?.command || ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/minecraft/logs', requireMinecraft, async (req, res) => {
    if (minecraftAgent.isConfigured()) {
      try {
        const r = await minecraftAgent.getLogs(req.tenantId);
        res.json({ logs: r.logs || [] });
      } catch (err) {
        res.json({ logs: [`[Agent] Impossible de récupérer les logs : ${err.message}`] });
      }
    } else {
      res.json({ logs: req.minecraft.getLogs() });
    }
  });

  // ── Logs du serveur (journal des actions joueurs) : recherche paginée,
  // filtrable par type d'événement. requireMinecraft s'assure déjà que le
  // tenant a bien le service Minecraft actif ; pas besoin d'être admin pour
  // consulter (même niveau d'accès que /minecraft/logs). ──────────────
  api.get('/minecraft/player-logs', requireMinecraft, async (req, res) => {
    try {
      const result = await playerLog.search(req.tenantId, {
        query: req.query.q,
        eventType: req.query.type,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Impossible de lire le journal des joueurs : ${err.message}` });
    }
  });

  // ── Configuration (server.properties) : lecture/écriture clé/valeur
  // du vrai fichier server.properties du tenant, via un schéma de champs
  // propre à l'édition (java/bedrock) pour le rendu du formulaire. ──
  api.get('/minecraft/properties', requireMinecraft, async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    if (!cfg.created) return res.status(400).json({ error: "Aucun serveur installé pour l'instant." });
    try {
      const properties = await minecraftManager.readServerProperties(minecraftManager.tenantDir(req.tenantId));
      res.json({ edition: cfg.edition, schema: minecraftManager.getPropertySchema(cfg.edition), properties });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  api.post('/minecraft/properties', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    if (!cfg.created) return res.status(400).json({ error: "Aucun serveur installé pour l'instant." });
    const updates = req.body?.properties;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Propriétés invalides.' });
    try {
      if (minecraftAgent.isConfigured()) {
        await minecraftAgent.call('POST', `/tenants/${req.tenantId}/properties`, { updates });
      } else {
        await minecraftManager.writeServerProperties(minecraftManager.tenantDir(req.tenantId), updates);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admins Minecraft : pseudos qui reçoivent la permission Operator/OP
  // à leur connexion et peuvent ensuite changer eux-mêmes de mode de jeu
  // en jeu — tout le monde d'autre reste limité au mode par défaut du
  // serveur (voir MinecraftController._checkPlayerJoin). ──
  api.get('/minecraft/admins', requireMinecraft, (req, res) => {
    const cfg = req.tenantStore.getMinecraft();
    res.json({ admins: cfg.admins || [] });
  });

  api.post('/minecraft/admins', requireMinecraft, requireRole('administrateur'), (req, res) => {
    const raw = req.body?.admins;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'Liste invalide.' });
    const admins = [...new Set(raw.map((a) => String(a).trim()).filter(Boolean))];
    const updated = req.tenantStore.setMinecraft({ admins });
    res.json({ ok: true, admins: updated.admins || [] });
  });

  // Installe un pack Bedrock (.mcpack/.mcaddon) envoyé en base64 depuis le
  // dashboard : extraction, détection comportement/ressources via
  // manifest.json, copie dans behavior_packs/ ou resource_packs/ et
  // activation pour le monde courant. Limite à 150 Mo.
  api.post('/minecraft/packs/install', requireMinecraft, requireRole('administrateur'), express.json({ limit: '150mb' }), async (req, res) => {
    try {
      let installed;
      if (minecraftAgent.isConfigured()) {
        const r = await minecraftAgent.call('POST', `/tenants/${req.tenantId}/packs/install`, req.body);
        installed = r.installed;
        res.json({ ok: true, installed });
      } else {
        installed = await minecraftManager.installPack(req.tenantId, req.body?.base64 || '', req.body?.filename || '');
        res.json({ ok: true, installed });
      }
      auditLog.logFromRequest(req, 'minecraft.pack_install', req.body?.filename || '');
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/minecraft', requireMinecraft, requireRole('administrateur'), async (req, res) => {
    try {
      const cfg = req.tenantStore.getMinecraft();
      await req.minecraft.wipe();
      req.tenantStore.setMinecraft({ created: false, mcVersion: '' });
      res.json({ ok: true });
      auditLog.logFromRequest(req, 'minecraft.delete', cfg.name);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Gestionnaire de fichiers : partagé Discord (dossier "libre" du
  // tenant) et Minecraft (dossier réel du serveur). Toujours borné à la
  // racine du tenant courant (voir lib/fileManager.js:safeResolve). ──
  function filesRoot(req) {
    return fileManager.rootForService(req.tenantId, req.tenantService);
  }

  // Helper : proxy une requête vers l'agent Minecraft pour les fichiers
  async function agentFileProxy(req, res, agentPath, options = {}) {
    const { method = 'GET', body = null } = options;
    const url = process.env.MINECRAFT_AGENT_URL + '/tenants/' + req.tenantId + agentPath;
    const secret = process.env.MINECRAFT_AGENT_SECRET || '';
    const http = require('http');
    const https = require('https');
    const { URL } = require('url');
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const reqOpts = {
        hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search, method,
        headers: { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
        timeout: 30000,
      };
      const proxyReq = lib.request(reqOpts, (proxyRes) => {
        let raw = '';
        proxyRes.on('data', c => raw += c);
        proxyRes.on('end', () => {
          try { resolve({ status: proxyRes.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: proxyRes.statusCode, body: { error: raw } }); }
        });
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('Agent timeout')));
      if (data) proxyReq.write(data);
      proxyReq.end();
    });
  }

  // Pour Minecraft avec agent : utilise l'agent, sinon fileManager local
  function isMcAgent(req) {
    return req.tenantService === 'minecraft' && minecraftAgent.isConfigured();
  }

  api.get('/files', requireRole('administrateur', 'moderateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files?path=' + encodeURIComponent(req.query.path || ''));
        return res.status(r.status).json(r.body);
      }
      res.json({ items: await fileManager.list(filesRoot(req), req.query.path || '') });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.get('/files/content', requireRole('administrateur', 'moderateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/content?path=' + encodeURIComponent(req.query.path || ''));
        return res.status(r.status).json(r.body);
      }
      res.json({ content: await fileManager.readFile(filesRoot(req), req.query.path || '') });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/files/content', requireRole('administrateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/content', { method: 'POST', body: req.body });
        return res.status(r.status).json(r.body);
      }
      await fileManager.writeFile(filesRoot(req), req.body?.path || '', req.body?.content ?? '');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/files/upload', requireRole('administrateur'), express.json({ limit: '200mb' }), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/upload', { method: 'POST', body: req.body });
        return res.status(r.status).json(r.body);
      }
      await fileManager.writeBinaryBase64(filesRoot(req), req.body?.path || '', req.body?.base64 || '');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/files/upload-zip', requireRole('administrateur'), express.json({ limit: '150mb' }), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/upload-zip', { method: 'POST', body: req.body });
        return res.status(r.status).json(r.body);
      }
      await fileManager.extractZipBase64(filesRoot(req), req.body?.path || '', req.body?.base64 || '');
      res.json({ ok: true });
      auditLog.logFromRequest(req, 'files.upload_zip', req.body?.path || '/');
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/files/mkdir', requireRole('administrateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/mkdir', { method: 'POST', body: req.body });
        return res.status(r.status).json(r.body);
      }
      await fileManager.mkdir(filesRoot(req), req.body?.path || '');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/files/rename', requireRole('administrateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files/rename', { method: 'POST', body: req.body });
        return res.status(r.status).json(r.body);
      }
      await fileManager.rename(filesRoot(req), req.body?.from || '', req.body?.to || '');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.delete('/files', requireRole('administrateur'), async (req, res) => {
    try {
      if (isMcAgent(req)) {
        const r = await agentFileProxy(req, res, '/files?path=' + encodeURIComponent(req.query.path || ''), { method: 'DELETE' });
        return res.status(r.status).json(r.body);
      }
      await fileManager.remove(filesRoot(req), req.query.path || '');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  api.post('/cfx/test', requireRole('administrateur'), async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Code CFX manquant.' });
    try {
      const status = await fetchServerStatus(code);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/settings/ticket-types', requireDiscord, requireRole('administrateur'), (req, res) => {
    const types = req.body?.ticketTypes;
    if (!Array.isArray(types)) return res.status(400).json({ error: 'Format invalide.' });

    for (const t of types) {
      if (!t.id || !t.label || !t.emoji) {
        return res.status(400).json({ error: 'Chaque type de ticket doit avoir un id, un label et un emoji.' });
      }
      if (!isValidEmoji(t.emoji)) {
        return res.status(400).json({
          error: `Emoji invalide pour "${t.label}" : "${t.emoji}". Utilise un emoji Unicode (ex: 🎫) ou un emoji personnalisé du serveur (ex: <:nom:1234567890>).`,
        });
      }
    }
    const ids = types.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Les identifiants de types de tickets doivent être uniques.' });
    }

    const saved = req.tenantStore.setTicketTypes(types);
    res.json({ ok: true, ticketTypes: saved });
  });

  api.post('/bot/restart', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const status = await req.bot.restart();
    if (status.rateLimitedUntil) {
      res.set('Retry-After', String(Math.max(status.retryAfterSeconds || 0, 0)));
      return res.status(429).json({
        ok: false,
        status,
        error: status.lastError,
        retryAfterSeconds: status.retryAfterSeconds,
      });
    }
    res.json({ ok: true, status });
  });

  api.post('/bot/refresh-panel', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const result = await req.bot.refreshPanel();
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ ok: true });
  });

  // ── Diagnostic connexion Discord ────────────────────────────
  // Isole la cause d'un blocage sur "connecting" : distingue un problème
  // de TOKEN (REST échoue tout de suite avec 401) d'un problème RÉSEAU
  // côté hébergeur (REST timeout/erreur alors que le token est valide,
  // typique d'une sortie WebSocket bloquée vers gateway.discord.gg alors
  // que les requêtes HTTPS classiques passent, ou l'inverse). Ne touche
  // pas au client discord.js du tenant : requête HTTPS indépendante.
  api.get('/bot/diagnose', requireDiscord, requireRole('administrateur'), async (req, res) => {
    const bot = req.tenantStore.getBot();
    if (!bot.token) return res.status(400).json({ error: 'Aucun token enregistré.' });

    const steps = [];
    const started = Date.now();
    let rateLimitedSeconds = null;

    // Extrait le délai d'attente exact renvoyé par Discord sur un 429,
    // depuis le header Retry-After ou le corps JSON ({ retry_after }).
    async function readRetryAfter(res) {
      const header = res.headers.get('retry-after');
      if (header && !Number.isNaN(Number(header))) return Number(header);
      try {
        const body = await res.clone().json();
        if (typeof body?.retry_after === 'number') return body.retry_after;
      } catch {}
      return null;
    }

    try {
      const t0 = Date.now();
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      const meRes = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${bot.token}` },
        signal: ctrl,
      });
      const ms = Date.now() - t0;
      if (meRes.status === 429) {
        const retryAfter = await readRetryAfter(meRes);
        rateLimitedSeconds = retryAfter ?? rateLimitedSeconds ?? 60;
        steps.push({
          step: 'REST /users/@me',
          ok: false,
          ms,
          detail: retryAfter
            ? `Rate limité par Discord (HTTP 429). Ce n'est PAS un problème de token : Discord demande d'attendre ${Math.ceil(retryAfter)}s avant toute nouvelle requête (probablement l'IP partagée de l'hébergeur, ou trop de tentatives rapprochées). Arrête toute reconnexion jusque-là.`
            : `Rate limité par Discord (HTTP 429) sans délai précisé dans la réponse. Arrête toute tentative de reconnexion pendant quelques minutes.`,
        });
      } else if (meRes.status === 401) {
        steps.push({ step: 'REST /users/@me', ok: false, ms, detail: 'Token invalide ou révoqué (401). Régénère le token sur le Developer Portal et recolle-le en entier, sans espace.' });
      } else if (!meRes.ok) {
        steps.push({ step: 'REST /users/@me', ok: false, ms, detail: `HTTP ${meRes.status}` });
      } else {
        const me = await meRes.json();
        steps.push({ step: 'REST /users/@me', ok: true, ms, detail: `Token valide, application "${me.username}". Les sorties HTTPS fonctionnent.` });
      }
    } catch (err) {
      steps.push({
        step: 'REST /users/@me',
        ok: false,
        ms: Date.now() - started,
        detail: `Échec réseau (${err.message}). L'hébergeur bloque probablement les connexions HTTPS sortantes vers discord.com, ou coupe les requêtes longues.`,
      });
    }

    try {
      const t0 = Date.now();
      const ctrl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
      const gwRes = await fetch(`${DISCORD_API}/gateway/bot`, {
        headers: { Authorization: `Bot ${bot.token}` },
        signal: ctrl,
      });
      const ms = Date.now() - t0;
      if (!gwRes.ok) {
        steps.push({ step: 'REST /gateway/bot', ok: false, ms, detail: `HTTP ${gwRes.status}` });
      } else {
        const gw = await gwRes.json();
        steps.push({
          step: 'REST /gateway/bot',
          ok: true,
          ms,
          detail: `URL gateway obtenue (${gw.url}). Sessions restantes ce jour : ${gw.session_start_limit?.remaining ?? '?'}/${gw.session_start_limit?.total ?? '?'}.`,
        });
        if (gw.session_start_limit && gw.session_start_limit.remaining === 0) {
          steps.push({
            step: 'Session start limit',
            ok: false,
            ms: 0,
            detail: `[WARN] Quota de connexions Discord épuisé pour aujourd'hui (reset dans ${Math.ceil((gw.session_start_limit.reset_after || 0) / 3600000)}h). C'est probablement la cause du blocage : Discord refuse silencieusement l'IDENTIFY tant que le quota n'est pas reset.`,
          });
        }
      }
    } catch (err) {
      steps.push({
        step: 'REST /gateway/bot',
        ok: false,
        ms: Date.now() - started,
        detail: `Échec réseau (${err.message}).`,
      });
    }

    const allRestOk = steps.filter((s) => s.step.startsWith('REST')).every((s) => s.ok);
    let verdict;
    if (!allRestOk) {
      verdict = "Les requêtes REST (HTTPS classique) vers Discord échouent déjà. C'est un problème de token ou de réseau sortant côté hébergeur, PAS spécifique au WebSocket. Corrige ça d'abord.";
    } else if (steps.some((s) => s.step === 'Session start limit')) {
      verdict = 'Le token et le réseau HTTPS fonctionnent, mais le quota de connexions Discord est épuisé — attends le reset.';
    } else {
      verdict = "Le token est valide et les requêtes HTTPS passent. Si la connexion WebSocket (bot) reste bloquée malgré ça, c'est très probablement l'hébergeur qui bloque spécifiquement le trafic WebSocket (port 443 en mode 'upgrade') vers gateway.discord.gg, alors qu'il laisse passer le HTTPS classique. Active DEBUG_DISCORD=true dans les variables d'environnement et regarde les logs pour voir où ça bloque exactement.";
    }

    res.json({ ok: allRestOk, steps, verdict, botStatus: req.bot.getStatus() });
  });

  api.get('/discord/guilds', requireDiscord, requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    const guilds = [...req.bot.client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
    res.json(guilds);
  });

  api.get('/discord/guilds/:guildId/channels', requireDiscord, requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()]
        .filter((c) => c && c.type === 0)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(textChannels);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/discord/guilds/:guildId/categories', requireDiscord, requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const channels = await guild.channels.fetch();
      const categories = [...channels.values()]
        .filter((c) => c && c.type === 4)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(categories);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/discord/guilds/:guildId/roles', requireDiscord, requireRole('administrateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') return res.json([]);
    try {
      const guild = await req.bot.client.guilds.fetch(req.params.guildId);
      const roles = await guild.roles.fetch();
      const list = [...roles.values()]
        .filter((r) => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
      res.json(list);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/stats', requireDiscord, async (req, res) => {
    res.json(await computeStats(req.tenantId));
  });

  api.get('/tickets/open', requireDiscord, async (req, res) => {
    const tickets = await readTickets(req.tenantId);
    const open = tickets
      .filter((t) => t.status === 'open')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => ({
        id: t.id,
        channelId: t.channelId,
        guildId: t.guildId,
        userTag: t.userTag,
        userId: t.userId,
        typeId: t.typeId,
        status: t.status,
        claimedByTag: t.claimedByTag || null,
        createdAt: t.createdAt,
      }));
    res.json(open);
  });

  api.get('/tickets/:id/messages', requireDiscord, requireRole('administrateur', 'moderateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online') {
      return res.status(503).json({ error: 'Le bot est hors ligne, impossible de lire les messages.' });
    }
    try {
      const [rows] = await db.query('SELECT data FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Ticket introuvable.' });
      const ticket = JSON.parse(rows[0].data);

      const channel = await req.bot.client.channels.fetch(ticket.channelId);
      const messages = await channel.messages.fetch({ limit: 30 });
      const list = [...messages.values()].reverse().map((m) => mapTicketMessage(m));

      res.json({
        ticket: { id: ticket.id, userTag: ticket.userTag, typeId: ticket.typeId, status: ticket.status },
        messages: list,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/tickets/:id/reply', requireDiscord, requireRole('administrateur', 'moderateur'), async (req, res) => {
    if (!req.bot.client || req.bot.status !== 'online' || !req.bot.ticketManager) {
      return res.status(503).json({ error: "Le bot est hors ligne, impossible d'envoyer un message." });
    }
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message vide.' });

    try {
      const [rows] = await db.query('SELECT data FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (!rows.length) return res.status(404).json({ error: 'Ticket introuvable.' });
      const ticket = JSON.parse(rows[0].data);

      const staffLabel = req.session.discordUser?.username || 'Staff';
      await req.bot.ticketManager.sendDashboardReply(ticket, staffLabel, message);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/tickets/export.csv', requireDiscord, requireRole('administrateur', 'moderateur'), async (req, res) => {
    const tickets = await readTickets(req.tenantId);
    const csv = toCsv(tickets);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-${Date.now()}.csv"`);
    res.send(csv);
  });

  // Complète la liste d'admins (stockée côté tenantStore, juste des
  // discordId/rôles) avec l'e-mail du compte lié, quand il existe dans
  // `users` (compte local ou déjà connecté au moins une fois via Discord).
  api.get('/admins', requireRole('administrateur'), async (req, res) => {
    const admins = req.tenantStore.getAdminsWithRoles();
    try {
      if (admins.length) {
        const ids = admins.map((a) => a.id);
        const [rows] = await db.query(
          `SELECT discord_id, email FROM users WHERE discord_id IN (${ids.map(() => '?').join(',')})`,
          ids
        );
        const emailById = new Map(rows.map((r) => [r.discord_id, r.email]));
        admins.forEach((a) => {
          a.email = emailById.get(a.id) || null;
        });
      }
    } catch (err) {
      console.error('Erreur lecture e-mails admins:', err.message);
    }
    res.json({ admins, selfId: req.session.discordUser.id });
  });

  api.post('/admins', requireRole('administrateur'), async (req, res) => {
    const id = String(req.body?.discordId || '').trim();
    if (!/^\d{15,25}$/.test(id)) return res.status(400).json({ error: "ID Discord invalide (identifiant numérique attendu)." });

    let role = String(req.body?.role || 'administrateur').trim();
    if (!TenantStore.ROLES.includes(role)) role = 'administrateur';

    const existingTenant = await tenantManager.findTenantIdForDiscordUser(id);
    if (existingTenant && existingTenant !== req.tenantId) {
      return res.status(400).json({ error: 'Cet identifiant Discord est déjà administrateur sur un autre dashboard.' });
    }

    await tenantManager.addAdminToTenant(req.tenantId, id, role);
    auditLog.logFromRequest(req, 'admins.add', id, { role });
    res.json({ ok: true, admins: req.tenantStore.getAdminsWithRoles() });
  });

  api.patch('/admins/:id/role', requireRole('administrateur'), (req, res) => {
    const role = String(req.body?.role || '').trim();
    if (!TenantStore.ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
    try {
      const admins = req.tenantStore.setAdminRole(req.params.id, role);
      auditLog.logFromRequest(req, 'admins.role_change', req.params.id, { role });
      res.json({ ok: true, admins });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Modifie l'e-mail du compte lié à cet admin (nécessite que l'identifiant
  // corresponde à un compte existant dans `users`, ce qui est le cas pour
  // tout admin ajouté via un compte local ou déjà connecté une fois).
  api.patch('/admins/:id/email', requireRole('administrateur'), async (req, res) => {
    const targetId = req.params.id;
    if (!req.tenantStore.getAdminRole(targetId)) {
      return res.status(404).json({ error: "Ce compte n'a pas accès au dashboard." });
    }

    const emailCheck = validateEmail(req.body?.email);
    if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
    const email = emailCheck.email;

    try {
      const [existingEmail] = await db.query('SELECT id FROM users WHERE email = ? AND discord_id != ?', [email, targetId]);
      if (existingEmail.length) {
        return res.status(400).json({ error: 'Cette adresse e-mail est déjà utilisée par un autre compte.' });
      }

      const [result] = await db.query('UPDATE users SET email = ? WHERE discord_id = ?', [email, targetId]);
      if (!result.affectedRows) {
        return res.status(404).json({ error: "Aucun compte lié à cet identifiant (connecte-toi au moins une fois avant de modifier l'e-mail)." });
      }

      auditLog.logFromRequest(req, 'admins.email_change', targetId, {});
      res.json({ ok: true, email });
    } catch (err) {
      console.error("Erreur modification e-mail admin:", err.message);
      res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
    }
  });

  api.delete('/admins/:id', requireRole('administrateur'), async (req, res) => {
    const adminIds = req.tenantStore.getAdminIds();
    if (adminIds.length <= 1) return res.status(400).json({ error: 'Impossible de retirer le dernier administrateur.' });
    if (
      req.tenantStore.getAdminRole(req.params.id) === 'administrateur' &&
      req.tenantStore.countAdministrateurs() <= 1
    ) {
      return res.status(400).json({ error: 'Impossible de retirer le dernier administrateur.' });
    }
    await tenantManager.removeAdminFromTenant(req.tenantId, req.params.id);
    auditLog.logFromRequest(req, 'admins.remove', req.params.id);
    res.json({ ok: true, admins: req.tenantStore.getAdminsWithRoles() });
  });

  // ── Registre d'audit : lecture des dernières actions du tenant ──────
  api.get('/audit-log', requireRole('administrateur'), async (req, res) => {
    try {
      const entries = await auditLog.getRecent(req.tenantId, req.query.limit);
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: `Impossible de lire le registre d'audit : ${err.message}` });
    }
  });

  app.use('/api', api);

  return app;
}

function maskToken(token) {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 6)}${'•'.repeat(18)}${token.slice(-4)}`;
}

module.exports = createDashboardServer;