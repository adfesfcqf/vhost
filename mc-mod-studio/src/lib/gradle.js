// Lance Gradle (compiler, tester dans Minecraft) et détecte Java.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

function javaBin(javaHome) {
  if (javaHome) return path.join(javaHome, 'bin', isWin ? 'java.exe' : 'java');
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, 'bin', isWin ? 'java.exe' : 'java');
  return 'java';
}

/** Retourne { ok, version, major, message } */
function detectJava(javaHome) {
  return new Promise((resolve) => {
    execFile(javaBin(javaHome), ['-version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: 'Java n\'est pas installé (ou introuvable). Installe Java 21.' });
        return;
      }
      const out = String(stderr || stdout);
      const m = out.match(/version "([^"]+)"/);
      const version = m ? m[1] : out.split('\n').find((l) => /version/i.test(l)) || '?';
      const major = parseInt(version.startsWith('1.') ? version.split('.')[1] : version, 10);
      const ok = major >= 21;
      resolve({ ok, version, major, message: ok ? `Java ${major} détecté ✔` : `Java ${major} détecté, mais il faut Java 21 ou plus récent.` });
    });
  });
}

class GradleRunner {
  constructor() {
    this.proc = null;
  }

  get running() {
    return !!this.proc;
  }

  /**
   * Lance une tâche Gradle. onData(texte), onExit(code).
   * Les tâches autorisées sont fixées (pas de commande arbitraire).
   */
  run(root, task, { javaHome, onData, onExit }) {
    if (this.proc) throw new Error('Une tâche est déjà en cours. Attends ou clique sur Stop.');
    const allowed = { build: ['build'], runClient: ['runClient'], clean: ['clean'], genSources: ['genSources'] };
    const args = allowed[task];
    if (!args) throw new Error('Tâche inconnue : ' + task);
    const script = path.join(root, isWin ? 'gradlew.bat' : 'gradlew');
    if (!fs.existsSync(script) || !fs.existsSync(path.join(root, 'gradle/wrapper/gradle-wrapper.jar'))) {
      throw new Error('Gradle Wrapper manquant dans ce projet. Clique sur "Réparer Gradle" (il faut internet).');
    }
    if (!isWin) {
      try { fs.chmodSync(script, 0o755); } catch { /* ignore */ }
    }
    const env = { ...process.env };
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      env.PATH = path.join(javaHome, 'bin') + path.delimiter + (env.PATH || env.Path || '');
    }
    const fullArgs = [...args, '--console=plain'];
    const proc = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${script}" ${fullArgs.join(' ')}`], { cwd: root, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(script, fullArgs, { cwd: root, env });
    this.proc = proc;
    let tail = '';
    const feed = (b) => {
      const s = b.toString();
      tail = (tail + s).slice(-60000);
      onData && onData(s);
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    return new Promise((resolve) => {
      const done = (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        onExit && onExit(code);
        resolve({ code, output: tail });
      };
      proc.on('error', (e) => { feed(`\n[Erreur] ${e.message}\n`); done(-1); });
      proc.on('close', (code) => done(code));
    });
  }

  stop() {
    const p = this.proc;
    if (!p) return;
    if (isWin) {
      spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { p.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

/** Dossier .minecraft/mods du joueur. */
function minecraftModsDir() {
  if (isWin) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), '.minecraft', 'mods');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/minecraft/mods');
  return path.join(os.homedir(), '.minecraft', 'mods');
}

/** Trouve le .jar compilé (hors -sources). */
function findBuiltJar(root) {
  const dir = path.join(root, 'build', 'libs');
  if (!fs.existsSync(dir)) return null;
  const jars = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-dev.jar'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return jars.length ? path.join(dir, jars[0].f) : null;
}

module.exports = { detectJava, GradleRunner, minecraftModsDir, findBuiltJar };
