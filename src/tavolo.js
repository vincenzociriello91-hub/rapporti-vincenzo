// Tavolo d'Avventura: una stanza di gioco D&D online (Durable Object, una per campagna).
// Tiene lo stato persistente (membri, schede, luoghi e mappe, dadi, diario, memoria del master)
// e fa da ponte per la voce (segnalazione WebRTC) e per il master AI (Gemini, chiave solo qui).
import { DurableObject } from 'cloudflare:workers';

const ORIGINI = ['https://vincenzociriello91-hub.github.io', 'http://localhost:8765'];
const MAX_MSG = 200000;
const ATTESA_MASTER = 3500; // ms di silenzio prima che il master AI risponda a quanto detto

export async function apriTavolo(req, env, codice) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('serve websocket', { status: 426 });
  if (!ORIGINI.includes(req.headers.get('Origin') || '')) return new Response('origine', { status: 403 });
  const id = env.TAVOLO.idFromName(codice.toUpperCase());
  return env.TAVOLO.get(id).fetch(req);
}

const casuale = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return a; };
const codiceCasuale = (len = 10) => { const alfa = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return [...casuale(len)].map(x => alfa[x % alfa.length]).join(''); };
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const testo = (s, max = 2000) => String(s ?? '').slice(0, max);
const COLORI = ['#e8b04b', '#5b8fd9', '#c97bd0', '#6cc08a', '#e2735f', '#4fc3c8', '#d9d36b', '#a98be8'];

export class Tavolo extends DurableObject {
  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ membro: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- utilità di stato ----------
  async get(k, def) { const v = await this.ctx.storage.get(k); return v === undefined ? def : v; }
  async put(k, v) { await this.ctx.storage.put(k, v); }
  membroDi(ws) { return ws.deserializeAttachment()?.membro || null; }
  invia(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  tutti(obj, filtro) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const m = this.membroDi(ws);
      if (!m || (filtro && !filtro(m))) continue;
      try { ws.send(s); } catch {}
    }
  }
  online() { return [...new Set(this.ctx.getWebSockets().map(ws => this.membroDi(ws)).filter(Boolean))]; }
  async diario(tipo, testoEv, chi) {
    const d = await this.get('diario', []);
    d.push({ t: Date.now(), tipo, testo: testo(testoEv, 1500), chi: chi || null });
    while (d.length > 400) d.shift();
    await this.put('diario', d);
    const n = (await this.get('daRiassumere', 0)) + 1;
    await this.put('daRiassumere', n);
    return d[d.length - 1];
  }

  async statoCompleto(perMembro) {
    const [campagna, membri, luoghiIdx, attuale, segnalini, diario, dadi, memoria, suggerimenti] = await Promise.all([
      this.get('campagna'), this.get('membri', {}), this.get('luoghi', {}), this.get('luogoAttuale', null),
      this.get('segnalini', {}), this.get('diario', []), this.get('dadi', []), this.get('memoria', ''), this.get('suggerimenti', [])]);
    const pg = {};
    for (const id of Object.keys(membri)) { const s = await this.get('pg:' + id); if (s) pg[id] = s; }
    const io = membri[perMembro];
    const vedeSegreti = io && (io.ruolo === 'master' || io.admin);
    const membriPubblici = Object.fromEntries(Object.entries(membri).map(([id, m]) => [id, { nome: m.nome, ruolo: m.ruolo, colore: m.colore, admin: !!m.admin }]));
    return {
      campagna: { ...campagna, invito: vedeSegreti || campagna.masterTipo === 'ai' ? campagna.invito : undefined },
      membri: membriPubblici, online: this.online(), pg,
      luoghi: luoghiIdx, luogo: attuale ? await this.get('luogo:' + attuale) : null,
      segnalini, diario: diario.slice(-120), dadi: dadi.filter(d => !d.segreto || vedeSegreti || d.chi === perMembro).slice(-40),
      combattimento: await this.get('combattimento', null), aree: await this.get('aree', []), gruppo: await this.get('gruppo', { oro: 0, oggetti: [] }),
      memoria: vedeSegreti ? memoria : undefined, suggerimenti: vedeSegreti ? suggerimenti.slice(-30) : undefined,
      costi: vedeSegreti ? await this.get('costi', null) : undefined
    };
  }

  // ---------- messaggi ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return this.invia(ws, { t: 'errore', msg: 'messaggio troppo grande' });
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      const io = this.membroDi(ws);
      if (m.t === 'crea') return this.crea(ws, m);
      if (m.t === 'entra') return this.entra(ws, m);
      if (m.t === 'ciao') return this.ciao(ws, m);
      if (m.t === 'ping') return this.invia(ws, { t: 'pong', ora: Date.now() });
      if (!io) return this.invia(ws, { t: 'errore', msg: 'non sei entrato nella stanza' });
      const membri = await this.get('membri', {});
      const me = membri[io];
      if (!me) return this.invia(ws, { t: 'errore', msg: 'membro sconosciuto' });
      const capo = me.ruolo === 'master' || me.admin;
      switch (m.t) {
        case 'scheda': return this.scheda(io, me, capo, m);
        case 'dado': return this.dado(io, me, capo, m);
        case 'segnalino': return this.segnalino(io, capo, m);
        case 'vai': if (!capo && (await this.get('campagna')).masterTipo === 'umano') return; return this.vai(io, me, m.nome, m.tipo);
        case 'modifica_luogo': return this.modificaLuogo(io, me, capo, m);
        case 'chat': { const ev = await this.diario('chat', m.testo, io); this.tutti({ t: 'diario', ev }); if (m.alMaster) await this.programmaMaster(true); return; }
        case 'parlato': return this.parlato(io, me, m);
        case 'comando': { const ev = await this.diario('comando', `${me.nome}: ${testo(m.testo, 300)}`, io); return this.tutti({ t: 'diario', ev }); }
        case 'narra': if (!capo) return; { const ev = await this.diario('narrazione', m.testo, io); return this.tutti({ t: 'narra', testo: ev.testo, png: testo(m.png, 40), chi: io }); }
        case 'rtc': return this.rtc(io, m);
        case 'impostazioni': return this.impostazioni(ws, io, me, capo, m);
        case 'nuovo_invito': if (!capo) return; { const c = await this.get('campagna'); c.invito = codiceCasuale(8); await this.put('campagna', c); return this.tutti({ t: 'invito', invito: c.invito }, x => { const mm = membri[x]; return mm && (mm.ruolo === 'master' || mm.admin || c.masterTipo === 'ai'); }); }
        case 'suggerimento': { const s = await this.get('suggerimenti', []); s.push({ t: Date.now(), chi: me.nome, testo: testo(m.testo, 1500) }); while (s.length > 200) s.shift(); await this.put('suggerimenti', s); return this.invia(ws, { t: 'ok', cosa: 'suggerimento' }); }
        case 'interpreta': return this.interpreta(ws, io, me, m);
        case 'regola': return this.regola(ws, me, m);
        case 'riassunto': return this.inviaRiassunto(ws);
        case 'stato': return this.invia(ws, { t: 'stato', stato: await this.statoCompleto(io) });
        case 'master_ora': return this.programmaMaster(true);
        case 'combattimento': return this.combattimento(io, me, capo, m);
        case 'area': return this.area(io, capo, m);
        case 'gruppo': return this.gruppo(io, me, m);
        case 'esci': case 'rimuovi': {
          const chi = m.t === 'rimuovi' && me.admin ? String(m.membro || '') : io;
          if (!membri[chi] || (chi !== io && membri[chi].admin)) return;
          const nome = membri[chi].nome;
          delete membri[chi]; await this.put('membri', membri); await this.ctx.storage.delete('pg:' + chi);
          const seg = await this.get('segnalini', {}); delete seg[chi]; await this.put('segnalini', seg);
          const ev = await this.diario('sistema', `${nome} lascia la campagna.`);
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x === chi) { s2.serializeAttachment({ membro: null }); try { s2.close(1000, 'uscito'); } catch {} } }
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x) { this.invia(s2, { t: 'stato', stato: await this.statoCompleto(x) }); this.invia(s2, { t: 'diario', ev }); } }
          return;
        }
      }
    } catch (e) {
      this.invia(ws, { t: 'errore', msg: 'errore del server: ' + (e.message || e) });
    }
  }

  async webSocketClose(ws) { this.dopoUscita(ws); }
  async webSocketError(ws) { this.dopoUscita(ws); }
  dopoUscita(ws) {
    const io = this.membroDi(ws);
    try { ws.serializeAttachment({ membro: null }); } catch {}
    if (io) this.tutti({ t: 'presenza', online: this.online(), uscito: io });
  }

  async accetta(ws, id, membri, extra = {}) {
    ws.serializeAttachment({ membro: id });
    this.invia(ws, { t: 'benvenuto', io: id, ...extra, stato: await this.statoCompleto(id) });
    this.tutti({ t: 'presenza', online: this.online(), entrato: id, membro: { nome: membri[id].nome, ruolo: membri[id].ruolo, colore: membri[id].colore, admin: !!membri[id].admin } });
  }

  async nuovoMembro(membri, nome, ruolo, admin) {
    const id = codiceCasuale(8);
    const chiave = codiceCasuale(24);
    const usati = Object.values(membri).map(m => m.colore);
    membri[id] = { nome: testo(nome, 30) || 'Avventuriero', ruolo, colore: COLORI.find(c => !usati.includes(c)) || COLORI[Object.keys(membri).length % COLORI.length], hash: await sha(chiave), admin: !!admin, dal: Date.now() };
    return { id, chiave };
  }

  async crea(ws, m) {
    if (await this.get('campagna')) return this.invia(ws, { t: 'errore', msg: 'esiste già una campagna con questo codice' });
    const campagna = {
      nome: testo(m.nome, 60) || 'Nuova campagna', regole: m.regole === '3.5' ? '3.5' : '5e',
      ambientazione: testo(m.ambientazione, 400) || 'Fantasy classico', masterTipo: m.masterTipo === 'umano' ? 'umano' : 'ai',
      invito: codiceCasuale(8), creata: Date.now(), sessione: 1
    };
    await this.put('campagna', campagna);
    const membri = {};
    const ruolo = m.ruolo === 'master' && campagna.masterTipo === 'umano' ? 'master' : 'giocatore';
    const { id, chiave } = await this.nuovoMembro(membri, m.mioNome, ruolo, true);
    await this.put('membri', membri);
    await this.diario('sistema', `Campagna "${campagna.nome}" creata. Regolamento ${campagna.regole === '5e' ? 'D&D 5ª edizione' : 'D&D 3.5'}. Ambientazione: ${campagna.ambientazione}.`);
    await this.accetta(ws, id, membri, { chiave });
  }

  async entra(ws, m) {
    const c = await this.get('campagna');
    if (!c) return this.invia(ws, { t: 'errore', msg: 'campagna inesistente', codice: 'inesistente' });
    if (!m.invito || m.invito !== c.invito) return this.invia(ws, { t: 'errore', msg: 'invito non valido o scaduto: chiedi un nuovo QR', codice: 'invito' });
    const membri = await this.get('membri', {});
    if (Object.keys(membri).length >= 12) return this.invia(ws, { t: 'errore', msg: 'stanza piena' });
    let ruolo = ['giocatore', 'spettatore', 'master'].includes(m.ruolo) ? m.ruolo : 'giocatore';
    if (ruolo === 'master' && (c.masterTipo !== 'umano' || Object.values(membri).some(x => x.ruolo === 'master'))) ruolo = 'giocatore';
    const { id, chiave } = await this.nuovoMembro(membri, m.nome, ruolo, false);
    await this.put('membri', membri);
    const ev = await this.diario('sistema', `${membri[id].nome} si unisce come ${ruolo}.`);
    this.tutti({ t: 'diario', ev });
    await this.accetta(ws, id, membri, { chiave });
  }

  async ciao(ws, m) {
    const membri = await this.get('membri', {});
    const me = membri[m.membro];
    if (!me || me.hash !== await sha(String(m.chiave || ''))) return this.invia(ws, { t: 'errore', msg: 'accesso non valido: entra di nuovo con il QR', codice: 'accesso' });
    await this.accetta(ws, m.membro, membri);
  }

  async impostazioni(ws, io, me, capo, m) {
    const c = await this.get('campagna');
    const membri = await this.get('membri', {});
    if (m.mioNome) { me.nome = testo(m.mioNome, 30); membri[io] = me; await this.put('membri', membri); }
    if (capo) {
      if (m.regole) c.regole = m.regole === '3.5' ? '3.5' : '5e';
      if (m.ambientazione) c.ambientazione = testo(m.ambientazione, 400);
      if (m.nome) c.nome = testo(m.nome, 60);
      if (m.masterTipo) c.masterTipo = m.masterTipo === 'umano' ? 'umano' : 'ai';
      if (m.nuovaSessione) { c.sessione = (c.sessione || 1) + 1; c.invito = codiceCasuale(8); await this.diario('sistema', `Inizia la sessione ${c.sessione}.`); }
      if (m.ruoli && me.admin) for (const [id, r] of Object.entries(m.ruoli)) if (membri[id] && ['giocatore', 'spettatore', 'master'].includes(r)) membri[id].ruolo = r;
      await this.put('campagna', c); await this.put('membri', membri);
    }
    for (const s of this.ctx.getWebSockets()) { const x = this.membroDi(s); if (x) this.invia(s, { t: 'stato', stato: await this.statoCompleto(x) }); }
  }

  // ---------- schede ----------
  async scheda(io, me, capo, m) {
    if (m.per && m.per !== io && !capo) return; // la scheda di un altro la tocca solo il master
    const per = m.per || io;
    if (!m.pg || typeof m.pg !== 'object') return;
    if (JSON.stringify(m.pg).length > 60000) return;
    await this.put('pg:' + per, m.pg);
    this.tutti({ t: 'scheda', per, pg: m.pg, nota: m.nota ? testo(m.nota, 300) : null, da: io });
    if (m.nota) { const ev = await this.diario('scheda', `${m.pg.nome || me.nome}: ${testo(m.nota, 300)}`, io); this.tutti({ t: 'diario', ev }); }
  }

  // ---------- dadi (tirati dal server, nessuno può barare) ----------
  async dado(io, me, capo, m) {
    const r = tiraFormula(String(m.formula || 'd20'), m.modo);
    if (!r) return this.tutti({ t: 'errore', msg: 'formula non valida' }, x => x === io);
    const tiro = { ...r, chi: io, nome: me.nome, motivo: testo(m.motivo, 80), segreto: !!(m.segreto && capo), t: Date.now() };
    const dadi = await this.get('dadi', []);
    dadi.push(tiro); while (dadi.length > 100) dadi.shift();
    await this.put('dadi', dadi);
    const membri = await this.get('membri', {});
    if (tiro.segreto) this.tutti({ t: 'dado', tiro }, x => x === io || membri[x]?.ruolo === 'master' || membri[x]?.admin);
    else {
      this.tutti({ t: 'dado', tiro });
      await this.diario('dado', `${me.nome} tira ${tiro.formula}${tiro.motivo ? ' (' + tiro.motivo + ')' : ''}: ${tiro.totale}${tiro.critico ? ' CRITICO!' : tiro.fallimento ? ' fallimento critico' : ''}`, io);
      const c = await this.get('campagna');
      if (c.masterTipo === 'ai' && m.alMaster !== false) await this.programmaMaster(false);
    }
  }

  // ---------- mappa ----------
  async segnalino(io, capo, m) {
    const id = String(m.id || io);
    if (id !== io && !capo) return;
    const seg = await this.get('segnalini', {});
    if (m.rimuovi && capo) delete seg[id];
    else seg[id] = { x: Math.max(0, Math.min(63, m.x | 0)), y: Math.max(0, Math.min(63, m.y | 0)), nome: testo(m.nome, 30) || seg[id]?.nome, colore: m.colore || seg[id]?.colore, tipo: m.tipo || seg[id]?.tipo || 'pg', pf: m.pf ?? seg[id]?.pf, ca: m.ca ?? seg[id]?.ca };
    await this.put('segnalini', seg);
    this.tutti({ t: 'segnalini', segnalini: seg });
    if (seg[id]?.tipo === 'pg') await this.scopri([seg[id]]);
  }

  // Nebbia di guerra: ogni luogo ricorda le caselle già viste dal gruppo
  async scopri(punti, luogoDato) {
    const id = luogoDato?.id || await this.get('luogoAttuale'); if (!id) return;
    const luogo = luogoDato || await this.get('luogo:' + id); if (!luogo) return;
    const r = ['dungeon', 'grotta', 'taverna'].includes(luogo.tipo) ? 3 : 6;
    const v = (luogo.visto || '0'.repeat(luogo.w * luogo.h)).split('');
    let cambi = 0;
    for (const p of punti) for (let y = p.y - r; y <= p.y + r; y++) for (let x = p.x - r; x <= p.x + r; x++) {
      if (x < 0 || y < 0 || x >= luogo.w || y >= luogo.h || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue;
      const i = y * luogo.w + x; if (v[i] === '0') { v[i] = '1'; cambi++; }
    }
    if (!cambi && luogo.visto) return luogo;
    luogo.visto = v.join('');
    await this.put('luogo:' + id, luogo);
    if (!luogoDato) this.tutti({ t: 'nebbia', id, visto: luogo.visto });
    return luogo;
  }

  async vai(io, me, nome, tipo) {
    nome = testo(nome, 60).trim();
    if (!nome) return;
    const c = await this.get('campagna');
    const id = chiaveLuogo(nome);
    let luogo = await this.get('luogo:' + id);
    const nuovo = !luogo;
    if (!luogo) {
      const t = ['citta', 'villaggio', 'taverna', 'dungeon', 'foresta', 'grotta', 'castello', 'porto', 'aperto'].includes(tipo) ? tipo : indovinaTipo(nome);
      luogo = generaLuogo(nome, t, c.creata + ':' + id);
      const idx = await this.get('luoghi', {});
      idx[id] = { nome: luogo.nome, tipo: luogo.tipo, prima: Date.now() };
      await this.put('luoghi', idx);
    }
    luogo.visite = (luogo.visite || 0) + 1; luogo.ultima = Date.now();
    await this.put('luogo:' + id, luogo);
    await this.put('luogoAttuale', id);
    const membri = await this.get('membri', {});
    const seg = {};
    let k = 0;
    for (const [mid, mm] of Object.entries(membri)) {
      if (mm.ruolo !== 'giocatore') continue;
      const pg = await this.get('pg:' + mid);
      seg[mid] = { x: Math.min(W - 1, luogo.ingresso.x + (k % 2)), y: Math.min(H - 1, luogo.ingresso.y + Math.floor(k / 2)), nome: pg?.nome || mm.nome, colore: mm.colore, tipo: 'pg' }; k++;
    }
    await this.put('segnalini', seg);
    await this.put('aree', []);
    await this.scopri(Object.values(seg), luogo);
    const ev = await this.diario('luogo', `${nuovo ? 'Il gruppo raggiunge per la prima volta' : 'Il gruppo torna a'}: ${luogo.nome}.`, io);
    this.tutti({ t: 'luogo', luogo, segnalini: seg, luoghi: await this.get('luoghi', {}) });
    this.tutti({ t: 'diario', ev });
  }

  async modificaLuogo(io, me, capo, m) {
    if (!capo) return;
    const id = m.luogo || await this.get('luogoAttuale');
    const luogo = await this.get('luogo:' + id);
    if (!luogo) return;
    const ed = luogo.edifici.find(e => e.id === m.edificio);
    if (!ed) return;
    ed.stato = ['integro', 'bruciato', 'distrutto', 'danneggiato'].includes(m.stato) ? m.stato : 'distrutto';
    luogo.storia = [...(luogo.storia || []), { t: Date.now(), testo: `${ed.nome}: ${ed.stato}` }].slice(-50);
    await this.put('luogo:' + id, luogo);
    const ev = await this.diario('luogo', `${luogo.nome} — ${ed.nome} ora è ${ed.stato}.`, io);
    this.tutti({ t: 'luogo_mod', luogo });
    this.tutti({ t: 'diario', ev });
  }

  // ---------- combattimento a turni ----------
  async combattimento(io, me, capo, m) {
    let c = await this.get('combattimento', null);
    const az = m.azione;
    const fineTurnoMio = az === 'prossimo' && c?.attivo && c.ordine[c.turno]?.id === io;
    if (!capo && !fineTurnoMio && io !== 'master') return;
    if (az === 'inizia') {
      const membri = await this.get('membri', {}), seg = await this.get('segnalini', {});
      const ordine = [];
      for (const [id, mm] of Object.entries(membri)) {
        if (mm.ruolo !== 'giocatore') continue;
        const p = await this.get('pg:' + id); if (!p) continue;
        const bonus = Math.floor(((p.car?.des || 10) - 10) / 2);
        const d = tiraFormula('d20' + (bonus ? (bonus > 0 ? '+' : '') + bonus : ''));
        ordine.push({ id, nome: p.nome, iniz: d.totale, dado: d.dadi[0], tipo: 'pg' });
      }
      for (const [id, s2] of Object.entries(seg)) if (s2.tipo === 'nemico') { const d = tiraFormula('d20' + (s2.iniz ? '+' + s2.iniz : '')); ordine.push({ id, nome: s2.nome, iniz: d.totale, dado: d.dadi[0], tipo: 'nemico' }); }
      ordine.sort((a, b) => b.iniz - a.iniz || b.dado - a.dado);
      c = { attivo: true, round: 1, turno: 0, ordine, inizio: Date.now() };
      await this.diario('combattimento', `Inizia il combattimento! Ordine: ${ordine.map(o => `${o.nome} (${o.iniz})`).join(', ')}.`, io);
    } else if (!c?.attivo) return;
    else if (az === 'prossimo') {
      c.turno++; if (c.turno >= c.ordine.length) { c.turno = 0; c.round++; }
    } else if (az === 'fine') { c.attivo = false; await this.diario('combattimento', `Fine del combattimento dopo ${c.round} round.`, io); }
    else if (az === 'aggiungi') { c.ordine.push({ id: 'x' + Date.now(), nome: testo(m.nome, 30) || 'Creatura', iniz: Number(m.iniz) || tiraFormula('d20').totale, tipo: 'nemico' }); c.ordine.sort((a, b) => b.iniz - a.iniz); }
    else if (az === 'togli') { const i = c.ordine.findIndex(o => o.id === m.id); if (i >= 0) { c.ordine.splice(i, 1); if (c.turno > i) c.turno--; if (c.turno >= c.ordine.length) c.turno = 0; } if (!c.ordine.length) c.attivo = false; }
    await this.put('combattimento', c);
    this.tutti({ t: 'combattimento', combattimento: c });
    const ev = (await this.get('diario', [])).slice(-1)[0];
    if (az === 'inizia' || az === 'fine') this.tutti({ t: 'diario', ev });
  }

  // ---------- aree degli incantesimi sulla mappa ----------
  async area(io, capo, m) {
    let aree = await this.get('aree', []);
    if (m.togli) aree = aree.filter(a => a.id !== m.togli || !(a.chi === io || capo));
    else if (m.pulisci && capo) aree = [];
    else aree.push({ id: 'a' + Date.now().toString(36), chi: io, forma: ['cerchio', 'quadrato', 'cono', 'linea'].includes(m.forma) ? m.forma : 'cerchio', x: m.x | 0, y: m.y | 0, dim: Math.max(1, Math.min(20, m.dim | 0)), dir: ['n', 's', 'e', 'o'].includes(m.dir) ? m.dir : 'e', colore: m.colore || '#e0602a', nome: testo(m.nome, 40) });
    aree = aree.slice(-20);
    await this.put('aree', aree);
    this.tutti({ t: 'aree', aree });
  }

  // ---------- tesoro del gruppo: monete e oggetti in comune ----------
  async gruppo(io, me, m) {
    const g = await this.get('gruppo', { oro: 0, oggetti: [] });
    let nota = '';
    const n = Math.max(0, Math.min(1000000, Number(m.qta ?? m.delta) || 0));
    if (m.op === 'oro') { const d = Math.trunc(Number(m.delta) || 0); g.oro = Math.max(0, g.oro + d); nota = `${d >= 0 ? 'mette' : 'prende'} ${Math.abs(d)} monete ${d >= 0 ? 'nel' : 'dal'} tesoro comune`; }
    else if (m.op === 'oggetto') { const nome = testo(m.nome, 60); const es = g.oggetti.find(o => o.nome.toLowerCase() === nome.toLowerCase()); if (es) es.qta += Math.max(1, n); else g.oggetti.push({ nome, qta: Math.max(1, n) }); nota = `mette ${nome} nel tesoro comune`; }
    else if (m.op === 'prendi') { const es = g.oggetti.find(o => o.nome.toLowerCase() === String(m.nome).toLowerCase()); if (!es) return; es.qta--; if (es.qta <= 0) g.oggetti = g.oggetti.filter(o => o !== es); const p = await this.get('pg:' + io); if (p) { const mio = (p.equip || []).find(e => e.nome === es.nome); if (mio) mio.qta = (mio.qta || 1) + 1; else p.equip = [...(p.equip || []), { nome: es.nome, qta: 1, indossato: false }]; await this.put('pg:' + io, p); this.tutti({ t: 'scheda', per: io, pg: p, da: 'gruppo' }); } nota = `prende ${es.nome} dal tesoro comune`; }
    else if (m.op === 'dividi') {
      const membri = await this.get('membri', {}); const ids = [];
      for (const [id, mm] of Object.entries(membri)) if (mm.ruolo === 'giocatore' && await this.get('pg:' + id)) ids.push(id);
      if (!ids.length || !g.oro) return;
      const quota = Math.floor(g.oro / ids.length);
      for (const id of ids) { const p = await this.get('pg:' + id); p.oro = (p.oro || 0) + quota; await this.put('pg:' + id, p); this.tutti({ t: 'scheda', per: id, pg: p, nota: `riceve ${quota} monete dalla divisione del bottino`, da: 'gruppo' }); }
      g.oro -= quota * ids.length; nota = `divide il bottino: ${quota} monete a testa${g.oro ? `, ${g.oro} restano nel tesoro` : ''}`;
    } else return;
    await this.put('gruppo', g);
    this.tutti({ t: 'gruppo', gruppo: g });
    const ev = await this.diario('gruppo', `${me.nome}: ${nota}`, io); this.tutti({ t: 'diario', ev });
  }

  rtc(io, m) {
    if (!m.a) return;
    this.tutti({ t: 'rtc', da: io, dati: m.dati }, x => x === m.a);
  }

  // ---------- uso dell'AI: chiamate e token per sessione (pannello costi) ----------
  async g(corpo, compito = 'master') {
    const r = await chiamaGemini(this.env, corpo);
    if (r.ok) {
      try {
        const u = (await r.clone().json()).usageMetadata || {};
        const c = await this.get('costi', { totale: { chiamate: 0, in: 0, out: 0 }, sessione: { n: 0, chiamate: 0, in: 0, out: 0 }, modelli: {}, compiti: {} });
        const sess = (await this.get('campagna'))?.sessione || 1;
        if (c.sessione.n !== sess) c.sessione = { n: sess, chiamate: 0, in: 0, out: 0 };
        for (const k of ['totale', 'sessione']) { c[k].chiamate++; c[k].in += u.promptTokenCount || 0; c[k].out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); }
        c.modelli[r.modello] = (c.modelli[r.modello] || 0) + 1;
        c.compiti[compito] = (c.compiti[compito] || 0) + 1;
        c.ultimo = { t: Date.now(), modello: r.modello, compito };
        await this.put('costi', c);
        const membri = await this.get('membri', {});
        this.tutti({ t: 'costi', costi: c }, x => membri[x]?.ruolo === 'master' || membri[x]?.admin);
      } catch {}
    }
    return r;
  }

  // ---------- master AI ----------
  async parlato(io, me, m) {
    const frase = testo(m.testo, 600).trim();
    if (!frase) return;
    const ev = await this.diario('parlato', `${me.nome}: ${frase}`, io);
    this.tutti({ t: 'diario', ev });
    const c = await this.get('campagna');
    if (c.masterTipo === 'ai' && me.ruolo !== 'spettatore') await this.programmaMaster(!!m.alMaster);
  }

  async programmaMaster(subito) {
    const c = await this.get('campagna');
    if (c.masterTipo !== 'ai') return;
    await this.put('masterInAttesa', true);
    await this.ctx.storage.setAlarm(Date.now() + (subito ? 200 : ATTESA_MASTER));
  }

  async alarm() {
    if (await this.get('masterOccupato', false) && Date.now() - (await this.get('masterDal', 0)) < 40000) {
      await this.ctx.storage.setAlarm(Date.now() + 1500); return;
    }
    if (await this.get('masterInAttesa', false)) {
      await this.put('masterInAttesa', false);
      await this.put('masterOccupato', true); await this.put('masterDal', Date.now());
      this.tutti({ t: 'master_pensa' });
      try { await this.turnoMaster(); } finally { await this.put('masterOccupato', false); }
    }
    if ((await this.get('daRiassumere', 0)) >= 25) await this.riassumi();
  }

  async contestoMaster() {
    const [c, membri, diario, memoria, attuale, luoghi] = await Promise.all([
      this.get('campagna'), this.get('membri', {}), this.get('diario', []), this.get('memoria', ''), this.get('luogoAttuale'), this.get('luoghi', {})]);
    const luogo = attuale ? await this.get('luogo:' + attuale) : null;
    const pgs = [];
    for (const [id, mm] of Object.entries(membri)) {
      if (mm.ruolo !== 'giocatore') continue;
      const p = await this.get('pg:' + id);
      if (p) pgs.push({ id, giocatore: mm.nome, nome: p.nome, razza: p.razza, classe: p.classe, livello: p.livello, pf: `${p.pf}/${p.pfMax}`, ca: p.ca, caratteristiche: p.car, condizioni: p.condizioni || [], equipaggiato: (p.equip || []).filter(e => e.indossato).map(e => e.nome + (e.bonus ? ' +' + e.bonus : '')), oro: p.oro, classi: p.classi, talenti: p.talenti, incantesimi: (p.incantesimi || []).map(i => i.nome), aspetto: p.aspetto ? { altezza: p.aspetto.altezza, peso: p.aspetto.peso, corporatura: p.aspetto.corporatura } : undefined });
      else pgs.push({ id, giocatore: mm.nome, nome: '(scheda non ancora creata)' });
    }
    return { c, pgs, diario: diario.slice(-40), memoria, luogo, luoghi };
  }

  async turnoMaster() {
    const { c, pgs, diario, memoria, luogo, luoghi } = await this.contestoMaster();
    const regole = c.regole === '3.5' ? 'D&D 3.5 (System Reference Document 3.5)' : 'D&D 5ª edizione (SRD 5.1)';
    const istr = `Sei il Dungeon Master di una partita di Dungeons & Dragons giocata online da amici italiani. Parli in italiano, con voce narrante coinvolgente ma concisa: le tue parole vengono lette ad alta voce.
Regolamento: ${regole}. Applicalo correttamente (prove, CD, tiri salvezza, attacchi, danni). Ambientazione scelta: ${c.ambientazione}.
Tieni conto dell'aspetto dei personaggi (altezza, peso, corporatura) quando conta davvero: passaggi stretti, essere notati, sollevare o spingere.
Ruolo: descrivi scene, interpreta i PNG (dai loro un nome e un modo di parlare riconoscibile), chiedi i tiri di dado quando servono con abilità e CD, applica le conseguenze, mantieni il mondo coerente con la memoria della campagna. Sii proattivo: i PNG agiscono e il mondo va avanti anche senza i giocatori.
Se il gruppo non è ancora in nessun luogo, fai partire l'avventura con un evento "luogo".
Se i giocatori stanno solo parlando tra loro fuori dal gioco o non serve il tuo intervento, rispondi con narrazione vuota "".
Quando un giocatore ha appena tirato un dado che avevi chiesto, risolvi l'esito.
Mai più di 110 parole di narrazione. Niente elenchi, niente markdown.
Rispondi SOLO con JSON: {"narrazione":"testo da leggere","png":"nome del PNG che parla o vuoto","eventi":[ ... ]}
Eventi possibili (solo se accadono davvero):
{"tipo":"danno","pg":"<id>","quantita":n,"zona":"testa|torso|braccio|gamba","motivo":"..."}
{"tipo":"cura","pg":"<id>","quantita":n}
{"tipo":"condizione","pg":"<id>","nome":"avvelenato|prono|spaventato|stordito|...","attiva":true}
{"tipo":"oggetto","pg":"<id>","nome":"...","quantita":1}
{"tipo":"oro","pg":"<id>","quantita":n}
{"tipo":"esperienza","pg":"<id>","quantita":n}
{"tipo":"luogo","nome":"nome proprio del luogo dove si spostano","tipoLuogo":"citta|villaggio|taverna|dungeon|foresta|grotta|castello|porto|aperto"}
{"tipo":"edificio","edificio":"<id edificio del luogo attuale>","stato":"bruciato|distrutto|danneggiato|integro"}
{"tipo":"tiro","pg":"<id>","prova":"Percezione","cd":15}
{"tipo":"nemico","nome":"Goblin","x":n,"y":n,"pf":7,"ca":15} (segnalino sulla mappa, griglia ${W}x${H})
{"tipo":"combattimento","azione":"inizia|prossimo|fine"} (inizia quando scoppia uno scontro: l'app tira l'iniziativa e gestisce i turni; "prossimo" quando un PNG o nemico ha finito il suo turno; "fine" quando lo scontro è finito)
{"tipo":"danno_nemico","nemico":"<id del segnalino>","quantita":n}
{"tipo":"bottino","oro":n,"oggetti":["..."]} (va nel tesoro comune del gruppo)
Durante il combattimento rispetta l'ordine di iniziativa e gioca tu i turni dei nemici quando tocca a loro.`;
    const contesto = {
      memoria_campagna: memoria || '(inizio della campagna)',
      luogo_attuale: luogo ? { nome: luogo.nome, tipo: luogo.tipo, edifici: luogo.edifici.map(e => ({ id: e.id, nome: e.nome, stato: e.stato })), storia: (luogo.storia || []).slice(-8) } : null,
      luoghi_conosciuti: Object.values(luoghi).map(l => l.nome),
      personaggi: pgs,
      nemici_sulla_mappa: Object.entries(await this.get('segnalini', {})).filter(([, s2]) => s2.tipo === 'nemico').map(([id, s2]) => ({ id, nome: s2.nome, x: s2.x, y: s2.y, pf: s2.pf, ca: s2.ca })),
      combattimento: await this.get('combattimento', null),
      tesoro_del_gruppo: await this.get('gruppo', null),
      ultimi_eventi: diario.map(d => `[${d.tipo}] ${d.testo}`)
    };
    const r = await this.g({
      systemInstruction: { parts: [{ text: istr }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(contesto) }] }],
      generationConfig: { temperature: 0.85, responseMimeType: 'application/json' }
    });
    if (!r.ok) { this.tutti({ t: 'errore', msg: `il master AI non risponde (${r.status}), riprova tra poco` }); return; }
    const j = await r.json();
    const out = leggiJSON(j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    if (!out) return;
    const narr = testo(out.narrazione, 1500).trim();
    for (const e of (Array.isArray(out.eventi) ? out.eventi.slice(0, 12) : [])) { try { await this.applicaEvento(e); } catch {} }
    if (narr) {
      const ev = await this.diario('narrazione', narr, 'master');
      this.tutti({ t: 'narra', testo: ev.testo, png: testo(out.png, 40), chi: 'master', modello: r.modello });
    } else this.tutti({ t: 'master_zitto' });
  }

  async applicaEvento(e) {
    if (!e || typeof e !== 'object') return;
    const pgMod = async (id, fn, nota) => {
      const p = await this.get('pg:' + id); if (!p) return;
      fn(p); await this.put('pg:' + id, p);
      this.tutti({ t: 'scheda', per: id, pg: p, nota, da: 'master' });
      const ev = await this.diario('scheda', `${p.nome}: ${nota}`, 'master'); this.tutti({ t: 'diario', ev });
    };
    const n = Math.max(0, Math.min(999, Number(e.quantita) || 0));
    switch (e.tipo) {
      case 'danno': return pgMod(e.pg, p => { p.pf = Math.max(-(p.pfMax || 10), (p.pf || 0) - n); if (e.zona) p.ferite = [...(p.ferite || []), { zona: testo(e.zona, 10), t: Date.now() }].slice(-6); }, `subisce ${n} danni${e.motivo ? ' (' + testo(e.motivo, 60) + ')' : ''}`);
      case 'cura': return pgMod(e.pg, p => { p.pf = Math.min(p.pfMax || 1, (p.pf || 0) + n); if (p.pf >= p.pfMax) p.ferite = []; else if ((p.ferite || []).length) p.ferite = p.ferite.slice(1); }, `recupera ${n} punti ferita`);
      case 'condizione': return pgMod(e.pg, p => { const s = new Set(p.condizioni || []); e.attiva === false ? s.delete(e.nome) : s.add(testo(e.nome, 30)); p.condizioni = [...s]; }, `${e.attiva === false ? 'non è più' : 'è'} ${testo(e.nome, 30)}`);
      case 'oggetto': return pgMod(e.pg, p => { p.equip = [...(p.equip || []), { nome: testo(e.nome, 60), qta: Math.max(1, n || 1), indossato: false }]; }, `ottiene ${testo(e.nome, 60)}`);
      case 'oro': return pgMod(e.pg, p => { p.oro = Math.max(0, (p.oro || 0) + (Number(e.quantita) || 0)); }, `${Number(e.quantita) >= 0 ? 'guadagna' : 'spende'} ${Math.abs(Number(e.quantita) || 0)} monete d'oro`);
      case 'esperienza': return pgMod(e.pg, p => { p.px = (p.px || 0) + n; }, `guadagna ${n} punti esperienza`);
      case 'luogo': return this.vai('master', { nome: 'Master' }, e.nome, e.tipoLuogo);
      case 'edificio': return this.modificaLuogo('master', {}, true, { edificio: e.edificio, stato: e.stato });
      case 'tiro': { const p = await this.get('pg:' + e.pg); this.tutti({ t: 'richiesta_tiro', pg: e.pg, prova: testo(e.prova, 40), cd: e.cd | 0, nome: p?.nome }); return; }
      case 'combattimento': return this.combattimento('master', { nome: 'Master' }, true, { azione: ['inizia', 'prossimo', 'fine'].includes(e.azione) ? e.azione : 'inizia' });
      case 'bottino': { if (e.oro) await this.gruppo('master', { nome: 'Il master' }, { op: 'oro', delta: Number(e.oro) || 0 }); for (const o of (Array.isArray(e.oggetti) ? e.oggetti.slice(0, 6) : [])) await this.gruppo('master', { nome: 'Il master' }, { op: 'oggetto', nome: String(o), qta: 1 }); return; }
      case 'danno_nemico': {
        const seg = await this.get('segnalini', {}); const s2 = seg[e.nemico]; if (!s2) return;
        s2.pf = (s2.pf ?? 10) - n;
        if (s2.pf <= 0) { delete seg[e.nemico]; const c = await this.get('combattimento'); if (c?.attivo) await this.combattimento('master', {}, true, { azione: 'togli', id: e.nemico }); const ev = await this.diario('combattimento', `${s2.nome} è sconfitto.`, 'master'); this.tutti({ t: 'diario', ev }); }
        await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg }); return;
      }
      case 'nemico': return this.segnalino('master', true, { id: 'n_' + testo(e.nome, 20).replace(/\W+/g, '_') + '_' + (e.x | 0) + '_' + (e.y | 0), x: e.x, y: e.y, nome: e.nome, colore: '#d84b3c', tipo: 'nemico', pf: Number(e.pf) || undefined, ca: Number(e.ca) || undefined });
    }
  }

  async riassumi() {
    const [diario, memoria] = await Promise.all([this.get('diario', []), this.get('memoria', '')]);
    const r = await this.g({ contents: [{ parts: [{ text: `Aggiorna la memoria di una campagna di D&D. Memoria attuale:\n${memoria || '(vuota)'}\n\nNuovi eventi:\n${diario.slice(-60).map(d => `[${d.tipo}] ${d.testo}`).join('\n')}\n\nScrivi la memoria aggiornata in italiano, massimo 350 parole, in punti brevi: trama, PNG incontrati (nome, ruolo, atteggiamento), promesse e debiti, nemici, luoghi e come sono cambiati, fazioni e reputazione del gruppo, stile di gioco preferito dal gruppo. Solo il testo.` }] }], generationConfig: { temperature: 0.2 } }, 'memoria');
    if (!r.ok) return;
    const j = await r.json();
    const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (t) { await this.put('memoria', testo(t, 6000)); await this.put('daRiassumere', 0); }
  }

  async inviaRiassunto(ws) {
    const memoria = await this.get('memoria', '');
    const diario = await this.get('diario', []);
    const r = await this.g({ contents: [{ parts: [{ text: `Sei il narratore di una campagna di D&D. Scrivi in italiano un "Nella puntata precedente..." di massimo 90 parole, da leggere ad alta voce, basato su:\n${memoria}\n${diario.slice(-30).map(d => d.testo).join('\n')}` }] }], generationConfig: { temperature: 0.7 } }, 'riassunto');
    if (!r.ok) return this.invia(ws, { t: 'errore', msg: 'riassunto non disponibile' });
    const j = await r.json();
    const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    this.tutti({ t: 'narra', testo: t || 'Nessuna avventura ancora da raccontare.', chi: 'master', riassunto: true });
  }

  // Frase che il riconoscitore nell'app non ha capito → operazioni sulla scheda
  async interpreta(ws, io, me, m) {
    const frase = testo(m.testo, 400);
    const r = await this.g({ contents: [{ parts: [{ text: `Un giocatore di D&D (${m.regole === '3.5' ? '3.5' : '5e'}) ha detto: "${frase}". Se è un comando per modificare la sua scheda personaggio, traducilo in operazioni. Rispondi SOLO JSON: {"ops":[...]} con elementi tra: {"op":"car","car":"for|des|cos|int|sag|car","delta":n} {"op":"pf","delta":n} {"op":"pfmax","delta":n} {"op":"livello","delta":1} {"op":"oro","delta":n} {"op":"px","delta":n} {"op":"oggetto","nome":"...","qta":n} {"op":"togli","nome":"..."} {"op":"indossa","nome":"..."} {"op":"condizione","nome":"...","attiva":true} {"op":"ca","delta":n}. Se non è un comando per la scheda: {"ops":[]}` }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }, 'comandi');
    if (!r.ok) return this.invia(ws, { t: 'interpretato', id: m.id, ops: [] });
    const j = await r.json();
    const out = leggiJSON(j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    this.invia(ws, { t: 'interpretato', id: m.id, testo: frase, ops: Array.isArray(out?.ops) ? out.ops.slice(0, 8) : [] });
  }

  // Domanda sulle regole in parole normali
  async regola(ws, me, m) {
    const c = await this.get('campagna');
    const r = await this.g({ contents: [{ parts: [{ text: `Domanda di regole di D&D ${c.regole === '3.5' ? '3.5' : '5ª edizione'}: "${testo(m.testo, 400)}". Rispondi in italiano, massimo 80 parole, preciso secondo il regolamento ufficiale (SRD). Solo testo.` }] }], generationConfig: { temperature: 0.1 } }, 'regole');
    if (!r.ok) return this.invia(ws, { t: 'regola', testo: 'Non riesco a rispondere ora, riprova tra poco.' });
    const j = await r.json();
    this.invia(ws, { t: 'regola', domanda: testo(m.testo, 400), testo: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '' });
  }
}

// ---------- Gemini (modelli in fila: se uno è sovraccarico si passa al successivo) ----------
async function chiamaGemini(env, corpo) {
  if (!env.GEMINI_KEY) return { ok: false, status: 503 };
  const modelli = [...new Set([env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'])];
  let r;
  for (const modello of modelli) {
    const url = `${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(modello)}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`;
    const invia = c => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    r = await invia({ ...corpo, generationConfig: { ...corpo.generationConfig, thinkingConfig: { thinkingBudget: 0 } } });
    if (r.status === 400) r = await invia(corpo);
    if (![404, 429, 500, 503].includes(r.status)) { r.modello = modello; return r; }
  }
  return r;
}
function leggiJSON(t) { try { return JSON.parse(t); } catch {} try { return JSON.parse(t.match(/\{[\s\S]*\}/)[0]); } catch { return null; } }

// ---------- dadi ----------
export function tiraFormula(f, modo) {
  f = f.toLowerCase().replace(/\s+/g, '');
  const mt = f.match(/^(\d{0,2})d(4|6|8|10|12|20|100)([+-]\d{1,3})?$/);
  if (!mt) return null;
  const n = Math.min(20, Math.max(1, Number(mt[1] || 1))), facce = Number(mt[2]), mod = Number(mt[3] || 0);
  const lancia = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return 1 + (a[0] % facce); };
  let dadi = Array.from({ length: n }, lancia), scartati = [];
  if (facce === 20 && n === 1 && (modo === 'vantaggio' || modo === 'svantaggio')) {
    const altro = lancia();
    const tieni = modo === 'vantaggio' ? Math.max(dadi[0], altro) : Math.min(dadi[0], altro);
    scartati = [dadi[0] === tieni ? altro : dadi[0]]; dadi = [tieni];
  }
  const totale = dadi.reduce((a, b) => a + b, 0) + mod;
  return { formula: `${n > 1 ? n : ''}d${facce}${mod ? (mod > 0 ? '+' : '') + mod : ''}`, dadi, scartati, mod, totale, modo: scartati.length ? modo : null, critico: facce === 20 && n === 1 && dadi[0] === 20, fallimento: facce === 20 && n === 1 && dadi[0] === 1 };
}

// ---------- luoghi persistenti: la mappa si genera una volta e poi resta, con le sue modifiche ----------
export function chiaveLuogo(nome) { return nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'luogo'; }
export function indovinaTipo(s) {
  s = s.toLowerCase();
  const regole = [['taverna', /taverna|locanda|osteria|bettola/], ['dungeon', /dungeon|cripta|segrete|sotterran|tomba|catacomb|labirint/], ['grotta', /grotta|caverna|miniera|antro/], ['foresta', /foresta|bosco|selva|giungla/], ['castello', /castello|fortezza|rocca|palazzo/], ['porto', /porto|molo|baia|approdo/], ['villaggio', /villaggio|borgo|frazione|fattoria/], ['citta', /citt|capitale|metropoli|quartiere|mercato/]];
  for (const [t, re] of regole) if (re.test(s)) return t;
  return 'aperto';
}
function rng(seme) {
  let h = 1779033703 ^ seme.length;
  for (let i = 0; i < seme.length; i++) { h = Math.imul(h ^ seme.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// Caselle: . erba  , strada  # muro  _ pavimento  ~ acqua  T albero  R roccia  = legno  + porta  t tavolo  b bancone  f focolare  c letto  ^ scala  w mura
export const W = 32, H = 20;
const NOMI_CITTA = ['Fabbro', 'Tempio', 'Mercato', 'Municipio', 'Caserma', 'Bottega dell\'alchimista', 'Stalla', 'Biblioteca', 'Gilda dei mercanti', 'Casa', 'Casa', 'Casa', 'Magazzino', 'Mulino', 'Torre del mago', 'Sartoria', 'Panetteria'];
export function generaLuogo(nome, tipo, seme) {
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
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (R() < 0.08) g[y][x] = R() < 0.5 ? 'T' : 'R';
    rett(0, Math.floor(H / 2), W, 2, ',');
    if (R() < 0.7) casa(ri(4, W - 10), ri(2, 5), 5, 4, 'Casolare');
    ingresso = { x: 1, y: Math.floor(H / 2) };
  }
  if ('#RTw~'.includes(g[ingresso.y][ingresso.x])) set(ingresso.x, ingresso.y, '_');
  return { id: chiaveLuogo(nome), nome, tipo, w: W, h: H, celle: g.map(r => r.join('')), edifici, ingresso, storia: [], creato: Date.now() };
}
