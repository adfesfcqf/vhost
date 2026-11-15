// Rend une page HTML animée en MP4 vertical (1080x1920, 30 fps).
// Usage : node video/render.cjs <page.html> <durée_s> <dossier_frames> <sortie.mp4>
// La page doit exposer window.seek(t) qui place toutes les animations au temps t.
// Prérequis : playwright (Chromium) + ffmpeg dans le PATH.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright'));
}

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

(async () => {
  const [page, dur, framesDir, mp4] = process.argv.slice(2);
  if (!page || !dur || !framesDir || !mp4) {
    console.error('Usage : node video/render.cjs <page.html> <durée_s> <dossier_frames> <sortie.mp4>');
    process.exit(1);
  }
  const duration = parseFloat(dur);
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
  const pg = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await pg.goto('file://' + path.resolve(page));
  await pg.evaluate(() => document.fonts.ready);

  const total = Math.round(duration * FPS);
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await pg.evaluate((time) => window.seek(time), t);
    await pg.screenshot({
      path: path.join(framesDir, `f${String(i).padStart(5, '0')}.jpg`),
      type: 'jpeg',
      quality: 93,
    });
    if (i % 150 === 0) console.log(`frame ${i}/${total} (t=${t.toFixed(1)}s)`);
  }
  await browser.close();

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.resolve(mp4),
  ], { stdio: 'inherit' });
  console.log('MP4 écrit :', path.resolve(mp4));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
