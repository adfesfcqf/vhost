const crypto = require('crypto');
const { pool, ensureSchema } = require('./db');

// Prix en centimes, définis CÔTÉ SERVEUR : on ne fait jamais confiance au
// montant envoyé par le navigateur. Les clés correspondent aux identifiants
// d'offres de la page d'accueil (PLANS dans index.html).
// Catalogue des offres — priceId = ID Stripe live (mode subscription).
// cents est conservé pour affichage uniquement (page d'accueil).
const PLAN_CATALOG = {
  bot_standard: { label: 'Hébergement Bot - Standard', cents:  99, priceId: 'price_1UKhrHFbO0HnEMFJluQsjyFo' },
  bot_avance:   { label: 'Hébergement Bot - Avancé',   cents: 249, priceId: 'price_1UKhtHFbO0HnEMFJM1hvMruF' },
  bot_premium:  { label: 'Hébergement Bot - Premium',  cents: 499, priceId: 'price_1UKhuRFbO0HnEMFJkcYdD39m' },
  bot_ultra:    { label: 'Hébergement Bot - Ultra',    cents: 999, priceId: 'price_1UKhvkFbO0HnEMFJqQ8FGdsQ' },
  minecraft_std:{ label: 'Minecraft - Standard',       cents: 699, priceId: 'price_1UKhyvFbO0HnEMFJkD7UcBxt' },
  minecraft_pro:{ label: 'Minecraft - Pro',            cents:1299, priceId: 'price_1UKhznFbO0HnEMFJLh1hU6Ci' },
  subdomain_addon:{ label: 'Sous-domaine personnalise', cents: 200, priceId: 'price_1UMOHFFbO0HnEMFJUohPW74i' },
};

let stripeClient = null;

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getStripe() {
  if (!isConfigured()) throw new Error('STRIPE_SECRET_KEY manquant dans le .env');
  if (!stripeClient) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Alphabet sans caractères ambigus (pas de 0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBlock(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

// Même format que les codes existants : TCKT-XXXX-XXXX-XXXX
function generateCode() {
  return `TCKT-${randomBlock(4)}-${randomBlock(4)}-${randomBlock(4)}`;
}

async function findCodeBySession(sessionId) {
  const [rows] = await pool.query(
    'SELECT code, plan_type FROM customer_codes WHERE stripe_session_id = ?',
    [sessionId]
  );
  return rows[0] || null;
}

// Crée (ou retrouve) le code lié à une session Stripe PAYÉE. Idempotent :
// appelé à la fois par le webhook et par la page de confirmation, il ne
// produit jamais deux codes pour la même session.
async function fulfillSession(session) {
  if (!session || session.payment_status !== 'paid') return null;
  await ensureSchema();

  const existing = await findCodeBySession(session.id);
  if (existing) return existing;

  const planId = session.metadata && session.metadata.planId;
  if (!PLAN_CATALOG[planId]) {
    throw new Error(`Offre inconnue dans la session ${session.id}: ${planId}`);
  }
  const email = (session.customer_details && session.customer_details.email) || null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await pool.query(
        `INSERT INTO customer_codes (code, plan_type, stripe_session_id, buyer_email)
         VALUES (?, ?, ?, ?)`,
        [code, planId, session.id, email]
      );
      return { code, plan_type: planId };
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      // Doublon : soit une autre requête a déjà créé le code de cette
      // session (on le renvoie), soit collision de code aléatoire (on retente).
      const raced = await findCodeBySession(session.id);
      if (raced) return raced;
    }
  }
  throw new Error('Impossible de générer un code unique');
}

// Crée une session Checkout Stripe en mode ABONNEMENT.
// Le tenant reçoit un code d'activation au paiement ; son accès est coupé
// si l'abonnement est annulé ou si un prélèvement échoue.
async function createCheckoutSession(planId, baseUrl, tenantId) {
  const plan = PLAN_CATALOG[planId];
  if (!plan) throw new Error('Offre inconnue');
  if (!plan.priceId) throw new Error(`Pas de priceId Stripe pour l'offre ${planId}`);
  return getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: plan.priceId, quantity: 1 }],
    metadata: { planId, tenantId: String(tenantId || '') },
    subscription_data: { metadata: { planId, tenantId: String(tenantId || '') } },
    success_url: `${baseUrl}/achat/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${baseUrl}/accueil`,
  });
}

// ── Gestion des abonnements (webhook) ───────────────────────────────────

// Retrouve le store d'un tenant par son tenantId (chargé à la demande)
let _storeLoader = null;
function setStoreLoader(fn) { _storeLoader = fn; }

async function _getStore(tenantId) {
  if (!tenantId || !_storeLoader) return null;
  try { return await _storeLoader(tenantId); } catch { return null; }
}

// Appelé quand checkout.session.completed (subscription) : génère le code
// et active l'abonnement dans le store du tenant.
async function fulfillSubscriptionSession(session) {
  const planId   = session.metadata?.planId;
  const tenantId = session.metadata?.tenantId;
  const subId    = session.subscription;
  if (!planId || !subId) return null;

  // Générer le code d'accès si pas encore fait
  let code = null;
  const existing = await findCodeBySession(session.id);
  if (existing) {
    code = existing.code;
  } else if (session.payment_status === 'paid' || session.status === 'complete') {
    const email = session.customer_details?.email || null;
    for (let i = 0; i < 5; i++) {
      const c = generateCode();
      try {
        await pool.query(
          'INSERT INTO customer_codes (code, plan_type, stripe_session_id, buyer_email) VALUES (?, ?, ?, ?)',
          [c, planId, session.id, email]
        );
        code = c;
        break;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        const raced = await findCodeBySession(session.id);
        if (raced) { code = raced.code; break; }
      }
    }
  }

  // Activer l'abonnement dans le store du tenant
  if (tenantId) {
    const store = await _getStore(Number(tenantId));
    if (store) {
      if (planId === 'subdomain_addon') {
        store.setSubscription({ subdomainActive: true, subdomainStripeSubId: subId });
        return { code: null, plan_type: planId };
      }
      store.setSubscription({
        planType:       planId,
        active:         true,
        stripeSubId:    subId,
        stripeCustomer: session.customer || '',
        renewedAt:      new Date().toISOString(),
        cancelAt:       null,
      });
    }
  }

  const plan = PLAN_CATALOG[planId];
  return code ? { code, plan_type: planId, planLabel: plan?.label || planId } : null;
}

// Appelé par invoice.payment_succeeded : renouvellement mensuel réussi.
async function handleInvoicePaid(invoice) {
  const subId    = invoice.subscription;
  const tenantId = invoice.subscription_details?.metadata?.tenantId
                || invoice.metadata?.tenantId;
  if (!tenantId || !subId) return;
  const store = await _getStore(Number(tenantId));
  if (!store) return;
  const sub = store.getSubscription();
  if (sub.stripeSubId !== subId) return; // pas le bon abonnement
  store.setSubscription({ active: true, renewedAt: new Date().toISOString(), cancelAt: null });
}

// Appelé par invoice.payment_failed ou customer.subscription.deleted : coupe l'accès.
async function handleSubscriptionCancelled(obj) {
  // obj = subscription Stripe ou invoice
  const subId    = obj.id || obj.subscription;
  const tenantId = obj.metadata?.tenantId
                || obj.subscription_details?.metadata?.tenantId;
  if (!tenantId || !subId) return;
  const store = await _getStore(Number(tenantId));
  if (!store) return;
  const sub = store.getSubscription();
  if (sub.stripeSubId !== subId) return;
  store.setSubscription({ active: false, cancelAt: new Date().toISOString() });
  console.log('⚠️  Abonnement coupé pour tenant ' + tenantId + ' (sub ' + subId + ')');
}

module.exports = {
  PLAN_CATALOG,
  isConfigured,
  getStripe,
  generateCode,
  fulfillSession,
  fulfillSubscriptionSession,
  handleInvoicePaid,
  handleSubscriptionCancelled,
  createCheckoutSession,
  setStoreLoader,
};
