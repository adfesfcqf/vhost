const crypto = require('crypto');

// ── Hachage de mot de passe (scrypt, stdlib Node — pas de dépendance
// externe nécessaire). Format stocké : "salt:hash" (tout en hexadécimal).
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ── Règles simples de validation côté serveur ──────────────────────
function validateUsername(raw) {
  const username = String(raw || '').trim();
  if (username.length < 3 || username.length > 32) {
    return { ok: false, error: "Le nom d'utilisateur doit faire entre 3 et 32 caractères." };
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return { ok: false, error: "Le nom d'utilisateur ne peut contenir que lettres, chiffres, '_', '-' et '.'." };
  }
  return { ok: true, username };
}

function validatePassword(raw) {
  const password = String(raw || '');
  if (password.length < 6) {
    return { ok: false, error: 'Le mot de passe doit faire au moins 6 caractères.' };
  }
  return { ok: true, password };
}

// Regex volontairement simple (pas de RFC 5322 complet) : suffisant pour
// rejeter les fautes de frappe évidentes sans bloquer des adresses valides.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) {
    return { ok: false, error: 'Adresse e-mail requise.' };
  }
  if (email.length > 191 || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Adresse e-mail invalide.' };
  }
  return { ok: true, email };
}

module.exports = { hashPassword, verifyPassword, validateUsername, validatePassword, validateEmail };