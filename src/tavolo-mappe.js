// Tavolo d'Avventura: luoghi e mappe (generazione, arredi, griglia, percorsi, linea di vista).
// ---------- luoghi persistenti: la mappa si genera una volta e poi resta, con le sue modifiche ----------
export function chiaveLuogo(nome) { return nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'luogo'; }
export function indovinaTipo(s) {
  s = s.toLowerCase();
  const regole = [['taverna', /taverna|locanda|osteria|bettola/], ['dungeon', /dungeon|cripta|segrete|sotterran|tomba|catacomb|labirint/], ['grotta', /grotta|caverna|miniera|antro/], ['foresta', /foresta|bosco|selva|giungla/], ['castello', /castello|fortezza|rocca|palazzo/], ['porto', /porto|molo|baia|approdo/], ['villaggio', /villaggio|borgo|frazione|fattoria/], ['citta', /citt|capitale|metropoli|quartiere|mercato/]];
  for (const [t, re] of regole) if (re.test(s)) return t;
  return 'aperto';
}
export function rng(seme) {
  let h = 1779033703 ^ seme.length;
  for (let i = 0; i < seme.length; i++) { h = Math.imul(h ^ seme.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// Caselle: . erba  , strada  # muro  _ pavimento  ~ acqua  T albero  R roccia  = legno  + porta  t tavolo  b bancone  f focolare  c letto  ^ scala  w mura
export const W = 32, H = 20;
export const NOMI_CITTA = ['Fabbro', 'Tempio', 'Mercato', 'Municipio', 'Caserma', 'Bottega dell\'alchimista', 'Stalla', 'Biblioteca', 'Gilda dei mercanti', 'Casa', 'Casa', 'Casa', 'Magazzino', 'Mulino', 'Torre del mago', 'Sartoria', 'Panetteria'];
export function generaLuogo(nome, tipo, seme, nomiInterni) {
  const R = rng(seme);
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const g = Array.from({ length: H }, () => Array(W).fill('.'));
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = c; };
  const rett = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c); };
  // dentro: solo caselle ok; bordo di una casella: anche strade e mura (le case si affacciano sulla strada)
  const libero = (x, y, w, h, ok) => { for (let j = y - 1; j <= y + h; j++) for (let i = x - 1; i <= x + w; i++) { if (i < 0 || j < 0 || i >= W || j >= H) return false; const bordo = j === y - 1 || j === y + h || i === x - 1 || i === x + w; if (!ok.includes(g[j][i]) && !(bordo && ',w'.includes(g[j][i]))) return false; } return true; };
  const edifici = [];
  let ingresso = { x: 1, y: Math.floor(H / 2) };
  const casa = (x, y, w, h, nomeEd) => {
    rett(x, y, w, h, '#'); rett(x + 1, y + 1, w - 2, h - 2, '=');
    const lato = ri(0, 1);
    set(lato ? x + Math.floor(w / 2) : x, lato ? y + h - 1 : y + Math.floor(h / 2), '+');
    let n = nomeEd; const uguali = edifici.filter(e => e.nome.startsWith(nomeEd)).length; if (uguali) n = `${nomeEd} ${uguali + 1}`;
    edifici.push({ id: 'e' + (edifici.length + 1), nome: n, x, y, w, h, stato: 'integro' });
  };
  if (tipo === 'citta' || tipo === 'villaggio' || tipo === 'porto') {
    const vy = ri(8, 11), vx = ri(13, 18);
    rett(0, vy, W, 2, ',');
    if (tipo === 'porto') { rett(0, H - 4, W, 4, '~'); for (let i = 3; i < W - 3; i += 7) rett(i, H - 6, 2, 5, '='); rett(vx, 0, 2, vy, ','); }
    else rett(vx, 0, 2, H, ',');
    if (tipo === 'citta') { for (let i = 0; i < W; i++) { set(i, 0, 'w'); set(i, H - 1, 'w'); } for (let j = 0; j < H; j++) { set(0, j, 'w'); set(W - 1, j, 'w'); } rett(0, vy, 1, 2, ','); rett(W - 1, vy, 1, 2, ','); rett(vx, 0, 2, 1, ','); rett(vx, H - 1, 2, 1, ','); }
    const nomi = [...NOMI_CITTA].sort(() => R() - 0.5);
    if (tipo === 'porto') nomi.unshift('Magazzino del porto', 'Capitaneria');
    nomi.unshift('Locanda');
    const quanti = tipo === 'villaggio' ? 7 : 12;
    for (let tentativi = 0; tentativi < 500 && edifici.length < quanti; tentativi++) {
      const w = ri(4, 6), h = ri(3, 4), x = ri(1, W - w - 1), y = ri(1, H - h - 1);
      if (libero(x, y, w, h, ['.'])) casa(x, y, w, h, nomi[edifici.length] || 'Casa');
    }
    if (tipo !== 'porto') { const px = vx - 3, py = vy - 3; if (libero(px, py, 2, 2, ['.', ','])) { rett(px, py, 2, 2, '~'); edifici.push({ id: 'pozzo', nome: 'Pozzo', x: px, y: py, w: 2, h: 2, stato: 'integro' }); } }
    for (let i = 0; i < 25; i++) { const x = ri(1, W - 2), y = ri(1, H - 2); if (g[y][x] === '.') set(x, y, 'T'); }
    ingresso = { x: 1, y: vy };
  } else if (tipo === 'taverna') {
    rett(0, 0, W, H, '#'); rett(1, 1, W - 2, H - 2, '=');
    rett(2, 2, 10, 1, 'b'); set(W - 11, 2, 'f'); set(W - 12, 2, 'f');
    for (let y = 5; y < H - 3; y += 3) for (let x = 3; x < W - 10; x += 5) set(x, y, 't');
    rett(W - 8, 1, 1, H - 2, '#'); for (let y = 5; y < H - 2; y += 4) { rett(W - 7, y, 6, 1, '#'); set(W - 4, y - 2, 'c'); set(W - 8, y - 2, '+'); }
    set(W - 2, H - 2, '^'); set(Math.floor(W / 2), H - 1, '+');
    edifici.push({ id: 'bancone', nome: 'Bancone', x: 2, y: 2, w: 10, h: 1, stato: 'integro' }, { id: 'camino', nome: 'Camino', x: W - 12, y: 2, w: 2, h: 1, stato: 'integro' }, { id: 'stanze', nome: 'Stanze per la notte', x: W - 8, y: 1, w: 7, h: H - 2, stato: 'integro' }, { id: 'sala', nome: 'Sala comune', x: 1, y: 4, w: W - 10, h: H - 6, stato: 'integro' });
    ingresso = { x: Math.floor(W / 2), y: H - 2 };
  } else if (tipo === 'dungeon') {
    rett(0, 0, W, H, '#');
    const stanze = [];
    for (let t = 0; t < 300 && stanze.length < 8; t++) {
      const w = ri(4, 8), h = ri(3, 6), x = ri(1, W - w - 1), y = ri(1, H - h - 1);
      if (stanze.every(s => x + w + 1 < s.x || s.x + s.w + 1 < x || y + h + 1 < s.y || s.y + s.h + 1 < y)) stanze.push({ x, y, w, h });
    }
    stanze.sort((a, b) => a.x - b.x);
    const nomiS = ['Ingresso', 'Sala delle guardie', 'Armeria', 'Cella', 'Sala del tesoro', 'Altare', 'Covo', 'Deposito'];
    stanze.forEach((s, i) => { rett(s.x, s.y, s.w, s.h, '_'); edifici.push({ id: 's' + (i + 1), nome: i === stanze.length - 1 && i > 0 ? 'Sala del boss' : nomiS[i] || 'Stanza', x: s.x, y: s.y, w: s.w, h: s.h, stato: 'integro' }); });
    for (let i = 1; i < stanze.length; i++) {
      const a = stanze[i - 1], b = stanze[i];
      let x = a.x + Math.floor(a.w / 2), y = a.y + Math.floor(a.h / 2);
      const bx = b.x + Math.floor(b.w / 2), by = b.y + Math.floor(b.h / 2);
      while (x !== bx) { if (g[y][x] === '#') set(x, y, '_'); x += Math.sign(bx - x); }
      while (y !== by) { if (g[y][x] === '#') set(x, y, '_'); y += Math.sign(by - y); }
    }
    if (stanze[0]) { ingresso = { x: stanze[0].x + 1, y: stanze[0].y + 1 }; set(stanze[0].x, stanze[0].y, '^'); }
  } else if (tipo === 'grotta') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y][x] = (x === 0 || y === 0 || x === W - 1 || y === H - 1 || R() < 0.45) ? 'R' : '_';
    for (let k = 0; k < 4; k++) {
      const c = g.map(r => [...r]);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let n = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (g[y + j][x + i] === 'R') n++; c[y][x] = n >= 5 ? 'R' : '_'; }
      for (let y = 0; y < H; y++) g[y] = c[y];
    }
    rett(1, Math.floor(H / 2) - 1, 5, 3, '_'); rett(5, Math.floor(H / 2), W - 8, 1, '_');
    for (let i = 0; i < 6; i++) { const x = ri(3, W - 4), y = ri(3, H - 4); if (g[y][x] === '_') set(x, y, '~'); }
    edifici.push({ id: 'antro', nome: 'Antro principale', x: Math.floor(W / 2) - 3, y: Math.floor(H / 2) - 2, w: 6, h: 4, stato: 'integro' });
    ingresso = { x: 2, y: Math.floor(H / 2) };
  } else if (tipo === 'castello') {
    for (let i = 0; i < W; i++) { set(i, 0, '~'); set(i, 1, '~'); }
    rett(3, 2, W - 6, H - 4, 'w'); rett(4, 3, W - 8, H - 6, '_');
    [[3, 2], [W - 5, 2], [3, H - 4], [W - 5, H - 4]].forEach(([x, y], i) => { rett(x, y, 2, 2, '#'); edifici.push({ id: 't' + (i + 1), nome: 'Torre ' + ['nord-ovest', 'nord-est', 'sud-ovest', 'sud-est'][i], x, y, w: 2, h: 2, stato: 'integro' }); });
    casa(Math.floor(W / 2) - 4, 4, 9, 6, 'Mastio');
    casa(6, H - 9, 6, 4, 'Caserma'); casa(W - 12, H - 9, 6, 4, 'Cappella');
    set(Math.floor(W / 2), H - 3, '+'); rett(Math.floor(W / 2), H - 2, 1, 2, ',');
    ingresso = { x: Math.floor(W / 2), y: H - 2 };
  } else if (tipo === 'foresta') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (R() < 0.38) g[y][x] = 'T';
    let rx = ri(6, W - 7); for (let yy = 0; yy < H; yy++) { set(rx, yy, '~'); set(rx + 1, yy, '~'); if (R() < 0.3) rx = Math.max(2, Math.min(W - 4, rx + ri(-1, 1))); }
    let y = ri(6, H - 7); const y0 = y; for (let x = 0; x < W; x++) { rett(x, y, 1, 2, g[y][x] === '~' ? '=' : ','); if (g[y + 1]?.[x] === '~') set(x, y + 1, '='); if (R() < 0.3) y = Math.max(2, Math.min(H - 4, y + ri(-1, 1))); }
    const cx = ri(4, W - 10), cy = ri(2, H - 8); rett(cx, cy, 6, 5, '.');
    edifici.push({ id: 'radura', nome: 'Radura', x: cx, y: cy, w: 6, h: 5, stato: 'integro' });
    if (R() < 0.6) casa(cx + 1, cy + 1, 4, 3, 'Capanna');
    ingresso = { x: 0, y: y0 };
  } else if (tipo === 'interno') {
    // stanze divise da muri con porte; arredi sparsi
    rett(0, 0, W, H, '#'); rett(1, 1, W - 2, H - 2, '=');
    const tagli = [ri(9, 13), ri(19, 23)], ty = ri(8, 11);
    for (const x of tagli) { rett(x, 1, 1, H - 2, '#'); set(x, ri(2, ty - 2), '+'); set(x, ri(ty + 2, H - 3), '+'); }
    rett(1, ty, W - 2, 1, '#'); [ri(3, tagli[0] - 2), ri(tagli[0] + 2, tagli[1] - 2), ri(tagli[1] + 2, W - 3)].forEach(x => set(x, ty, '+'));
    const zone = [[1, 1, tagli[0] - 1, ty - 1], [tagli[0] + 1, 1, tagli[1] - tagli[0] - 1, ty - 1], [tagli[1] + 1, 1, W - tagli[1] - 2, ty - 1], [1, ty + 1, tagli[0] - 1, H - ty - 2], [tagli[0] + 1, ty + 1, tagli[1] - tagli[0] - 1, H - ty - 2], [tagli[1] + 1, ty + 1, W - tagli[1] - 2, H - ty - 2]];
    (nomiInterni || []).slice(0, 6).forEach((n, i) => { const [x, y, w, h] = zone[i]; edifici.push({ id: 'r' + (i + 1), nome: n, x, y, w, h, stato: 'integro' }); });
    for (const [x, y, w, h] of zone) for (let k = 0; k < 3; k++) { const ax = x + ri(1, Math.max(1, w - 2)), ay = y + ri(1, Math.max(1, h - 2)); if (g[ay][ax] === '=') set(ax, ay, ['t', 'c', 'b', 'f', 't'][ri(0, 4)]); }
    set(Math.floor(W / 2), H - 1, '+');
    ingresso = { x: Math.floor(W / 2), y: H - 2 };
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (R() < 0.08) g[y][x] = R() < 0.5 ? 'T' : 'R';
    rett(0, Math.floor(H / 2), W, 2, ',');
    const n = String(nome).toLowerCase();
    if (/ponte|viadott|guado|fiume|torrente|burron|gola|precipizi|canyon/.test(n)) {
      // acqua (o il fondo della gola) che taglia la strada, con il ponte di legno sopra
      let fx = ri(13, 17); for (let yy = 0; yy < H; yy++) { rett(fx, yy, 3, 1, '~'); if (R() < 0.25) fx = Math.max(10, Math.min(19, fx + ri(-1, 1))); }
      for (let xx = 0; xx < W; xx++) for (const yy of [Math.floor(H / 2), Math.floor(H / 2) + 1]) if (g[yy][xx] === '~') set(xx, yy, '=');
      if (/spezzat|crollat|rott|distrutt|caduto/.test(n)) {
        // ponte crollato a metà: si passa solo dal guado più a valle
        for (let xx = 0; xx < W; xx++) if (g[Math.floor(H / 2)][xx] === '=' && g[Math.floor(H / 2)][xx - 1] === '=' && g[Math.floor(H / 2)][xx + 1] === '=') { set(xx, Math.floor(H / 2), '~'); set(xx, Math.floor(H / 2) + 1, '~'); }
        const gy = H - 4; for (let xx = 0; xx < W; xx++) if (g[gy][xx] === '~') set(xx, gy, ',');
        edifici.push({ id: 'guado', nome: 'Guado', x: fx, y: gy, w: 3, h: 1, stato: 'integro' });
      }
      edifici.push({ id: 'ponte', nome: /viadott/.test(n) ? 'Viadotto' : 'Ponte', x: fx, y: Math.floor(H / 2), w: 3, h: 2, stato: /spezzat|crollat|rott|distrutt|caduto/.test(n) ? 'distrutto' : 'integro' });
    } else if (R() < 0.7) casa(ri(4, W - 10), ri(2, 5), 5, 4, 'Casolare');
    ingresso = { x: 1, y: Math.floor(H / 2) };
  }
  if ('#RTw~'.includes(g[ingresso.y][ingresso.x])) set(ingresso.x, ingresso.y, '_');
  const l = { id: chiaveLuogo(nome), nome, tipo, w: W, h: H, celle: g.map(r => r.join('')), edifici, ingresso, storia: [], creato: Date.now() };
  collega(l);
  l.oggetti = arreda(l, seme); l.arrediV = ARREDI_V;
  return l;
}

// Oggetti di scena (persistenti): strutturali (fissi) o movibili. Tavoli e letti passano dalle caselle agli oggetti.
// ---------- griglia: passaggi, percorsi e linea di vista (le stesse regole stanno in mappa.js) ----------
// caselle coperte da un'area d'incantesimo: stesse regole dell'app (mappa.js, celleArea)
export function celleArea(a, l) {
  const out = [];
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
    const dx = x - a.x, dy = y - a.y; let dentro = false;
    if (a.forma === 'cerchio') dentro = dx * dx + dy * dy <= a.dim * a.dim;
    else if (a.forma === 'quadrato') dentro = dx >= 0 && dy >= 0 && dx < a.dim && dy < a.dim;
    else {
      const [ax, ay] = { n: [0, -1], s: [0, 1], e: [1, 0], o: [-1, 0] }[a.dir || 'e'];
      const lungo = dx * ax + dy * ay, lato = Math.abs(dx * ay - dy * ax);
      dentro = a.forma === 'linea' ? lungo >= 1 && lungo <= a.dim && lato === 0 : lungo >= 1 && lungo <= a.dim && lato <= Math.floor(lungo / 2);
    }
    if (dentro) out.push([x, y]);
  }
  return out;
}
export const ARREDI_V = 3;
export const PASSABILI = ['tappeto', 'ragnatela', 'ossa', 'funghi', 'macerie', 'torcia', 'candelabro'];
export const DUE_CASELLE = ['letto', 'carretto', 'tronco', 'bancarella', 'barca'];
export function celleOggetto(o) { return DUE_CASELLE.includes(o.tipo) ? [[o.x, o.y], o.dir === 'v' ? [o.x, o.y + 1] : [o.x + 1, o.y]] : [[o.x, o.y]]; }
export const ESTERNI = ['citta', 'villaggio', 'porto', 'foresta', 'aperto', 'castello'];
// caselle dove non si cammina: muri, rocce, acqua, alberi, camino, bancone, le case viste da fuori, gli oggetti ingombranti
export function griglia(l) {
  const blocco = new Uint8Array(l.w * l.h), vista = new Uint8Array(l.w * l.h);
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) { const c = l.celle[y][x], i = y * l.w + x; if ('#wR~Tfb'.includes(c)) blocco[i] = 1; if ('#wR'.includes(c)) vista[i] = 1; }
  if (ESTERNI.includes(l.tipo)) for (const e of l.edifici) if (l.celle[e.y]?.[e.x] === '#' && e.stato !== 'distrutto') for (let y = e.y; y < e.y + e.h; y++) for (let x = e.x; x < e.x + e.w; x++) { blocco[y * l.w + x] = 1; vista[y * l.w + x] = 1; }
  for (const o of l.oggetti || []) if (!PASSABILI.includes(o.tipo) && !(o.tipo === 'barca')) for (const [x, y] of celleOggetto(o)) if (x < l.w && y < l.h) blocco[y * l.w + x] = 1;
  for (const o of l.oggetti || []) if (['colonna', 'statua', 'scaffale', 'masso', 'stalagmite'].includes(o.tipo)) vista[o.y * l.w + o.x] = 1;
  return { blocco, vista };
}
// percorso più breve a 8 direzioni senza tagliare gli angoli dei muri; null se non si arriva
// la casella libera (raggiungibile a piedi) più vicina a [da] e non ancora presa: dove far comparire chi entra
export function vicine(l, da, presi = new Set(), blocco = griglia(l).blocco) {
  const W2 = l.w, H2 = l.h, vis = new Uint8Array(W2 * H2), q = [da.y * W2 + da.x]; vis[q[0]] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % W2, y = (i / W2) | 0;
    if (!blocco[i] && !presi.has(i)) return { x, y };
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) { const nx = x + dx, ny = y + dy, j = ny * W2 + nx; if (nx >= 0 && ny >= 0 && nx < W2 && ny < H2 && !vis[j] && (!blocco[j] || blocco[i])) { vis[j] = 1; q.push(j); } }
  }
  return { x: da.x, y: da.y };
}
export function percorso(l, da, a, blocco = griglia(l).blocco) {
  const W2 = l.w, H2 = l.h, ok = (x, y) => x >= 0 && y >= 0 && x < W2 && y < H2 && !blocco[y * W2 + x];
  if (!ok(a.x, a.y)) return null;
  const prima = new Int32Array(W2 * H2).fill(-1), coda = [da.y * W2 + da.x]; prima[coda[0]] = coda[0];
  for (let q = 0; q < coda.length; q++) {
    const i = coda[q], x = i % W2, y = (i / W2) | 0;
    if (x === a.x && y === a.y) { const via = []; for (let k = i; k !== prima[k]; k = prima[k]) via.push({ x: k % W2, y: (k / W2) | 0 }); return via.reverse(); }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy, j = ny * W2 + nx;
      if (!ok(nx, ny) || prima[j] >= 0 || (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy)))) continue;
      prima[j] = i; coda.push(j);
    }
  }
  return null;
}
// ogni zona percorribile si collega all'ingresso: si apre la strada tra alberi e rocce, si getta un ponte sull'acqua
// (mai attraverso le case o le mura della città), così nessuna parte della mappa resta irraggiungibile
export function collega(l) {
  const W2 = l.w, H2 = l.h, g = l.celle.map(r => r.split('')), pav = l.tipo === 'grotta' || l.tipo === 'dungeon' ? '_' : ['taverna', 'interno'].includes(l.tipo) ? '=' : '.';
  const casa = new Uint8Array(W2 * H2);
  if (ESTERNI.includes(l.tipo)) for (const e of l.edifici) if (g[e.y]?.[e.x] === '#') for (let y = e.y - 1; y <= e.y + e.h; y++) for (let x = e.x - 1; x <= e.x + e.w; x++) if (x >= 0 && y >= 0 && x < W2 && y < H2) casa[y * W2 + x] = 1;
  const libera = (x, y) => !'#wR~Tfb'.includes(g[y][x]) && !(casa[y * W2 + x] && g[y][x] === '#');
  const scavabile = (x, y) => x > 0 && y > 0 && x < W2 - 1 && y < H2 - 1 && !casa[y * W2 + x] && g[y][x] !== 'w' && g[y][x] !== 'f' && g[y][x] !== 'b' && !(ESTERNI.includes(l.tipo) && g[y][x] === '#');
  let reg = null;
  for (let giro = 0; giro < 40; giro++) {
    reg = new Int32Array(W2 * H2).fill(-1); const q = [l.ingresso.y * W2 + l.ingresso.x];
    if (!libera(l.ingresso.x, l.ingresso.y)) return;
    reg[q[0]] = 0;
    for (let k = 0; k < q.length; k++) { const i = q[k], x = i % W2, y = (i / W2) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, j = ny * W2 + nx; if (nx >= 0 && ny >= 0 && nx < W2 && ny < H2 && reg[j] < 0 && libera(nx, ny)) { reg[j] = 0; q.push(j); } } }
    // la zona isolata più vicina (almeno 3 caselle)
    let partenza = -1;
    for (let i = 0; i < W2 * H2 && partenza < 0; i++) { const x = i % W2, y = (i / W2) | 0; if (reg[i] < 0 && libera(x, y)) { let n = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (g[y + dy]?.[x + dx] && libera(x + dx, y + dy)) n++; if (n >= 2) partenza = i; } }
    if (partenza < 0) break;
    // strada più corta (Dijkstra semplice) dalla zona isolata a quella dell'ingresso, scavando il meno possibile
    const costo = new Float32Array(W2 * H2).fill(1e9), da = new Int32Array(W2 * H2).fill(-1), aperti = [partenza]; costo[partenza] = 0;
    let arrivo = -1;
    while (aperti.length) {
      aperti.sort((a, b) => costo[a] - costo[b]); const i = aperti.shift(), x = i % W2, y = (i / W2) | 0;
      if (reg[i] === 0) { arrivo = i; break; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, j = ny * W2 + nx; if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) continue; const c = libera(nx, ny) ? 1 : scavabile(nx, ny) ? 6 : 1e9; if (c >= 1e9) continue; if (costo[i] + c < costo[j]) { costo[j] = costo[i] + c; da[j] = i; aperti.push(j); } }
    }
    if (arrivo < 0) { const x = partenza % W2, y = (partenza / W2) | 0; g[y][x] = l.tipo === 'grotta' ? 'R' : g[y][x]; if (l.tipo !== 'grotta') break; continue; }
    for (let k = arrivo; k >= 0; k = da[k]) { const x = k % W2, y = (k / W2) | 0; if (!libera(x, y)) g[y][x] = g[y][x] === '~' ? '=' : pav; }
    reg = null;
  }
  // angolini rimasti chiusi (cortili tra le case, buchi tra gli alberi): diventano alberi o roccia, così non c'è niente di irraggiungibile
  if (reg) for (let i = 0; i < W2 * H2; i++) { const x = i % W2, y = (i / W2) | 0; if (reg[i] < 0 && libera(x, y) && '.,_='.includes(g[y][x])) g[y][x] = ESTERNI.includes(l.tipo) ? 'T' : l.tipo === 'grotta' ? 'R' : g[y][x]; }
  l.celle = g.map(r => r.join(''));
}
export function vede(l, vista, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, passi = Math.ceil(Math.hypot(dx, dy) / 0.3);
  for (let i = 1; i < passi; i++) { const x = Math.floor(x0 + 0.5 + dx * i / passi), y = Math.floor(y0 + 0.5 + dy * i / passi); if ((x !== x0 || y !== y0) && (x !== x1 || y !== y1) && vista[y * l.w + x]) return false; }
  return true;
}
export const MOVIBILI = ['tavolo', 'sedia', 'sgabello', 'botte', 'cassa', 'baule', 'forziere', 'carretto', 'panca', 'sacco', 'secchio', 'barca'];
export function arreda(l, seme) {
  const R = rng(seme + ':arredi'), ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const g = l.celle.map(r => r.split('')), out = [];
  const pav = ['taverna', 'interno'].includes(l.tipo) ? '=' : '_';
  const occ = new Set();
  // davanti alle porte e all'ingresso non si mette niente
  const vietate = new Set();
  const vieta = (x, y) => { for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) vietate.add((x + dx) + ',' + (y + dy)); };
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) if (g[y][x] === '+' || g[y][x] === '^') vieta(x, y);
  vieta(l.ingresso.x, l.ingresso.y);
  const dentroCasa = (x, y) => ESTERNI.includes(l.tipo) && l.edifici.some(e => g[e.y]?.[e.x] === '#' && x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h);
  const metti = (tipo, x, y, rot = 0, dir) => {
    const o = { id: 'o' + (out.length + 1), tipo, x, y, rot, stato: 'integro', movibile: MOVIBILI.includes(tipo) };
    if (DUE_CASELLE.includes(tipo)) o.dir = dir || 'h';
    const celle = celleOggetto(o);
    if (celle.some(([cx, cy]) => g[cy]?.[cx] !== g[y][x]) || celle.some(([cx, cy]) => cx < 0 || cy < 0 || cx >= l.w || cy >= l.h || occ.has(cx + ',' + cy) || vietate.has(cx + ',' + cy) || dentroCasa(cx, cy))) return false;
    celle.forEach(([cx, cy]) => occ.add(cx + ',' + cy)); out.push(o); return true;
  };
  const su = (x, y, cc) => cc.includes(g[y]?.[x]);
  // lato del muro a cui l'oggetto si appoggia: 0 nord, 1 est, 2 sud, 3 ovest (l'oggetto guarda dalla parte opposta)
  const LATI = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const latoMuro = (x, y) => { const k = LATI.findIndex(([dx, dy]) => '#wR'.includes(g[y + dy]?.[x + dx] || '#')); return k; };
  const vicinoMuro = (x, y) => latoMuro(x, y) >= 0;
  // tavoli con sedie, letti con bauli
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
    // sedie attorno al tavolo, ognuna girata verso il tavolo (rot = lato dove sta il tavolo)
    if (g[y][x] === 't') { g[y][x] = pav; metti('tavolo', x, y); [[-1, 0, 1], [1, 0, 3], [0, -1, 2], [0, 1, 0]].forEach(([dx, dy, r]) => { if (su(x + dx, y + dy, pav) && R() < 0.7) metti(l.tipo === 'taverna' && R() < 0.4 ? 'sgabello' : 'sedia', x + dx, y + dy, r); }); }
    // letto lungo due caselle con la testiera al muro, baule ai piedi
    if (g[y][x] === 'c') { g[y][x] = pav; const k = latoMuro(x, y), v = k === 0 || k === 2 || k < 0; const fx = v ? x : (k === 1 ? x - 1 : x), fy = v ? (k === 2 ? y - 1 : y) : y; if (su(v ? fx : fx, v ? fy + (k === 2 ? 0 : 1) : fy, pav) || true) { if (metti('letto', fx, fy, k < 0 ? 0 : k, v ? 'v' : 'h')) { const px = v ? fx : (k === 1 ? fx - 1 : fx + 2), py = v ? (k === 2 ? fy - 1 : fy + 2) : fy; if (su(px, py, pav)) metti('baule', px, py, k); } } }
  }
  const libere = (cc, fn) => { const v = []; for (let y = 1; y < l.h - 1; y++) for (let x = 1; x < l.w - 1; x++) if (su(x, y, cc) && !occ.has(x + ',' + y) && (!fn || fn(x, y))) v.push([x, y]); return v; };
  const sparsi = (tipi, n, cc, fn) => { const v = libere(cc, fn); for (let k = 0; k < n && v.length; k++) { const [x, y] = v.splice(Math.floor(R() * v.length), 1)[0], tipo = tipi[ri(0, tipi.length - 1)], lm = latoMuro(x, y); if (DUE_CASELLE.includes(tipo)) { if (!metti(tipo, x, y, 0, 'h')) metti(tipo, x, y, 0, 'v'); } else metti(tipo, x, y, lm >= 0 ? lm : ri(0, 3)); } };
  const dentro = (nome) => { const e = l.edifici.find(e => e.nome.startsWith(nome)); return e ? (x, y) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h : () => false; };
  if (l.tipo === 'taverna') {
    for (let x = 2; x < 12; x += 3) metti('botte', x, 1 + (su(x, 1, pav) ? 0 : 2));
    sparsi(['botte', 'cassa', 'sacco'], 4, pav, vicinoMuro);
    sparsi(['candelabro'], 3, pav, dentro('Sala'));
    sparsi(['tappeto'], 1, pav, dentro('Sala'));
  } else if (l.tipo === 'interno') {
    sparsi(['scaffale', 'scaffale', 'rastrelliera', 'cassa', 'botte'], 8, pav, vicinoMuro);
    sparsi(['tappeto', 'candelabro', 'sedia', 'sgabello', 'sacco'], 7, pav);
  } else if (l.tipo === 'dungeon') {
    sparsi(['ossa', 'macerie', 'ragnatela', 'cassa', 'botte', 'secchio'], 14, '_');
    sparsi(['torcia'], 8, '_', vicinoMuro);
    sparsi(['forziere'], 2, '_', dentro('Sala del tesoro'));
    sparsi(['altare'], 1, '_', dentro('Altare'));
    sparsi(['forziere'], 1, '_', dentro('Sala del boss'));
    sparsi(['colonna'], 3, '_', (x, y) => !vicinoMuro(x, y));
  } else if (l.tipo === 'grotta') {
    sparsi(['masso', 'stalagmite', 'funghi', 'ossa', 'masso'], 18, '_');
  } else if (['citta', 'villaggio', 'porto'].includes(l.tipo)) {
    const strada = (x, y) => [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => g[y + dy]?.[x + dx] === ',');
    sparsi(['botte', 'cassa', 'carretto', 'lampione', 'panca', 'fieno', 'bancarella'], l.tipo === 'citta' ? 16 : 10, '.', strada);
    sparsi(['cespuglio', 'masso'], 6, '.');
    if (l.tipo === 'porto') { sparsi(['cassa', 'botte', 'cassa'], 8, '=,'); sparsi(['barca'], 3, '~', (x, y) => [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => g[y + dy]?.[x + dx] === '=')); }
  } else if (l.tipo === 'castello') {
    sparsi(['rastrelliera', 'botte', 'cassa', 'statua', 'stendardo', 'carretto'], 12, '_', vicinoMuro);
    sparsi(['statua'], 2, '_');
  } else if (l.tipo === 'foresta') {
    sparsi(['tronco', 'cespuglio', 'masso', 'ceppo', 'funghi', 'cespuglio'], 22, '.');
    sparsi(['falo'], 1, '.', dentro('Radura'));
  } else {
    sparsi(['cespuglio', 'masso', 'tronco', 'ceppo', 'fieno'], 16, '.');
  }
  l.celle = g.map(r => r.join(''));
  // nessun oggetto deve chiudere un passaggio: si tolgono quelli che isolano caselle prima raggiungibili
  const base = griglia({ ...l, oggetti: [] }).blocco, raggiungibili = b => { const vis = new Uint8Array(l.w * l.h), q = [l.ingresso.y * l.w + l.ingresso.x]; if (b[q[0]]) return vis; vis[q[0]] = 1; for (let k = 0; k < q.length; k++) { const i = q[k], x = i % l.w, y = (i / l.w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy, j = ny * l.w + nx; if (nx >= 0 && ny >= 0 && nx < l.w && ny < l.h && !b[j] && !vis[j]) { vis[j] = 1; q.push(j); } } } return vis; };
  const prima = raggiungibili(base); let conta = prima.reduce((a, v) => a + v, 0);
  const tenuti = [], b = base.slice();
  for (const o of out) {
    if (PASSABILI.includes(o.tipo) || o.tipo === 'barca') { tenuti.push(o); continue; }
    const celle = celleOggetto(o); if (celle.some(([x, y]) => !prima[y * l.w + x])) { tenuti.push(o); continue; } // fuori dalle zone percorribili (es. sull'acqua): non chiude niente
    celle.forEach(([x, y]) => { b[y * l.w + x] = 1; });
    const ora = raggiungibili(b).reduce((a, v) => a + v, 0);
    if (ora === conta - celle.length) { tenuti.push(o); conta = ora; } else celle.forEach(([x, y]) => { b[y * l.w + x] = 0; });
  }
  tenuti.forEach((o, i) => { o.id = 'o' + (i + 1); });
  return tenuti;
}
