'use strict';
/* 測地・磁気偏角・大気（Magi の geo.cpp を移植）。DOM 非依存。window.Geo のみ公開
 * - magDecl: WMM2025（NOAA/NCEI 公開係数, 有効 2025.0–2030.0。範囲外は外挿）
 * - vincenty: WGS84 楕円体上の測地線（逆解）。収束しないときは球近似
 * - normalGravity: 正規重力（Somigliana + 高度補正。遠心力を含む）
 * - isa1976: 米国標準大気 1976（0〜84.852 km、検算用）
 */
window.Geo = (() => {
  const DEG = Math.PI / 180;
  const A = 6378137.0, F = 1 / 298.257223563, B = A * (1 - F), E2 = F * (2 - F);
  const OMEGA = 7.2921150e-5;

  // WMM2025 係数: n m g h gdot hdot [nT, nT/yr]
  const WMM = [
    [1,0,-29351.8,0,12,0],[1,1,-1410.8,4545.4,9.7,-21.5],[2,0,-2556.6,0,-11.6,0],[2,1,2951.1,-3133.6,-5.2,-27.7],[2,2,1649.3,-815.1,-8,-12.1],
    [3,0,1361,0,-1.3,0],[3,1,-2404.1,-56.6,-4.2,4],[3,2,1243.8,237.5,0.4,-0.3],[3,3,453.6,-549.5,-15.6,-4.1],
    [4,0,895,0,-1.6,0],[4,1,799.5,278.6,-2.4,-1.1],[4,2,55.7,-133.9,-6,4.1],[4,3,-281.1,212,5.6,1.6],[4,4,12.1,-375.6,-7,-4.4],
    [5,0,-233.2,0,0.6,0],[5,1,368.9,45.4,1.4,-0.5],[5,2,187.2,220.2,0,2.2],[5,3,-138.7,-122.9,0.6,0.4],[5,4,-142,43,2.2,1.7],[5,5,20.9,106.1,0.9,1.9],
    [6,0,64.4,0,-0.2,0],[6,1,63.8,-18.4,-0.4,0.3],[6,2,76.9,16.8,0.9,-1.6],[6,3,-115.7,48.8,1.2,-0.4],[6,4,-40.9,-59.8,-0.9,0.9],[6,5,14.9,10.9,0.3,0.7],[6,6,-60.7,72.7,0.9,0.9],
    [7,0,79.5,0,0,0],[7,1,-77,-48.9,-0.1,0.6],[7,2,-8.8,-14.4,-0.1,0.5],[7,3,59.3,-1,0.5,-0.8],[7,4,15.8,23.4,-0.1,0],[7,5,2.5,-7.4,-0.8,-1],[7,6,-11.1,-25.1,-0.8,0.6],[7,7,14.2,-2.3,0.8,-0.2],
    [8,0,23.2,0,-0.1,0],[8,1,10.8,7.1,0.2,-0.2],[8,2,-17.5,-12.6,0,0.5],[8,3,2,11.4,0.5,-0.4],[8,4,-21.7,-9.7,-0.1,0.4],[8,5,16.9,12.7,0.3,-0.5],[8,6,15,0.7,0.2,-0.6],[8,7,-16.8,-5.2,0,0.3],[8,8,0.9,3.9,0.2,0.2],
    [9,0,4.6,0,0,0],[9,1,7.8,-24.8,-0.1,-0.3],[9,2,3,12.2,0.1,0.3],[9,3,-0.2,8.3,0.3,-0.3],[9,4,-2.5,-3.3,-0.3,0.3],[9,5,-13.1,-5.2,0,0.2],[9,6,2.4,7.2,0.3,-0.1],[9,7,8.6,-0.6,-0.1,-0.2],[9,8,-8.7,0.8,0.1,0.4],[9,9,-12.9,10,-0.1,0.1],
    [10,0,-1.3,0,0.1,0],[10,1,-6.4,3.3,0,0],[10,2,0.2,0,0.1,0],[10,3,2,2.4,0.1,-0.2],[10,4,-1,5.3,0,0.1],[10,5,-0.6,-9.1,-0.3,-0.1],[10,6,-0.9,0.4,0,0.1],[10,7,1.5,-4.2,-0.1,0],[10,8,0.9,-3.8,-0.1,-0.1],[10,9,-2.7,0.9,0,0.2],[10,10,-3.9,-9.1,0,0],
    [11,0,2.9,0,0,0],[11,1,-1.5,0,0,0],[11,2,-2.5,2.9,0,0.1],[11,3,2.4,-0.6,0,0],[11,4,-0.6,0.2,0,0.1],[11,5,-0.1,0.5,-0.1,0],[11,6,-0.6,-0.3,0,0],[11,7,-0.1,-1.2,0,0.1],[11,8,1.1,-1.7,-0.1,0],[11,9,-1,-2.9,-0.1,0],[11,10,-0.2,-1.8,-0.1,0],[11,11,2.6,-2.3,-0.1,0],
    [12,0,-2,0,0,0],[12,1,-0.2,-1.3,0,0],[12,2,0.3,0.7,0,0],[12,3,1.2,1,0,-0.1],[12,4,-1.3,-1.4,0,0.1],[12,5,0.6,0,0,0],[12,6,0.6,0.6,0.1,0],[12,7,0.5,-0.1,0,0],[12,8,-0.1,0.8,0,0],[12,9,-0.4,0.1,0,0],[12,10,-0.2,-1,-0.1,0],[12,11,-1.3,0.1,0,0],[12,12,-0.7,0.2,-0.1,-0.1],
  ];
  // Schmidt 準正規化ルジャンドル陪関数 P[n][m](x)
  function legendre(x) {
    const P = Array.from({ length: 13 }, () => new Float64Array(13));
    const s = Math.sqrt(Math.max(0, 1 - x * x));
    P[0][0] = 1;
    for (let m = 1; m <= 12; m++) P[m][m] = P[m - 1][m - 1] * s * (2 * m - 1);
    for (let m = 0; m <= 11; m++) P[m + 1][m] = x * (2 * m + 1) * P[m][m];
    for (let m = 0; m <= 12; m++) for (let n = m + 2; n <= 12; n++) P[n][m] = (x * (2 * n - 1) * P[n - 1][m] - (n + m - 1) * P[n - 2][m]) / (n - m);
    for (let n = 1; n <= 12; n++) for (let m = 0; m <= n; m++) {
      let f = 1; for (let k = n - m + 1; k <= n + m; k++) f /= k;
      P[n][m] *= Math.sqrt((m === 0 ? 1 : 2) * f);
    }
    return P;
  }
  // 地心座標での磁場の北・東・下成分 [nT]（phi: 地心緯度, r: 地心距離 [m], t: 2025.0 からの年数）
  function field(phi, lam, r, t) {
    const P = legendre(Math.sin(phi)), d = 1e-6, Pp = legendre(Math.sin(phi + d)), Pm = legendre(Math.sin(phi - d));
    const a = 6371200;
    let X = 0, Y = 0, Z = 0;
    for (const [n, m, g0, h0, gd, hd] of WMM) {
      const g = g0 + gd * t, h = h0 + hd * t, ar = Math.pow(a / r, n + 2);
      const cm = Math.cos(m * lam), sm = Math.sin(m * lam), dP = (Pp[n][m] - Pm[n][m]) / (2 * d);
      X += -ar * (g * cm + h * sm) * dP;
      Y += ar * m * (g * sm - h * cm) * P[n][m];
      Z += -(n + 1) * ar * (g * cm + h * sm) * P[n][m];
    }
    return [X, Y / Math.cos(phi), Z];
  }
  // 磁気偏角 [deg]（東偏が正）。h: 楕円体高 [m], year: 10 進年
  function magDecl(latDeg, lonDeg, h, year) {
    const la = Math.max(-89.9, Math.min(89.9, latDeg)) * DEG, lo = lonDeg * DEG;
    const s = Math.sin(la), c = Math.cos(la), N = A / Math.sqrt(1 - E2 * s * s);
    const p = (N + h) * c, z = (N * (1 - E2) + h) * s, r = Math.hypot(p, z), phi = Math.asin(z / r);
    const [X, Y, Z] = field(phi, lo, r, year - 2025);
    const dphi = phi - la, Xg = X * Math.cos(dphi) - Z * Math.sin(dphi);
    return Math.atan2(Y, Xg) / DEG;
  }
  // 'YYYY-MM-DD'（または Date）→ 10 進年
  function decimalYear(d) {
    const dt = d instanceof Date ? d : new Date(String(d || '') + 'T12:00:00Z');
    if (isNaN(dt)) return 2026.0;
    const y = dt.getUTCFullYear(), t0 = Date.UTC(y, 0, 1), t1 = Date.UTC(y + 1, 0, 1);
    return y + (dt.getTime() - t0) / (t1 - t0);
  }

  // WGS84 測地線（Vincenty 逆解）→ {dist [m], az [deg, 北から時計回り]}
  function vincenty(lat1, lon1, lat2, lon2) {
    const L = (lon2 - lon1) * DEG;
    const U1 = Math.atan((1 - F) * Math.tan(lat1 * DEG)), U2 = Math.atan((1 - F) * Math.tan(lat2 * DEG));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = L, lamP, sinS, cosS, sig, cos2a, cos2sm, it = 0;
    do {
      const sl = Math.sin(lam), cl = Math.cos(lam), t1 = cU2 * sl, t2 = cU1 * sU2 - sU1 * cU2 * cl;
      sinS = Math.sqrt(t1 * t1 + t2 * t2);
      if (sinS === 0) return { dist: 0, az: 0 };
      cosS = sU1 * sU2 + cU1 * cU2 * cl; sig = Math.atan2(sinS, cosS);
      const sinA = cU1 * cU2 * sl / sinS; cos2a = 1 - sinA * sinA;
      cos2sm = cos2a !== 0 ? cosS - 2 * sU1 * sU2 / cos2a : 0;
      const C = F / 16 * cos2a * (4 + F * (4 - 3 * cos2a));
      lamP = lam;
      lam = L + (1 - C) * F * sinA * (sig + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)));
      if (!isFinite(lam)) break;
    } while (Math.abs(lam - lamP) > 1e-12 && ++it < 100);
    if (!(it < 100) || !isFinite(lam)) { // 球近似（対蹠点付近）
      const R = 6371008.8, p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
      const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      const az = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / DEG;
      return { dist: 2 * R * Math.asin(Math.min(1, Math.sqrt(h))), az: (az + 360) % 360 };
    }
    const u2 = cos2a * (A * A - B * B) / (B * B);
    const AA = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2))), BB = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dS = BB * sinS * (cos2sm + BB / 4 * (cosS * (-1 + 2 * cos2sm * cos2sm) - BB / 6 * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)));
    const az = Math.atan2(cU2 * Math.sin(lam), cU1 * sU2 - sU1 * cU2 * Math.cos(lam)) / DEG;
    return { dist: B * AA * (sig - dS), az: (az + 360) % 360 };
  }

  function geodeticToEcef(latDeg, lonDeg, h) {
    const la = latDeg * DEG, lo = lonDeg * DEG, s = Math.sin(la), c = Math.cos(la), N = A / Math.sqrt(1 - E2 * s * s);
    return [(N + h) * c * Math.cos(lo), (N + h) * c * Math.sin(lo), (N * (1 - E2) + h) * s];
  }
  function ecefToGeodetic([x, y, z]) {
    const lon = Math.atan2(y, x), rho = Math.hypot(x, y);
    let lat = Math.atan2(z, rho * (1 - E2)), h = 0;
    for (let i = 0; i < 6; i++) {
      const s = Math.sin(lat), N = A / Math.sqrt(1 - E2 * s * s);
      h = Math.abs(Math.cos(lat)) > 1e-9 ? rho / Math.cos(lat) - N : Math.abs(z) / Math.abs(s) - N * (1 - E2);
      lat = Math.atan2(z, rho * (1 - E2 * N / (N + h)));
    }
    return { lat: lat / DEG, lon: lon / DEG, h };
  }
  // 射点 ENU [m] → 緯度経度・楕円体高（楕円体上で正確に）
  function enuToGeodetic(lat0, lon0, h0, e, n, u) {
    const la = lat0 * DEG, lo = lon0 * DEG, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    const o = geodeticToEcef(lat0, lon0, h0);
    return ecefToGeodetic([o[0] - so * e - sl * co * n + cl * co * u, o[1] + co * e - sl * so * n + cl * so * u, o[2] + cl * n + sl * u]);
  }
  // 正規重力 [m/s²]（Somigliana の式 + 高度の 2 次補正。地球の自転による遠心力を含む）
  function normalGravity(latDeg, h) {
    const s2 = Math.sin(latDeg * DEG) ** 2;
    const g0 = 9.7803253359 * (1 + 0.00193185265241 * s2) / Math.sqrt(1 - 0.00669437999013 * s2);
    return g0 * (1 - 2 / A * (1 + F + OMEGA * OMEGA * A * A * B / 3.986004418e14 - 2 * F * s2) * h + 3 / (A * A) * h * h);
  }
  // 米国標準大気 1976（幾何高度 [m]）→ {T, p, rho, a}
  function isa1976(hm) {
    const L = [[0, 288.15, -0.0065], [11000, 216.65, 0], [20000, 216.65, 0.001], [32000, 228.65, 0.0028], [47000, 270.65, 0], [51000, 270.65, -0.0028], [71000, 214.65, -0.002], [84852, 186.946, 0]];
    const R = 287.05287, g = 9.80665, Re = 6356766.0;
    const H = Math.max(-5000, Math.min(Re * hm / (Re + hm), 84852));
    let p = 101325, i = 0;
    for (; i < 7; i++) {
      const [Hb, Tb, Lr] = L[i], top = L[i + 1][0], Hu = i === 0 && H < 0 ? H : Math.min(H, top);
      p *= Math.abs(Lr) < 1e-12 ? Math.exp(-g * (Hu - Hb) / (R * Tb)) : Math.pow((Tb + Lr * (Hu - Hb)) / Tb, -g / (Lr * R));
      if (H <= top) break;
    }
    i = Math.min(i, 6);
    const T = L[i][1] + L[i][2] * (H - L[i][0]);
    return { T, p, rho: p / (R * T), a: Math.sqrt(1.4 * R * T) };
  }
  return { DEG, A, F, B, E2, OMEGA, magDecl, decimalYear, vincenty, geodeticToEcef, ecefToGeodetic, enuToGeodetic, normalGravity, isa1976 };
})();
