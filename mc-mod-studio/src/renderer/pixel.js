// Éditeur de pixels pour les textures (PNG 16x16, 32x32…).
(function () {
  const PALETTE = [
    '#000000', '#3f3f3f', '#7f7f7f', '#bfbfbf', '#ffffff', '#5a3a1e', '#8b5a2b', '#c08a52',
    '#7a1010', '#d22d2d', '#ff7b7b', '#b65a00', '#ff9d1c', '#ffd84a', '#fff4a3', '#2e6b1f',
    '#4caf2c', '#9be070', '#0f5a5a', '#1fb0a8', '#7ff0e6', '#1d3f9a', '#3c78ff', '#9cc0ff',
    '#4b1f7a', '#9b4dff', '#e0b0ff', '#a01c6b', '#ff4fb4', '#ffc0e3',
  ];

  class PixelEditor {
    constructor(container, { base64, name, onSave }) {
      this.container = container;
      this.onSave = onSave;
      this.color = '#d22d2d';
      this.tool = 'pen';
      this.undo = [];
      this.dirty = false;
      container.innerHTML = `
        <div class="pixel-wrap">
          <div class="pixel-tools">
            <div class="pixel-title">🎨 ${window.escapeHtml(name)}</div>
            <div class="tool-row">
              <button data-tool="pen" class="active" title="Crayon (B)">✏️</button>
              <button data-tool="eraser" title="Gomme (E)">🧽</button>
              <button data-tool="fill" title="Pot de peinture (F)">🪣</button>
              <button data-tool="pick" title="Pipette (I)">💧</button>
            </div>
            <div class="palette"></div>
            <label class="custom-color">Couleur : <input type="color" value="${this.color}"></label>
            <div class="tool-row">
              <button data-act="undo" title="Annuler (Ctrl+Z)">↩ Annuler</button>
              <button data-act="clear">🗑 Vider</button>
            </div>
            <div class="tool-row">
              <button data-act="noise" title="Ajoute un léger grain façon Minecraft">✨ Grain</button>
              <button data-act="import">📥 Importer</button>
            </div>
            <button data-act="save" class="primary wide">💾 Enregistrer la texture</button>
            <p class="hint">Astuce : clic droit = gomme. Les textures Minecraft font 16×16 pixels.</p>
          </div>
          <div class="pixel-stage">
            <canvas class="pixel-canvas"></canvas>
            <div class="pixel-preview"><span>Aperçu</span><canvas class="pv1"></canvas><canvas class="pv2"></canvas></div>
          </div>
        </div>`;
      this.canvas = container.querySelector('.pixel-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.img = document.createElement('canvas');
      this.ictx = this.img.getContext('2d', { willReadFrequently: true });
      const pal = container.querySelector('.palette');
      PALETTE.forEach((c) => {
        const b = document.createElement('button');
        b.style.background = c;
        b.title = c;
        b.onclick = () => this.setColor(c);
        pal.appendChild(b);
      });
      this.colorInput = container.querySelector('input[type=color]');
      this.colorInput.oninput = () => this.setColor(this.colorInput.value);
      container.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => this.setTool(b.dataset.tool)));
      container.querySelector('[data-act=undo]').onclick = () => this.doUndo();
      container.querySelector('[data-act=clear]').onclick = () => { this.pushUndo(); this.ictx.clearRect(0, 0, this.w, this.h); this.changed(); };
      container.querySelector('[data-act=noise]').onclick = () => this.noise();
      container.querySelector('[data-act=save]').onclick = () => this.save();
      container.querySelector('[data-act=import]').onclick = () => this.onImport && this.onImport();
      this.bindPointer();
      this.keyHandler = (e) => this.onKey(e);
      window.addEventListener('keydown', this.keyHandler);
      this.load(base64);
    }

    destroy() {
      window.removeEventListener('keydown', this.keyHandler);
    }

    load(base64) {
      const im = new Image();
      im.onload = () => {
        this.w = im.width || 16;
        this.h = im.height || 16;
        this.img.width = this.w;
        this.img.height = this.h;
        this.ictx.clearRect(0, 0, this.w, this.h);
        this.ictx.drawImage(im, 0, 0);
        this.layout();
      };
      im.onerror = () => {
        this.w = this.h = 16;
        this.img.width = this.img.height = 16;
        this.layout();
      };
      im.src = 'data:image/png;base64,' + base64;
    }

    layout() {
      const size = Math.min(512, Math.floor(512 / Math.max(this.w, this.h)) * Math.max(this.w, this.h));
      this.scale = Math.floor(size / Math.max(this.w, this.h));
      this.canvas.width = this.w * this.scale;
      this.canvas.height = this.h * this.scale;
      const [p1, p2] = this.container.querySelectorAll('.pixel-preview canvas');
      p1.width = this.w; p1.height = this.h; p1.style.width = this.w * 2 + 'px';
      p2.width = this.w; p2.height = this.h; p2.style.width = this.w * 4 + 'px';
      this.draw();
    }

    draw() {
      const { ctx, scale: s } = this;
      ctx.imageSmoothingEnabled = false;
      // damier de transparence
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#3a3d45' : '#2d3038';
        ctx.fillRect(x * s, y * s, s, s);
      }
      ctx.drawImage(this.img, 0, 0, this.w * s, this.h * s);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      for (let i = 0; i <= this.w; i++) { ctx.moveTo(i * s + 0.5, 0); ctx.lineTo(i * s + 0.5, this.h * s); }
      for (let i = 0; i <= this.h; i++) { ctx.moveTo(0, i * s + 0.5); ctx.lineTo(this.w * s, i * s + 0.5); }
      ctx.stroke();
      this.container.querySelectorAll('.pixel-preview canvas').forEach((c) => {
        const x = c.getContext('2d');
        x.clearRect(0, 0, c.width, c.height);
        x.drawImage(this.img, 0, 0);
      });
    }

    setColor(c) {
      this.color = c;
      this.colorInput.value = c;
      if (this.tool === 'eraser' || this.tool === 'pick') this.setTool('pen');
    }

    setTool(t) {
      this.tool = t;
      this.container.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    }

    pushUndo() {
      this.undo.push(this.ictx.getImageData(0, 0, this.w, this.h));
      if (this.undo.length > 60) this.undo.shift();
    }

    doUndo() {
      const d = this.undo.pop();
      if (d) { this.ictx.putImageData(d, 0, 0); this.changed(); }
    }

    changed() {
      this.dirty = true;
      this.draw();
    }

    cell(e) {
      const r = this.canvas.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * this.w), Math.floor(((e.clientY - r.top) / r.height) * this.h)];
    }

    paint(x, y, erase) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      if (erase) this.ictx.clearRect(x, y, 1, 1);
      else { this.ictx.fillStyle = this.color; this.ictx.fillRect(x, y, 1, 1); }
    }

    fill(x, y) {
      const d = this.ictx.getImageData(0, 0, this.w, this.h);
      const idx = (x, y) => (y * this.w + x) * 4;
      const t = d.data.slice(idx(x, y), idx(x, y) + 4);
      const c = this.color.match(/\w\w/g).map((h) => parseInt(h, 16)).concat(255);
      if (t.every((v, i) => v === c[i])) return;
      const st = [[x, y]];
      while (st.length) {
        const [cx, cy] = st.pop();
        if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) continue;
        const i = idx(cx, cy);
        if (!(d.data[i] === t[0] && d.data[i + 1] === t[1] && d.data[i + 2] === t[2] && d.data[i + 3] === t[3])) continue;
        d.data.set(c, i);
        st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      this.ictx.putImageData(d, 0, 0);
    }

    pick(x, y) {
      const p = this.ictx.getImageData(x, y, 1, 1).data;
      if (p[3] === 0) return;
      this.setColor('#' + [p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
    }

    noise() {
      this.pushUndo();
      const d = this.ictx.getImageData(0, 0, this.w, this.h);
      for (let i = 0; i < d.data.length; i += 4) {
        if (!d.data[i + 3]) continue;
        const n = (Math.random() - 0.5) * 26;
        for (let k = 0; k < 3; k++) d.data[i + k] = Math.max(0, Math.min(255, d.data[i + k] + n));
      }
      this.ictx.putImageData(d, 0, 0);
      this.changed();
    }

    bindPointer() {
      let down = false;
      let erase = false;
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      this.canvas.addEventListener('pointerdown', (e) => {
        const [x, y] = this.cell(e);
        erase = e.button === 2 || this.tool === 'eraser';
        if (this.tool === 'pick' && !erase) { this.pick(x, y); return; }
        this.pushUndo();
        if (this.tool === 'fill' && !erase) { this.fill(x, y); this.changed(); return; }
        down = true;
        this.canvas.setPointerCapture(e.pointerId);
        this.paint(x, y, erase);
        this.changed();
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!down) return;
        const [x, y] = this.cell(e);
        this.paint(x, y, erase);
        this.changed();
      });
      const up = () => (down = false);
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
    }

    onKey(e) {
      if (!this.container.offsetParent) return; // éditeur caché
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.doUndo(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const map = { b: 'pen', e: 'eraser', f: 'fill', i: 'pick' };
      if (map[e.key]) this.setTool(map[e.key]);
    }

    async save() {
      const b64 = this.img.toDataURL('image/png').split(',')[1];
      await this.onSave(b64);
      this.dirty = false;
    }
  }

  window.PixelEditor = PixelEditor;
})();
