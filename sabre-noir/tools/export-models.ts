import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices, toCreasedNormals, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadAssetByPath } from './core/registry';
import { simplify } from './assets/shared/human/simplify';

const G = globalThis as any;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- material simplification
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function simpleMat(m: THREE.Material): THREE.MeshStandardMaterial {
  const s = m as THREE.MeshStandardMaterial;
  const c = s.color ? s.color.clone() : new THREE.Color(0x888888);
  const key = c.getHexString() + '|' + (s.roughness ?? 1).toFixed(2) + '|' + (s.metalness ?? 0).toFixed(2) + '|' + (s.transparent ? 1 : 0);
  let r = matCache.get(key);
  if (!r) {
    r = new THREE.MeshStandardMaterial({ color: c, roughness: Math.max(0.35, s.roughness ?? 1), metalness: Math.min(0.6, s.metalness ?? 0), transparent: !!s.transparent, opacity: s.opacity ?? 1 });
    r.name = (s.name || 'mat') + '_' + key.slice(0, 6);
    matCache.set(key, r);
  }
  return r;
}

interface Part { name: string; geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; }

/** Collect world-space geometries (position only, welded) grouped as parts. */
function collect(root: THREE.Object3D, xf?: THREE.Matrix4, filter?: (name: string) => boolean): Part[] {
  root.updateMatrixWorld(true);
  const out: Part[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    let top: THREE.Object3D = m;
    while (top.parent && top.parent !== root) top = top.parent;
    const name = top.name || m.name || 'part';
    if (filter && !filter(name)) return;
    if (/button|piping|rim|tongue|litzen|chinstrap/i.test(name)) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    let g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.morphAttributes = {};
    g.clearGroups();
    const mw = m.matrixWorld.clone();
    if (xf) mw.premultiply(xf);
    g.applyMatrix4(mw);
    if (mw.determinant() < 0 && g.index) { const a = g.index.array as any; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
    if (!g.index) g = mergeVertices(g, 1e-5);
    else g = mergeVertices(g, 1e-5);
    out.push({ name, geo: g, mat: simpleMat(mats[0]) });
  });
  return out;
}
const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

function lighten(parts: Part[], target: number, maxErr = 0.012) {
  const total = parts.reduce((s, p) => s + triCount(p.geo), 0);
  const ratio = Math.min(1, target / total);
  for (const p of parts) {
    const n = triCount(p.geo);
    const boost = /head|helmet|hand|weapon|eye|cap/i.test(p.name) ? 2.2 : 1;
    const t = Math.max(8, Math.round(n * Math.min(1, ratio * boost)));
    if (t < n * 0.95) { try { p.geo = simplify(p.geo, t, { maxError: maxErr, maxFlipDeg: 80 }); } catch (e) { console.warn('simplify fail', p.name, e); } }
    for (const k of Object.keys(p.geo.attributes)) if (k !== 'position') p.geo.deleteAttribute(k);
    if (G.__CREASE) { let g = toCreasedNormals(p.geo, (55 * Math.PI) / 180); p.geo = mergeVertices(g, 1e-5); }
    else { p.geo = mergeVertices(p.geo, 1e-5); p.geo.computeVertexNormals(); }
  }
  return parts.reduce((s, p) => s + triCount(p.geo), 0);
}

// ---------- skinning
const BONES = ['Hips', 'Spine', 'ThighL', 'ShinL', 'FootL', 'ThighR', 'ShinR', 'FootR'];
function closestOnSeg(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a); const L = ab.length(); const t = p.clone().sub(a).dot(ab) / (L * L);
  const tc = Math.min(1, Math.max(0, t));
  return { t, tc, L, d: p.distanceTo(a.clone().addScaledVector(ab, tc)) };
}
function skinWeights(parts: Part[], sk: any) {
  const P0 = sk.pelvis.o as THREE.Vector3, Px = sk.pelvis.x as THREE.Vector3;
  const lumY = (sk.lumbar.o as THREE.Vector3).y;
  const legs: any = {};
  for (const s of ['l', 'r']) {
    const L = sk.leg[s];
    const toe = (L.foot.o as THREE.Vector3).clone().addScaledVector(L.foot.z, 0.17).setY(0.05);
    legs[s] = { hip: L.hip, knee: L.knee, ankle: L.ankle, toe };
  }
  for (const p of parts) {
    const rigid = /weapon|hand|head|helmet|sling|arm|neck|face|collar/i.test(p.name);
    const pos = p.geo.attributes.position; const n = pos.count;
    const si = new Uint8Array(n * 4), sw = new Uint8Array(n * 4);
    const v = V();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const wSpine = sstep(lumY - 0.05, lumY + 0.08, v.y);
      const w: number[] = new Array(8).fill(0);
      let done = false;
      if (!rigid && v.y < (P0.y + 0.12)) {
        const side = (v.clone().sub(P0).dot(Px)) >= 0 ? 'l' : 'r';
        const Lg = legs[side];
        const s1 = closestOnSeg(v, Lg.hip, Lg.knee), s2 = closestOnSeg(v, Lg.knee, Lg.ankle), s3 = closestOnSeg(v, Lg.ankle, Lg.toe);
        const dmin = Math.min(s1.d, s2.d, s3.d);
        let a: number;
        if (s2.d <= s1.d && s2.d <= s3.d) a = s1.L + s2.tc * s2.L;
        else if (s3.d < s1.d) a = s1.L + s2.L + s3.tc * s3.L;
        else a = s1.t * s1.L; // may be negative above the hip
        if (dmin < 0.2 && a > -0.14) {
          const base = side === 'l' ? 2 : 5;
          const wT = sstep(-0.1, 0.05, a);
          const k = sstep(s1.L - 0.05, s1.L + 0.05, a);
          const f = sstep(s1.L + s2.L - 0.03, s1.L + s2.L + 0.04, a);
          w[0] = (1 - wT) * (1 - wSpine); w[1] = (1 - wT) * wSpine;
          w[base] = wT * (1 - k); w[base + 1] = wT * k * (1 - f); w[base + 2] = wT * k * f;
          done = true;
        }
      }
      if (!done) { w[0] = 1 - (rigid ? 1 : wSpine); w[1] = rigid ? 1 : wSpine; }
      // top 4
      const idx = w.map((x, j) => [x, j]).sort((A, B) => B[0] - A[0]).slice(0, 4);
      const sum = idx.reduce((s, x) => s + x[0], 0) || 1;
      let acc = 0;
      for (let k = 0; k < 4; k++) { si[i * 4 + k] = idx[k][1]; const q = k < 3 ? Math.round(idx[k][0] / sum * 255) : 255 - acc; sw[i * 4 + k] = Math.max(0, q); acc += q; }
    }
    p.geo.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(si, 4));
    p.geo.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(sw, 4, true));
  }
}
function makeBones(sk: any) {
  const wp: Record<string, THREE.Vector3> = {
    Hips: sk.pelvis.o, Spine: sk.lumbar.o, ThighL: sk.leg.l.hip, ShinL: sk.leg.l.knee, FootL: sk.leg.l.ankle,
    ThighR: sk.leg.r.hip, ShinR: sk.leg.r.knee, FootR: sk.leg.r.ankle,
  };
  const parent: Record<string, string | null> = { Hips: null, Spine: 'Hips', ThighL: 'Hips', ShinL: 'ThighL', FootL: 'ShinL', ThighR: 'Hips', ShinR: 'ThighR', FootR: 'ShinR' };
  const bones: THREE.Bone[] = BONES.map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
  const by: Record<string, THREE.Bone> = {}; bones.forEach((b) => (by[b.name] = b));
  for (const n of BONES) { const pn = parent[n]; const pw = pn ? wp[pn] : V(); by[n].position.copy((wp[n] as THREE.Vector3).clone().sub(pw)); if (pn) by[pn].add(by[n]); }
  return bones;
}

function byMaterial(parts: Part[]) {
  const m = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const p of parts) { if (!m.has(p.mat)) m.set(p.mat, []); m.get(p.mat)!.push(p.geo); }
  const out: { mat: THREE.MeshStandardMaterial; geo: THREE.BufferGeometry }[] = [];
  for (const [mat, gs] of m) out.push({ mat: mat as THREE.MeshStandardMaterial, geo: mergeGeometries(gs, false)! });
  return out;
}

async function toGLB(scene: THREE.Object3D): Promise<string> {
  const ex = new GLTFExporter();
  const buf = (await ex.parseAsync(scene, { binary: true })) as ArrayBuffer;
  let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function build(path: string, cfg: any = {}) {
  const def = await loadAssetByPath(path);
  const c = { ...(def.options ? Object.fromEntries(def.options.map((o: any) => [o.id, o.default])) : {}), ...cfg };
  const obj = await def.build(c, { detail: 'high' } as any);
  return obj as THREE.Object3D;
}

G.exportCharacter = async (path: string, pose: string | null, target = 9000, cfg: any = {}, drop: string = '') => {
  G.__FORCE_POSE = pose;
  const obj = await build(path, cfg);
  G.__FORCE_POSE = null;
  const sk = G.__LAST_SOL.sk;
  const dre = drop ? new RegExp(drop, 'i') : null;
  const parts = collect(obj, undefined, dre ? (n) => !dre.test(n) : undefined);
  const names = [...new Set(parts.map((p) => p.name))];
  const before = parts.reduce((s, p) => s + triCount(p.geo), 0);
  const tris = lighten(parts, target, 0.02);
  skinWeights(parts, sk);
  const bones = makeBones(sk);
  const root = new THREE.Group(); root.name = 'character';
  root.add(bones[0]);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  for (const { mat, geo } of byMaterial(parts)) {
    const sm = new THREE.SkinnedMesh(geo, mat); sm.name = 'body_' + mat.name;
    root.add(sm); sm.bind(skeleton, new THREE.Matrix4());
  }
  const head = sk.head.o as THREE.Vector3;
  root.userData = { eye: [head.x, head.y + 0.03, head.z + 0.08] };
  return { glb: await toGLB(root), before, tris, names };
};

G.exportFP = async (path: string, target = 9000, cfg: any = {}, fo: any = {}) => {
  G.__FORCE_POSE = 'aim';
  const obj = await build(path, cfg);
  G.__FORCE_POSE = null;
  const { sk, wm } = G.__LAST_SOL;
  const inv = (wm as THREE.Matrix4).clone().invert();
  const arm = (s: string) => [sk.arm[s].shoulder, sk.arm[s].elbow, sk.arm[s].wrist] as THREE.Vector3[];
  const arms = { l: arm('l'), r: arm('r') };
  // keep weapon + hands + sleeves (triangles near the arm segments, outside the shoulder)
  let parts = collect(obj, undefined, (n) => !/head|helmet|neck|boot|trouser|belt|pouch|canteen|shovel|bread|strap|pack|kit|grenade|holster|bag|mess|pocket|suspender|braces|skatka|^part$|gear:/i.test(n));
  const near = (p: THREE.Vector3) => {
    let best = 9;
    for (const s of ['l', 'r'] as const) {
      const [a, b, c] = arms[s];
      const s1 = closestOnSeg(p, a, b), s2 = closestOnSeg(p, b, c);
      if (s === 'r') { best = Math.min(best, s1.t > 0.25 ? s1.d : 9, s2.d); }
      else { best = Math.min(best, s1.t > 0.2 ? s1.d : 9, s2.d); }
    }
    return best;
  };
  for (const p of parts) {
    if (/weapon|hand|sling/i.test(p.name)) continue;
    const pos = p.geo.attributes.position; const idx = p.geo.index!.array; const keep: number[] = [];
    const A = V(), B = V(), C = V();
    for (let i = 0; i < idx.length; i += 3) {
      A.fromBufferAttribute(pos, idx[i]); B.fromBufferAttribute(pos, idx[i + 1]); C.fromBufferAttribute(pos, idx[i + 2]);
      const cen = A.add(B).add(C).multiplyScalar(1 / 3);
      if (near(cen) < 0.085) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    p.geo.setIndex(keep);
  }
  parts = parts.filter((p) => p.geo.index!.count > 0);
  if (fo.onlyRight) {
    parts = parts.filter((p) => !/weapon|sling|hand-l|cuff-l/i.test(p.name));
    for (const p of parts) if (/tunic/i.test(p.name)) {
      const pos = p.geo.attributes.position; const idx = p.geo.index!.array; const keep: number[] = []; const A = V();
      for (let i = 0; i < idx.length; i += 3) { A.fromBufferAttribute(pos, idx[i]); const [a, b, c] = arms.r; if (Math.min(closestOnSeg(A, a, b).d, closestOnSeg(A, b, c).d) < 0.09) keep.push(idx[i], idx[i + 1], idx[i + 2]); }
      p.geo.setIndex(keep);
    }
  }
  const sleeve = new THREE.MeshStandardMaterial({ color: new THREE.Color(fo.sleeve ?? 0x6d6648), roughness: 0.95 }); sleeve.name = 'sleeve';
  for (const p of parts) if (/tunic|cuff/i.test(p.name)) p.mat = sleeve;
  for (const p of parts) p.geo.applyMatrix4(inv);
  const tris = lighten(parts, target, 0.004);
  // sights (weapon-local): front = highest point near the muzzle; rear = highest point on the receiver
  let wpos: THREE.Vector3[] = [];
  for (const p of parts) if (/weapon/i.test(p.name)) { const a = p.geo.attributes.position; for (let i = 0; i < a.count; i++) wpos.push(V().fromBufferAttribute(a, i)); }
  const zMax = Math.max(...wpos.map((q) => q.z));
  const front = wpos.filter((q) => q.z > zMax - 0.09 && Math.abs(q.x) < 0.01).reduce((b, q) => (q.y > b.y ? q : b), V(0, -9, 0));
  const rearC = wpos.filter((q) => q.z > 0.03 && q.z < zMax * 0.55 && Math.abs(q.x) < 0.012);
  const rear = rearC.reduce((b, q) => (q.y > b.y ? q : b), V(0, -9, 0));
  const head = (sk.head.o as THREE.Vector3).clone().applyMatrix4(inv);
  const root = new THREE.Group(); root.name = 'fp';
  for (const { mat, geo } of byMaterial(parts)) { const m = new THREE.Mesh(geo, mat); m.name = 'fp_' + mat.name; root.add(m); }
  root.userData = { front: front.toArray(), rear: rear.toArray(), zMax, head: head.toArray() };
  return { glb: await toGLB(root), tris, names: [...new Set(parts.map((p) => p.name))], ud: root.userData };
};

G.exportProp = async (path: string, target = 8000, cfg: any = {}) => {
  const obj = await build(path, cfg);
  const parts = collect(obj);
  const before = parts.reduce((s, p) => s + triCount(p.geo), 0);
  const tris = lighten(parts, target, 0.01);
  const root = new THREE.Group(); root.name = 'prop';
  for (const { mat, geo } of byMaterial(parts)) { const m = new THREE.Mesh(geo, mat); m.name = 'p_' + mat.name; root.add(m); }
  const box = new THREE.Box3().setFromObject(root);
  root.userData = { min: box.min.toArray(), max: box.max.toArray() };
  return { glb: await toGLB(root), before, tris, names: [...new Set(parts.map((p) => p.name))].slice(0, 40), ud: root.userData };
};
G.__exportReady = true;
