'use strict';
/* 検算（Magi の verify.cpp を移植）: シミュレータ本体とは別の式・別の積分法で結果を確かめる。window.Verify のみ公開
 * 1. 解析解  2. 保存則  3. 数値（独立 1 次元モデル・刻み収束）  4. 空力・大気  5. 座標
 * 判定: 合格 / 注意 / 不合格 / 参考。※「設定どおりに計算できているか」の確認で、実機との一致を保証するものではない
 */
window.Verify = (() => {
  const ST = { pass: ['合格', '#7ee787'], warn: ['注意', '#ffd36b'], fail: ['不合格', '#ff6b8b'], info: ['参考', '#8c9bbd'] };
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const f = (v, d = 3) => (fin(v) ? (+v.toPrecision(d + 3)).toString() : '—');
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function run(base) {
    const items = [], t0 = performance.now();
    const add = (g, title, exp, act, diff, st, note) => items.push({ g, title, exp, act, diff, st, note });
    // 相対誤差で判定
    const rel = (g, title, e, a, unit, tp, tw, note) => {
      const r = Math.abs(a - e) / Math.max(Math.abs(e), 1e-12);
      add(g, title, `${f(e, 5)} ${unit}`, `${f(a, 5)} ${unit}`, `${(100 * r).toFixed(3)} %`, !fin(r) ? 'fail' : r <= tp ? 'pass' : r <= tw ? 'warn' : 'fail', note + `（合格 ≤ ${100 * tp}%、注意 ≤ ${100 * tw}%）`);
    };
    const G1 = '1. 解析解', G2 = '2. 保存則', G3 = '3. 数値', G4 = '4. 空力・大気', G5 = '5. 座標';
    const clean = { wind: 0, gust: 0, windModel: 'power', elev: 90, rec1: 'none', payloadOn: false, earthRot: false, landSurface: 'site', tipOff: false, chuteDelay: 0 };
    let M0;
    try { M0 = buildModel(base); } catch (e) { add(G1, 'モデルの構築', '-', '-', '-', 'info', '設定からモデルを作れません: ' + e.message); return finish(); }
    if (!(M0.Itot > 0)) { add(G1, '推力', '-', '-', '-', 'info', '全力積が 0 のため飛行の検算を省略しました'); return finish(); }
    const gH = h => G0 * (RE / (RE + h)) ** 2, phi = h => -G0 * RE * RE / (RE + h);

    // ---- 1. 鉛直・無抗力: 独立 RK4（刻み 0.1 ms）で燃焼終了速度・高度、エネルギー式で頂点 ----
    const cA = normalizeCfg({ ...base, ...clean, cdScale: 0 }), MA = buildModel(cA), sA = simulate(MA, { seed: 1 });
    {
      let t = 0, z = 0, v = 0; const h = 1e-4, tb = MA.tb;
      const acc = (tt, zz, vv) => { const a = MA.thrust(tt, zz) / MA.massAt(tt).m - gH(MA.siteAlt + zz); return vv <= 0 && zz <= 0 && a < 0 ? 0 : a; };
      while (t < tb - 1e-12) {
        const dt = Math.min(h, tb - t);
        const k1v = acc(t, z, v), k1z = v, k2v = acc(t + dt / 2, z + dt / 2 * k1z, v + dt / 2 * k1v), k2z = v + dt / 2 * k1v;
        const k3v = acc(t + dt / 2, z + dt / 2 * k2z, v + dt / 2 * k2v), k3z = v + dt / 2 * k2v, k4v = acc(t + dt, z + dt * k3z, v + dt * k3v), k4z = v + dt * k3v;
        v += dt / 6 * (k1v + 2 * k2v + 2 * k3v + k4v); z += dt / 6 * (k1z + 2 * k2z + 2 * k3z + k4z); t += dt;
        if (z < 0) { z = 0; v = Math.max(v, 0); }
      }
      const B = sA.ev.burnout;
      if (B) {
        rel(G1, '燃焼終了速度（鉛直・無抗力・無風）', v, B.V, 'm/s', 0.005, 0.02, '独立した RK4（刻み 0.1 ms）で dv/dt = T/m − g(h) を積分');
        rel(G1, '燃焼終了高度', z, B.z, 'm', 0.005, 0.02, '同上');
        const hb = MA.siteAlt + z, ha = 1 / (1 / (RE + hb) - v * v / (2 * G0 * RE * RE)) - RE;
        if (sA.ev.apogee) rel(G1, '頂点高度（エネルギー式）', ha - MA.siteAlt, sA.st.apogee, 'm', 0.005, 0.02, '燃焼終了後は v²/2 + Φ(h) 一定（Φ = −g₀R²/(R+h)）として計算');
      } else add(G1, '燃焼終了', '-', '-', '-', 'info', '検算用の飛行が燃焼終了まで計算できませんでした: ' + (sA.ev.error || ''));
      const m0 = MA.massAt(0).m, m1 = MA.massAt(MA.tEnd).m, ve = MA.Itot / Math.max(MA.prop, 1e-9);
      add(G1, 'ツィオルコフスキーの理想速度 ve·ln(m₀/m₁)', `${f(ve * Math.log(m0 / m1), 4)} m/s`, B ? `${f(B.V, 4)} m/s（重力損失込み）` : '—', B ? `重力損失 ≈ ${f(ve * Math.log(m0 / m1) - B.V, 3)} m/s` : '—', 'info', `有効排気速度 ve = 全力積/推進剤質量 = ${f(ve, 4)} m/s。差はおおむね g×燃焼時間（${f(G0 * MA.tb, 3)} m/s）`);
    }
    // ---- 1. パラシュート終端降下速度 √(2mg/ρCdA) ----
    {
      const cP = normalizeCfg({ ...base, wind: 0, gust: 0, windModel: 'power', payloadOn: false, landSurface: 'site', chuteDelay: 0 }), MP = buildModel(cP), sP = simulate(MP, { seed: 1 });
      const L = sP.ev.landing;
      if (cP.rec1 === 'none' || !(MP.c1CdA > 0)) add(G1, 'パラシュート終端降下速度', '-', '-', '-', 'info', '回収系が無いため省略');
      else if (!L) add(G1, 'パラシュート終端降下速度', '-', '-', '-', 'info', '着地まで計算できなかったため省略');
      else {
        const two = !!sP.ev.deploy2, cda = MP.chuteVel ? (two ? MP.c2CdA : MP.c1CdA) : MP.A * MP.cd0 + MP.c1CdA + (two ? MP.c2CdA : 0);
        const rho = atm(MP, MP.siteAlt).rho, m = MP.massAt(L.t).m, vt = Math.sqrt(2 * m * gH(MP.siteAlt) / (rho * cda));
        rel(G1, `パラシュート終端降下速度（${two ? '2段目' : '1段目'}、着地時）`, vt, Math.abs(L.vz), 'm/s', 0.01, 0.03, '√(2mg/ρ·CdA)、ρ は射点の大気密度。展開直後で平衡に達していないと差が出ます');
      }
    }
    // ---- 2. 保存則 ----
    {
      const r = sA.rec, tb = MA.tb, ta = sA.ev.apogee ? sA.ev.apogee.t : Infinity;
      const coast = r.filter(q => q.t > tb + 0.05 && q.t < ta - 0.05);
      if (coast.length > 5) {
        const E = coast.map(q => q.V * q.V / 2 + phi(MA.siteAlt + q.z)), K0 = coast[0].V ** 2 / 2;
        const drift = Math.max(...E) - Math.min(...E), rr = drift / Math.max(K0, 1);
        add(G2, '力学的エネルギー保存（無抗力・惰性飛行）', '変化 0 J/kg', `最大変化 ${f(drift, 3)} J/kg`, `${rr.toExponential(2)}（初期運動エネルギー比）`, rr < 1e-4 ? 'pass' : rr < 1e-3 ? 'warn' : 'fail', 'v²/2 + Φ(h)。RK4 の打切り誤差の大きさを見る（合格 < 1e-4）');
      } else add(G2, '力学的エネルギー保存', '-', '-', '-', 'info', '惰性飛行のサンプルが無いため省略');
      // 力積: 記録した推力の台形積分 vs 推力曲線の全力積
      const pw = r.filter(q => q.t <= tb + 0.02);
      let I = 0; for (let i = 1; i < pw.length; i++) I += (pw[i].T + pw[i - 1].T) / 2 * (pw[i].t - pw[i - 1].t);
      rel(G2, '力積 ∫T dt（記録値の台形積分）', MA.Itot, I, 'N·s', 0.01, 0.03, '記録は 0.02 s 間隔のため曲線の細部で差が出ます');
      const m0 = MA.massAt(0).m, m1 = MA.massAt(MA.tEnd).m;
      rel(G2, '質量収支 m(0) − m(終了)', MA.prop, m0 - m1, 'kg', 1e-9, 1e-6, '推進剤質量（hybrid は酸化剤＋消費燃料）と一致するか');
      const isp = MA.Itot / (G0 * MA.prop);
      add(G2, '比推力 Isp = I/(g₀·Δm)', '40〜400 s の範囲', `${f(isp, 4)} s`, '-', isp >= 40 && isp <= 400 ? 'pass' : 'warn', '推力曲線と推進剤質量の整合（固体 80〜250 s、ハイブリッド 100〜250 s 程度）');
    }
    // ---- 3. 数値: 独立 1 次元モデル（Dormand–Prince 適応刻み）と比較、刻み幅の収束 ----
    {
      const cV = normalizeCfg({ ...base, ...clean }), MV = buildModel(cV), sV = simulate(MV, { seed: 1, record: false });
      const fdrag = (t, z, v) => {
        const at = atm(MV, Math.max(MV.siteAlt + z, 0)), D = 0.5 * at.rho * v * Math.abs(v) * MV.A * MV.cdAt(Math.abs(v) / at.a);
        const a = (MV.thrust(t, z) - D) / MV.massAt(t).m - gH(MV.siteAlt + z);
        return v <= 0 && z <= 0 && a < 0 ? 0 : a;
      };
      // Dormand–Prince 5(4)
      const A = [[], [1 / 5], [3 / 40, 9 / 40], [44 / 45, -56 / 15, 32 / 9], [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729], [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656], [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]];
      const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1], B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0], B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];
      let t = 0, y = [0, 0], h = 1e-3, zmax = 0, tmax = 0, steps = 0, rejected = 0;
      const F = (tt, s) => [s[1], fdrag(tt, s[0], s[1])];
      while (t < 600 && steps < 200000) {
        if (MV.tb > t && t + h > MV.tb) h = Math.max(MV.tb - t, 1e-6); // 推力曲線の終わりで刻みを合わせる
        const k = [];
        for (let i = 0; i < 7; i++) { const yi = y.map((v, j) => v + h * A[i].reduce((s, a, m) => s + a * k[m][j], 0)); k.push(F(t + C[i] * h, yi)); }
        const y5 = y.map((v, j) => v + h * B5.reduce((s, b, m) => s + b * k[m][j], 0)), y4 = y.map((v, j) => v + h * B4.reduce((s, b, m) => s + b * k[m][j], 0));
        const err = Math.max(...y5.map((v, j) => Math.abs(v - y4[j]) / (1e-6 + 1e-8 * Math.abs(v))));
        if (err <= 1) {
          t += h; y = y5; steps++;
          if (y[0] > zmax) { zmax = y[0]; tmax = t; }
          if (t > MV.tb && y[1] < 0) break;
        } else rejected++;
        h = Math.min(0.05, h * Math.min(5, Math.max(0.2, 0.9 * Math.pow(Math.max(err, 1e-12), -0.2))));
      }
      if (sV.ev.apogee) {
        rel(G3, '頂点高度: 独立 1 次元モデル（Dormand–Prince 適応刻み）', zmax, sV.st.apogee, 'm', 0.005, 0.02, `鉛直・無風・抗力あり。独立モデルは ${steps} ステップ（棄却 ${rejected}）`);
        rel(G3, '頂点到達時刻: 独立 1 次元モデル', tmax, sV.ev.apogee.t, 's', 0.01, 0.03, '本体は外側刻み単位で頂点を検出するため、刻み程度の差は正常');
      } else add(G3, '独立 1 次元モデル', '-', '-', '-', 'info', '頂点に到達しなかったため比較を省略（推力不足の可能性）');
      // 刻み幅の収束（設定どおりの条件、乱流なし）
      const ap = k => { const c = normalizeCfg({ ...base, gust: 0, dt: base.dt / k }); const s = simulate(buildModel(c), { seed: 1, record: false }); return [s.st.apogee, s.ev.landing ? Math.hypot(s.ev.landing.x, s.ev.landing.y) : NaN]; };
      const [a1, l1] = ap(1), [a2, l2] = ap(2), [a4, l4] = ap(4);
      const ra = Math.abs(a1 - a4) / Math.max(a4, 1e-9), rl = Math.abs(l1 - l4) / Math.max(l4, 1e-9);
      add(G3, '刻み幅の収束: 頂点高度', `${f(a4, 6)} m（刻み 1/4）`, `${f(a1, 6)} m（刻み ${base.dt} ms）`, `1/2: ${f(a2, 6)} m、差 ${(100 * ra).toFixed(4)} %`, ra < 1e-3 ? 'pass' : ra < 1e-2 ? 'warn' : 'fail', '刻みを 1/2・1/4 にして結果が変わらないこと（合格 < 0.1%）');
      if (fin(l4)) add(G3, '刻み幅の収束: 落下距離', `${f(l4, 6)} m（刻み 1/4）`, `${f(l1, 6)} m`, `1/2: ${f(l2, 6)} m、差 ${(100 * rl).toFixed(4)} %`, rl < 5e-3 ? 'pass' : rl < 2e-2 ? 'warn' : 'fail', '落下距離は開傘タイミングの離散化の影響を受けやすい（合格 < 0.5%）');
    }
    // ---- 4. 空力・大気 ----
    {
      const G = window.Geo;
      if (G) {
        const Ms = { T0sl: 288.15 }; let worstP = 0, worstR = 0;
        for (const hk of [0, 1, 2, 5, 8, 11]) { const a = atm(Ms, hk * 1000), b = G.isa1976(hk * 1000); worstP = Math.max(worstP, Math.abs(a.p / b.p - 1)); worstR = Math.max(worstR, Math.abs(a.rho / b.rho - 1)); }
        add(G4, '標準大気（0〜11 km, 6 点, 地上 15℃）', 'US Standard Atmosphere 1976', `圧力 最大差 ${(100 * worstP).toFixed(3)} %`, `密度 最大差 ${(100 * worstR).toFixed(3)} %`, Math.max(worstP, worstR) < 0.005 ? 'pass' : Math.max(worstP, worstR) < 0.02 ? 'warn' : 'fail', '本体は対流圏＋等温層の簡易式（20 km 以上は標準大気からずれます）');
        const a20 = atm(Ms, 20000), b20 = G.isa1976(20000);
        add(G4, '標準大気 20 km（参考）', `${f(b20.p, 5)} Pa`, `${f(a20.p, 5)} Pa`, `${(100 * (a20.p / b20.p - 1)).toFixed(2)} %`, 'info', '20 km 以上を飛ぶ機体では誤差が増えます');
      }
      // Barrowman の独立再計算（physics とは別に書いた式）
      const c = base, mm = 1e-3, d = c.d * mm, R = d / 2, Ln = c.noseLen * mm, L = cfgLenMm(c) * mm;
      const kn = { ogive: 0.466, cone: 2 / 3, parabolic: 0.5, elliptic: 1 / 3 }[c.noseShape];
      const parts = [[2, kn * Ln]];
      if (c.tailLen > 0 && Math.abs(c.tailD - c.d) > 1e-6) { const q = c.d / c.tailD; parts.push([2 * ((c.tailD / c.d) ** 2 - 1), L - c.tailLen * mm + c.tailLen * mm / 3 * (1 + (1 - q) / (1 - q * q))]); }
      const cr = c.finCr * mm, ct = c.finCt * mm, s = c.finSpan * mm, xs = c.finSweep * mm, N = Math.round(c.finN), xb = L - c.finAft * mm - cr;
      const lm = Math.hypot(s, xs + ct / 2 - cr / 2), nf = { 5: 0.97, 6: 0.948, 7: 0.9, 8: 0.865 }[N] || 1;
      const cnf = (1 + R / (s + R)) * nf * 4 * N * (s / d) ** 2 / (1 + Math.sqrt(1 + (2 * lm / (cr + ct)) ** 2));
      parts.push([cnf, xb + xs / 3 * (cr + 2 * ct) / (cr + ct) + (cr + ct - cr * ct / (cr + ct)) / 6]);
      const cn = parts.reduce((a, p) => a + p[0], 0), xcp = parts.reduce((a, p) => a + p[0] * p[1], 0) / cn;
      const Mb = buildModel(normalizeCfg({ ...base, aeroMode: 'barrowman', aeroTable: '', cnaScale: 100, cpShift: 0 })), cb = Mb.cpAt(0);
      rel(G4, 'Barrowman 再計算: CNα', cn, cb.cna, '1/rad', 1e-6, 1e-3, '機体形状から独立に書いた式で再計算');
      rel(G4, 'Barrowman 再計算: 圧力中心（先端から）', xcp * 1000, cb.xcp * 1000, 'mm', 1e-6, 1e-3, '同上');
      if (base.aeroMode === 'manual') {
        const dcn = base.cnaManual / cn - 1, dcp = base.cpManual - xcp * 1000;
        add(G4, '空力の入力値と Barrowman の比較: CNα', `Barrowman ${f(cn, 4)} /rad`, `入力 ${f(base.cnaManual, 4)} /rad`, `${(100 * dcn).toFixed(1)} %`, Math.abs(dcn) < 0.1 ? 'pass' : Math.abs(dcn) < 0.25 ? 'warn' : 'fail', '入力値（諸元表など）が形状と整合するか（合格 ±10%）');
        add(G4, '空力の入力値と Barrowman の比較: 圧力中心', `Barrowman ${f(L * 1000 - xcp * 1000, 5)} mm（後端から）`, `入力 ${f(L * 1000 - base.cpManual, 5)} mm`, `${dcp.toFixed(1)} mm`, Math.abs(dcp) < 0.03 * L * 1000 ? 'pass' : Math.abs(dcp) < 0.08 * L * 1000 ? 'warn' : 'fail', '合格 ±3% 全長');
      }
      const ms0 = M0.massAt(0), fst = (M0.cpAt(0).xcp - ms0.cg) / M0.L * 100;
      add(G4, '初期 Fst の目安', '10〜30 % 程度（機体による）', `${fst.toFixed(2)} %`, '-', fst >= 10 && fst <= 30 ? 'pass' : fst >= 5 ? 'warn' : 'fail', '5% 未満は不安定側。ここでは目安のみ');
    }
    // ---- 5. 座標 ----
    {
      const G = window.Geo, c = base;
      if (G) {
        let worstPos = 0, worstD = 0, worstA = 0, worstRT = 0;
        for (const r of [1000, 3000, 5000, 10000]) for (let k = 0; k < 8; k++) {
          const az = k * 45 * Math.PI / 180, x = r * Math.sin(az), y = r * Math.cos(az);
          const [la, lo] = enuToLatLon(c.lat, c.lon, x, y), g = G.enuToGeodetic(c.lat, c.lon, 0, x, y, 0);
          const dPos = G.vincenty(la, lo, g.lat, g.lon).dist; worstPos = Math.max(worstPos, dPos / r);
          const vv = G.vincenty(c.lat, c.lon, la, lo); worstD = Math.max(worstD, Math.abs(vv.dist / r - 1));
          let da = Math.abs(vv.az - k * 45); da = Math.min(da, 360 - da); worstA = Math.max(worstA, da);
          const e = G.geodeticToEcef(la, lo, 123.4), b = G.ecefToGeodetic(e), e2 = G.geodeticToEcef(b.lat, b.lon, b.h);
          worstRT = Math.max(worstRT, Math.hypot(e[0] - e2[0], e[1] - e2[1], e[2] - e2[2]));
        }
        add(G5, '着地点の緯度経度: 接平面近似 vs 楕円体（1〜10 km）', '一致', `位置差 最大 ${(100 * worstPos).toFixed(4)} %（距離比）`, '-', worstPos < 1e-3 ? 'pass' : worstPos < 5e-3 ? 'warn' : 'fail', '本体は射点の接平面で計算し、楕円体の曲率半径で緯度経度に直します（合格 < 0.1%。誤差は距離にほぼ比例し 30 km で約 0.2%）');
        add(G5, '距離・方位: 接平面 vs Vincenty 測地線（1〜10 km）', '一致', `距離差 最大 ${(100 * worstD).toFixed(4)} %`, `方位差 最大 ${worstA.toFixed(4)}°`, worstD < 3e-3 && worstA < 0.2 ? 'pass' : 'warn', 'WGS84 楕円体上の測地線（Vincenty）と比較（合格 < 0.3%・0.2°）');
        add(G5, '測地座標 ⇄ ECEF の往復誤差', '0 m', `最大 ${worstRT.toExponential(2)} m`, '32 点', worstRT < 1e-3 ? 'pass' : worstRT < 1e-2 ? 'warn' : 'fail', '');
        const decl = G.magDecl(c.lat, c.lon, c.siteAlt, G.decimalYear(c.launchDate)), used = M0.magDecl;
        const dd = Math.abs(decl - used);
        add(G5, '磁気偏角: WMM2025 と使用値', `${decl.toFixed(2)}°（${c.launchDate}）`, `${used.toFixed(2)}°（${c.magMode === 'auto' ? '自動' : '手入力'}）`, `${dd.toFixed(2)}°`,
          c.azimRef !== 'magnetic' && c.windDirRef !== 'magnetic' ? 'info' : dd < 1 ? 'pass' : dd < 3 ? 'warn' : 'fail', '方位・風向を磁北基準で入れているときは、偏角の誤りがそのまま打上げ方位のずれになります');
      }
    }
    return finish();
    function finish() {
      const n = { pass: 0, warn: 0, fail: 0, info: 0 }; items.forEach(i => n[i.st]++);
      return { items, n, ms: performance.now() - t0 };
    }
  }

  function text(base, R) {
    let s = `検算レポート（student-rocket-sim）\n機体: ${base.name}\n合格 ${R.n.pass} / 注意 ${R.n.warn} / 不合格 ${R.n.fail} / 参考 ${R.n.info}（${(R.ms / 1000).toFixed(1)} s）\n※ 設定どおりに計算できているかの確認で、実機の飛行結果との一致を保証するものではありません。\n`;
    let g = '';
    for (const it of R.items) {
      if (it.g !== g) { g = it.g; s += `\n[${g}]\n`; }
      s += `[${ST[it.st][0]}] ${it.title}\n    検算: ${it.exp}\n    本体: ${it.act}\n    差  : ${it.diff}\n    備考: ${it.note}\n`;
    }
    return s;
  }
  let last = null;
  function mount(el) {
    el.innerHTML = `<div class="card"><div class="card-h">検算（本体とは別の式・別の積分法で結果を確かめる）</div>
      <div class="row"><button class="primary" id="vfRun">検算を実行</button><button id="vfTxt" disabled>レポート保存（txt）</button><span id="vfSum" class="muted small"></span></div>
      <div class="muted small">1. 解析解（ツィオルコフスキー・終端速度）2. 保存則（エネルギー・力積・質量収支・比推力）3. 数値（独立 1 次元モデル・刻み収束）4. 空力・大気 5. 座標。
      ※ 設定どおりに計算できているかの確認で、実機との一致を保証するものではありません</div><div id="vfOut"></div></div>`;
    el.querySelector('#vfRun').addEventListener('click', () => {
      const base = normalizeCfg(cfg), b = el.querySelector('#vfRun');
      b.disabled = true; el.querySelector('#vfSum').textContent = '計算中…';
      setTimeout(() => {
        try { last = { base, R: run(base) }; render(el); } catch (e) { el.querySelector('#vfSum').textContent = 'エラー: ' + e.message; console.error(e); }
        b.disabled = false;
      }, 30);
    });
    el.querySelector('#vfTxt').addEventListener('click', () => last && download('verify_report.txt', text(last.base, last.R), 'text/plain'));
  }
  function render(el) {
    const R = last.R;
    el.querySelector('#vfTxt').disabled = false;
    el.querySelector('#vfSum').innerHTML = `合格 <b style="color:${ST.pass[1]}">${R.n.pass}</b> / 注意 <b style="color:${ST.warn[1]}">${R.n.warn}</b> / 不合格 <b style="color:${ST.fail[1]}">${R.n.fail}</b> / 参考 ${R.n.info}（${(R.ms / 1000).toFixed(1)} s）`;
    let g = '', h = '<div style="overflow-x:auto"><table class="vf-t" style="border-collapse:collapse;font-size:12px;width:100%">';
    for (const it of R.items) {
      if (it.g !== g) { g = it.g; h += `<tr><th colspan="5" style="text-align:left;padding:8px 4px 2px">${esc(g)}</th></tr><tr class="muted"><td>判定</td><td>項目</td><td>検算（独立）</td><td>本体</td><td>差</td></tr>`; }
      h += `<tr style="border-top:1px solid var(--line)"><td style="color:${ST[it.st][1]};font-weight:700;padding:3px 6px">${ST[it.st][0]}</td><td style="padding:3px 6px">${esc(it.title)}<div class="muted small">${esc(it.note)}</div></td><td style="padding:3px 6px">${esc(it.exp)}</td><td style="padding:3px 6px">${esc(it.act)}</td><td style="padding:3px 6px">${esc(it.diff)}</td></tr>`;
    }
    el.querySelector('#vfOut').innerHTML = h + '</table></div>';
  }
  return { run, text, mount, markStale() { const s = document.querySelector('#vfSum'); if (s && last) s.textContent = '設定が変わりました。再実行してください'; } };
})();
