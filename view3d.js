'use strict';
/* 3D ビュー（Three.js r128）。window.V3D として公開（spec-v2 §0.2）
 * app.js のグローバル (sim, model, cfg, playIdx, playing, playT, PH_COL, phKey, payAt, noseR, niceStep, fmtN) を参照する。
 * 姿勢: q = fromUnitVectors(Y_UP, 機軸) · fromAxisAngle(Y_UP, ロール角)（spec §6）
 * 座標変換: シミュ (x=東, y=北, z=上) → three (x, z, -y)
 */
window.V3D = (() => {
  const box = document.getElementById('v3d');
  let renderer, scene, camera, controls, root, dirty = true, visible = false, ok = false;
  let sprites = [], rocket, flame, chute, dropLine, beacon, trailNow, ext = 500, visScale = 1, peakT = 1;
  let pay = null;   // ペイロード {g: カプセル, chute, line: 軌跡, beacon, lbl}（放出が無ければ null）
  const qRoll = window.THREE ? new THREE.Quaternion() : null;
  const camSmooth = { pos: null, look: null };
  const V = (x, y, z) => new THREE.Vector3(x, z, -y);
  const Y_UP = window.THREE ? new THREE.Vector3(0, 1, 0) : null;   // Three.js が読めないときも window.V3D は作る

  function init() {
    if (!window.THREE || !THREE.OrbitControls) {
      box.innerHTML = '<p class="muted" style="padding:16px">Three.js を読み込めませんでした（オフラインの可能性があります）。2D の「飛行軌跡」タブは使えます。</p>';
      return false;
    }
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    box.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1c38);
    camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500000);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a3a22, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(0.6, 1, 0.4); scene.add(sun);
    new ResizeObserver(resize).observe(box);
    document.getElementById('v3dCam').addEventListener('change', () => { camSmooth.pos = null; dirty = true; });
    document.getElementById('v3dScale').addEventListener('change', () => { dirty = true; });
    resize();
    requestAnimationFrame(loop);
    return true;
  }
  function resize() {
    if (!renderer) return;
    const w = box.clientWidth || 1, h = box.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // ---------- ラベル ----------
  function label(text, color = '#e6ecf8', size = 1) {
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    ctx.font = 'bold 40px system-ui, sans-serif';
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    cv.width = w; cv.height = 60;
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(8,14,30,.65)'; ctx.fillRect(0, 0, w, 60);
    ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 12, 31);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true }));
    sp.scale.set(0.045 * size * w / 60, 0.045 * size, 1);
    sp.center.set(0, 0);
    sp.renderOrder = 10;
    sp.userData.base = sp.scale.clone(); sprites.push(sp);
    return sp;
  }

  // ---------- 機体メッシュ（実寸, 原点=離陸時重心, 機軸 +Y） ----------
  function buildRocket(M) {
    const g = new THREE.Group();
    const cg = M.massAt(0).cg;
    const nosePts = [], bodyPts = [];
    for (let i = 0; i <= 30; i++) { const x = M.Ln * i / 30; nosePts.push(new THREE.Vector2(Math.max(noseR(M, x), 1e-5), cg - x)); }
    nosePts[0].x = 0;
    bodyPts.push(new THREE.Vector2(M.R, cg - M.Ln), new THREE.Vector2(M.R, cg - M.Ln - M.Lb),
      new THREE.Vector2(M.dBase / 2, cg - M.L), new THREE.Vector2(0, cg - M.L));
    const mat = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide, ...extra });
    g.add(new THREE.Mesh(new THREE.LatheGeometry(nosePts, 32), mat(0xff7a2f)));
    g.add(new THREE.Mesh(new THREE.LatheGeometry(bodyPts, 32), mat(0xeef2f8)));
    // 帯（ロール方向が分かるように）
    const band = new THREE.Mesh(new THREE.CylinderGeometry(M.R * 1.01, M.R * 1.01, M.d * 0.6, 32, 1, true), mat(0x1d4fbf));
    band.position.y = cg - M.Ln - M.Lb * 0.35; g.add(band);
    // フィン
    const sh = new THREE.Shape();
    sh.moveTo(M.R * 0.98, cg - M.Xb);
    sh.lineTo(M.R + M.s, cg - M.Xb - M.Xs);
    sh.lineTo(M.R + M.s, cg - M.Xb - M.Xs - M.Ct);
    sh.lineTo(M.R * 0.98, cg - M.Xb - M.Cr);
    sh.closePath();
    const th = Math.max(cfg.finThick / 1000, 0.001);
    const fg = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false });
    fg.translate(0, 0, -th / 2);
    for (let i = 0; i < M.N; i++) {
      const f = new THREE.Mesh(fg, mat(0x2f5fd0)); f.rotation.y = 2 * Math.PI * i / M.N; g.add(f);
    }
    // 炎
    const fl = new THREE.Mesh(new THREE.ConeGeometry(M.mDia * 0.45, M.L * 0.45, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    fl.geometry.rotateX(Math.PI); fl.geometry.translate(0, -M.L * 0.225, 0);
    fl.position.y = cg - M.L - cfg.mOver / 1000;
    const core = new THREE.Mesh(new THREE.ConeGeometry(M.mDia * 0.25, M.L * 0.25, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.95, depthWrite: false }));
    core.geometry.rotateX(Math.PI); core.geometry.translate(0, -M.L * 0.125, 0);
    fl.add(core);
    g.add(fl);
    return { g, flame: fl };
  }
  function buildChute(c2 = [1, 0.25, 0.25]) {
    const g = new THREE.Group();
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2.2),
      new THREE.MeshStandardMaterial({ color: 0xff4040, roughness: 0.8, side: THREE.DoubleSide }));
    // 赤白ゴア
    const cols = []; const pos = canopy.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i)); const k = Math.floor((a + Math.PI) / (Math.PI / 4)) % 2;
      cols.push(...(k ? c2 : [0.96, 0.96, 0.96]));
    }
    canopy.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    canopy.material.vertexColors = true; canopy.material.color.set(0xffffff);
    g.add(canopy);
    const lines = [];
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; lines.push(Math.cos(a) * 0.98, 0.15, Math.sin(a) * 0.98, 0, -2.2, 0); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.7 })));
    return { g, canopy };
  }
  // ペイロードのカプセル（r128 には CapsuleGeometry が無いので Lathe で作る。原点=中心, 軸 +Y）
  function buildCapsule(r, len) {
    const pts = [], h = Math.max(len / 2 - r, 0);
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + Math.PI / 2 * i / 8; pts.push(new THREE.Vector2(Math.max(r * Math.cos(a), 1e-5), -h + r * Math.sin(a))); }
    for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 * i / 8; pts.push(new THREE.Vector2(Math.max(r * Math.cos(a), 1e-5), h + r * Math.sin(a))); }
    pts[0].x = 0; pts[pts.length - 1].x = 0;
    return new THREE.Mesh(new THREE.LatheGeometry(pts, 20), new THREE.MeshStandardMaterial({ color: 0xc58bff, roughness: 0.5, metalness: 0.1 }));
  }

  // ---------- シーン構築 ----------
  function rebuild() {
    dirty = false;
    if (root) { scene.remove(root); root.traverse(o => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach(m => { m.map?.dispose(); m.dispose(); }); }); }
    root = new THREE.Group(); scene.add(root); sprites = []; pay = null;
    const rec = sim?.rec; if (!rec || !rec.length) return;
    const M = model;
    const prec = sim.payload?.rec || [];
    let rMax = 0, zMax = 0;
    for (const r of rec.concat(prec)) { rMax = Math.max(rMax, Math.hypot(r.x, r.y)); zMax = Math.max(zMax, r.z); }
    ext = Math.max(rMax, zMax, 100);
    const sv = document.getElementById('v3dScale').value;
    visScale = sv === 'auto' ? Math.max(1, ext / 35 / Math.max(M.L, 0.2)) : +sv;
    const mode = document.getElementById('v3dCam').value;
    if (mode !== 'orbit' && sv === 'auto') visScale = 1;
    document.getElementById('v3dNote').textContent = visScale > 1.01
      ? `機体とパラシュートは見やすさのため ×${visScale.toFixed(0)} で表示しています（軌跡・地形は実寸）。グリッド 1 マス = ${fmtN(gridStep())} m`
      : `すべて実寸表示。グリッド 1 マス = ${fmtN(gridStep())} m`;

    scene.fog = new THREE.Fog(0x0e1c38, ext * 4, ext * 14);
    // 地面
    const ground = new THREE.Mesh(new THREE.CircleGeometry(ext * 14, 64), new THREE.MeshStandardMaterial({ color: 0x1b2a1e, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; root.add(ground);
    const st = gridStep(), grid = new THREE.GridHelper(st * 60, 60, 0x3b5a44, 0x2a4232);
    grid.position.y = 0.02; root.add(grid);
    // 方位
    const n = label('N', '#ff8a8a', 1.2); n.position.copy(V(0, ext * 1.1, 0)); root.add(n);
    const e = label('E', '#c8d3ea'); e.position.copy(V(ext * 1.1, 0, 0)); root.add(e);
    // ランチャー
    const u0 = V(Math.cos(M.elev) * Math.sin(M.azim), Math.cos(M.elev) * Math.cos(M.azim), Math.sin(M.elev));
    const railLen = M.railLen * Math.max(1, visScale * 0.6);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03 * visScale, railLen, 0.03 * visScale), new THREE.MeshStandardMaterial({ color: 0x9aa4b5, metalness: 0.6, roughness: 0.4 }));
    rail.geometry.translate(0, railLen / 2, 0);
    rail.quaternion.setFromUnitVectors(Y_UP, u0); root.add(rail);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.6 * visScale, 0.8 * visScale, 0.1 * visScale, 24), new THREE.MeshStandardMaterial({ color: 0x555d6b }));
    root.add(pad);
    const lp = label('射点', '#ffffff'); lp.position.set(0, 0, 0); root.add(lp);
    // 風
    const wd = V(M.wdir[0], M.wdir[1], 0).normalize();
    const wa = new THREE.ArrowHelper(wd, V(-M.wdir[0] * ext * 0.6, -M.wdir[1] * ext * 0.6, ext * 0.02), ext * 0.2, 0x4fc3f7, ext * 0.05, ext * 0.025);
    root.add(wa);
    const wl = label(`風 ${cfg.wind} m/s（高度 ${cfg.windRef} m）`, '#4fc3f7'); wl.position.copy(V(-M.wdir[0] * ext * 0.6, -M.wdir[1] * ext * 0.6, ext * 0.05)); root.add(wl);

    // 軌跡（フェーズ別の頂点色）
    const P = [], C = [], S = [], col = new THREE.Color();
    for (const r of rec) {
      const v = V(r.x, r.y, r.z); P.push(v.x, v.y, v.z); S.push(v.x, 0.3, v.z);
      col.set(PH_COL[phKey(r)]); C.push(col.r, col.g, col.b);
    }
    const mkLine = (pos, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      return new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity }));
    };
    root.add(mkLine(P, 0.25));
    trailNow = mkLine(P, 1); root.add(trailNow);
    const shadow = mkLine(S, 0.18); root.add(shadow);
    // マーカー
    const ev = sim.ev;
    const mark = (r, text, color, below) => {   // below: ラベルを点の下に出す（頂点と 1段目開傘などが重ならないように）
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex(), color, sizeAttenuation: false, depthTest: false, transparent: true }));
      s.scale.set(0.02, 0.02, 1); s.userData.base = s.scale.clone(); sprites.push(s);
      s.position.copy(V(r.x, r.y, r.z)); root.add(s);
      const l = label(text, color); l.position.copy(s.position); if (below) l.center.set(0, 1.15); root.add(l);
    };
    const at = t => rec.find(q => q.t >= t) || rec[rec.length - 1];
    if (ev.burnout) mark(at(ev.burnout.t), '燃焼終了', PH_COL.pow);
    if (ev.apogee) mark(at(ev.apogee.t), `頂点 ${ev.apogee.z.toFixed(0)} m`, '#ffffff');
    if (ev.deploy1 && !ev.deploy2?.beforeDeploy1) mark(at(ev.deploy1.t), '1段目開傘', PH_COL.c1, true);
    if (ev.deploy2) mark(at(ev.deploy2.t), ev.deploy2.beforeDeploy1 ? '1・2段目 同時開傘' : '2段目開傘', PH_COL.c2);
    if (ev.payload) mark(at(ev.payload.t), 'ペイロード放出', PH_COL.pay, true);
    if (ev.landing) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(ext * 0.012, ext * 0.018, 32), new THREE.MeshBasicMaterial({ color: 0xff6b8b, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.copy(V(ev.landing.x, ev.landing.y, 0.5)); root.add(ring);
      const l = label(`着地 ${Math.hypot(ev.landing.x, ev.landing.y).toFixed(0)} m`, '#ff6b8b'); l.position.copy(ring.position); root.add(l);
    }
    // 機体・パラ
    const R = buildRocket(M); rocket = R.g; flame = R.flame;
    rocket.scale.setScalar(visScale); root.add(rocket);
    chute = buildChute().g; root.add(chute);
    // ペイロード（破線の軌跡・着地点・カプセル＋パラシュート）
    if (prec.length) {
      const PP = []; for (const q of prec) { const v = V(q.x, q.y, q.z); PP.push(v.x, v.y, v.z); }
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(PP, 3));
      const dashed = op => new THREE.LineDashedMaterial({ color: PH_COL.pay, dashSize: ext * 0.012, gapSize: ext * 0.008, transparent: true, opacity: op });
      const ghost = new THREE.Line(pg, dashed(0.3)); ghost.computeLineDistances(); root.add(ghost);
      const line = new THREE.Line(pg.clone(), dashed(1)); line.computeLineDistances(); root.add(line);
      const PL = sim.payload.landing;
      if (PL) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(ext * 0.010, ext * 0.015, 32), new THREE.MeshBasicMaterial({ color: PH_COL.pay, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.copy(V(PL.x, PL.y, 0.6)); root.add(ring);
        const l = label(`ペイロード着地 ${Math.hypot(PL.x, PL.y).toFixed(0)} m`, PH_COL.pay); l.position.copy(ring.position); root.add(l);
      }
      const g = new THREE.Group(), cap = buildCapsule(M.R * 0.8, Math.max(M.d * 2.5, 0.08)); g.add(cap);
      g.scale.setScalar(visScale); root.add(g);
      const pc = buildChute([0.77, 0.55, 1]); root.add(pc.g);
      const pb = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex(), color: PH_COL.pay, sizeAttenuation: false, depthTest: false, transparent: true }));
      pb.scale.set(0.018, 0.018, 1); pb.userData.base = pb.scale.clone(); sprites.push(pb); pb.renderOrder = 11; root.add(pb);
      const lbl = label('ペイロード', PH_COL.pay, 0.8); lbl.center.set(1.08, 0.5); root.add(lbl);   // 本体のラベルと重ならないよう左側に出す
      pay = { g, chute: pc.g, line, beacon: pb, lbl, n: prec.length };
    }
    peakT = Math.max(...M.pts.map(p => p[1]), 1);
    // 落下線とビーコン（遠くても位置が分かるように）
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    dropLine = new THREE.Line(dg, new THREE.LineDashedMaterial({ color: 0xffd36b, dashSize: ext * 0.01, gapSize: ext * 0.01, transparent: true, opacity: 0.5 }));
    root.add(dropLine);
    beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex(), sizeAttenuation: false, depthTest: false, transparent: true }));
    beacon.scale.set(0.022, 0.022, 1); beacon.userData.base = beacon.scale.clone(); sprites.push(beacon); beacon.renderOrder = 11; root.add(beacon);

    if (mode === 'orbit') resetOrbit();
    camSmooth.pos = null;
  }
  function gridStep() { return niceStep(ext * 2, 12); }
  // パラシュートの描画直径 [m]（velocity 指定でも M の等価直径を使う）
  function chuteDia(k) { return (k === 'pay' ? model.payloadDia : k === 'c2' ? model.c2Dia ?? cfg.c2D / 1000 : model.c1Dia ?? cfg.c1D / 1000) || 0.3; }
  let _dot;
  function dotTex() {
    if (_dot) return _dot;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 30); g.addColorStop(0, 'rgba(255,230,140,1)'); g.addColorStop(0.35, 'rgba(255,200,90,.6)'); g.addColorStop(1, 'rgba(255,200,90,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    return (_dot = new THREE.CanvasTexture(cv));
  }
  function resetOrbit() {
    // 軌跡のバウンディングボックス中心を注視し、主な水平移動方向に対して斜め横から見る
    const rec = sim.rec;
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0, z1 = 1;
    for (const r of rec) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x); y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); z1 = Math.max(z1, r.z); }
    const L = sim.ev.landing || { x: Math.sin(model.azim), y: Math.cos(model.azim) };
    const main = Math.atan2(L.x, L.y);              // 方位（北=0）
    const view = main + Math.PI / 2 + 0.5;            // 横から少し斜め
    const target = V((x0 + x1) / 2, (y0 + y1) / 2, z1 * 0.42);
    const span = Math.max(x1 - x0, y1 - y0, z1);
    const d = span * 1.7;
    camera.position.copy(target).add(V(Math.sin(view) * d, Math.cos(view) * d, span * 0.22));
    controls.target.copy(target); controls.update();
  }

  // ---------- 毎フレーム ----------
  function sample() {
    const rec = sim.rec, i = Math.max(0, Math.min(playIdx, rec.length - 1)), a = rec[i];
    const b = rec[i + 1];
    if (!playing || !b) return a;
    const f = Math.min(1, Math.max(0, (playT - a.t) / Math.max(b.t - a.t, 1e-6)));
    const o = {};
    for (const k in a) o[k] = typeof a[k] === 'number' ? a[k] + (b[k] - a[k]) * f : a[k];
    o.ph = a.ph;
    return o;
  }
  function update(time) {
    const r = sample();
    const p = V(r.x, r.y, r.z);
    trailNow.geometry.setDrawRange(0, playIdx + 1);
    rocket.position.copy(p);
    const k = phKey(r), ev = sim.ev;
    let axis;
    if (r.ph === 2) {
      // 吊り下げ: 機体はほぼ水平に、パラは上
      const tc = (k === 'c2' ? ev.deploy2 : ev.deploy1)?.t ?? r.t;
      const open = Math.min(1, (r.t - tc) / Math.max(cfg.openTime, 0.05));
      const D = chuteDia(k);
      const rad = Math.max(D / 2, 0.05) * visScale * (0.25 + 0.75 * open);
      const sway = Math.sin(time * 0.0017) * 0.12;
      axis = new THREE.Vector3(Math.cos(model.azim), -0.35, Math.sin(model.azim)).normalize();
      chute.visible = true;
      chute.scale.set(rad, rad * (0.6 + 0.4 * open), rad);
      chute.position.copy(p).add(new THREE.Vector3(Math.sin(sway) * rad * 2.2, rad * 2.2, 0));
      chute.rotation.z = -sway;
      flame.visible = false;
    } else {
      axis = V(r.ux, r.uy, r.uz).normalize();
      chute.visible = false;
      flame.visible = r.T > 0.5;
      if (flame.visible) { const s = Math.sqrt(r.T / peakT); flame.scale.set(0.6 + 0.4 * s, (0.4 + 0.9 * s) * (0.92 + 0.08 * Math.sin(time * 0.05)), 0.6 + 0.4 * s); }
    }
    // 機軸に向けてからロール角だけ機軸まわりに回す（φ は mod 2π しない値。ph 2 では最後の値のまま）
    rocket.quaternion.setFromUnitVectors(Y_UP, axis).multiply(qRoll.setFromAxisAngle(Y_UP, Number.isFinite(r.roll) ? r.roll : 0));
    updatePayload(time);
    const pos = dropLine.geometry.attributes.position;
    pos.setXYZ(0, p.x, p.y, p.z); pos.setXYZ(1, p.x, 0, p.z); pos.needsUpdate = true; dropLine.computeLineDistances();
    beacon.position.copy(p);
    beacon.visible = document.getElementById('v3dCam').value !== 'chase';

    const mode = document.getElementById('v3dCam').value;
    controls.enabled = mode === 'orbit';
    if (mode === 'orbit') { if (camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); } controls.update(); fixSprites(); return; }
    const L = model.L * visScale;
    let want, look;
    if (mode === 'chase') {
      const vel = new THREE.Vector3(r.vx, r.vz, -r.vy);
      const dir = r.ph === 2 || vel.length() < 1 ? axis.clone().setY(0).normalize().negate() : vel.normalize();
      const side = new THREE.Vector3().crossVectors(dir, Y_UP); if (side.lengthSq() < 1e-6) side.set(1, 0, 0); side.normalize();
      const dist = r.ph === 2 ? Math.max(L * 6, chuteDia(k) * visScale * 6) : L * 3;
      want = p.clone().addScaledVector(dir, -dist).addScaledVector(side, dist * 0.45).addScaledVector(Y_UP, dist * 0.25);
      if (want.y < 1.5) want.y = 1.5;
      look = p.clone();
    } else if (mode === 'ground') {
      const az = model.azim + Math.PI / 2;
      want = V(Math.sin(az) * 25, Math.cos(az) * 25, 1.7);
      look = p.clone();
      // 遠ざかるほどズーム
      const d = want.distanceTo(p);
      camera.fov = THREE.MathUtils.clamp(2 * Math.atan(Math.max(L * 5, 6) / d) * 180 / Math.PI, 4, 60);
      camera.updateProjectionMatrix();
    } else { // onboard
      const ref = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const perp = new THREE.Vector3().crossVectors(axis, ref).normalize();
      const off = model.R * visScale * 1.8;
      want = p.clone().addScaledVector(perp, off).addScaledVector(axis, L * 0.15);
      look = p.clone().addScaledVector(axis, -L * 50).addScaledVector(perp, off);
      if (r.ph === 2) look = p.clone().setY(0);
    }
    if (mode !== 'ground' && camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); }
    // 機体基準のオフセットを平滑化（高速でもカメラが置いていかれない）
    const off = want.clone().sub(p), lo = look.clone().sub(p);
    if (!camSmooth.pos || mode !== 'chase') { camSmooth.pos = off; camSmooth.look = lo; }
    else { camSmooth.pos.lerp(off, 0.08); camSmooth.look.lerp(lo, 0.3); }
    camera.position.copy(p).add(camSmooth.pos);
    if (camera.position.y < 1.2) camera.position.y = 1.2;
    camera.lookAt(p.clone().add(camSmooth.look));
    fixSprites();
  }
  // ペイロード: playT で補間した位置にカプセルを置き、放出からの経過時間でパラを開く。放出前は隠す
  function updatePayload(time) {
    if (!pay) return;
    const t = playT, q = payAt(t);   // playT は再生中もスクラブ中も現在時刻（app.js の seekT）
    const vis = !!q;
    pay.g.visible = pay.chute.visible = pay.beacon.visible = pay.lbl.visible = vis;
    const pr = sim.payload.rec; let n = 0; while (n < pr.length && pr[n].t <= t) n++;
    pay.line.geometry.setDrawRange(0, n);
    if (!vis) return;
    const p = V(q.x, q.y, q.z), t0 = pr[0].t;
    const open = Math.min(1, Math.max(0, (t - t0) / Math.max(cfg.openTime, 0.05)));
    const rad = Math.max(chuteDia('pay') / 2, 0.03) * visScale * (0.25 + 0.75 * open);
    const sway = Math.sin(time * 0.0021 + 1) * 0.1;
    pay.g.position.copy(p);
    pay.chute.scale.set(rad, rad * (0.6 + 0.4 * open), rad);
    pay.chute.position.copy(p).add(new THREE.Vector3(Math.sin(sway) * rad * 2.2, rad * 2.2, 0));
    pay.chute.rotation.z = -sway;
    pay.beacon.position.copy(p); pay.beacon.visible = document.getElementById('v3dCam').value !== 'chase';
    pay.lbl.position.copy(p);
  }
  // 非減衰スプライトは視野角に比例して大きくなるため、FOV に合わせて補正
  function fixSprites() {
    const k = Math.tan(camera.fov * Math.PI / 360) / Math.tan(25 * Math.PI / 180);
    for (const sp of sprites) sp.scale.set(sp.userData.base.x * k, sp.userData.base.y * k, 1);
  }
  function loop(time) {
    requestAnimationFrame(loop);
    if (!visible || !sim) return;
    if (dirty) rebuild();
    if (!rocket || !sim.rec.length) { renderer.render(scene, camera); return; }
    update(time);
    renderer.render(scene, camera);
  }

  ok = init();
  return {
    markDirty() { dirty = true; },
    _dbg: () => ({ renderer, scene, camera, controls, THREE: window.THREE, rocket, chute, pay, visScale }),
    setVisible(v) { visible = v; if (v && ok) { resize(); } },
  };
})();
window.V3D.setVisible(document.getElementById('tab-3d').classList.contains('on'));
