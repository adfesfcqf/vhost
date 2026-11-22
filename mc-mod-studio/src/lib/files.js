// Accès fichiers confiné au dossier du projet.
const fs = require('fs');
const path = require('path');

const HIDDEN = new Set(['.gradle', 'build', 'run', '.git', '.idea', 'out', 'node_modules', '.vscode', 'bin']);
const TEXT_EXT = new Set(['.js', '.lang', '.mcfunction', '.java', '.json', '.gradle', '.properties', '.txt', '.md', '.mcmeta', '.toml', '.cfg', '.kts', '.gitignore', '.bat', '']);

function resolveInside(root, rel) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, String(rel || '.'));
  const r = path.relative(rootAbs, target);
  if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
    throw new Error('Chemin en dehors du projet refusé : ' + rel);
  }
  // Protège aussi contre les liens symboliques qui sortent du projet
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(rootAbs);
    const rr = path.relative(realRoot, real);
    if (rr === '..' || rr.startsWith('..' + path.sep) || path.isAbsolute(rr)) {
      throw new Error('Chemin en dehors du projet refusé : ' + rel);
    }
  }
  return target;
}

function toRel(root, abs) {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

/** Arbre de fichiers { name, path, dir, children } */
function tree(root, rel = '.', depth = 0) {
  const abs = resolveInside(root, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !(depth === 0 && HIDDEN.has(e.name)) && e.name !== '.DS_Store')
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  return entries.map((e) => {
    const p = toRel(root, path.join(abs, e.name));
    if (e.isDirectory()) return { name: e.name, path: p, dir: true, children: depth < 14 ? tree(root, p, depth + 1) : [] };
    return { name: e.name, path: p, dir: false };
  });
}

/** Liste plate (pour l'IA). */
function listFlat(root, rel = '.') {
  const out = [];
  const walk = (nodes) => nodes.forEach((n) => (n.dir ? walk(n.children) : out.push(n.path)));
  walk(tree(root, rel));
  return out;
}

function isText(p) {
  const ext = path.extname(p).toLowerCase();
  return TEXT_EXT.has(ext) || path.basename(p) === 'gradlew';
}

function readText(root, rel) {
  const abs = resolveInside(root, rel);
  if (!isText(abs)) throw new Error('Ce fichier n\'est pas un fichier texte : ' + rel);
  return fs.readFileSync(abs, 'utf8');
}

function writeText(root, rel, content) {
  const abs = resolveInside(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function readBase64(root, rel) {
  return fs.readFileSync(resolveInside(root, rel)).toString('base64');
}

function writeBase64(root, rel, b64) {
  const abs = resolveInside(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  return abs;
}

function remove(root, rel) {
  const abs = resolveInside(root, rel);
  if (path.resolve(abs) === path.resolve(root)) throw new Error('Impossible de supprimer le projet entier.');
  fs.rmSync(abs, { recursive: true, force: true });
}

function rename(root, from, to) {
  const a = resolveInside(root, from);
  const b = resolveInside(root, to);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
}

module.exports = { resolveInside, toRel, tree, listFlat, isText, readText, writeText, readBase64, writeBase64, remove, rename };
