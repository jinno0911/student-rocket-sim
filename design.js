'use strict';
/* 設計ツール（Magi の design.cpp を移植）。window.Design のみ公開
 *  - バロウマン法フィン最適化: 範囲内のランダム探索（既定 15 万通り）＋上位候補の座標降下。
 *    評価 = 50·|Fst − 目標| + 1000·フィン抗力係数 + 範囲外・フラッター余裕不足のペナルティ
 *    フラッター速度は NACA TN 4197、フィン抗力は摩擦（Schlichting）＋誘導抗力（±10° 平均）の概算
 *  - パラシュート寸法設計: 目標降下速度から開口面積・直径・ゴア型紙・スピルホール・吊索長
 * 形状の定義はこのアプリのフィン入力と同じ（翼根 Cr, 翼端 Ct, 前縁後退長 Xs, スパン s, 翼根後縁〜後端 finAft）
 */
window.Design = (() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const KEY = 'student-rocket-sim:design';
  const DEF = {
    fstTarget: 16, fstMin: 0, fstMax: 0, state: 'wet', E: 20, nu: 0.3, rho: 1800, step: 1, vEval: 0, alt: 0, nSamples: 150000, replaceFinMass: true,
    crMin: 100, crMax: 250, ctMin: 30, ctMax: 150, swMin: 0, swMax: 200, spMin: 50, spMax: 180, afMin: 0, afMax: 30,
    pdMass: 0, pdV: 7, pdCd: 0.75, pdRho: 1.225, pdG: 9.80665, pdGores: 8, pdSpill: 0.1, pdLine: 1, pdTarget: 'c1',
  };
  let st = { ...DEF };
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };

  // ---- 1 形状の評価（SI。位置は先端基準）----
  // ctx: {L, D, R, A, N, t, E, nu, rho, V, at(大気), body:{m, x}（フィンを除いた機体）, nose:[cna, x], tail:[cna, x] | null}
  function evaluate(ctx, g) {
    const { L, D, R, N } = ctx, { cr, ct, sw, sp, af } = g;
    if (!(cr > 0) || !(ct >= 0) || !(sp > 0)) return null;
    const Af = 0.5 * (cr + ct) * sp;                      // フィン 1 枚の面積
    const xRle = L - af - cr, lm = Math.hypot(sp, sw + ct / 2 - cr / 2);
    const nf = { 5: 0.97, 6: 0.948, 7: 0.9, 8: 0.865 }[N] || 1;
    const cnf = (1 + R / (sp + R)) * nf * 4 * N * (sp / D) ** 2 / (1 + Math.sqrt(1 + (2 * lm / (cr + ct)) ** 2));
    const xf = xRle + sw / 3 * (cr + 2 * ct) / (cr + ct) + (cr + ct - cr * ct / (cr + ct)) / 6;
    const parts = [ctx.nose, [cnf, xf]]; if (ctx.tail) parts.push(ctx.tail);
    const cna = parts.reduce((a, p) => a + p[0], 0), xcp = parts.reduce((a, p) => a + p[0] * p[1], 0) / cna;
    // フィン質量と重心（台形の図心）
    const m1 = Af * ctx.t * ctx.rho, mf = m1 * N;
    const px = [xRle, xRle + cr, xRle + sw + ct, xRle + sw], py = [0, 0, sp, sp];
    let A2 = 0, cx = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4, k = px[i] * py[j] - px[j] * py[i]; A2 += k; cx += (px[i] + px[j]) * k; }
    const xfc = Math.abs(A2) > 1e-15 ? cx / (3 * A2) : xRle + cr / 2;
    const mtot = ctx.body.m + mf, xcg = (ctx.body.m * ctx.body.x + mf * xfc) / mtot;
    const fst = (xcp - xcg) / L * 100;
    // 減衰係数（このアプリの定義: L 基準）
    const s2 = parts.reduce((a, p) => a + p[0] * (p[1] - xcg) ** 2, 0), cmq = -2 * s2 / (L * L);
    const kc = (ct - cr) / sp, ac = cr - kc * R, Fr = r => ac * r ** 3 / 3 + kc * r ** 4 / 4, rg2 = (Fr(R + sp) - Fr(R)) / Af;
    const clp = -4 * cnf * rg2 / (L * L);
    // フラッター速度（NACA TN 4197）
    const AR = sp * sp / Af, lam = ct / cr, tc = ctx.t / cr, Gm = ctx.E / (2 * (1 + ctx.nu));
    const den = 1.337 * AR ** 3 * ctx.at.p * (lam + 1) / (2 * (AR + 2) * tc ** 3);
    const flutter = ctx.t > 0 && ctx.E > 0 ? ctx.at.a * Math.sqrt(Gm / den) : NaN;
    // フィン抗力（概算）: 摩擦 + 誘導（迎角 ±10° の平均と最大）
    const cmean = 0.5 * (cr + ct), Re = ctx.at.rho * ctx.V * cmean / ctx.at.mu, Cf = Re > 1e4 ? 0.455 / Math.log10(Re) ** 2.58 : 0.01;
    const cdf = N * Cf * 2 * Af * (1 + 2 * ctx.t / Math.max(cmean, 1e-9)) / ctx.A;
    const tanL = (sw + ct / 2 - cr / 2) / sp, af2 = 2 * Math.PI * AR / (2 + Math.sqrt(AR * AR * (1 + tanL * tanL) + 4));
    let sum = 0, mx = 0;
    for (let i = 0; i < 41; i++) {
      const a = (-10 + 20 * i / 40) * Math.PI / 180;
      let cdi = 0; for (let k = 0; k < N; k++) { const cl = af2 * a * Math.cos(2 * Math.PI * k / N); cdi += cl * cl / (Math.PI * AR * 0.9) * Af / ctx.A; }
      sum += cdi; mx = Math.max(mx, cdi);
    }
    const q = 0.5 * ctx.at.rho * ctx.V ** 2, cdMean = cdf + sum / 41, cdMax = cdf + mx;
    return { g, cna, xcp, xcg, mtot, mf, m1, Af, fst, cmq, clp, flutter, cdf, cdMean, cdMax, Fmean: cdMean * q * ctx.A, Fmax: cdMax * q * ctx.A, mach: ctx.V / ctx.at.a, h: sp };
  }

  // 現在の cfg・モデルから評価用の文脈を作る
  function context(c, M, opt) {
    const mm = 1e-3, L = M.L, D = M.d, R = D / 2, G = window.Geo;
    const ms = opt.state === 'dry' ? M.massAt(M.tEnd) : M.massAt(0); // dry = 燃焼終了時
    const t = c.finThick * mm;
    // 機体（フィン除く）: 現在のフィンの推定質量を差し引く（材料密度 × 面積 × 厚さ）
    let body = { m: ms.m, x: ms.cg };
    if (opt.replaceFinMass) {
      const cur = { cr: c.finCr * mm, ct: c.finCt * mm, sw: c.finSweep * mm, sp: c.finSpan * mm, af: c.finAft * mm };
      const Af = 0.5 * (cur.cr + cur.ct) * cur.sp, mf = Af * t * opt.rho * M.N, xRle = L - cur.af - cur.cr;
      const px = [xRle, xRle + cur.cr, xRle + cur.sw + cur.ct, xRle + cur.sw], py = [0, 0, cur.sp, cur.sp];
      let A2 = 0, cx = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4, k = px[i] * py[j] - px[j] * py[i]; A2 += k; cx += (px[i] + px[j]) * k; }
      const xfc = Math.abs(A2) > 1e-15 ? cx / (3 * A2) : xRle + cur.cr / 2; // 台形の図心
      if (ms.m - mf > 0.1 * ms.m) body = { m: ms.m - mf, x: (ms.m * ms.cg - mf * xfc) / (ms.m - mf) };
    }
    const nose = M.comps.find(p => p.name === 'ノーズ'), tail = M.comps.find(p => p.name === 'テール');
    const atR = G ? G.isa1976(Math.max(opt.alt, 0)) : { p: 101325, a: 340.3, rho: 1.225, T: 288.15 };
    const at = { ...atR, mu: 1.458e-6 * atR.T ** 1.5 / (atR.T + 110.4) };
    return { L, D, R, A: M.A, N: M.N, t, E: opt.E * 1e9, nu: opt.nu, rho: opt.rho, V: opt.V, at, body, nose: [nose.cna, nose.x], tail: tail ? [tail.cna, tail.x] : null };
  }

  function score(e, o) {
    if (!e) return 1e18;
    let s = 50 * Math.abs(e.fst - o.fstTarget) + 1000 * e.cdMean;
    const fr = !(o.fstMin === 0 && o.fstMax === 0), lo = Math.min(o.fstMin, o.fstMax), hi = Math.max(o.fstMin, o.fstMax);
    if (fr) { if (e.fst < lo) s += 200 * (lo - e.fst) + 100; if (e.fst > hi) s += 200 * (e.fst - hi) + 100; }
    if (fin(e.flutter) && e.flutter < 1.5 * o.V) s += 500 * (1.5 - e.flutter / o.V) + 50;
    return s;
  }

  async function optimize(ctx, o, onProgress, ctl) {
    const mm = 1e-3, step = Math.max(o.step, 0.01) * mm;
    const R = [[o.crMin, o.crMax], [o.ctMin, o.ctMax], [o.swMin, o.swMax], [o.spMin, o.spMax], [o.afMin, o.afMax]].map(([a, b]) => [Math.min(a, b) * mm, Math.max(a, b) * mm]);
    const snap = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round((v - lo) / step) * step + lo));
    const geom = v => ({ cr: v[0], ct: v[1], sw: v[2], sp: v[3], af: v[4] });
    const rnd = mulberry32(20260101), best = [];
    let count = 0;
    for (let i = 0; i < o.nSamples; i++) {
      if (ctl.cancel) return null;
      const v = R.map(r => snap(r[0] + (r[1] - r[0]) * rnd(), r)), s = score(evaluate(ctx, geom(v)), o); count++;
      if (best.length < 24 || s < best[best.length - 1].s) { best.push({ v, s }); best.sort((a, b) => a.s - b.s); if (best.length > 24) best.pop(); }
      if (i % 5000 === 4999) { onProgress(70 * i / o.nSamples, `ランダム探索 ${i + 1}/${o.nSamples}`); await new Promise(r => setTimeout(r)); }
    }
    for (let b = 0; b < best.length; b++) { // 上位候補を刻み単位で座標降下
      const cd = best[b];
      for (let guard = 0, imp = true; imp && guard < 400; guard++) {
        imp = false;
        for (let k = 0; k < 5; k++) for (const dir of [-1, 1]) {
          const v2 = cd.v.slice(); v2[k] = Math.max(R[k][0], Math.min(R[k][1], v2[k] + dir * step));
          const s2 = score(evaluate(ctx, geom(v2)), o); count++;
          if (s2 < cd.s - 1e-12) { cd.v = v2; cd.s = s2; imp = true; }
        }
      }
      onProgress(70 + 30 * (b + 1) / best.length, `上位候補を局所探索 ${b + 1}/${best.length}`);
      if (ctl.cancel) return null;
      await new Promise(r => setTimeout(r));
    }
    best.sort((a, b) => a.s - b.s);
    return { e: evaluate(ctx, geom(best[0].v)), count };
  }

  // ---- パラシュート寸法 ----
  function chute(o) {
    if (!(o.pdMass > 0 && o.pdV > 0 && o.pdCd > 0 && o.pdRho > 0 && o.pdG > 0)) return null;
    const W = o.pdMass * o.pdG, A = 2 * W / (o.pdRho * o.pdV ** 2 * o.pdCd), D0 = Math.sqrt(4 * A / Math.PI), circ = Math.PI * D0;
    const spill = o.pdSpill * D0, line = o.pdLine * D0;
    return { W, A, D0, R0: D0 / 2, circ, base: circ / o.pdGores, h: D0 / 2 - spill / 2, spill, spillRatio: o.pdSpill ** 2, line, lineTotal: line * o.pdGores, cds: o.pdCd * A };
  }

  // ================= UI =================
  let finRes = null, ctlF = null;
  const num = (k, l, u, extra = '') => `<label class="field"><span>${l}${u ? ` <small>[${u}]</small>` : ''}</span><input type="number" step="any" data-d="${k}" value="${st[k]}" ${extra}></label>`;
  const rng = (a, b, l, u) => `<label class="field"><span>${l} <small>[${u}] 最小〜最大</small></span><span style="display:flex;gap:4px"><input type="number" step="any" data-d="${a}" value="${st[a]}"><input type="number" step="any" data-d="${b}" value="${st[b]}"></span></label>`;
  function mount(el) {
    el.innerHTML = `<div class="card"><div class="card-h">バロウマン法 フィン最適化（Fst 目標・フラッター余裕・フィン抗力）</div>
      <div class="muted small">機体の寸法・ノーズ・フィン枚数と厚さ・質量は現在の設定を使います。フィンを差し替えたときの重心変化は「現在のフィン質量を差し引いて新しいフィンを足す」で近似します（材料密度から計算）。</div>
      <div class="fields mini">${num('fstTarget', 'Fst 目標値', '%')}${num('fstMin', 'Fst 最小（0,0 で指定なし）', '%')}${num('fstMax', 'Fst 最大', '%')}
        <label class="field"><span>評価する状態</span><select data-d="state"><option value="wet">点火時（充填時）</option><option value="dry">燃焼終了時</option></select></label>
        ${num('E', 'ヤング率', 'GPa')}${num('nu', 'ポアソン比', '')}${num('rho', '材料密度', 'kg/m³')}${num('step', '加工刻み', 'mm')}
        ${num('vEval', '評価対気速度（0=最大速度）', 'm/s')}${num('alt', '評価高度', 'm')}${num('nSamples', 'ランダム探索の数', '通り')}
        <label class="field check"><input type="checkbox" data-d="replaceFinMass"${st.replaceFinMass ? ' checked' : ''}><span>フィン質量の差し替えで重心を補正</span></label>
        ${rng('crMin', 'crMax', '翼根コード Cr', 'mm')}${rng('ctMin', 'ctMax', '翼端コード Ct', 'mm')}${rng('swMin', 'swMax', '前縁後退長 Cle', 'mm')}${rng('spMin', 'spMax', 'スパン S', 'mm')}${rng('afMin', 'afMax', '翼根後縁〜機体後端', 'mm')}</div>
      <div class="row"><button class="primary" id="dsOpt">最適化</button><button id="dsEval">現在のフィンを評価</button><button id="dsStop" disabled>中止</button><button id="dsApply" disabled>設定に反映</button><span id="dsProg" class="muted small"></span></div>
      <div id="dsOut"></div></div>
      <div class="card"><div class="card-h">パラシュート寸法設計</div>
      <div class="fields mini">${num('pdMass', '吊下質量（0=燃焼終了時の全質量）', 'kg')}${num('pdV', '目標降下速度', 'm/s')}${num('pdCd', '抗力係数 Cd', '')}${num('pdRho', '空気密度', 'kg/m³')}${num('pdG', '重力加速度', 'm/s²')}${num('pdGores', 'ゴア枚数', '枚')}${num('pdSpill', 'スピルホール径／直径', '')}${num('pdLine', '吊索長／傘直径', '')}
        <label class="field"><span>反映先</span><select data-d="pdTarget"><option value="c1">1段目</option><option value="c2">2段目</option></select></label></div>
      <div class="row"><button class="primary" id="pdRun">計算</button><button id="pdApply" disabled>設定に反映</button></div><div id="pdOut" class="kv"></div></div>`;
    el.querySelector('[data-d="state"]').value = st.state; el.querySelector('[data-d="pdTarget"]').value = st.pdTarget;
    const onIn = e => {
      const k = e.target.dataset && e.target.dataset.d; if (!k) return;
      st[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.tagName === 'SELECT' ? e.target.value : parseFloat(e.target.value) || 0; save();
    };
    el.addEventListener('input', onIn); el.addEventListener('change', onIn);
    const prog = el.querySelector('#dsProg');
    const mk = () => {
      if (!model) throw new Error('計算エラーのため使えません');
      const V = st.vEval > 0 ? st.vEval : Math.max(fin(sim && sim.st && sim.st.maxV) ? sim.st.maxV : 100, 10);
      return { ctx: context(cfg, model, { ...st, V }), V };
    };
    el.querySelector('#dsEval').addEventListener('click', () => {
      try {
        const { ctx, V } = mk(), mm = 1e-3;
        finRes = { e: evaluate(ctx, { cr: cfg.finCr * mm, ct: cfg.finCt * mm, sw: cfg.finSweep * mm, sp: cfg.finSpan * mm, af: cfg.finAft * mm }), V, current: true };
        renderFin(el); prog.textContent = '現在のフィン形状を評価しました';
      } catch (e) { prog.textContent = e.message; }
    });
    el.querySelector('#dsOpt').addEventListener('click', async () => {
      if (ctlF) return;
      let m; try { m = mk(); } catch (e) { prog.textContent = e.message; return; }
      const ctl = ctlF = { cancel: false }, t0 = performance.now();
      el.querySelector('#dsStop').disabled = false; el.querySelector('#dsOpt').disabled = true;
      const r = await optimize(m.ctx, { ...st, V: m.V }, (p, s) => { prog.textContent = `${s} | ${p.toFixed(0)}% | 経過 ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, ctl);
      ctlF = null; el.querySelector('#dsStop').disabled = true; el.querySelector('#dsOpt').disabled = false;
      if (!r) { prog.textContent = '中止しました'; return; }
      finRes = { e: r.e, V: m.V, count: r.count }; renderFin(el);
      prog.textContent = `完了（${r.count.toLocaleString()} 形状を評価、${((performance.now() - t0) / 1000).toFixed(1)} s）`;
    });
    el.querySelector('#dsStop').addEventListener('click', () => { if (ctlF) ctlF.cancel = true; });
    el.querySelector('#dsApply').addEventListener('click', () => {
      if (!finRes || !finRes.e) return;
      const g = finRes.e.g, r1 = v => Math.round(v * 1e4) / 10;
      const patch = { finCr: r1(g.cr), finCt: r1(g.ct), finSweep: r1(g.sw), finSpan: r1(g.sp), finAft: r1(g.af) };
      let msg = `フィン形状を反映します:\nCr ${patch.finCr} / Ct ${patch.finCt} / 前縁後退 ${patch.finSweep} / スパン ${patch.finSpan} / 後縁〜後端 ${patch.finAft} mm`;
      if (cfg.aeroMode === 'manual') {
        Object.assign(patch, { cnaManual: +finRes.e.cna.toFixed(4), cpManual: +(finRes.e.xcp * 1000).toFixed(2), cmq: +finRes.e.cmq.toFixed(4), clp: +finRes.e.clp.toFixed(4) });
        msg += `\n空力が「直接入力」なので CNα・圧力中心・Cmq・Clp も Barrowman の値で上書きします`;
      }
      if (!confirm(msg + '\n（質量・重心は変更しません。必要なら機体質量を見直してください）')) return;
      applyCfg({ ...cfg, ...patch });
    });
    // パラシュート
    let pdRes = null;
    el.querySelector('#pdRun').addEventListener('click', () => {
      const mass = st.pdMass > 0 ? st.pdMass : model ? model.massAt(model.tEnd).m : 0;
      pdRes = chute({ ...st, pdMass: mass });
      const o = el.querySelector('#pdOut');
      if (!pdRes) { o.textContent = '吊下質量・目標降下速度・Cd・空気密度・重力加速度を正の値にしてください'; return; }
      el.querySelector('#pdApply').disabled = false;
      const r = pdRes;
      o.innerHTML = [['吊下質量', mass.toFixed(3) + ' kg'], ['吊下静荷重 mg', r.W.toFixed(2) + ' N'], ['キャノピー開口面積', r.A.toFixed(4) + ' m²'], ['円形換算直径', (r.D0 * 1000).toFixed(1) + ' mm'], ['開口円周', (r.circ * 1000).toFixed(1) + ' mm'],
        ['ゴア底辺', (r.base * 1000).toFixed(1) + ' mm'], ['ゴア型紙高さ', (r.h * 1000).toFixed(1) + ' mm'], ['スピルホール直径', (r.spill * 1000).toFixed(1) + ' mm'], ['スピルホール面積比', (r.spillRatio * 100).toFixed(2) + ' %'],
        ['吊索 1 本の有効長', (r.line * 1000).toFixed(1) + ' mm'], ['全吊索の合計', r.lineTotal.toFixed(2) + ' m'], ['シミュレーター入力 CdS', r.cds.toFixed(4) + ' m²']].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
    });
    el.querySelector('#pdApply').addEventListener('click', () => {
      if (!pdRes) return;
      const two = st.pdTarget === 'c2', D = Math.round(pdRes.D0 * 10000) / 10;
      const patch = cfg.chuteSpec === 'velocity' ? { [two ? 'c2Vt' : 'c1Vt']: st.pdV } : { [two ? 'c2D' : 'c1D']: D, [two ? 'c2Cd' : 'c1Cd']: st.pdCd };
      if (!confirm(`${two ? '2段目' : '1段目'}のパラシュートに反映します: ${Object.entries(patch).map(([k, v]) => `${k} = ${v}`).join(', ')}`)) return;
      applyCfg({ ...cfg, ...patch });
    });
  }
  function renderFin(el) {
    const R = finRes, e = R && R.e, o = el.querySelector('#dsOut');
    if (!e) { o.textContent = '形状が不正です'; return; }
    el.querySelector('#dsApply').disabled = !!R.current;
    const g = e.g, L = cfgLenMm(cfg), w = [];
    const lo = Math.min(st.fstMin, st.fstMax), hi = Math.max(st.fstMin, st.fstMax);
    if (!(st.fstMin === 0 && st.fstMax === 0) && (e.fst < lo || e.fst > hi)) w.push('Fst が指定範囲に入る形状は見つかりませんでした（最も近い形状を表示）');
    if (fin(e.flutter) && e.flutter < 1.5 * R.V) w.push(`フラッター速度の余裕（評価速度 ${R.V.toFixed(0)} m/s の 1.5 倍）を満たせていません`);
    if (!R.current && Math.abs(e.fst - st.fstTarget) > 1) w.push(`Fst が目標値（${st.fstTarget} %）から 1 ポイント以上離れています（範囲の制約が厳しい可能性）`);
    const rows = [
      ['フィン形状・取付位置', [['翼根コード Cr', g.cr * 1000, 'mm'], ['翼端コード Ct', g.ct * 1000, 'mm'], ['前縁後退長 Cle', g.sw * 1000, 'mm'], ['スパン S', g.sp * 1000, 'mm'], ['翼根後縁〜機体後端', g.af * 1000, 'mm'], ['後退角（後縁）', Math.atan2(g.sp, g.sw + g.ct - g.cr) * 180 / Math.PI, 'deg']]],
      ['質量・安定性・空力', [['フィン 1 枚の面積', e.Af * 1e4, 'cm²'], ['フィン 1 枚の質量', e.m1 * 1000, 'g'], ['全フィンの質量', e.mf * 1000, 'g'], ['合計質量', e.mtot, 'kg'], ['重心（後端から）', L - e.xcg * 1000, 'mm'], ['圧力中心（後端から）', L - e.xcp * 1000, 'mm'], ['Fst', e.fst, '%'], ['静安定余裕', (e.xcp - e.xcg) / (cfg.d / 1000), 'cal'], ['CNα', e.cna, '1/rad'], ['Cmq（全長基準）', e.cmq, '-'], ['Clp（全長基準）', e.clp, '-'], ['フラッター速度', e.flutter, 'm/s'], ['評価対気速度', R.V, 'm/s']]],
      ['フィン抗力（概算）', [['平均フィン抗力係数（±10°）', e.cdMean, '-'], ['摩擦抗力係数', e.cdf, '-'], ['最大フィン抗力係数（±10°）', e.cdMax, '-'], ['平均フィン抗力', e.Fmean, 'N'], ['最大フィン抗力', e.Fmax, 'N'], ['評価マッハ数', e.mach, '-']]],
    ];
    o.innerHTML = (w.length ? w.map(s => `<div class="w warn">⚠ ${esc(s)}</div>`).join('') : '') + `<div class="kv" style="display:block">` + rows.map(([sec, rs]) => `<div style="margin-top:6px"><b style="color:var(--fg)">${sec}</b><div class="kv">${rs.map(([l, v, u]) => `<span>${l} <b>${fin(v) ? +v.toPrecision(5) : '—'} ${u}</b></span>`).join('')}</div></div>`).join('') + '</div>';
  }
  return { evaluate, context, optimize, chute, mount };
})();
