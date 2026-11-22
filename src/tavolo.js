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
    if (req.method === 'POST' && req.headers.get('x-tavolo-interno') === '1') return this.interno(await req.json());
    const md = new URL(req.url).pathname.match(/\/media\/(voce|img)\/([a-z0-9]{4,30})$/);
    if (req.method === 'GET' && md) {
      const dati = md[1] === 'voce' ? this.voci?.get(md[2]) : await this.ctx.storage.get('img:' + md[2]);
      if (!dati) return new Response('non pronto', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
      return new Response(dati, { headers: { 'Content-Type': md[1] === 'voce' ? 'audio/wav' : 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }
    const gr = new URL(req.url).pathname.match(/\/grafica\/atlante\.(png|json)$/);
    if (req.method === 'GET' && gr) return this.grafica(req, gr[1]);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ membro: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- voce naturale del master (Gemini TTS): una sola sintesi per narrazione, tenuta in memoria per chi la scarica ----------
  // Atlante dei pacchetti grafici comprati: sta nel repository privato dei rapporti, non in quelli pubblici;
  // si consegna solo a un membro della campagna (id e chiave del membro) e resta nella cache di Cloudflare.
  async grafica(req, est) {
    const u = new URL(req.url), cors = { 'Access-Control-Allow-Origin': '*' };
    const me = (await this.get('membri', {}))[u.searchParams.get('m') || ''];
    if (!me || me.hash !== await sha(u.searchParams.get('k') || '')) return new Response('non autorizzato', { status: 403, headers: cors });
    const chiave = new Request('https://grafica.tavolo.interna/atlante.' + est), cache = caches.default;
    let r = await cache.match(chiave);
    if (!r) {
      const g = await fetch('https://api.github.com/repos/vincenzociriello91-hub/TavoloAvventura-rapporti/contents/grafica/atlante.' + est, { headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'tavolo-worker' } });
      if (!g.ok) return new Response('grafica non disponibile', { status: 502, headers: cors });
      r = new Response(await g.arrayBuffer(), { headers: { 'Content-Type': est === 'png' ? 'image/png' : 'application/json', 'Cache-Control': 'public, max-age=86400' } });
      await cache.put(chiave, r.clone());
    }
    return new Response(r.body, { headers: { ...cors, 'Content-Type': r.headers.get('Content-Type'), 'Cache-Control': 'private, max-age=86400' } });
  }
  async voce(id, testoV, png) {
    try {
      const wav = await sintesiVocale(this.env, testoV, png);
      if (!wav) return this.tutti({ t: 'voce', id, ok: false });
      this.voci = this.voci || new Map();
      this.voci.set(id, wav);
      while (this.voci.size > 8) this.voci.delete(this.voci.keys().next().value);
      this.tutti({ t: 'voce', id, ok: true });
    } catch { this.tutti({ t: 'voce', id, ok: false }); }
  }

  // ---------- illustrazioni realistiche delle scene (Workers AI, quota gratuita giornaliera) ----------
  async illustra(prompt, didascalia, forza, vera) {
    try {
      const oggi = new Date().toISOString().slice(0, 10), q = await this.get('quotaImmagini', { giorno: oggi, n: 0, ultima: 0 });
      if (q.giorno !== oggi) { q.giorno = oggi; q.n = 0; }
      if (q.n >= 40 || (!forza && Date.now() - q.ultima < 120000)) return null; // al massimo 40 al giorno, una ogni 2 minuti
      q.n++; q.ultima = Date.now(); await this.put('quotaImmagini', q);
      const prova = (await this.get('campagna'))?.prova; // partita bot: non consuma i crediti gratuiti delle immagini
      const jpeg = await generaImmagine(prova && !vera ? { ...this.env, IMG_FINTA: 1 } : this.env, prompt, prova);
      if (!jpeg) return null;
      const id = 'i' + Date.now().toString(36);
      await this.ctx.storage.put('img:' + id, jpeg);
      const elenco = await this.get('immagini', []);
      const luogo = await this.get('luogoAttuale');
      elenco.push({ id, t: Date.now(), didascalia: testo(didascalia, 200), luogo });
      while (elenco.length > 60) { const vecchia = elenco.shift(); await this.ctx.storage.delete('img:' + vecchia.id); }
      await this.put('immagini', elenco);
      const d = await this.get('diario', []);
      d.push({ t: Date.now(), tipo: 'illustrazione', testo: testo(didascalia, 200), chi: 'master', img: id });
      while (d.length > 400) d.shift();
      await this.put('diario', d);
      this.tutti({ t: 'diario', ev: d[d.length - 1] });
      return id;
    } catch (e) { this.erroreImg = String(e?.message || e).slice(0, 700); console.error('illustra', this.erroreImg); return null; }
  }
  // ---------- riepilogo illustrato di fine sessione ----------
  async riepilogo() {
    const [c, diario, memoria] = await Promise.all([this.get('campagna'), this.get('diario', []), this.get('memoria', '')]);
    const inizio = [...diario].reverse().find(d => d.tipo === 'sistema' && /^Inizia la sessione/.test(d.testo))?.t || c.creata;
    const ev = diario.filter(d => d.t >= inizio);
    const tutte = (re, tipi) => ev.filter(d => (!tipi || tipi.includes(d.tipo)) && re.test(d.testo));
    const px = {}; for (const d of tutte(/guadagna (\d+) punti esperienza/, ['scheda'])) { const [nome] = d.testo.split(':'); px[nome] = (px[nome] || 0) + Number(d.testo.match(/guadagna (\d+) punti/)[1]); }
    const stats = {
      sessione: c.sessione || 1,
      nemici: tutte(/è sconfitto/, ['combattimento']).map(d => d.testo.replace(/ è sconfitto\.?$/, '')),
      combattimenti: tutte(/^Inizia il combattimento/, ['combattimento']).length,
      luoghi: [...new Set(ev.filter(d => d.tipo === 'luogo').map(d => d.testo.replace(/^.*?: /, '').replace(/\.$/, '')))],
      bottino: ev.filter(d => (d.tipo === 'gruppo' || d.tipo === 'scheda') && /ottiene|monete d'oro|tesoro|aggiunge/.test(d.testo) && !/spende/.test(d.testo)).map(d => d.testo).slice(-12),
      livelli: tutte(/livello/i, ['scheda']).map(d => d.testo).slice(-8),
      px
    };
    const r = await this.g({ contents: [{ parts: [{ text: `Sei il master di una campagna di D&D (${c.ambientazione}). Racconta la serata di gioco appena finita come una pagina di cronaca epica, in italiano, massimo 170 parole, piacevole da leggere ad alta voce e da condividere nel gruppo. Poi dai un titolo all'episodio e scrivi in inglese il prompt (max 60 parole, niente nomi) per un'illustrazione realistica del momento più memorabile.
Rispondi SOLO JSON: {"titolo":"...","racconto":"...","prompt":"..."}
Memoria della campagna: ${memoria || '(nessuna)'}
Eventi della serata:\n${ev.slice(-120).map(d => `[${d.tipo}] ${d.testo}`).join('\n')}` }] }], generationConfig: { temperature: 0.8, responseMimeType: 'application/json' } }, 'master');
    if (!r.ok) return this.tutti({ t: 'errore', msg: 'Riepilogo non disponibile ora' });
    const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') || {};
    stats.trofei = (await this.statistiche()).trofei;
    const rie = { t: Date.now(), titolo: testo(out.titolo, 100) || `Sessione ${stats.sessione}`, racconto: testo(out.racconto, 1800), stats, img: null };
    rie.img = out.prompt ? await this.illustra(testo(out.prompt, 600), rie.titolo, true) : null;
    const elenco = await this.get('riepiloghi', []); elenco.push(rie); await this.put('riepiloghi', elenco.slice(-30));
    const d = await this.get('diario', []); d.push({ t: rie.t, tipo: 'riepilogo', testo: rie.titolo, chi: 'master', riepilogo: rie.t }); while (d.length > 400) d.shift(); await this.put('diario', d);
    this.tutti({ t: 'riepilogo', r: rie });
    this.tutti({ t: 'diario', ev: d[d.length - 1] });
    if (rie.racconto) this.tutti({ t: 'narra', testo: rie.racconto, chi: 'master', riassunto: true });
  }

  // ---------- mostri disegnati e volti dei PNG: generati una volta per campagna, poi salvati ----------
  async immagineSalvata(prompt, quotaChiave, max) {
    const oggi = new Date().toISOString().slice(0, 10), q = await this.get(quotaChiave, { giorno: oggi, n: 0 });
    if (q.giorno !== oggi) { q.giorno = oggi; q.n = 0; }
    if (q.n >= max) return null;
    q.n++; await this.put(quotaChiave, q);
    const jpeg = await generaImmagine((await this.get('campagna'))?.prova ? { ...this.env, IMG_FINTA: 1 } : this.env, prompt, true).catch(() => null);
    if (!jpeg) return null;
    const id = 'i' + Date.now().toString(36) + Math.floor(Math.random() * 100);
    await this.ctx.storage.put('img:' + id, jpeg);
    return id;
  }
  async disegnaMostro(nome) {
    const chiave = nomeMostro(nome); if (!chiave || UMANOIDI.test(chiave)) return;
    const mostri = await this.get('mostri', {}); if (mostri[chiave] || this.inCorso?.has('m:' + chiave)) return;
    (this.inCorso = this.inCorso || new Set()).add('m:' + chiave);
    try {
      const id = await this.immagineSalvata(`pixel art sprite of a ${chiave} (fantasy monster from Dungeons and Dragons), one single creature, full body, side view facing right, 16-bit detailed RPG game asset, centered, on a plain flat pure white background, no ground, no shadow, no text`, 'quotaMostri', 25);
      if (!id) return;
      const m2 = await this.get('mostri', {}); m2[chiave] = id; await this.put('mostri', m2);
      this.tutti({ t: 'mostri', mostri: m2 });
    } finally { this.inCorso.delete('m:' + chiave); }
  }
  async disegnaVolto(png) {
    const nome = testo(png, 40).trim(); if (!nome || /banditore/i.test(nome)) return;
    const volti = await this.get('volti', {}); if (volti[nome] || this.inCorso?.has('v:' + nome)) return;
    (this.inCorso = this.inCorso || new Set()).add('v:' + nome);
    try {
      const diario = await this.get('diario', []), recenti = diario.filter(d => d.tipo === 'narrazione').slice(-2).map(d => d.testo).join('\n');
      const r = await this.g({ contents: [{ parts: [{ text: `Describe in English, max 40 words, the face and look of the D&D character "${nome}" for a portrait painting (age, race, hair, clothes, expression), consistent with this scene:\n${recenti}\nOnly the description.` }] }], generationConfig: { temperature: 0.7 } }, 'interni');
      const desc = r.ok ? ((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim().slice(0, 400) : '';
      const id = await this.immagineSalvata(`realistic fantasy portrait painting, head and shoulders, ${desc || nome}, Dungeons and Dragons character, dramatic warm lighting, highly detailed face, painterly realism, dark background, no text`, 'quotaVolti', 25);
      if (!id) return;
      const v2 = await this.get('volti', {}); v2[nome] = id; await this.put('volti', v2);
      this.tutti({ t: 'volti', volti: v2 });
    } finally { this.inCorso.delete('v:' + nome); }
  }

  // ---------- avventure pronte: luoghi, PNG, incontri, tesori e segreti preparati ----------
  async avventuraPerMaster() {
    const avv = await this.get('avventura', null); if (!avv || !AVVENTURE[avv.id]) return null;
    return { ...avv, ...AVVENTURE[avv.id] };
  }
  async iniziaAvventura(id) {
    const A = AVVENTURE[id]; if (!A) return;
    const c = await this.get('campagna');
    // luoghi preparati una volta, con le loro mappe
    const idx = await this.get('luoghi', {});
    for (const sc of A.scene) { const lid = chiaveLuogo(sc.luogo); if (!await this.get('luogo:' + lid)) { const l = generaLuogo(sc.luogo, sc.tipo, c.creata + ':' + lid); await this.put('luogo:' + lid, l); idx[lid] = { nome: l.nome, tipo: l.tipo, prima: Date.now() }; } }
    await this.put('luoghi', idx);
    const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] });
    for (const f of A.fazioni || []) mo.fazioni[f.nome] = { reputazione: f.reputazione, descrizione: f.descrizione };
    await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo });
    const memoria = await this.get('memoria', '');
    if (!memoria.includes(A.titolo)) await this.put('memoria', `${memoria}\n**Avventura**: ${A.titolo}. ${A.sinossi}`.trim());
    await this.put('avventura', { id, scena: 0, iniziata: true });
    await this.scenaAvventura(A.scene[0].id, true);
  }
  async scenaAvventura(idScena, leggi) {
    const avv = await this.get('avventura', null), A = AVVENTURE[avv?.id]; if (!A) return;
    const i = A.scene.findIndex(x => x.id === idScena); if (i < 0) return;
    const sc = A.scene[i];
    avv.scena = i; avv.iniziata = true; await this.put('avventura', avv);
    if (chiaveLuogo(sc.luogo) !== await this.get('luogoAttuale')) await this.vai('master', { nome: 'Master' }, sc.luogo, sc.tipo);
    if (sc.incontro) await this.piazzaNemici(sc.incontro);
    if (leggi) { const ev = await this.diario('narrazione', sc.leggi, 'master'); this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master' }); }
    const membri = await this.get('membri', {});
    for (const ws of this.ctx.getWebSockets()) { const x = this.membroDi(ws); if (x && (membri[x]?.ruolo === 'master' || membri[x]?.admin)) this.invia(ws, { t: 'avventura', avventura: await this.avventuraPerMaster() }); }
  }

  // ---------- statistiche della serata e di tutta la campagna, trofei ----------
  async conta(chi, campi) {
    const c = await this.get('campagna'), st = await this.get('statistiche', { sessione: c.sessione || 1, s: {}, t: {} });
    if (st.sessione !== (c.sessione || 1)) { st.sessione = c.sessione || 1; st.s = {}; }
    for (const k of ['s', 't']) { const o = st[k][chi] = st[k][chi] || {}; for (const [campo, v] of Object.entries(campi)) o[campo] = (o[campo] || 0) + v; }
    await this.put('statistiche', st);
  }
  async contaPf(id, prima, dopo) {
    if (!prima || !dopo || prima.pf === dopo.pf) return;
    const d = (dopo.pf || 0) - (prima.pf || 0);
    await this.conta(id, d < 0 ? { danniSubiti: -d, ...(prima.pf > 0 && dopo.pf <= 0 ? { cadute: 1 } : {}) } : { cure: d });
  }
  async statistiche() {
    const st = await this.get('statistiche', { s: {}, t: {} }), membri = await this.get('membri', {}), nomi = {};
    for (const id of Object.keys(membri)) nomi[id] = (await this.get('pg:' + id))?.nome || membri[id].nome;
    nomi.gruppo = 'Il gruppo';
    return { sessione: st.sessione, s: st.s, tot: st.t, nomi, trofei: trofei(st.s, nomi) }; // "tot": "t" è il tipo del messaggio
  }

  // ---------- negozi: il gruppo compra e vende con le monete della scheda ----------
  async apriNegozio(e) {
    const nome = testo(e.nome, 60) || 'Mercante';
    let merci = (Array.isArray(e.merci) ? e.merci : []).slice(0, 24).map(x => ({ nome: testo(x.nome, 60), prezzo: Math.max(0, Math.round(Number(x.prezzo) || 0)) })).filter(x => x.nome);
    if (!merci.length) merci = CATALOGHI[e.tipo] || CATALOGHI[tipoNegozio(nome)];
    const n = { nome, merci, aperto: Date.now() };
    await this.put('negozio', n);
    const ev = await this.diario('gruppo', `Si apre il banco: ${nome}.`, 'master'); this.tutti({ t: 'diario', ev });
    this.tutti({ t: 'negozio', negozio: n });
  }
  async compra(ws, io, me, m) {
    const n = await this.get('negozio'), merce = n?.merci.find(x => x.nome === m.merce), p = await this.get('pg:' + io);
    if (!merce || !p) return;
    if ((p.oro || 0) < merce.prezzo) return this.invia(ws, { t: 'errore', msg: `Non hai abbastanza monete (servono ${merce.prezzo} mo)` });
    p.oro -= merce.prezzo; await this.conta(io, { speso: merce.prezzo });
    const es = (p.equip || []).find(x => x.nome === merce.nome && !x.indossato);
    if (es) es.qta = (es.qta || 1) + 1; else p.equip = [...(p.equip || []), { nome: merce.nome, qta: 1, indossato: false }];
    await this.put('pg:' + io, p);
    this.tutti({ t: 'scheda', per: io, pg: p, da: 'negozio' });
    const ev = await this.diario('scheda', `${p.nome}: compra ${merce.nome} per ${merce.prezzo} mo da ${n.nome}`, io); this.tutti({ t: 'diario', ev });
  }
  async vendi(ws, io, me, m) {
    const n = await this.get('negozio'), p = await this.get('pg:' + io), i = Number(m.indice), og = p?.equip?.[i];
    if (!n || !og) return;
    const prezzo = Math.max(0, Math.floor((n.merci.find(x => x.nome === og.nome)?.prezzo ?? prezzoBase(og.nome)) / 2));
    if ((og.qta || 1) > 1) og.qta--; else p.equip.splice(i, 1);
    p.oro = (p.oro || 0) + prezzo;
    await this.put('pg:' + io, p);
    this.tutti({ t: 'scheda', per: io, pg: p, da: 'negozio' });
    const ev = await this.diario('scheda', `${p.nome}: vende ${og.nome} per ${prezzo} mo a ${n.nome}`, io); this.tutti({ t: 'diario', ev });
  }

  // ---------- schermo del master: PNG, incontri bilanciati, tesori ----------
  async strumento(m) {
    const membri = await this.get('membri', {}), pgs = [];
    for (const id of Object.keys(membri)) { const p = await this.get('pg:' + id); if (p && membri[id].ruolo === 'giocatore') pgs.push(p); }
    const luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
    const chiedi = async (testoP) => { const r = await this.g({ contents: [{ parts: [{ text: testoP }] }], generationConfig: { temperature: 0.9, responseMimeType: 'application/json' } }, 'interni'); return r.ok ? leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') : null; };
    if (m.tipo === 'png') {
      const ai = await chiedi(`Inventa un personaggio non giocante per una campagna di D&D, in italiano, adatto a: ${luogo?.nome || 'un villaggio'} (${luogo?.tipo || ''}). Rispondi SOLO JSON {"nome":"...","razza":"...","mestiere":"...","aspetto":"una frase","tratto":"modo di fare","segreto":"un segreto","battuta":"prima frase che dice"}`);
      return ai?.nome ? ai : pngCasuale();
    }
    if (m.tipo === 'incontro') {
      const diff = ['facile', 'media', 'difficile', 'mortale'].includes(m.difficolta) ? m.difficolta : 'media', col = { facile: 0, media: 1, difficile: 2, mortale: 3 }[diff];
      const livelli = pgs.length ? pgs.map(p => Math.max(1, Math.min(20, p.livello || 1))) : [1, 1, 1, 1];
      const budget = livelli.reduce((a, l) => a + SOGLIE_PX[l - 1][col], 0);
      const ai = await chiedi(`Proponi un incontro di D&D 5e ${diff} per un gruppo di livelli ${livelli.join(', ')} (budget ${budget} PX, moltiplicatore per numero di mostri già considerato) in ${luogo?.nome || 'un luogo'} (${luogo?.tipo || 'aperto'}). Usa mostri dell'SRD con nomi italiani. Rispondi SOLO JSON {"mostri":[{"nome":"Goblin","numero":3,"gs":"1/4","pf":7,"ca":15}],"tattica":"come combattono, una frase"}`);
      const mostri = Array.isArray(ai?.mostri) && ai.mostri.length ? ai.mostri.slice(0, 6).map(x => ({ nome: testo(x.nome, 30), numero: Math.max(1, Math.min(8, x.numero | 0 || 1)), gs: testo(x.gs, 6), pf: Number(x.pf) || 10, ca: Number(x.ca) || 12 })) : incontroCasuale(budget);
      return { difficolta: diff, budget, mostri, tattica: testo(ai?.tattica, 300) };
    }
    if (m.tipo === 'tesoro') return tesoroCasuale(Math.max(0, Math.min(20, Number(m.gs) || 1)));
    return null;
  }
  async piazzaNemici(mostri) {
    const seg = await this.get('segnalini', {}), luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
    if (!luogo || !Array.isArray(mostri)) return;
    const pgs = Object.values(seg).filter(x => x.tipo === 'pg'), cx = pgs.length ? Math.round(pgs.reduce((a, x) => a + x.x, 0) / pgs.length) : Math.floor(W / 2), cy = pgs.length ? Math.round(pgs.reduce((a, x) => a + x.y, 0) / pgs.length) : Math.floor(H / 2);
    const { blocco } = griglia(luogo), libera = (x, y) => x > 0 && y > 0 && x < luogo.w - 1 && y < luogo.h - 1 && !blocco[y * luogo.w + x] && !Object.values(seg).some(o => o.x === x && o.y === y);
    let k = 0;
    for (const mo of mostri.slice(0, 6)) for (let i = 0; i < Math.min(8, mo.numero || 1); i++) {
      let fatto = false;
      for (let r = 4; r < 12 && !fatto; r++) for (let t = 0; t < 24 && !fatto; t++) { const a = (k * 1.7 + t) * 0.5, x = cx + Math.round(Math.cos(a) * r), y = cy + Math.round(Math.sin(a) * r * 0.7); if (libera(x, y)) { const nome = (mo.numero || 1) > 1 ? `${testo(mo.nome, 24)} ${i + 1}` : testo(mo.nome, 30); seg['n_' + Date.now().toString(36) + k] = { x, y, nome, colore: '#d84b3c', tipo: 'nemico', pf: Number(mo.pf) || 10, ca: Number(mo.ca) || 12 }; fatto = true; k++; } }
    }
    await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg });
    for (const mo of mostri.slice(0, 6)) this.ctx.waitUntil(this.disegnaMostro(mo.nome));
  }

  // ---------- libro della campagna: riepiloghi, illustrazioni e narrazioni ----------
  async libro() {
    const [c, riepiloghi, diario, membri] = await Promise.all([this.get('campagna'), this.get('riepiloghi', []), this.get('diario', []), this.get('membri', {})]);
    const pg = []; for (const id of Object.keys(membri)) { const p = await this.get('pg:' + id); if (p) pg.push(p); }
    return { campagna: { nome: c.nome, regole: c.regole, ambientazione: c.ambientazione, sessione: c.sessione, creata: c.creata }, riepiloghi, pg, diario: diario.filter(d => ['narrazione', 'illustrazione', 'luogo', 'sistema', 'riepilogo', 'combattimento'].includes(d.tipo)) };
  }

  // ---------- sessione zero: il master aiuta a creare il personaggio parlando ----------
  async sessioneZero(io, m) {
    const membri = await this.get('membri', {}), altri = [];
    for (const id of Object.keys(membri)) { if (id === io) continue; const p = await this.get('pg:' + id); if (p) altri.push(`${p.nome} (${p.razza} ${p.classe})${p.note ? ': ' + testo(p.note, 160) : ''}`); }
    const c = await this.get('campagna'), razze = (m.razze || []).slice(0, 20).map(x => testo(x, 30)), classi = (m.classi || []).slice(0, 20).map(x => testo(x, 30));
    const storia = (Array.isArray(m.storia) ? m.storia : []).slice(-12).map(x => `${x.chi === 'io' ? 'Giocatore' : 'Master'}: ${testo(x.testo, 400)}`).join('\n');
    const risposte = (m.storia || []).filter(x => x.chi === 'io').length;
    const r = await this.g({ contents: [{ parts: [{ text: `Sei il master di una campagna di D&D (${c.ambientazione}, regole ${c.regole}). Aiuti un giocatore a creare il suo personaggio con una breve chiacchierata, in italiano, tono caldo. Fai UNA domanda alla volta, breve (concetto del personaggio, passato, carattere, legame con gli altri personaggi, aspetto). ${risposte >= 5 ? 'Ora hai abbastanza: fai la proposta.' : 'Dopo al massimo 5 risposte fai la proposta.'}
Altri personaggi del gruppo: ${altri.join('; ') || 'nessuno ancora'}.
Razze possibili: ${razze.join(', ')}. Classi possibili: ${classi.join(', ')}.
Conversazione finora:\n${storia || '(inizio)'}
Rispondi SOLO JSON: {"domanda":"..."} oppure {"proposta":{"nome":"...","razza":"una delle razze","classe":"una delle classi","allineamento":"...","aspetto":{"pelle":"chiara|olivastra|scura|molto scura","capelli":"corti|lunghi|coda|ricci|cresta|calvo","coloreCapelli":"nero|castano|biondo|rosso|bianco|grigio","barba":"nessuna|corta|lunga","occhi":"marroni|azzurri|verdi|grigi|ambra","corporatura":"normale|snella|robusta","figura":"maschile|femminile"},"storia":"passato in massimo 120 parole","legami":"legami con gli altri personaggi, una o due frasi"}}` }] }], generationConfig: { temperature: 0.85, responseMimeType: 'application/json' } }, 'comandi');
    if (!r.ok) return { errore: 'Il master non risponde, riprova tra poco' };
    const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') || {};
    if (out.proposta) { const pr = out.proposta; if (!razze.includes(pr.razza)) pr.razza = razze[0]; if (!classi.includes(pr.classe)) pr.classe = classi.includes('Guerriero') ? 'Guerriero' : classi[0]; return { proposta: pr }; }
    return { domanda: testo(out.domanda, 400) || 'Raccontami di più sul tuo personaggio.' };
  }

  // prompt inglese per la scena attuale, dalle ultime narrazioni
  async illustraScena(forza) {
    const diario = await this.get('diario', []), luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
    const recenti = diario.filter(d => d.tipo === 'narrazione').slice(-3).map(d => d.testo).join('\n');
    if (!recenti && !luogo) return;
    const r = await this.g({ contents: [{ parts: [{ text: `Write ONE English prompt (max 60 words) for a realistic image generator, describing the current scene of a D&D game: setting, lighting, mood, characters seen from a cinematic angle. No names, no text in the image. Place: ${luogo?.nome || ''} (${luogo?.tipo || ''}). Recent narration (Italian):\n${recenti}\nThen on a second line write an Italian caption of max 12 words. Format: PROMPT: ...\nDIDASCALIA: ...` }] }], generationConfig: { temperature: 0.6 } }, 'interni');
    const t = r.ok ? (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '' : '';
    // se Gemini non risponde si disegna comunque il luogo, senza lasciare il gruppo ad aspettare
    const prompt = t.match(/PROMPT:\s*(.+)/i)?.[1] || `Detailed fantasy D&D illustration of ${luogo?.nome || 'an adventuring party'} (${luogo?.tipo || 'tavern'}), cinematic lighting, painterly, atmospheric`, did = t.match(/DIDASCALIA:\s*(.+)/i)?.[1];
    const ok = await this.illustra(prompt, did || luogo?.nome || 'La scena', forza, forza);
    if (!ok && forza) this.tutti({ t: 'avviso', msg: "L'illustrazione non è riuscita (servizio immagini occupato o quota del giorno finita): riprova tra poco", motivo: this.erroreImg || null });
  }

  // ---------- connettore per Claude: lettura dello stato e preparazione delle sessioni ----------
  async interno(m) {
    const ris = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    const c = await this.get('campagna');
    if (!c) return ris({ errore: 'campagna inesistente' });
    if (m.azione === 'stato') {
      const membri = await this.get('membri', {}); const pg = [];
      for (const [id, mm] of Object.entries(membri)) { const p = await this.get('pg:' + id); pg.push({ giocatore: mm.nome, ruolo: mm.ruolo, personaggio: p ? `${p.nome}, ${p.razza} ${(p.classi || [{ classe: p.classe, livello: p.livello }]).map(x => x.classe + ' ' + x.livello).join('/')}, PF ${p.pf}/${p.pfMax}, CA ${p.ca}` : null }); }
      const attuale = await this.get('luogoAttuale');
      return ris({ campagna: c, membri: pg, luogo_attuale: attuale ? (await this.get('luogo:' + attuale))?.nome : null, luoghi: Object.values(await this.get('luoghi', {})).map(l => l.nome), memoria: await this.get('memoria', ''), mondo: await this.get('mondo', {}), tesoro: await this.get('gruppo', null), costi: await this.get('costi', null), suggerimenti: (await this.get('suggerimenti', [])).slice(-20), online: this.online().length });
    }
    if (m.azione === 'diario') return ris((await this.get('diario', [])).slice(-Math.min(200, m.n || 50)).map(d => `${new Date(d.t).toISOString().slice(0, 16)} [${d.tipo}] ${d.testo}`));
    if (m.azione === 'nota') { const mem = await this.get('memoria', ''); await this.put('memoria', testo(`${mem}\nNote di preparazione del master: ${testo(m.testo, 1500)}`, 7000)); return ris({ ok: true }); }
    if (m.azione === 'prepara_luogo') { const id = chiaveLuogo(testo(m.nome, 60)); if (!await this.get('luogo:' + id)) { const l = generaLuogo(testo(m.nome, 60), m.tipo || indovinaTipo(m.nome), c.creata + ':' + id); await this.put('luogo:' + id, l); const idx = await this.get('luoghi', {}); idx[id] = { nome: l.nome, tipo: l.tipo, prima: Date.now() }; await this.put('luoghi', idx); } return ris({ ok: true, luogo: m.nome }); }
    if (m.azione === 'fazione') { await this.applicaEvento({ tipo: 'fazione', nome: m.nome, descrizione: m.descrizione }); if (m.delta) await this.applicaEvento({ tipo: 'reputazione', fazione: m.nome, delta: m.delta, motivo: m.motivo }); return ris({ ok: true }); }
    return ris({ errore: 'azione sconosciuta' });
  }

  // ---------- utilità di stato ----------
  async get(k, def) { const v = await this.ctx.storage.get(k); return v === undefined ? def : v; }
  async put(k, v) { await this.ctx.storage.put(k, v); }
  membroDi(ws) { return ws.deserializeAttachment()?.membro || null; }
  invia(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  tutti(obj, filtro) {
    if (obj.t === 'narra' && obj.testo && this.env.GEMINI_KEY && !obj.voce) { obj.voce = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4); this.ctx.waitUntil(this.voce(obj.voce, obj.testo, obj.png)); }
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
      luoghi: luoghiIdx, luogo: await this.luogoCon(attuale),
      segnalini, diario: diario.slice(-120), dadi: dadi.filter(d => !d.segreto || vedeSegreti || d.chi === perMembro).slice(-40),
      mondo: await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }), relazioni: await this.get('relazioni', {}),
      combattimento: await this.get('combattimento', null), aree: await this.get('aree', []), gruppo: await this.get('gruppo', { oro: 0, oggetti: [] }),
      mostri: await this.get('mostri', {}), volti: await this.get('volti', {}), negozio: await this.get('negozio', null),
      avventura: vedeSegreti ? await this.avventuraPerMaster() : undefined,
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
        case 'scena': return this.scena(io, me.ruolo === 'master', m);
        case 'riepilogo': if (!capo) return; this.ctx.waitUntil(this.riepilogo()); return this.invia(ws, { t: 'avviso', msg: 'Il master prepara il riepilogo della serata…' });
        case 'riepiloghi': return this.invia(ws, { t: 'riepiloghi', elenco: await this.get('riepiloghi', []) });
        case 'illustra': if (!capo) return; this.ctx.waitUntil(this.illustraScena(true)); return this.invia(ws, { t: 'avviso', msg: 'Sto disegnando la scena…' });
        case 'modifica_luogo': return this.modificaLuogo(io, me, me.ruolo === 'master', m); // solo il master umano; il master AI cambia lo stato con gli eventi
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
        case 'apri_negozio': if (!capo) return; return this.apriNegozio({ nome: m.nome, tipo: m.tipo, merci: m.merci });
        case 'chiudi_negozio': if (!capo) return; await this.put('negozio', null); return this.tutti({ t: 'negozio', negozio: null });
        case 'compra': return this.compra(ws, io, me, m);
        case 'vendi': return this.vendi(ws, io, me, m);
        case 'strumento': if (!capo) return; return this.invia(ws, { t: 'strumento', tipo: m.tipo, ris: await this.strumento(m) });
        case 'piazza_nemici': if (!capo) return; return this.piazzaNemici(m.mostri);
        case 'note_master': if (!capo) return; if (typeof m.testo === 'string') await this.put('noteMaster', testo(m.testo, 8000)); return this.invia(ws, { t: 'note_master', testo: await this.get('noteMaster', '') });
        case 'libro': return this.invia(ws, { t: 'libro', ...(await this.libro()) });
        case 'avventura_inizia': if (!capo) return; return this.iniziaAvventura(m.id);
        case 'avventura_scena': if (!capo) return; return this.scenaAvventura(m.scena);
        case 'avventura_leggi': if (!capo) return; { const avv = await this.get('avventura'), sc = AVVENTURE[avv?.id]?.scene.find(x => x.id === m.scena); if (!sc) return; const ev = await this.diario('narrazione', sc.leggi, 'master'); return this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master' }); }
        case 'statistiche': return this.invia(ws, { t: 'statistiche', ...(await this.statistiche()) });
        case 'sessione_zero': return this.invia(ws, { t: 'sessione_zero', ...(await this.sessioneZero(io, m)) });
        case 'relazione': {
          const rel = await this.get('relazioni', {}); const LIV = ['sconosciuti', 'conoscenti', 'amici', 'amici stretti', 'compagni di vita', 'famiglia', 'rivali'];
          if (!membri[m.con] || m.con === io || !LIV.includes(m.livello)) return;
          rel[io] = { ...(rel[io] || {}), [m.con]: m.livello }; await this.put('relazioni', rel);
          this.tutti({ t: 'relazioni', relazioni: rel }); return;
        }
        case 'mondo_evolvi': if (!capo) return; return this.evolviMondo(true);
        case 'entra_edificio': if (!capo && (await this.get('campagna')).masterTipo === 'umano') return; return this.entraEdificio(io, me, m.edificio);
        case 'esci_edificio': { const l = await this.get('luogo:' + await this.get('luogoAttuale')); if (l?.genitore) { const g = await this.get('luogo:' + l.genitore); if (g) return this.vai(io, me, g.nome); } return; }
        case 'mondo': {
          if (!capo) return;
          const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] });
          if (m.fazione) { const f = testo(m.fazione, 40); if (m.rimuovi) delete mo.fazioni[f]; else mo.fazioni[f] = { reputazione: Math.max(-100, Math.min(100, Number(m.reputazione) || 0)), descrizione: testo(m.descrizione, 200) || mo.fazioni[f]?.descrizione || '' }; }
          if (m.valuta) { const v = testo(m.valuta, 40); if (m.rimuovi) delete mo.valute[v]; else mo.valute[v] = { cambio: Math.max(0.001, Number(m.cambio) || 1) }; }
          await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); return;
        }
        case 'esci': case 'rimuovi': {
          const chi = m.t === 'rimuovi' && me.admin ? String(m.membro || '') : io;
          if (!membri[chi] || (chi !== io && membri[chi].admin)) return;
          const nome = membri[chi].nome;
          delete membri[chi]; await this.put('membri', membri); await this.ctx.storage.delete('pg:' + chi);
          const seg = await this.get('segnalini', {}); delete seg[chi]; await this.put('segnalini', seg);
          const ev = await this.diario('sistema', `${nome} lascia la campagna.`);
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x === chi) { s2.serializeAttachment({ membro: null }); try { s2.close(1000, 'uscito'); } catch {} } }
          if (!Object.keys(membri).length && (await this.get('campagna'))?.prova) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; } // partita bot finita: niente resta sul server
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
      invito: codiceCasuale(8), creata: Date.now(), sessione: 1, solitaria: !!m.solitaria, prova: !!m.prova
    };
    await this.put('campagna', campagna);
    if (AVVENTURE[m.avventura]) await this.put('avventura', { id: m.avventura, scena: 0, iniziata: false });
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
      if (m.nuovaSessione) { c.sessione = (c.sessione || 1) + 1; c.invito = codiceCasuale(8); await this.diario('sistema', `Inizia la sessione ${c.sessione}.`); this.ctx.waitUntil(this.evolviMondo(false)); }
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
    const primaPg = await this.get('pg:' + per);
    await this.put('pg:' + per, m.pg);
    await this.contaPf(per, primaPg, m.pg);
    this.tutti({ t: 'scheda', per, pg: m.pg, nota: m.nota ? testo(m.nota, 300) : null, da: io });
    if (m.nota) { const ev = await this.diario('scheda', `${m.pg.nome || me.nome}: ${testo(m.nota, 300)}`, io); this.tutti({ t: 'diario', ev }); }
  }

  // ---------- dadi (tirati dal server, nessuno può barare) ----------
  async dado(io, me, capo, m) {
    const r = tiraFormula(String(m.formula || 'd20'), m.modo);
    if (!r) return this.tutti({ t: 'errore', msg: 'formula non valida' }, x => x === io);
    const tiro = { ...r, chi: io, nome: me.nome, motivo: testo(m.motivo, 80), segreto: !!(m.segreto && capo), t: Date.now() };
    await this.conta(io, { tiri: 1, ...(tiro.critico ? { critici: 1 } : {}), ...(tiro.fallimento ? { fallimenti: 1 } : {}) });
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
    if (!capo) m = { x: m.x, y: m.y }; // un giocatore sposta solo il suo segnalino: non ne cambia tipo, nome o punti ferita
    const seg = await this.get('segnalini', {});
    let via = null;
    if (!m.rimuovi && seg[id] && seg[id].tipo === 'pg' && (!capo || id === io)) {
      const luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
      if (luogo) { via = percorso(luogo, seg[id], { x: m.x | 0, y: m.y | 0 }); if (!via) return this.invia(this.wsDi?.(io), { t: 'segnalini', segnalini: seg }); }
    }
    let x = Math.max(0, Math.min(63, m.x | 0)), y = Math.max(0, Math.min(63, m.y | 0));
    // mostri e PNG piazzati dal master: mai dentro un muro o un mobile, ma nella casella libera più vicina
    if (!m.rimuovi && capo && !via && (m.tipo || seg[id]?.tipo) !== 'pg') {
      const luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
      if (luogo && x < luogo.w && y < luogo.h) { const presi = new Set(Object.entries(seg).filter(([k]) => k !== id).map(([, s]) => s.y * luogo.w + s.x)); ({ x, y } = vicine(luogo, { x, y }, presi)); }
    }
    if (m.rimuovi && capo) delete seg[id];
    else seg[id] = { x, y, nome: testo(m.nome, 30) || seg[id]?.nome, colore: m.colore || seg[id]?.colore, tipo: m.tipo || seg[id]?.tipo || 'pg', pf: m.pf ?? seg[id]?.pf, ca: m.ca ?? seg[id]?.ca };
    await this.put('segnalini', seg);
    this.tutti({ t: 'segnalini', segnalini: seg });
    if (seg[id]?.tipo === 'pg') await this.scopri(via?.length ? via : [seg[id]]);
  }
  wsDi(io) { return this.ctx.getWebSockets().find(ws => this.membroDi(ws) === io); }

  // Nebbia di guerra: ogni luogo ricorda le caselle già viste dal gruppo
  async scopri(punti, luogoDato) {
    const id = luogoDato?.id || await this.get('luogoAttuale'); if (!id) return;
    const luogo = luogoDato || await this.get('luogo:' + id); if (!luogo) return;
    // si scopre solo ciò che si vede davvero: muri, rocce e case bloccano la vista (stanze dietro i muri restano nascoste)
    const r = ['dungeon', 'grotta'].includes(luogo.tipo) ? 5 : ['taverna', 'interno'].includes(luogo.tipo) ? 8 : 9;
    const v = (luogo.visto || '0'.repeat(luogo.w * luogo.h)).split(''), { vista } = griglia(luogo);
    let cambi = 0;
    for (const p of punti) for (let y = p.y - r; y <= p.y + r; y++) for (let x = p.x - r; x <= p.x + r; x++) {
      if (x < 0 || y < 0 || x >= luogo.w || y >= luogo.h || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue;
      const i = y * luogo.w + x; if (v[i] !== '0' || !vede(luogo, vista, p.x, p.y, x, y)) continue;
      v[i] = '1'; cambi++;
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
    let luogo = await this.luogoCon(id);
    const nuovo = !luogo;
    if (!luogo) {
      const t = ['citta', 'villaggio', 'taverna', 'dungeon', 'foresta', 'grotta', 'castello', 'porto', 'aperto', 'interno'].includes(tipo) ? tipo : indovinaTipo(nome);
      luogo = generaLuogo(nome, t, c.creata + ':' + id);
      const idx = await this.get('luoghi', {});
      idx[id] = { nome: luogo.nome, tipo: luogo.tipo, prima: Date.now() };
      await this.put('luoghi', idx);
    }
    luogo.visite = (luogo.visite || 0) + 1; luogo.ultima = Date.now();
    const precedente = await this.get('luogoAttuale');
    if (precedente !== id) { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); mo.viaggi = [...(mo.viaggi || []), { da: precedente || null, a: id, t: Date.now(), sessione: c.sessione || 1 }].slice(-300); await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); }
    await this.put('luogo:' + id, luogo);
    await this.put('luogoAttuale', id);
    const membri = await this.get('membri', {});
    const seg = {}, presi = new Set(), posto = (da) => { const p = vicine(luogo, da, presi); presi.add(p.y * luogo.w + p.x); return p; };
    for (const [mid, mm] of Object.entries(membri)) {
      if (mm.ruolo !== 'giocatore') continue;
      const pg = await this.get('pg:' + mid);
      seg[mid] = { ...posto(luogo.ingresso), nome: pg?.nome || mm.nome, colore: mm.colore, tipo: 'pg' };
    }
    // chi abita il luogo: l'oste dietro il bancone, il padrone di casa negli interni
    if ((await this.get('campagna'))?.solitaria) COMPAGNI.forEach(cmp => { seg[cmp.id] = { ...posto(luogo.ingresso), nome: cmp.nome, tipo: 'alleato', colore: '#5cc85c', pf: cmp.pf, ca: cmp.ca }; });
    const banco = luogo.edifici.find(e => e.id === 'bancone');
    if (banco) seg.p_oste = { ...posto({ x: banco.x + 4, y: Math.max(1, banco.y - 1) }), nome: luogo.png || 'Oste', tipo: 'png', colore: '#bfae86' };
    else if (luogo.png && luogo.tipo === 'interno') { const cx = Math.floor(W / 2), cy = Math.floor(H / 2); for (let r = 0; r < 6 && !seg.p_casa; r++) for (let dy = -r; dy <= r && !seg.p_casa; dy++) for (let dx = -r; dx <= r; dx++) { const x = cx + dx, y = cy + dy; if (luogo.celle[y]?.[x] === '=' && !(luogo.oggetti || []).some(o => o.x === x && o.y === y)) { seg.p_casa = { x, y, nome: luogo.png, tipo: 'png', colore: '#bfae86' }; break; } } }
    await this.put('segnalini', seg);
    await this.put('aree', []);
    await this.scopri(Object.values(seg), luogo);
    const ev = await this.diario('luogo', `${nuovo ? 'Il gruppo raggiunge per la prima volta' : 'Il gruppo torna a'}: ${luogo.nome}.`, io);
    if (nuovo) { const cal = (await this.get('mondo', {}))?.calendario || {}; this.ctx.waitUntil(this.illustra(`${SCENE_EN[luogo.tipo] || SCENE_EN.aperto}, called "${luogo.nome}"${cal.ora !== undefined ? `, at ${cal.ora}:00` : ''}${cal.meteo ? `, weather: ${cal.meteo}` : ''}${cal.stagione ? `, season: ${cal.stagione}` : ''}`, luogo.nome, true)); }
    this.tutti({ t: 'luogo', luogo, segnalini: seg, luoghi: await this.get('luoghi', {}) });
    this.tutti({ t: 'diario', ev });
  }

  async luogoCon(id) {
    const l = id ? await this.get('luogo:' + id) : null;
    if (l && (!l.oggetti || l.arrediV !== ARREDI_V)) {
      const c = await this.get('campagna'), nuovo = generaLuogo(l.nome, l.tipo, (c?.creata || l.creato) + ':' + id, l.tipo === 'interno' ? l.edifici.map(e => e.nome) : undefined);
      l.celle = nuovo.celle; l.oggetti = nuovo.oggetti; l.arrediV = ARREDI_V;
      for (const e of l.edifici) if (e.stato === 'bruciato' || e.stato === 'distrutto') for (const o of l.oggetti) if (o.x >= e.x && o.x < e.x + e.w && o.y >= e.y && o.y < e.y + e.h) o.stato = e.stato === 'bruciato' ? 'bruciato' : 'rotto';
      await this.put('luogo:' + id, l);
    }
    return l;
  }

  // Oggetti di scena: il master umano li sposta a mano, il master AI con l'evento "scena"
  async scena(io, capo, m) {
    if (!capo) return;
    const id = await this.get('luogoAttuale'), luogo = await this.luogoCon(id);
    if (!luogo) return;
    const o = luogo.oggetti.find(o => o.id === m.oggetto);
    const xy = v => Math.max(0, Math.min(W - 1, v | 0));
    let testoEv = '';
    if (m.azione === 'aggiungi') {
      const tipo = testo(m.tipo, 20).toLowerCase(); if (!tipo) return;
      luogo.oggetti.push({ id: 'o' + Date.now().toString(36), tipo, nome: testo(m.nome, 40) || undefined, x: xy(m.x), y: xy(m.y), rot: 0, stato: 'integro', movibile: MOVIBILI.includes(tipo) });
      testoEv = `compare: ${testo(m.nome, 40) || tipo}`;
    } else if (o && m.azione === 'sposta') { if (!o.movibile && io !== 'master') return; o.x = xy(m.x); o.y = xy(m.y); }
    else if (o && ['rompi', 'brucia'].includes(m.azione)) { o.stato = m.azione === 'rompi' ? 'rotto' : 'bruciato'; testoEv = `${o.nome || o.tipo}: ${o.stato}`; }
    else if (o && m.azione === 'togli') { luogo.oggetti = luogo.oggetti.filter(x => x !== o); testoEv = `${o.nome || o.tipo} non c'è più`; }
    else return;
    if (testoEv) luogo.storia = [...(luogo.storia || []), { t: Date.now(), testo: testoEv }].slice(-50);
    await this.put('luogo:' + id, luogo);
    this.tutti({ t: 'luogo_mod', luogo });
  }

  async modificaLuogo(io, me, capo, m) {
    if (!capo) return;
    const id = m.luogo || await this.get('luogoAttuale');
    const luogo = await this.luogoCon(id);
    if (!luogo) return;
    const ed = luogo.edifici.find(e => e.id === m.edificio);
    if (!ed) return;
    ed.stato = ['integro', 'bruciato', 'distrutto', 'danneggiato'].includes(m.stato) ? m.stato : 'distrutto';
    // gli oggetti dentro l'edificio seguono la sua sorte
    if (ed.stato === 'bruciato' || ed.stato === 'distrutto') for (const o of luogo.oggetti || []) if (o.x >= ed.x && o.x < ed.x + ed.w && o.y >= ed.y && o.y < ed.y + ed.h) o.stato = ed.stato === 'bruciato' ? 'bruciato' : 'rotto';
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
      await this.conta('gruppo', { combattimenti: 1 });
      const membri = await this.get('membri', {}), seg = await this.get('segnalini', {});
      const ordine = [];
      for (const [id, mm] of Object.entries(membri)) {
        if (mm.ruolo !== 'giocatore') continue;
        const p = await this.get('pg:' + id); if (!p) continue;
        const bonus = Math.floor(((p.car?.des || 10) - 10) / 2);
        const d = tiraFormula('d20' + (bonus ? (bonus > 0 ? '+' : '') + bonus : ''));
        ordine.push({ id, nome: p.nome, iniz: d.totale, dado: d.dadi[0], tipo: 'pg' });
      }
      for (const [id, s2] of Object.entries(seg)) if (s2.tipo === 'alleato') { const d = tiraFormula('d20+2'); ordine.push({ id, nome: s2.nome, iniz: d.totale, dado: d.dadi[0], tipo: 'alleato' }); }
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
    const leggero = ['comandi', 'regole', 'riassunto', 'memoria', 'interni'].includes(compito);
    const r = compito === 'master' && this.env.ANTHROPIC_KEY ? await chiamaClaude(this.env, corpo).then(x => x.ok ? x : chiamaGemini(this.env, corpo)) : await chiamaGemini(this.env, corpo, leggero);
    if (r.ok) {
      try {
        const u = (await r.clone().json()).usageMetadata || {};
        const c = await this.get('costi', { totale: { chiamate: 0, in: 0, out: 0 }, sessione: { n: 0, chiamate: 0, in: 0, out: 0 }, modelli: {}, compiti: {} });
        const sess = (await this.get('campagna'))?.sessione || 1;
        if (c.sessione.n !== sess) c.sessione = { n: sess, chiamate: 0, in: 0, out: 0 };
        for (const k of ['totale', 'sessione']) { c[k].chiamate++; c[k].in += u.promptTokenCount || 0; c[k].out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); }
        c.modelli[r.modello] = (c.modelli[r.modello] || 0) + 1;
        c.compiti[compito] = (c.compiti[compito] || 0) + 1;
        c.ultimo = { t: Date.now(), modello: r.modello, compito, tentativi: r.tentativi }; // tempi di ogni tentativo, per capire perché il master è lento
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
    const avv = await this.get('avventura', null);
    if (avv && !avv.iniziata && AVVENTURE[avv.id]) return this.iniziaAvventura(avv.id); // l'avventura pronta parte con la sua scena d'apertura
    const regole = c.regole === '3.5' ? 'D&D 3.5 (System Reference Document 3.5)' : 'D&D 5ª edizione (SRD 5.1)';
    const istr = `Sei il Dungeon Master di una partita di Dungeons & Dragons giocata online da amici italiani. Parli in italiano, con voce narrante coinvolgente ma concisa: le tue parole vengono lette ad alta voce.
Regolamento: ${regole}. Applicalo correttamente (prove, CD, tiri salvezza, attacchi, danni). Ambientazione scelta: ${c.ambientazione}.
Tieni conto dell'aspetto dei personaggi (altezza, peso, corporatura) quando conta davvero: passaggi stretti, essere notati, sollevare o spingere.
Ruolo: descrivi scene, interpreta i PNG (dai loro un nome e un modo di parlare riconoscibile; chi è già in png_incontrati tiene sempre lo stesso nome, e il campo "png" è il nome con cui lo presenti nel testo), chiedi i tiri di dado quando servono con abilità e CD, applica le conseguenze, mantieni il mondo coerente con la memoria della campagna. Sii proattivo: i PNG agiscono e il mondo va avanti anche senza i giocatori.
Se il gruppo non è ancora in nessun luogo, fai partire l'avventura con un evento "luogo". Evita gli inizi scontati (taverna sotto la pioggia, locandiere nano, incarico da un vecchio misterioso): parti nel mezzo di una situazione originale legata all'ambientazione e alla stagione.
Varia il linguaggio: non ripetere immagini, aggettivi o battute già presenti in ultimi_eventi.
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
{"tipo":"scena","azione":"sposta|rompi|brucia|togli|aggiungi","oggetto":"<id oggetto di scena>","tipoOggetto":"botte|cassa|tavolo|...","nome":"...","x":n,"y":n} (oggetti visibili sulla mappa: usalo quando un oggetto viene spostato, rotto, bruciato, preso o compare; per "aggiungi" servono tipoOggetto, x, y)
{"tipo":"illustra","prompt":"English description of the scene for a realistic image, max 60 words, no names","didascalia":"didascalia italiana breve"} (solo nei momenti davvero memorabili: un mostro che appare, un colpo di scena, un luogo spettacolare; al massimo una volta ogni tanto)
{"tipo":"negozio","nome":"Bottega di Bruna","merci":[{"nome":"Pozione di guarigione","prezzo":50}]} (apre il banco di un mercante: i giocatori comprano e vendono dall'app con le loro monete; prezzi in monete d'oro; {"tipo":"negozio","chiudi":true} quando escono)
{"tipo":"tiro","pg":"<id>","prova":"Percezione","cd":15}
{"tipo":"nemico","nome":"Goblin","x":n,"y":n,"pf":7,"ca":15} (segnalino sulla mappa, griglia ${W}x${H})
{"tipo":"combattimento","azione":"inizia|prossimo|fine"} (inizia quando scoppia uno scontro: l'app tira l'iniziativa e gestisce i turni; "prossimo" quando un PNG o nemico ha finito il suo turno; "fine" quando lo scontro è finito)
{"tipo":"danno_nemico","nemico":"<id del segnalino>","quantita":n}
{"tipo":"png","nome":"Oste Bruno","x":n,"y":n} (mette sulla mappa un personaggio non giocante che è in scena; con "via":true lo toglie quando se ne va)
{"tipo":"bottino","oro":n,"oggetti":["..."]} (va nel tesoro comune del gruppo)
{"tipo":"fazione","nome":"Gilda dei Ladri","descrizione":"..."} (nuova fazione) e {"tipo":"reputazione","fazione":"...","delta":n,"motivo":"..."} (da -100 a +100: i PNG delle fazioni trattano il gruppo di conseguenza)
{"tipo":"tempo","giorni":n,"ora":0-23,"stagione":"primavera|estate|autunno|inverno","meteo":"sereno|nuvoloso|pioggia|temporale|neve|nebbia"} (quando passa il tempo o cambia il tempo atmosferico: la mappa mostra luce del giorno, notte, ombre del sole, pioggia, neve e nebbia; tieni coerenti ora e meteo con la narrazione)
{"tipo":"valuta","nome":"Corone di Argentea","cambio":0.5} (valuta locale e quanto vale in monete d'oro) e {"tipo":"valuta_pg","pg":"<id>","valuta":"...","quantita":n}
Durante il combattimento rispetta l'ordine di iniziativa e gioca tu i turni dei nemici quando tocca a loro.${c.solitaria ? `
PARTITA IN SOLITARIA: c'è un solo giocatore. Interpreti anche i suoi compagni alleati (${COMPAGNI.map(x => x.nome + ': ' + x.carattere).join('; ')}): falli parlare con la loro personalità, agire e combattere nel loro turno (descrivi le azioni e usa danno_nemico per i loro colpi), senza rubare la scena al giocatore. Dai qualche suggerimento in più su cosa si può fare e rispondi sempre subito.` : ''}${avv ? `
AVVENTURA PRONTA "${AVVENTURE[avv.id].titolo}": seguila (trovi scene, segreti e scena attuale in "avventura"), ma lascia libertà ai giocatori e adattala alle loro scelte. Quando il gruppo arriva alla scena successiva usa {"tipo":"avventura","scena":"<id della scena>"}: l'app li porta nel luogo e mette i nemici della scena; poi tu decidi se e quando inizia il combattimento.` : ''}`;
    const contesto = {
      avventura: avv ? { titolo: AVVENTURE[avv.id].titolo, sinossi: AVVENTURE[avv.id].sinossi, scena_attuale: AVVENTURE[avv.id].scene[avv.scena]?.id, scene: AVVENTURE[avv.id].scene.map(x => ({ id: x.id, luogo: x.luogo, obiettivo: x.obiettivo, png: x.png, indizi: x.indizi, incontro: x.incontro?.map(n => `${n.numero} ${n.nome}`).join(', ') || null, tesoro: x.tesoro || null })), segreti: AVVENTURE[avv.id].segreti, ricompensa: AVVENTURE[avv.id].ricompensa } : undefined,
      memoria_campagna: memoria || '(inizio della campagna)',
      luogo_attuale: luogo ? { nome: luogo.nome, tipo: luogo.tipo, edifici: luogo.edifici.map(e => ({ id: e.id, nome: e.nome, stato: e.stato })), oggetti_di_scena: (luogo.oggetti || []).slice(0, 60).map(o => ({ id: o.id, tipo: o.nome || o.tipo, x: o.x, y: o.y, stato: o.stato !== 'integro' ? o.stato : undefined })), storia: (luogo.storia || []).slice(-8) } : null,
      luoghi_conosciuti: Object.values(luoghi).map(l => l.nome),
      personaggi: pgs,
      nemici_sulla_mappa: Object.entries(await this.get('segnalini', {})).filter(([, s2]) => s2.tipo === 'nemico').map(([id, s2]) => ({ id, nome: s2.nome, x: s2.x, y: s2.y, pf: s2.pf, ca: s2.ca })),
      combattimento: await this.get('combattimento', null),
      tesoro_del_gruppo: await this.get('gruppo', null),
      stagione_reale: stagione(),
      calendario_di_gioco: (await this.get('mondo', {}))?.calendario || null,
      fazioni_e_reputazione: (await this.get('mondo', {}))?.fazioni || {},
      valute_locali: (await this.get('mondo', {}))?.valute || {},
      relazioni_tra_personaggi: await this.get('relazioni', {}),
      png_incontrati: Object.entries(await this.get('png', {})).map(([nome, p]) => ({ nome, luogo: p.luogo })),
      ultimi_eventi: diario.map(d => `[${d.tipo}] ${d.testo}`)
    };
    const r = await this.g({
      systemInstruction: { parts: [{ text: istr }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(contesto) }] }],
      generationConfig: { temperature: 0.85, responseMimeType: 'application/json' }
    });
    if (!r.ok) { this.tutti({ t: 'errore', msg: r.status === 429 ? 'Il master AI ha finito la quota gratuita di oggi: riprova più tardi o passate al master umano' : `il master AI non risponde (${r.status}), riprova tra poco` }); return; }
    const j = await r.json();
    const out = leggiJSON(j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    if (!out) return;
    const narr = testo(out.narrazione, 1500).trim();
    for (const e of (Array.isArray(out.eventi) ? out.eventi.slice(0, 12) : [])) { try { await this.applicaEvento(e); } catch {} }
    const nomePng = testo(out.png, 40).trim();
    if (narr && nomePng) { // memoria dei PNG: lo stesso personaggio non cambia nome tra un turno e l'altro
      const png = await this.get('png', {});
      png[nomePng] = { luogo: luogo?.nome || png[nomePng]?.luogo || null, t: Date.now() };
      const nomi = Object.keys(png).sort((a, b) => png[b].t - png[a].t).slice(0, 40); // shortcut: solo gli ultimi 40, la memoria lunga li riassume
      await this.put('png', Object.fromEntries(nomi.map(n => [n, png[n]])));
    }
    if (narr) {
      const ev = await this.diario('narrazione', narr, 'master');
      this.tutti({ t: 'narra', testo: ev.testo, png: testo(out.png, 40), chi: 'master', modello: r.modello });
      if (nomePng) this.ctx.waitUntil(this.disegnaVolto(nomePng));
    } else this.tutti({ t: 'master_zitto' });
  }

  async applicaEvento(e) {
    if (!e || typeof e !== 'object') return;
    const pgMod = async (id, fn, nota) => {
      const p = await this.get('pg:' + id); if (!p) return;
      const primaPf = { pf: p.pf };
      fn(p); await this.put('pg:' + id, p);
      await this.contaPf(id, primaPf, p);
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
      case 'scena': return this.scena('master', true, { azione: e.azione, oggetto: e.oggetto, tipo: e.oggetto_tipo || e.tipoOggetto, nome: e.nome, x: e.x, y: e.y });
      case 'avventura': return this.scenaAvventura(e.scena);
      case 'negozio': if (e.chiudi) { await this.put('negozio', null); return this.tutti({ t: 'negozio', negozio: null }); } return this.apriNegozio(e);
      case 'illustra': this.ctx.waitUntil(e.prompt ? this.illustra(testo(e.prompt, 600), testo(e.didascalia, 200)) : this.illustraScena()); return;
      case 'tiro': { const p = await this.get('pg:' + e.pg); this.tutti({ t: 'richiesta_tiro', pg: e.pg, prova: testo(e.prova, 40), cd: e.cd | 0, nome: p?.nome }); return; }
      case 'reputazione': case 'fazione': {
        const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); const f = testo(e.fazione || e.nome, 40); if (!f) return;
        const prima = mo.fazioni[f]?.reputazione || 0;
        mo.fazioni[f] = { reputazione: Math.max(-100, Math.min(100, prima + (Number(e.delta) || 0))), descrizione: testo(e.descrizione, 200) || mo.fazioni[f]?.descrizione || '' };
        await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo });
        if (e.delta) { const ev = await this.diario('mondo', `Reputazione con ${f}: ${e.delta > 0 ? '+' : ''}${e.delta}${e.motivo ? ' (' + testo(e.motivo, 80) + ')' : ''}.`, 'master'); this.tutti({ t: 'diario', ev }); }
        return;
      }
      case 'tempo': { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); const cal = mo.calendario || { giorno: 1, stagione: 'primavera' }; cal.giorno += Math.max(0, Math.min(365, Number(e.giorni) || 0)); if (['primavera', 'estate', 'autunno', 'inverno'].includes(e.stagione)) cal.stagione = e.stagione; if (e.ora !== undefined && e.ora !== null && e.ora !== '') cal.ora = Math.max(0, Math.min(23, Number(e.ora) | 0)); if (['sereno', 'nuvoloso', 'pioggia', 'temporale', 'neve', 'nebbia'].includes(e.meteo)) cal.meteo = e.meteo; mo.calendario = cal; await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); return; }
      case 'valuta': { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); const v = testo(e.nome, 40); if (!v) return; mo.valute[v] = { cambio: Math.max(0.001, Number(e.cambio) || 1) }; await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); return; }
      case 'valuta_pg': return pgMod(e.pg, p => { p.valute = { ...(p.valute || {}), [testo(e.valuta, 40)]: Math.max(0, (p.valute?.[e.valuta] || 0) + (Number(e.quantita) || 0)) }; }, `${Number(e.quantita) >= 0 ? 'ottiene' : 'spende'} ${Math.abs(Number(e.quantita) || 0)} ${testo(e.valuta, 40)}`);
      case 'combattimento': return this.combattimento('master', { nome: 'Master' }, true, { azione: ['inizia', 'prossimo', 'fine'].includes(e.azione) ? e.azione : 'inizia' });
      case 'bottino': { if (e.oro) await this.gruppo('master', { nome: 'Il master' }, { op: 'oro', delta: Number(e.oro) || 0 }); for (const o of (Array.isArray(e.oggetti) ? e.oggetti.slice(0, 6) : [])) await this.gruppo('master', { nome: 'Il master' }, { op: 'oggetto', nome: String(o), qta: 1 }); return; }
      case 'danno_nemico': {
        const seg = await this.get('segnalini', {}); const s2 = seg[e.nemico]; if (!s2) return;
        s2.pf = (s2.pf ?? 10) - n;
        if (s2.pf <= 0) { await this.conta('gruppo', { nemici: 1 }); delete seg[e.nemico]; const c = await this.get('combattimento'); if (c?.attivo) await this.combattimento('master', {}, true, { azione: 'togli', id: e.nemico }); const ev = await this.diario('combattimento', `${s2.nome} è sconfitto.`, 'master'); this.tutti({ t: 'diario', ev }); }
        await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg }); return;
      }
      case 'png': return e.via ? this.segnalino('master', true, { id: 'p_' + testo(e.nome, 20).replace(/\W+/g, '_'), rimuovi: true }) : this.segnalino('master', true, { id: 'p_' + testo(e.nome, 20).replace(/\W+/g, '_'), x: e.x, y: e.y, nome: testo(e.nome, 40), colore: '#bfae86', tipo: 'png' });
      case 'nemico': this.ctx.waitUntil(this.disegnaMostro(e.nome)); return this.segnalino('master', true, { id: 'n_' + testo(e.nome, 20).replace(/\W+/g, '_') + '_' + (e.x | 0) + '_' + (e.y | 0), x: e.x, y: e.y, nome: e.nome, colore: '#d84b3c', tipo: 'nemico', pf: Number(e.pf) || undefined, ca: Number(e.ca) || undefined });
    }
  }

  // Tra una sessione e l'altra il mondo va avanti: ricostruzioni, notizie, fazioni
  async evolviMondo(manuale) {
    const c = await this.get('campagna'); if (c.masterTipo !== 'ai' && !manuale) return;
    const [memoria, idx, mo] = await Promise.all([this.get('memoria', ''), this.get('luoghi', {}), this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] })]);
    const luoghi = [];
    for (const id of Object.keys(idx).slice(-15)) { const l = await this.get('luogo:' + id); if (l) luoghi.push({ id, nome: l.nome, edifici: l.edifici.map(e => ({ id: e.id, nome: e.nome, stato: e.stato })) }); }
    if (!luoghi.length && !memoria) return;
    const r = await this.g({ contents: [{ parts: [{ text: `Sei il master di una campagna di D&D (${c.ambientazione}). Tra una sessione e l'altra il mondo va avanti da solo. In base a memoria, luoghi e fazioni decidi cosa è cambiato: edifici ricostruiti o danneggiati, chi governa, nuove voci, reputazione delle fazioni. Sii coerente e moderato (2-5 cambiamenti).
Memoria: ${memoria || '(poca)'}
Luoghi: ${JSON.stringify(luoghi)}
Fazioni: ${JSON.stringify(mo.fazioni)}
Rispondi SOLO JSON: {"notizie":"testo di massimo 80 parole da leggere ad alta voce, come un banditore","edifici":[{"luogo":"<id>","edificio":"<id>","stato":"integro|danneggiato|bruciato|distrutto"}],"fazioni":[{"nome":"...","delta":n}]}` }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }, 'mondo');
    if (!r.ok) return;
    const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    if (!out) return;
    for (const e of (out.edifici || []).slice(0, 6)) await this.modificaLuogo('master', {}, true, { luogo: e.luogo, edificio: e.edificio, stato: e.stato });
    for (const f of (out.fazioni || []).slice(0, 4)) await this.applicaEvento({ tipo: 'reputazione', fazione: f.nome, delta: f.delta, motivo: 'tra una sessione e l\'altra' });
    if (out.notizie) {
      const m2 = await this.get('mondo', mo); m2.notizie = [...(m2.notizie || []), { t: Date.now(), sessione: c.sessione, testo: testo(out.notizie, 800) }].slice(-30); await this.put('mondo', m2); this.tutti({ t: 'mondo', mondo: m2 });
      const ev = await this.diario('narrazione', 'Notizie dal mondo: ' + out.notizie, 'master');
      this.tutti({ t: 'narra', testo: ev.testo, png: 'Il banditore', chi: 'master' });
    }
  }

  // Entrare in un edificio: interno generato una volta (stanze e descrizione dall'IA gratuita di Cloudflare, ripiego su Gemini)
  async entraEdificio(io, me, edId) {
    const pid = await this.get('luogoAttuale'); const padre = await this.get('luogo:' + pid); if (!padre) return;
    const ed = padre.edifici.find(e => e.id === edId); if (!ed) return;
    if (ed.stato === 'distrutto') { const ev = await this.diario('luogo', `${ed.nome} è solo macerie: non si può entrare.`, io); return this.tutti({ t: 'diario', ev }); }
    const nome = `${ed.nome} di ${padre.nome}`.slice(0, 60);
    const id = chiaveLuogo(nome);
    if (!await this.get('luogo:' + id)) {
      const c = await this.get('campagna');
      const tipo = /locanda|taverna|osteria/i.test(ed.nome) ? 'taverna' : 'interno';
      let info = null;
      const domanda = `Ambientazione D&D: ${c.ambientazione}. Descrivi l'interno di "${ed.nome}" nel luogo "${padre.nome}"${ed.stato !== 'integro' ? ' (' + ed.stato + ')' : ''}. Rispondi SOLO JSON: {"descrizione":"massimo 60 parole in italiano, da leggere ad alta voce","stanze":["nome stanza 1", "... fino a 6 nomi brevi in italiano"],"png":"nome e ruolo di chi si trova dentro, o vuoto"}`;
      if (this.env.AI) { try { const o = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: domanda }], max_tokens: 400 }); info = leggiJSON(o?.response || ''); if (info) info.da = 'cloudflare'; } catch {} }
      if (!info) { const r = await this.g({ contents: [{ parts: [{ text: domanda }] }], generationConfig: { temperature: 0.8, responseMimeType: 'application/json' } }, 'interni'); if (r.ok) { info = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''); if (info) info.da = 'gemini'; } }
      const stanze = Array.isArray(info?.stanze) && info.stanze.length ? info.stanze.map(x => testo(x, 30)) : ['Ingresso', 'Sala', 'Magazzino', 'Stanza privata', 'Cucina', 'Retro'];
      const l = generaLuogo(nome, tipo, c.creata + ':' + id, stanze);
      l.genitore = pid; l.descrizione = testo(info?.descrizione, 600); l.png = testo(info?.png, 60); l.generatoDa = info?.da || 'nessuna IA';
      await this.put('luogo:' + id, l);
      const idx = await this.get('luoghi', {}); idx[id] = { nome, tipo, prima: Date.now(), interno: true }; await this.put('luoghi', idx);
    }
    await this.vai(io, me, nome);
    const l = await this.get('luogo:' + id);
    if (l.descrizione && l.visite <= 1) { const ev = await this.diario('narrazione', l.descrizione, 'master'); this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master' }); }
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
// per 10 minuti si riparte dall'ultimo modello che ha risposto (gli altri possono essere esauriti o lenti)
const BUONI = {};
async function chiamaGemini(env, corpo, leggero) {
  if (!env.GEMINI_KEY) return { ok: false, status: 503 };
  // maestro: modello migliore; allievo (compiti leggeri): Flash-Lite, più veloce e con più quota gratuita
  // ogni modello ha la sua quota gratuita: se uno è esaurito (429) o ritirato (404) si passa al successivo
  const LITE = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], FLASH = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
  const buono = BUONI[leggero ? 'lite' : 'pieno'], recente = buono && Date.now() - buono.t < 600000 ? [buono.modello] : [];
  const modelli = [...new Set(leggero ? [...recente, ...LITE, ...FLASH] : [...recente, env.GEMINI_MODEL || 'gemini-flash-latest', ...FLASH, ...LITE])];
  let r, peggiore = null; const inizio = Date.now(), tentativi = [];
  for (const modello of modelli) {
    const url = `${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(modello)}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`;
    // un modello che pensa troppo a lungo (fino a 524 dopo 100 s) blocca il turno: dopo 30 s si passa al successivo
    if (Date.now() - inizio > 70000) break;
    const invia = c => { const t = Date.now(); return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c), signal: AbortSignal.timeout(30000) }).catch(() => new Response('{}', { status: 504 })).then(x => { tentativi.push({ modello, ms: Date.now() - t, stato: x.status, pensiero: c.generationConfig?.thinkingConfig ? JSON.stringify(c.generationConfig.thinkingConfig) : 'pieno' }); return x; }); };
    r = await invia({ ...corpo, generationConfig: { ...corpo.generationConfig, thinkingConfig: { thinkingBudget: 0 } } });
    // Gemini 3 non accetta thinkingBudget 0: si prova il ragionamento minimo prima di quello pieno (lento, ~24 s per turno)
    if (r.status === 400) r = await invia({ ...corpo, generationConfig: { ...corpo.generationConfig, thinkingConfig: { thinkingLevel: 'minimal' } } });
    if (r.status === 400) r = await invia(corpo);
    if (![404, 429, 500, 502, 503, 504, 524].includes(r.status)) { r.modello = modello; r.tentativi = tentativi; if (r.ok) BUONI[leggero ? 'lite' : 'pieno'] = { modello, t: Date.now() }; return r; }
    if (r.status !== 404) peggiore = r; // un 404 (modello ritirato) non deve nascondere la quota finita
  }
  return peggiore || r;
}
// Voce naturale: Gemini TTS (modelli più nuovi prima). Il PCM a 24 kHz diventa WAV a 16 kHz (più leggero da scaricare).
const VOCI_PNG = ['Algenib', 'Fenrir', 'Puck', 'Kore', 'Leda', 'Orus', 'Aoede', 'Enceladus', 'Gacrux', 'Umbriel', 'Zephyr', 'Iapetus'];
export async function sintesiVocale(env, testoV, png) {
  if (!env.GEMINI_KEY) return null;
  const h = [...String(png || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const voceNome = png ? VOCI_PNG[h % VOCI_PNG.length] : (env.VOCE_NARRATORE || 'Charon');
  const stile = png ? `Recita in italiano dando voce a ${png}, con il tono adatto al personaggio:` : 'Leggi in italiano come il narratore di un\'avventura fantasy, con voce calda, espressiva e coinvolgente:';
  const corpo = { contents: [{ parts: [{ text: `${stile}\n${testo(testoV, 1500)}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voceNome } } } } };
  for (const modello of [...new Set([env.GEMINI_TTS, 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))]) {
    const r = await fetch(`${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${modello}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    if (!r.ok) { if ([400, 404, 429, 500, 503].includes(r.status)) continue; return null; }
    const parte = (await r.json()).candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!parte) continue;
    const rate = Number(parte.inlineData.mimeType?.match(/rate=(\d+)/)?.[1]) || 24000;
    const bin = Uint8Array.from(atob(parte.inlineData.data), c => c.charCodeAt(0));
    return wav16k(new Int16Array(bin.buffer, 0, bin.length >> 1), rate);
  }
  return null;
}
export function wav16k(pcm, rate) {
  const fuori = 16000, n = Math.floor(pcm.length * fuori / rate), dati = new Int16Array(n);
  for (let i = 0; i < n; i++) { const x = i * rate / fuori, k = Math.floor(x), f = x - k; dati[i] = (pcm[k] || 0) * (1 - f) + (pcm[k + 1] ?? pcm[k] ?? 0) * f; }
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), scrivi = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  scrivi(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); scrivi(8, 'WAVE'); scrivi(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, fuori, true); v.setUint32(28, fuori * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); scrivi(36, 'data'); v.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(dati);
  return buf;
}
// Illustrazioni: FLUX.1 schnell su Workers AI (quota gratuita di Cloudflare). IMG_FINTA nelle prove.
const SCENE_EN = { citta: 'a bustling medieval fantasy city with stone houses, cobblestone streets and market stalls', villaggio: 'a small medieval fantasy village with thatched cottages and dirt roads', porto: 'a medieval fantasy harbor with wooden docks, ships and warehouses', taverna: 'the cozy interior of a medieval fantasy tavern with a roaring fireplace, wooden tables and patrons', dungeon: 'a dark ancient dungeon with stone corridors lit by flickering torches', grotta: 'a vast natural cave with stalagmites, glowing mushrooms and underground pools', castello: 'a mighty medieval castle with towers, banners and a courtyard', foresta: 'a dense ancient forest with towering trees, mist and a winding path', interno: 'the interior of a medieval fantasy building with furniture and candlelight', aperto: 'open medieval fantasy countryside with rolling hills and a dirt road' };
// Compagni della partita in solitaria, interpretati dal master AI
export const COMPAGNI = [
  { id: 'a_mira', nome: 'Mira la ranger', carattere: 'elfa silenziosa e pratica, ottima con l\'arco, diffida delle città', pf: 13, ca: 14 },
  { id: 'a_tobia', nome: 'Fra\' Tobia il chierico', carattere: 'umano chiacchierone e goloso, cura le ferite e cita proverbi', pf: 12, ca: 16 }
];
// Avventure pronte (testi originali)
export const AVVENTURE = {
  miniera: {
    titolo: 'La miniera dei goblin',
    sinossi: 'Da una settimana la miniera di Pietrarossa è caduta in mano ai goblin del capo Rugnak: i minatori sono fuggiti, uno di loro (Brann, un nano) è prigioniero e il villaggio rischia la fame. La sindaca Gerlinda offre una ricompensa a chi libera la miniera. Avventura per personaggi di livello 1-3, da giocare in una serata.',
    fazioni: [{ nome: 'Goblin di Rugnak', reputazione: -60, descrizione: 'banda di goblin guidata dall\'hobgoblin Rugnak, occupa la miniera di Pietrarossa' }, { nome: 'Villaggio di Pietrarossa', reputazione: 10, descrizione: 'minatori e contadini, spaventati ma ospitali' }],
    segreti: ['Rugnak non è il vero capo: prende ordini da un bugbear, Grumsh, che vuole usare la miniera come covo per razziare la valle.', 'Brann ha scoperto una vena d\'argento: per questo i goblin lo tengono vivo e lo fanno scavare.', 'Il vecchio Ulrico, il fabbro del villaggio, vende di nascosto chiodi e lanterne ai goblin in cambio di argento: se scoperto, chiede di non dirlo alla sindaca.', 'Nel bosco i goblin hanno lasciato un carretto rovesciato con le loro tracce: porta dritto all\'ingresso secondario della miniera, che evita le trappole.'],
    ricompensa: '50 monete d\'oro a testa dalla sindaca Gerlinda, il martello magico di Brann (arma +1) e 300 PX a personaggio; l\'argento della vena, se diviso con il villaggio, rende il gruppo benvoluto per sempre.',
    scene: [
      { id: 'villaggio', luogo: 'Villaggio di Pietrarossa', tipo: 'villaggio', obiettivo: 'Il gruppo arriva al villaggio, sente le voci sui goblin e viene mandato dalla sindaca.', png: 'Gerlinda la sindaca (energica, stanca, onesta); bambini che giocano ai goblin', indizi: 'carri vuoti, botteghe chiuse, i minatori bevono nella taverna invece di lavorare',
        leggi: 'La strada sale tra campi di segale fino a Pietrarossa, un villaggio di case basse con i tetti di ardesia, aggrappato alla montagna. Dovrebbe essere ora di lavoro, eppure i carri dei minatori sono fermi e vuoti, e le botteghe hanno le imposte chiuse. Una bambina vi fissa da dietro un recinto, poi corre via gridando: "Altri forestieri! Forse questi i goblin li ammazzano davvero!"' },
      { id: 'taverna', luogo: 'Taverna del Mulo Stanco', tipo: 'taverna', obiettivo: 'La sindaca offre l\'incarico; i minatori raccontano della miniera, delle trappole all\'ingresso principale e di Brann prigioniero.', png: 'Tobia l\'oste (gentile, pauroso); Gerlinda la sindaca; Hilde, minatrice ferita che conosce la miniera', indizi: 'Hilde disegna una mappa sommaria: ingresso principale con trappole, un ingresso secondario nel Bosco dei Corvi che solo i goblin usano',
        leggi: 'Nella Taverna del Mulo Stanco il fuoco è acceso ma nessuno ride. Una dozzina di minatori fissa i boccali in silenzio. Dietro il bancone, l\'oste Tobia vi saluta con un sorriso che vorrebbe essere allegro. Al tavolo vicino al camino una donna robusta con la fascia da sindaca si alza in piedi: "Se siete qui per lavorare, ho un lavoro da offrirvi. Pagato bene."' },
      { id: 'bosco', luogo: 'Bosco dei Corvi', tipo: 'foresta', obiettivo: 'Seguendo le tracce dei goblin il gruppo trova il carretto rovesciato e due lupi addestrati dai goblin.', png: 'nessuno: corvi che gracchiano', indizi: 'carretto rovesciato con sacchi di grano rubati e impronte piccole che portano all\'ingresso secondario della miniera',
        incontro: [{ nome: 'Lupo', numero: 2, gs: '1/4', pf: 11, ca: 13 }],
        leggi: 'Il Bosco dei Corvi merita il suo nome: centinaia di uccelli neri gracchiano dai rami, e tacciono di colpo al vostro passaggio. Sul sentiero, un carretto è rovesciato su un fianco, i sacchi di grano squarciati. Tutt\'intorno, piccole impronte di piedi nudi. E poi un ringhio basso, tra i cespugli.' },
      { id: 'miniera', luogo: 'Miniera di Pietrarossa', tipo: 'dungeon', obiettivo: 'Il gruppo entra nella miniera (dall\'ingresso principale con le trappole o da quello secondario), affronta le sentinelle goblin e trova Brann incatenato.', png: 'Brann il minatore nano (prigioniero, testardo, grato); goblin sentinelle che litigano tra loro', indizi: 'Brann racconta della vena d\'argento e che Rugnak ha paura di qualcuno più grosso nella sala in fondo',
        incontro: [{ nome: 'Goblin', numero: 4, gs: '1/4', pf: 7, ca: 15 }],
        leggi: 'L\'aria della miniera sa di ferro e di fumo. Le travi di sostegno scricchiolano sopra le vostre teste, e da qualche parte più in basso arriva un rumore regolare di picconi, accompagnato da risate stridule. Una torcia, piantata male nella roccia, illumina quattro figure piccole e verdi che giocano a dadi con delle ossa.' },
      { id: 'boss', luogo: 'Sala profonda della miniera', tipo: 'grotta', obiettivo: 'Scontro finale con Rugnak e il suo padrone, il bugbear Grumsh, vicino alla vena d\'argento. Poi il ritorno al villaggio e la ricompensa.', png: 'Rugnak l\'hobgoblin (arrogante, vigliacco quando perde); Grumsh il bugbear (silenzioso, brutale)', indizi: 'se Rugnak viene risparmiato tradisce Grumsh',
        incontro: [{ nome: 'Rugnak l\'hobgoblin', numero: 1, gs: '1/2', pf: 22, ca: 18 }, { nome: 'Grumsh il bugbear', numero: 1, gs: '1', pf: 27, ca: 16 }],
        tesoro: '150 monete d\'oro, 2 pozioni di guarigione, il martello di Brann (arma +1), un sacco di argento grezzo (200 mo)',
        leggi: 'La galleria si apre in una caverna enorme. Sulle pareti, una lunga vena scintillante riflette la luce di un braciere: argento, tanto argento. Davanti al braciere, un hobgoblin con un elmo troppo grande sbraita ordini. Ma è l\'ombra alle sue spalle a farvi gelare il sangue: qualcosa di grosso, peloso, che si alza lentamente impugnando una mazza chiodata.' }
    ]
  }
};
// Trofei della serata: a chi ha il numero più alto in ogni voce (almeno 1)
const TROFEI = [['critici', 'Mano d\'oro', n => `${n} colpi critici`], ['fallimenti', 'Nato sotto una cattiva stella', n => `${n} fallimenti critici`], ['danniSubiti', 'Muro vivente', n => `${n} danni incassati`], ['cadute', 'Bacio del pavimento', n => n === 1 ? 'a terra una volta' : `a terra ${n} volte`], ['cure', 'Pellaccia', n => `${n} punti ferita recuperati`], ['speso', 'Spendaccione', n => `${n} monete spese`], ['tiri', 'Lanciatore instancabile', n => `${n} dadi tirati`]];
export function trofei(s, nomi) {
  const out = [];
  for (const [campo, titolo, motivo] of TROFEI) {
    const [chi, v] = Object.entries(s || {}).filter(([id]) => id !== 'gruppo').map(([id, o]) => [id, o[campo] || 0]).sort((a, b) => b[1] - a[1])[0] || [];
    if (chi && v > 0) out.push({ titolo, chi: nomi[chi] || chi, motivo: motivo(v) });
  }
  return out;
}
// Cataloghi dei negozi (prezzi dell'SRD 5.1 in monete d'oro, arrotondati)
export const CATALOGHI = {
  emporio: [['Razioni (1 giorno)', 1], ['Corda (15 m)', 1], ['Torcia', 1], ['Zaino', 2], ['Otre', 1], ['Sacco a pelo', 1], ['Lanterna', 5], ['Olio (ampolla)', 1], ['Kit da guaritore', 5], ['Acciarino', 1], ['Chiodi da rocciatore (10)', 1], ['Rampino', 2]],
  fabbro: [['Pugnale', 2], ['Spada corta', 10], ['Spada lunga', 15], ['Ascia da battaglia', 10], ['Mazza', 5], ['Martello da guerra', 15], ['Lancia', 1], ['Arco corto', 25], ['Frecce (20)', 1], ['Scudo', 10], ['Armatura di cuoio', 10], ['Camicia di maglia', 50], ['Cotta di maglia', 75], ['Elmo', 10]],
  alchimista: [['Pozione di guarigione', 50], ['Antidoto', 50], ["Fuoco dell'alchimista", 50], ['Acqua santa', 25], ['Pozione di guarigione superiore', 150], ['Erbe medicinali', 5]],
  magia: [['Pergamena di Dardo incantato', 50], ['Pergamena di Cura ferite', 50], ['Pergamena di Scudo', 50], ['Bacchetta (focus arcano)', 10], ['Simbolo sacro', 5], ['Amuleto', 5], ['Libro degli incantesimi', 50]]
};
for (const k of Object.keys(CATALOGHI)) CATALOGHI[k] = CATALOGHI[k].map(([nome, prezzo]) => ({ nome, prezzo }));
export function tipoNegozio(nome) { const n = String(nome).toLowerCase(); return /fabbr|armaiol|armi|forgia/.test(n) ? 'fabbro' : /alchim|erbor|speziale|pozion|guaritor/.test(n) ? 'alchimista' : /mago|arcan|magic|incant|tempio/.test(n) ? 'magia' : 'emporio'; }
export function prezzoBase(nome) { for (const c of Object.values(CATALOGHI)) { const x = c.find(m => m.nome.toLowerCase() === String(nome).toLowerCase()); if (x) return x.prezzo; } return /pozione|pergamena/i.test(nome) ? 50 : /spada|ascia|martello|arco/i.test(nome) ? 10 : 2; }
// PX per personaggio per livello (facile, media, difficile, mortale) — SRD 5.1
export const SOGLIE_PX = [[25, 50, 75, 100], [50, 100, 150, 200], [75, 150, 225, 400], [125, 250, 375, 500], [250, 500, 750, 1100], [300, 600, 900, 1400], [350, 750, 1100, 1700], [450, 900, 1400, 2100], [550, 1100, 1600, 2400], [600, 1200, 1900, 2800], [800, 1600, 2400, 3600], [1000, 2000, 3000, 4500], [1100, 2200, 3400, 5100], [1250, 2500, 3800, 5700], [1400, 2800, 4300, 6400], [1600, 3200, 4800, 7200], [2000, 3900, 5900, 8800], [2100, 4200, 6300, 9500], [2400, 4900, 7300, 10900], [2800, 5700, 8500, 12700]];
const BESTIARIO = [['Bandito', '1/8', 25, 11, 12], ['Goblin', '1/4', 50, 7, 15], ['Lupo', '1/4', 50, 11, 13], ['Scheletro', '1/4', 50, 13, 13], ['Zombi', '1/4', 50, 22, 8], ['Orco', '1/2', 100, 15, 13], ['Hobgoblin', '1/2', 100, 11, 18], ['Gnoll', '1/2', 100, 22, 15], ['Bugbear', '1', 200, 27, 16], ['Lupo crudele', '1', 200, 37, 14], ['Ragno gigante', '1', 200, 26, 14], ['Ogre', '2', 450, 59, 11], ['Ghoul', '1', 200, 22, 12], ['Orsogufo', '3', 700, 59, 13], ['Troll', '5', 1800, 84, 15], ['Giovane drago verde', '8', 3900, 136, 18], ['Giovane drago rosso', '10', 5900, 178, 18]];
export function incontroCasuale(budget) {
  const adatti = BESTIARIO.filter(b => b[2] <= budget); const b = adatti.length ? adatti[Math.floor(Math.random() * adatti.length)] : BESTIARIO[0];
  const numero = Math.max(1, Math.min(8, Math.floor(budget / (b[2] * 1.5))));
  return [{ nome: b[0], numero, gs: b[1], pf: b[3], ca: b[4] }];
}
const d = n => 1 + Math.floor(Math.random() * n);
export function tesoroCasuale(gs) {
  const fascia = gs <= 4 ? 0 : gs <= 10 ? 1 : gs <= 16 ? 2 : 3;
  const oro = [() => (d(6) + d(6)) * 10, () => (d(6) + d(6) + d(6)) * 50, () => (d(6) + d(6) + d(6) + d(6)) * 250, () => (d(6) + d(6) + d(6) + d(6) + d(6)) * 1000][fascia]();
  const gemme = [['Agata', 10], ['Ematite', 10], ['Corniola', 50], ['Onice', 50], ['Ambra', 100], ['Perla nera', 500], ['Smeraldo', 1000], ['Diamante', 5000]];
  const magici = [['Pozione di guarigione', 'comune'], ['Pergamena di Dardo incantato', 'comune'], ['Pozione di arrampicata', 'comune'], ['Pozione di guarigione superiore', 'non comune'], ['Borsa conservante', 'non comune'], ['Arma +1', 'non comune'], ['Mantello di protezione', 'non comune'], ['Anello di protezione', 'raro'], ['Arma +2', 'raro'], ['Bacchetta delle palle di fuoco', 'raro']];
  const oggetti = [];
  for (let i = 0; i < d(2 + fascia); i++) { const g = gemme[Math.min(gemme.length - 1, Math.floor(Math.random() * (3 + fascia * 2)))]; oggetti.push(`${g[0]} (${g[1]} mo)`); }
  for (let i = 0; i < (Math.random() < 0.5 + fascia * 0.15 ? d(1 + fascia) : 0); i++) { const m = magici[Math.min(magici.length - 1, Math.floor(Math.random() * (4 + fascia * 2)))]; oggetti.push(`${m[0]} (${m[1]})`); }
  return { oro, oggetti };
}
export function pngCasuale() {
  const p = a => a[Math.floor(Math.random() * a.length)];
  return { nome: p(['Bruna', 'Aldo', 'Gerlinda', 'Tobia', 'Mirella', 'Corrado', 'Isotta', 'Brenno', 'Fiamma', 'Ulrico']) + ' ' + p(['Ventofreddo', 'Pietrascura', 'dal Molino', 'Mezzaluna', 'Barbagrigia', 'Corvonero']), razza: p(['umana', 'umano', 'nano', 'elfa', 'halfling', 'mezzorco', 'gnoma']), mestiere: p(['locandiere', 'fabbra', 'guardia', 'mercante', 'erborista', 'barcaiolo', 'sacerdotessa', 'cacciatore']), aspetto: p(['cicatrice sul sopracciglio', 'mani macchiate di inchiostro', 'grembiule sempre sporco', 'occhi chiarissimi', 'denti d\'oro']), tratto: p(['parla a voce bassissima', 'ride per niente', 'diffida degli stranieri', 'esagera ogni storia', 'conta sempre le monete']), segreto: p(['deve soldi alla gilda dei ladri', 'è una spia del barone', 'nasconde un fratello ricercato', 'ha visto il mostro della palude', 'è di sangue nobile']), battuta: p(['"Non è un buon momento per fare domande."', '"Se pagate, parlo."', '"Siete nuovi da queste parti, eh?"', '"Ho una storia per voi, ma vi costerà."']) };
}
// "Goblin 2", "goblin arciere" -> "goblin arciere"; umanoidi e orchi usano le figure LPC
export const UMANOIDI = /bandit|brigant|guardi|soldat|cultist|mago|strega|ladro|assassin|cavalier|mercenar|predon|pirat|negromant|sacerdot|capitan|stregon|goblin|orco|orchi|hobgoblin|bugbear|drow|elfo oscuro/;
export function nomeMostro(n) { return testo(n, 40).toLowerCase().replace(/[^a-zà-ù ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
export async function generaImmagine(env, prompt, piccola) {
  const stile = 'Realistic cinematic fantasy illustration, Dungeons and Dragons, dramatic volumetric lighting, highly detailed, painterly realism, no text, no watermark. ';
  if (env.IMG_FINTA) return Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='), c => c.charCodeAt(0));
  const errori = []; let errore = null;
  if (env.AI) {
    try { const r = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: piccola ? prompt : stile + prompt, steps: piccola ? 4 : 6 }); if (r?.image) return Uint8Array.from(atob(r.image), c => c.charCodeAt(0)); }
    catch (e) { errori.push(String(e.message || e).slice(0, 90)); } // es. 4006: finiti i 10.000 neuroni gratuiti del giorno (condivisi con le altre app)
  }
  // riserva 1: Hugging Face. Prima lo Space gratuito di FLUX schnell (quota GPU gratuita del tuo account,
  // come fa KindredNest), poi i fornitori a crediti del router se un giorno ce ne saranno.
  if (env.HF_TOKEN) {
    const testoHF = (piccola ? '' : stile) + prompt, lato = piccola ? 512 : 768, auth = { Authorization: `Bearer ${env.HF_TOKEN}` };
    for (const base of ['https://black-forest-labs-flux-1-schnell.hf.space']) {
      try {
        const avvio = await fetch(base + '/gradio_api/call/infer', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [testoHF, 0, true, lato, lato, 4] }), signal: AbortSignal.timeout(20000) });
        if (!avvio.ok) { errori.push(`HF spazio ${avvio.status} ${(await avvio.text()).slice(0, 80)}`); continue; }
        const evento = (await avvio.json()).event_id;
        const flusso = await (await fetch(`${base}/gradio_api/call/infer/${evento}`, { headers: auth, signal: AbortSignal.timeout(90000) })).text();
        const fatto = flusso.split(/\n\n+/).find(b => /^event: complete/m.test(b));
        if (!fatto) { errori.push('HF spazio: ' + flusso.replace(/\s+/g, ' ').slice(0, 120)); continue; }
        const ris = JSON.parse(fatto.split('\n').filter(r => r.startsWith('data:')).map(r => r.slice(5)).join(''));
        const f = Array.isArray(ris) ? ris[0] : null, link = f?.url || (f?.path ? `${base}/gradio_api/file=${f.path}` : null);
        const im = link && await fetch(link, { headers: auth });
        if (im?.ok) return new Uint8Array(await im.arrayBuffer());
        errori.push('HF spazio: immagine non scaricabile');
      } catch (e) { errori.push('HF spazio ' + String(e.message || e).slice(0, 60)); }
    }
    try {
      const r = await fetch('https://router.huggingface.co/fal-ai/fal-ai/flux/schnell', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: testoHF, image_size: piccola ? 'square' : 'square_hd', num_inference_steps: 4 }), signal: AbortSignal.timeout(60000) });
      if (r.ok) { const j = await r.json(), link = j.images?.[0]?.url; const im = link && await fetch(link); if (im?.ok) return new Uint8Array(await im.arrayBuffer()); errori.push('HF fal: risposta senza immagine'); }
      else errori.push(`HF fal ${r.status}`);
    } catch (e) { errori.push('HF fal ' + String(e.message || e).slice(0, 60)); }
  }
  // riserva 2: i modelli immagine di Gemini, con la sua quota separata
  for (const modello of env.GEMINI_KEY ? ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'] : []) {
    try {
      const r = await fetch(`${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${modello}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: (piccola ? '' : stile) + prompt + (piccola ? '' : ' Square image.') }] }], generationConfig: { responseModalities: ['IMAGE'] } }), signal: AbortSignal.timeout(60000) });
      if (!r.ok) { errori.push(`${modello} ${r.status}`); continue; }
      const dati = (await r.json()).candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      if (dati) return Uint8Array.from(atob(dati), c => c.charCodeAt(0));
    } catch (e) { errore = e; }
  }
  if (errori.length) throw new Error(errori.join(' | '));
  return null;
}
// Eventi stagionali del mondo reale: il master li intreccia nella storia se ha senso
function stagione() {
  const d = new Date(), m = d.getUTCMonth() + 1, g = d.getUTCDate();
  const ev = (m === 10 && g >= 20) || (m === 11 && g <= 2) ? 'notte delle ombre (Halloween): spiriti, maschere, zucche intagliate' : m === 12 || (m === 1 && g <= 6) ? 'feste d\'inverno (Natale): neve, luci, doni, banchetti' : m === 2 ? 'carnevale: maschere, scherzi, feste in piazza' : m === 8 && g >= 10 && g <= 20 ? 'Ferragosto: fiere d\'estate e caldo torrido' : null;
  return { mese: m, stagione: m <= 2 || m === 12 ? 'inverno' : m <= 5 ? 'primavera' : m <= 8 ? 'estate' : 'autunno', evento: ev };
}
// Maestro con Claude (facoltativo: solo se è impostato il segreto ANTHROPIC_KEY). Risponde nello stesso formato di Gemini.
async function chiamaClaude(env, corpo) {
  try {
    const sistema = corpo.systemInstruction?.parts?.map(p => p.text).join('\n') || '';
    const utente = corpo.contents?.map(c => c.parts.map(p => p.text || '').join('\n')).join('\n') || '';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system: sistema + '\nRispondi solo con il JSON richiesto.', messages: [{ role: 'user', content: utente }] }) });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const testoR = j.content?.map(c => c.text || '').join('') || '';
    const finto = { candidates: [{ content: { parts: [{ text: testoR }] } }], usageMetadata: { promptTokenCount: j.usage?.input_tokens || 0, candidatesTokenCount: j.usage?.output_tokens || 0 } };
    const risposta = { ok: true, status: 200, modello: j.model || 'claude', json: async () => finto };
    risposta.clone = () => risposta;
    return risposta;
  } catch { return { ok: false, status: 502 }; }
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
    if (R() < 0.7) casa(ri(4, W - 10), ri(2, 5), 5, 4, 'Casolare');
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
export const ARREDI_V = 2;
export const PASSABILI = ['tappeto', 'ragnatela', 'ossa', 'funghi', 'macerie', 'torcia', 'candelabro'];
export const DUE_CASELLE = ['letto', 'carretto', 'tronco', 'bancarella', 'barca'];
export function celleOggetto(o) { return DUE_CASELLE.includes(o.tipo) ? [[o.x, o.y], o.dir === 'v' ? [o.x, o.y + 1] : [o.x + 1, o.y]] : [[o.x, o.y]]; }
const ESTERNI = ['citta', 'villaggio', 'porto', 'foresta', 'aperto', 'castello'];
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
