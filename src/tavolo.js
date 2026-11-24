// Tavolo d'Avventura: una stanza di gioco D&D online (Durable Object, una per campagna).
// Tiene lo stato persistente (membri, schede, luoghi e mappe, dadi, diario, memoria del master)
// e fa da ponte per la voce (segnalazione WebRTC) e per il master AI (Gemini, chiave solo qui).
import { DurableObject } from 'cloudflare:workers';
import { codiceCasuale, sha, testo } from './tavolo-util.js';
import { INCONTRI_VIAGGIO, dataGioco, STAGIONI, COMPAGNI_ANIMALI, STANZE_BASE, MESTIERI, RICETTE, SEGRETI, senzaRegia, TIPI_EVENTO, TATTICHE, RISERVA, PROMEMORIA, b64url, COPIA, PER_SPETTATORI, SILENZIO, REAZIONI, MAZZO, DIFFICOLTA, LINGUE, SUONI, ATTESA_MASTER, SCENE_EN, COMPAGNI, AVVENTURE, trofei, CATALOGHI, tipoNegozio, prezzoBase, SOGLIE_PX, incontroCasuale, tesoroCasuale, pngCasuale, UMANOIDI, nomeMostro, stagione, tiraFormula, RARI } from './tavolo-dati.js';
import { chiamaGemini, sintesiVocale, STILE_IMG, STILI_IMG, generaImmagine, chiamaClaude, leggiJSON } from './tavolo-ai.js';
import { chiaveLuogo, indovinaTipo, W, H, generaLuogo, ARREDI_V, griglia, vicine, percorso, vede, MOVIBILI, celleArea } from './tavolo-mappe.js';
export * from './tavolo-util.js';
export * from './tavolo-dati.js';
export * from './tavolo-ai.js';
export * from './tavolo-mappe.js';

const ORIGINI = ['https://vincenzociriello91-hub.github.io', 'http://localhost:8765'];
const MAX_MSG = 400000; // le immagini disegnate dal telefono (riserva) arrivano fino a ~300 KB

export async function apriTavolo(req, env, codice) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('serve websocket', { status: 426 });
  if (!ORIGINI.includes(req.headers.get('Origin') || '')) return new Response('origine', { status: 403 });
  const id = env.TAVOLO.idFromName(codice.toUpperCase());
  return env.TAVOLO.get(id).fetch(req);
}

const COLORI = ['#e8b04b', '#5b8fd9', '#c97bd0', '#6cc08a', '#e2735f', '#4fc3c8', '#d9d36b', '#a98be8'];

export class Tavolo extends DurableObject {
  reazioni = new Map(); traduzioni = new Map(); raffica = new Map(); // in memoria: si azzerano quando la stanza dorme
  async fetch(req) {
    if (req.method === 'POST' && req.headers.get('x-tavolo-interno') === '1') return this.interno(await req.json());
    const md = new URL(req.url).pathname.match(/\/media\/(voce|img)\/([a-z0-9]{4,30})$/);
    if (req.method === 'GET' && md) {
      const dati = md[1] === 'voce' ? this.voci?.get(md[2]) : await this.ctx.storage.get('img:' + md[2]);
      if (!dati) return new Response('non pronto', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
      return new Response(dati, { headers: { 'Content-Type': md[1] === 'voce' ? 'audio/wav' : 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }
    if (req.method === 'GET' && /\/avviso$/.test(new URL(req.url).pathname)) { const a = await this.get('ultimoAvviso', null); return new Response(JSON.stringify({ tipo: a && Date.now() - a.t < 600000 ? a.tipo : null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }); }
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
  // riserva finale: un telefono del tavolo disegna con un servizio gratuito e manda l'immagine (vale per scene, riepiloghi, volti e mostri)
  chiediDisegno(prompt, dati) { const id = 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1000); this.daDisegnare = { ...(this.daDisegnare?.id ? {} : this.daDisegnare || {}), [id]: { ...dati, t: Date.now() } }; this.tutti({ t: 'disegna_tu', id, prompt, piccola: dati.scopo !== 'scena' }); }
  async illustra(prompt, didascalia, forza, vera, extra) {
    try {
      const oggi = new Date().toISOString().slice(0, 10), q = await this.get('quotaImmagini', { giorno: oggi, n: 0, ultima: 0 });
      if (q.giorno !== oggi) { q.giorno = oggi; q.n = 0; }
      if (q.n >= 40 || (!forza && Date.now() - q.ultima < 120000)) return null; // al massimo 40 al giorno, una ogni 2 minuti
      q.n++; q.ultima = Date.now(); await this.put('quotaImmagini', q);
      const prova = (await this.get('campagna'))?.prova; // partita bot: non consuma i crediti gratuiti delle immagini
      const stile = STILI_IMG[(await this.get('campagna'))?.stileImg] || STILE_IMG; this.stileOra = stile;
      const jpeg = await generaImmagine(prova ? { ...this.env, IMG_FINTA: 1 } : this.env, prompt, prova, stile);
      if (!jpeg) throw new Error('nessun servizio immagini ha risposto');
      return await this.salvaIllustrazione(jpeg, didascalia);
    } catch (e) {
      this.erroreImg = String(e?.message || e).slice(0, 700); console.error('illustra', this.erroreImg);
      // riserva finale: chiede a un telefono del tavolo di disegnarla (servizio gratuito dal suo collegamento) e di mandarla qui
      if (forza || vera) { this.chiediDisegno((this.stileOra || STILE_IMG) + prompt, { scopo: 'scena', didascalia, ...(extra || {}) }); this.erroreImg = 'riserva'; }
      return null;
    }
  }
  async salvaIllustrazione(jpeg, didascalia) {
    {
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
    }
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
Scrivi anche, per ogni personaggio, una pagina del suo diario personale in prima persona (massimo 70 parole, con la sua voce e il suo punto di vista sulla serata). Personaggi: ${(await Promise.all(Object.keys(await this.get('membri', {})).map(async id => { const p = await this.get('pg:' + id); return p ? `${id}=${p.nome} (${p.razza} ${p.classe})` : null; }))).filter(Boolean).join('; ')}
Rispondi SOLO JSON: {"titolo":"...","racconto":"...","prompt":"...","diari":{"<id personaggio>":"pagina di diario"}}
Memoria della campagna: ${memoria || '(nessuna)'}
Eventi della serata:\n${ev.slice(-120).map(d => `[${d.tipo}] ${d.testo}`).join('\n')}` }] }], generationConfig: { temperature: 0.8, responseMimeType: 'application/json' } }, 'master');
    if (!r.ok) return this.tutti({ t: 'errore', msg: 'Riepilogo non disponibile ora' });
    const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') || {};
    stats.trofei = (await this.statistiche()).trofei;
    const rie = { t: Date.now(), titolo: testo(out.titolo, 100) || `Sessione ${stats.sessione}`, racconto: testo(out.racconto, 1800), stats, img: null };
    for (const [id, pagina] of Object.entries(out.diari && typeof out.diari === 'object' ? out.diari : {})) {
      const p = await this.get('pg:' + id); if (!p || !pagina) continue;
      p.diario = [...(p.diario || []), { t: rie.t, sessione: stats.sessione, titolo: rie.titolo, testo: testo(pagina, 700) }].slice(-30);
      await this.put('pg:' + id, p); this.tutti({ t: 'scheda', per: id, pg: p });
    }
    rie.img = out.prompt ? await this.illustra(testo(out.prompt, 600), rie.titolo, true, false, { riepilogo: rie.t }) : null;
    const elenco = await this.get('riepiloghi', []); elenco.push(rie); await this.put('riepiloghi', elenco.slice(-30));
    const d = await this.get('diario', []); d.push({ t: rie.t, tipo: 'riepilogo', testo: rie.titolo, chi: 'master', riepilogo: rie.t }); while (d.length > 400) d.shift(); await this.put('diario', d);
    this.tutti({ t: 'riepilogo', r: rie });
    this.tutti({ t: 'diario', ev: d[d.length - 1] });
    if (rie.racconto) this.tutti({ t: 'narra', testo: rie.racconto, chi: 'master', riassunto: true });
  }

  // ---------- mostri disegnati e volti dei PNG: generati una volta per campagna, poi salvati ----------
  async immagineSalvata(prompt, quotaChiave, max, riserva) {
    const oggi = new Date().toISOString().slice(0, 10), q = await this.get(quotaChiave, { giorno: oggi, n: 0 });
    if (q.giorno !== oggi) { q.giorno = oggi; q.n = 0; }
    if (q.n >= max) return null;
    q.n++; await this.put(quotaChiave, q);
    const prova = (await this.get('campagna'))?.prova;
    const jpeg = await generaImmagine(prova ? { ...this.env, IMG_FINTA: 1 } : this.env, prompt, true).catch(() => null);
    if (!jpeg) { if (riserva && !prova) this.chiediDisegno(prompt, riserva); return null; }
    const id = 'i' + Date.now().toString(36) + Math.floor(Math.random() * 100);
    await this.ctx.storage.put('img:' + id, jpeg);
    return id;
  }
  async disegnaMostro(nome, desc) {
    const chiave = nomeMostro(nome); if (!chiave || (UMANOIDI.test(chiave) && !desc)) return;
    const mostri = await this.get('mostri', {}); if (mostri[chiave] || this.inCorso?.has('m:' + chiave)) return;
    (this.inCorso = this.inCorso || new Set()).add('m:' + chiave);
    try {
      const id = await this.immagineSalvata(`pixel art sprite of a ${chiave}${desc ? ` (${String(desc).slice(0, 160)})` : ''} (fantasy monster from Dungeons and Dragons), one single creature, full body, side view facing right, 16-bit detailed RPG game asset, centered, on a plain flat pure white background, no ground, no shadow, no text`, 'quotaMostri', 25, { scopo: 'mostro', chiave });
      if (!id) return;
      const m2 = await this.get('mostri', {}); m2[chiave] = id; await this.put('mostri', m2);
      this.tutti({ t: 'mostri', mostri: m2 });
    } finally { this.inCorso.delete('m:' + chiave); }
  }
  // ritratto illustrato del personaggio, dalla sua scheda (razza, classe, aspetto, equipaggiamento), nello stile della campagna
  async ritrattoPg(ws, io, me, capo, m) {
    const per = m.per && capo ? String(m.per) : io; if (me.ruolo === 'spettatore') return;
    const p = await this.get('pg:' + per); if (!p) return;
    if (this.inCorso?.has('r:' + per)) return; (this.inCorso = this.inCorso || new Set()).add('r:' + per);
    try {
      const a = p.aspetto || {}, ind = (p.equip || []).filter(e => e.indossato).map(e => e.nome).slice(0, 5).join(', ');
      const r = await this.g({ contents: [{ parts: [{ text: `Describe in English, max 45 words, the look of this D&D player character for a portrait painting (face, hair, build, clothes and gear, expression). Only the description.\n${JSON.stringify({ nome: p.nome, razza: p.razza, classe: p.classe, livello: p.livello, allineamento: p.allineamento, aspetto: a, equipaggiamento: ind, storia: p.storia ? String(p.storia).slice(0, 300) : undefined })}` }] }], generationConfig: { temperature: 0.7 } });
      const desc = r.ok ? ((await r.json()).candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '').trim().slice(0, 400) : '';
      const stile = STILI_IMG[(await this.get('campagna'))?.stileImg] || STILE_IMG;
      const id = await this.immagineSalvata(`${stile}Portrait, head and shoulders, of ${desc || `a ${p.razza} ${p.classe}`}, Dungeons and Dragons hero, highly detailed face, dark simple background`, 'quotaRitratti', 12);
      if (!id) return this.invia(ws, { t: 'avviso', msg: 'Oggi i ritratti sono finiti o il servizio delle immagini non risponde: riprova domani', errore: true });
      const p2 = await this.get('pg:' + per); if (!p2) return; const vecchio = p2.ritratto; p2.ritratto = id; await this.put('pg:' + per, p2);
      if (vecchio && /^i[a-z0-9]+$/.test(vecchio)) await this.ctx.storage.delete('img:' + vecchio);
      this.tutti({ t: 'scheda', per, pg: p2, nota: 'ha un nuovo ritratto', da: io });
    } finally { this.inCorso.delete('r:' + per); }
  }
  async disegnaVolto(png) {
    const nome = testo(png, 40).trim(); if (!nome || /banditore/i.test(nome)) return;
    const volti = await this.get('volti', {}); if (volti[nome] || this.inCorso?.has('v:' + nome)) return;
    (this.inCorso = this.inCorso || new Set()).add('v:' + nome);
    try {
      const diario = await this.get('diario', []), recenti = diario.filter(d => d.tipo === 'narrazione').slice(-2).map(d => d.testo).join('\n');
      const r = await this.g({ contents: [{ parts: [{ text: `Describe in English, max 40 words, the face and look of the D&D character "${nome}" for a portrait painting (age, race, hair, clothes, expression), consistent with this scene:\n${recenti}\nOnly the description.` }] }], generationConfig: { temperature: 0.7 } }, 'racconto');
      const desc = r.ok ? ((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim().slice(0, 400) : '';
      const id = await this.immagineSalvata(`realistic fantasy portrait painting, head and shoulders, ${desc || nome}, Dungeons and Dragons character, dramatic warm lighting, highly detailed face, painterly realism, dark background, no text`, 'quotaVolti', 25, { scopo: 'volto', chiave: nome });
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
    // anche mese per mese (ora italiana), per il riepilogo «il vostro mese»: si tengono gli ultimi 12
    const mese = new Date(Date.now() + 3600000).toISOString().slice(0, 7); st.m = st.m || {}; const om = (st.m[mese] = st.m[mese] || {})[chi] = st.m[mese][chi] || {}; for (const [campo, v] of Object.entries(campi)) om[campo] = (om[campo] || 0) + v;
    for (const k of Object.keys(st.m).sort().slice(0, -12)) delete st.m[k];
    await this.put('statistiche', st);
  }
  async contaPf(id, prima, dopo) {
    if (!prima || !dopo || prima.pf === dopo.pf) return;
    const d = (dopo.pf || 0) - (prima.pf || 0);
    await this.conta(id, d < 0 ? { danniSubiti: -d, ...(prima.pf > 0 && dopo.pf <= 0 ? { cadute: 1 } : {}) } : { cure: d });
  }
  // ---------- battute di riserva (come i Dialoghi dei Varchi): senza intelligenza artificiale, mai due volte uguali ----------
  async battutaDiRiserva(luogo, silenzio) {
    const png = await this.get('png', {}), qui = Object.entries(png).filter(([, p]) => p.luogo && p.luogo === luogo?.nome).map(([n]) => n);
    const tipo = luogo?.tipo || 'aperto', usate = await this.get('riserveUsate', []);
    const R = a => a[Math.floor(Math.random() * a.length)];
    let frase = '';
    for (let k = 0; k < 12; k++) {
      const scena = R(RISERVA.scena[tipo] || RISERVA.scena.aperto), invito = R(silenzio ? RISERVA.silenzio : RISERVA.invito), chi = qui.length && Math.random() < 0.6 ? R(qui) : null;
      frase = chi ? `${scena} ${chi} ${R(RISERVA.png)} ${invito}` : `${scena} ${invito}`;
      if (!usate.includes(frase)) break;
    }
    await this.put('riserveUsate', [...usate, frase].slice(-40));
    const ev = await this.diario('narrazione', frase, 'master');
    this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master', riserva: true });
  }
  // ---------- dungeon del giorno (come i Varchi): una discesa al giorno, ogni giorno più in basso, il custode che vince diventa nemesi ----------
  async dungeonDelGiorno(io) {
    const oggi = new Date().toISOString().slice(0, 10), d = await this.get('dungeonGiorno', { livello: 0, giorno: '' });
    if (d.giorno === oggi) return this.invia(this.wsDi(io), { t: 'errore', msg: 'Oggi siete già scesi: la prossima discesa si apre domani' });
    d.livello++; d.giorno = oggi;
    const nomi = ['Cripta di Ossanera', 'Rovine di Valtetra', 'Pozzi di Grimvalle', 'Catacombe del Re Muto', 'Antro delle Mille Voci', 'Segrete di Torrebruna', 'Abisso di Fumoscuro'];
    const giorno = Math.floor(Date.now() / 86400000), nome = `${nomi[giorno % nomi.length]}, livello ${d.livello}`;
    const membri = await this.get('membri', {}); let lv = 1; for (const id of Object.keys(membri)) lv = Math.max(lv, (await this.get('pg:' + id))?.livello || 1);
    const custodi = ['Il Custode d\'Ossa', 'La Sentinella di Pietra', 'Il Signore dei Vermi', 'La Strega del Pozzo', 'Il Cavaliere Senza Volto'];
    d.custode = custodi[(giorno + d.livello) % custodi.length]; d.luogo = nome;
    await this.put('dungeonGiorno', d);
    await this.vai(io, { nome: 'Master' }, nome, 'dungeon');
    const l = await this.get('luogo:' + await this.get('luogoAttuale')), sala = l?.edifici?.find(e => /boss/i.test(e.nome)) || l?.edifici?.slice(-1)[0];
    if (sala) await this.applicaEvento({ tipo: 'nemico', nome: d.custode, x: sala.x + Math.floor(sala.w / 2), y: sala.y + Math.floor(sala.h / 2), pf: 20 + lv * 8 + d.livello * 4, ca: 13 + Math.min(5, Math.floor((lv + d.livello) / 3)) });
    await this.annuncia(`Discesa del giorno: ${nome}. In fondo vi aspetta ${d.custode}. Se vi sconfigge, si ricorderà di voi.`);
  }
  // ---------- tattiche del gruppo: i nemici intelligenti e la nemesi si adattano (come i nemici dei Varchi) ----------
  async notaTattica(frase) {
    const trovate = Object.entries(TATTICHE).filter(([, re]) => re.test(frase)).map(([k]) => k); if (!trovate.length) return;
    const t = await this.get('tattiche', {}); for (const k of trovate) t[k] = (t[k] || 0) + 1; await this.put('tattiche', t);
  }
  // ---------- manuale di esperienza del master (come il bot di Minecraft: impara dagli errori, mai due volte lo stesso) ----------
  async manuale(azione, dati = {}) {
    try { const r = await this.env.TAVOLO.get(this.env.TAVOLO.idFromName('__MANUALE__')).fetch('https://tavolo/interno', { method: 'POST', headers: { 'x-tavolo-interno': '1' }, body: JSON.stringify({ azione, ...dati }) }); return await r.json(); } catch { return null; }
  }
  async lezioniMaster() {
    if (this.cacheManuale && Date.now() - this.cacheManuale.t < 600000) return this.cacheManuale.lezioni;
    const man = await this.manuale('manuale_leggi'); const lezioni = (man?.lezioni || []).slice(0, 15).map(l => l.testo);
    this.cacheManuale = { t: Date.now(), lezioni }; return lezioni;
  }
  async impara(lezioni, problemi) { if (lezioni?.length || problemi?.length) await this.manuale('manuale_aggiungi', { lezioni, problemi, da: (await this.get('campagna'))?.prova ? 'partita bot' : 'partita' }); }
  // dagli ultimi eventi: cosa può fare meglio il master in generale (lezioni valide per tutte le campagne)
  async estraiLezioni(diario) {
    const r = await this.g({ contents: [{ parts: [{ text: `Sei l'allenatore di un master AI di D&D. Dagli eventi di una partita estrai da 0 a 3 lezioni GENERALI per fare meglio il master la prossima volta: regole applicate male, giocatori che correggono il master o si lamentano, momenti confusi o noiosi, PNG che cambiano nome, eventi rifiutati dall'app. Niente nomi di questa campagna. Se non c'è niente da imparare rispondi con un elenco vuoto.\\nEventi:\\n${diario.slice(-60).map(d => `[${d.tipo}] ${d.testo}`).join('\\n').slice(0, 9000)}\\nRispondi SOLO JSON: {"lezioni":["..."]}` }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }, 'memoria');
    if (!r.ok) return; const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    await this.impara((out?.lezioni || []).filter(x => typeof x === 'string').slice(0, 3), []);
  }
  // master proattivo: se il tavolo tace da qualche minuto fa succedere qualcosa (al massimo due volte di fila)
  async controllaSilenzio() {
    const c = await this.get('campagna'); if (c?.masterTipo !== 'ai' || c.differito) return this.prossimoControllo(); // a distanza il master non riempie i silenzi: aspetta le mosse
    const membri = await this.get('membri', {}), online = this.online().filter(x => membri[x]?.ruolo === 'giocatore');
    if (!online.length) return this.prossimoControllo();
    const diario = await this.get('diario', []), ultimo = diario[diario.length - 1]?.t || 0;
    const dopoGiocatori = diario.slice(diario.map(d => d.chi !== 'master' && ['chat', 'parlato', 'dado', 'comando'].includes(d.tipo)).lastIndexOf(true) + 1).filter(d => d.tipo === 'narrazione' && d.silenzio).length;
    if (Date.now() - ultimo >= SILENZIO && dopoGiocatori < 2 && !(await this.get('masterInAttesa', false))) { this.silenzio = true; await this.programmaMaster(true); return; }
    await this.prossimoControllo();
  }
  async prossimoControllo() {
    const a = await this.ctx.storage.getAlarm(), pross = await this.prossimoPromemoria();
    const membri = await this.get('membri', {}), qualcuno = this.online().some(x => membri[x]?.ruolo === 'giocatore');
    const quando = Math.min(qualcuno ? Date.now() + SILENZIO : Infinity, pross || Infinity, (await this.get('giroScade', 0)) || Infinity);
    if (quando !== Infinity && (!a || a > quando)) await this.ctx.storage.setAlarm(quando);
  }
  // ---------- promemoria delle serate come notifica sul telefono (Web Push senza contenuto: niente dati personali in giro) ----------
  async prossimoPromemoria() { const l = await this.get('serate', []); let min = 0; for (const x of l) for (const [k, dt] of PROMEMORIA) { const t = x.t - dt; if (!x.avvisi?.[k] && t > Date.now() - 3600000 && (!min || t < min)) min = Math.max(t, Date.now() + 1000); } return min; }
  async mandaPromemoria() {
    const l = await this.get('serate', []), iscritti = await this.get('push', {}); let cambiato = false;
    for (const x of l) for (const [k, dt] of PROMEMORIA) if (!x.avvisi?.[k] && Date.now() >= x.t - dt && Date.now() < x.t) {
      x.avvisi = { ...(x.avvisi || {}), [k]: true }; cambiato = true; await this.put('ultimoAvviso', { tipo: 'serata', t: Date.now() });
      for (const [id, sub] of Object.entries(iscritti)) if (x.risposte?.[id] !== false) { const ok = await this.webPush(sub); if (ok === 'via') { delete iscritti[id]; await this.put('push', iscritti); } }
    }
    if (cambiato) await this.put('serate', l);
  }
  // gioco a distanza: notifica «tocca a te» a chi deve ancora scrivere e non è collegato
  async avvisaTurno(ids) {
    const iscritti = await this.get('push', {}), on = this.online(); let cambiato = false, mandate = 0;
    for (const id of ids || []) { if (on.includes(id) || !iscritti[id]) continue; const ok = await this.webPush(iscritti[id]); if (ok === 'via') { delete iscritti[id]; cambiato = true; } else if (ok) mandate++; }
    if (cambiato) await this.put('push', iscritti);
    if (mandate) await this.put('ultimoAvviso', { tipo: 'turno', t: Date.now() });
    return mandate;
  }
  async webPush(endpoint) {
    try {
      const k = await this.manuale('vapid'); if (!k?.jwk) return false;
      const u = new URL(endpoint), enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
      const corpo = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://vincenzociriello91-hub.github.io/TavoloAvventura/' })}`;
      const chiave = await crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const firma = b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chiave, new TextEncoder().encode(corpo))));
      const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `vapid t=${corpo}.${firma}, k=${k.pub}`, TTL: '86400', Urgency: 'high', 'Content-Length': '0' } });
      return r.status === 404 || r.status === 410 ? 'via' : r.ok;
    } catch { return false; }
  }
  // ---------- serate, traduzioni, note sulla mappa, giochi di taverna ----------
  // calendario delle serate: il master propone, ognuno risponde ci sono / non ci sono (il promemoria lo mette il calendario del telefono)
  async serata(io, me, capo, m) {
    let l = (await this.get('serate', [])).filter(x => x.t > Date.now() - 86400000);
    if (m.t === 'serata_nuova') { if (!capo) return; const t = Date.parse(m.quando); if (!(t > Date.now() - 3600000)) return; l.push({ id: 's' + Date.now().toString(36), t, nota: testo(m.nota, 120), risposte: { [io]: true } }); l.sort((a, b) => a.t - b.t); l = l.slice(0, 12); await this.annuncia(`Prossima serata: ${new Date(t).toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${m.nota ? ' (' + testo(m.nota, 120) + ')' : ''}.`); }
    else if (m.t === 'serata_risposta') { const x = l.find(y => y.id === m.id); if (!x || me.ruolo === 'spettatore') return; x.risposte[io] = !!m.ci; }
    else { if (!capo) return; l = l.filter(y => y.id !== m.id); }
    await this.put('serate', l); this.tutti({ t: 'serate', serate: l }); await this.prossimoControllo();
  }
  async traduci(ws, m) {
    const lingua = LINGUE[m.lingua], t = testo(m.testo, 1500); if (!lingua || !t) return;
    const k = m.lingua + ':' + t; if (this.traduzioni.has(k)) return this.invia(ws, { t: 'traduzione', id: m.id, testo: this.traduzioni.get(k) });
    const r = await this.g({ contents: [{ parts: [{ text: `Traduci in ${lingua} questo testo di una partita di D&D, mantenendo nomi propri e tono. Rispondi solo con la traduzione.\n\n${t}` }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 900 } }, 'regole');
    if (!r.ok) return this.invia(ws, { t: 'traduzione', id: m.id, errore: true });
    const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (this.traduzioni.size > 300) this.traduzioni.clear(); this.traduzioni.set(k, out);
    this.invia(ws, { t: 'traduzione', id: m.id, testo: out });
  }
  // annotazioni dei giocatori sulla mappa del luogo (restano con il luogo)
  // lavagna: tratti a mano libera sulla mappa del luogo, in decimi di casella; ognuno toglie i suoi, il master tutti
  async disegno(io, me, capo, m) {
    const lid = await this.get('luogoAttuale'), luogo = lid && await this.get('luogo:' + lid); if (!luogo) return;
    let l = await this.get('disegni:' + lid, []);
    if (m.togli === 'tutti') l = capo ? [] : l.filter(d => d.chi !== io);
    else if (m.togli === 'ultimo') { const i = l.map(d => d.chi).lastIndexOf(io); if (i >= 0) l.splice(i, 1); }
    else {
      const punti = Array.isArray(m.punti) ? m.punti.slice(0, 160).map(p => [Math.max(0, Math.min(luogo.w * 10, Math.round(Number(p?.[0]) || 0))), Math.max(0, Math.min(luogo.h * 10, Math.round(Number(p?.[1]) || 0)))]) : [];
      if (punti.length < 2) return;
      l.push({ id: 'd' + Date.now().toString(36), chi: io, colore: /^#[0-9a-f]{6}$/i.test(m.colore || '') ? m.colore : me.colore || '#e8b04b', punti });
      l = l.slice(-40);
    }
    await this.put('disegni:' + lid, l); this.tutti({ t: 'disegni', luogo: lid, disegni: l });
  }
  async notaMappa(io, me, m) {
    const lid = await this.get('luogoAttuale'), luogo = lid && await this.get('luogo:' + lid); if (!luogo) return;
    let l = await this.get('note:' + lid, []);
    if (m.togli) { const capo = me.ruolo === 'master' || me.admin; l = l.filter(n => n.id !== m.togli || (n.chi !== io && !capo)); }
    else { const x = m.x | 0, y = m.y | 0, t = testo(m.testo, 80).trim(); if (!t || x < 0 || y < 0 || x >= luogo.w || y >= luogo.h) return; const p = await this.get('pg:' + io); l.push({ id: 'n' + Date.now().toString(36), x, y, testo: t, chi: io, nome: p?.nome || me.nome }); l = l.slice(-60); }
    await this.put('note:' + lid, l); this.tutti({ t: 'note_mappa', luogo: lid, note: l });
  }
  // giochi di taverna con le monete vere della scheda: dadi (2d6, vince il più alto) o carte (la carta più alta)
  async giocoTaverna(io, me, capo, m) {
    let g = await this.get('giocoTaverna', null); const paga = async (id, d) => { const p = await this.get('pg:' + id); if (!p) return false; if (d < 0 && (p.oro || 0) < -d) return false; p.oro = (p.oro || 0) + d; await this.put('pg:' + id, p); this.tutti({ t: 'scheda', per: id, pg: p }); return true; };
    if (m.t === 'gioco_apri') {
      if (g) return; const posta = Math.max(1, Math.min(100, m.posta | 0)), tipo = m.tipo === 'carte' ? 'carte' : 'dadi';
      if (!await paga(io, -posta)) return this.invia(this.wsDi(io), { t: 'errore', msg: `Servono ${posta} mo nella scheda per giocare` });
      g = { tipo, posta, da: io, giocatori: [io], t: Date.now() }; await this.annuncia(`${me.nome} apre un tavolo di ${tipo === 'dadi' ? 'dadi' : 'carte'}: posta ${posta} mo. Chi gioca?`, 'gruppo');
    } else if (m.t === 'gioco_entra') {
      if (!g || g.giocatori.includes(io) || g.giocatori.length >= 8) return;
      if (!await paga(io, -g.posta)) return this.invia(this.wsDi(io), { t: 'errore', msg: `Servono ${g.posta} mo nella scheda per giocare` });
      g.giocatori.push(io);
    } else if (m.t === 'gioco_annulla') {
      if (!g || (g.da !== io && !capo)) return; for (const id of g.giocatori) await paga(id, g.posta); g = null; await this.annuncia('Il tavolo da gioco si chiude: monete restituite.', 'gruppo');
    } else {
      if (!g || (g.da !== io && !capo) || g.giocatori.length < 2) return;
      const membri = await this.get('membri', {}), nomeDi = async id => (await this.get('pg:' + id))?.nome || membri[id]?.nome || '?';
      const VAL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Fante', 'Regina', 'Re', 'Asso'], SEMI = ['cuori', 'quadri', 'fiori', 'picche'], mazzo = [];
      for (let v = 0; v < 13; v++) for (const s2 of SEMI) mazzo.push({ v, s: s2 });
      const ris = [];
      for (const id of g.giocatori) {
        if (g.tipo === 'dadi') { const a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6); ris.push({ id, punti: a + b, testo: `${a}+${b}` }); }
        else { const c2 = mazzo.splice(Math.floor(Math.random() * mazzo.length), 1)[0]; ris.push({ id, punti: c2.v, testo: `${VAL[c2.v]} di ${c2.s}` }); }
      }
      const max = Math.max(...ris.map(r => r.punti)), vincitori = ris.filter(r => r.punti === max), piatto = g.posta * g.giocatori.length, quota = Math.floor(piatto / vincitori.length);
      for (const v of vincitori) await paga(v.id, quota);
      const righe = []; for (const r of ris) righe.push(`${await nomeDi(r.id)} ${r.testo}`);
      const nomiV = []; for (const v of vincitori) nomiV.push(await nomeDi(v.id));
      await this.annuncia(`${g.tipo === 'dadi' ? 'Dadi' : 'Carte'} sul tavolo: ${righe.join(', ')}. ${vincitori.length > 1 ? 'Pareggio tra ' + nomiV.join(' e ') + `: ${quota} mo a testa` : `Vince ${nomiV[0]}: ${quota} mo`}!`, 'gruppo');
      this.tutti({ t: 'suono', nome: 'monete' }); g = null;
    }
    await this.put('giocoTaverna', g); this.tutti({ t: 'gioco_taverna', gioco: g });
  }
  // ---------- mondo vivo: bacheca, voto, enigmi, nemesi, scelte, sogni, segreti, minacce, reputazione, compagni, casa, mestieri ----------
  async mondoVivo(vedeSegreti) {
    const [missioni, voto, enigma, nemesi, scelte, minacce, base, mo] = await Promise.all(['missioni', 'voto', 'enigma', 'nemesi', 'scelte', 'minacce', 'base', 'mondo'].map(k => this.get(k, null)));
    return { missioni: missioni || [], voto, enigma: enigma ? { ...enigma, risposta: vedeSegreti ? enigma.risposta : undefined } : null, nemesi, scelte: scelte || [], minacce: minacce || [], base, reputazioneLuoghi: mo?.reputazioneLuoghi || {}, catalogo: { ricette: RICETTE, stanze: STANZE_BASE, mestieri: MESTIERI, specie: Object.keys(COMPAGNI_ANIMALI) } };
  }
  async annuncia(testoEv, tipo = 'sistema') { const ev = await this.diario(tipo, testoEv); this.tutti({ t: 'diario', ev }); }
  async aggiornaMondo() { const per = { false: JSON.stringify({ t: 'mondo_vivo', ...(await this.mondoVivo(false)) }), true: JSON.stringify({ t: 'mondo_vivo', ...(await this.mondoVivo(true)) }) }; for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a?.membro) try { ws.send(per[!!a.vede]); } catch {} } }
  async eventoMondo(e) {
    const t = Date.now();
    switch (e.tipo) {
      case 'missione': { const l = await this.get('missioni', []), titolo = testo(e.titolo, 80); if (!titolo || l.some(x => x.titolo === titolo)) return; const oggi = (await this.get('mondo', {}))?.calendario?.giorno || 1, entro = Math.max(0, Math.min(120, Number(e.entro) || 0)); l.push({ id: 'q' + t.toString(36), titolo, descrizione: testo(e.descrizione, 300), ricompensa: testo(e.ricompensa, 80), stato: 'aperta', t, ...(entro ? { scadenza: oggi + entro } : {}) }); await this.put('missioni', l.slice(-12)); await this.annuncia(`Nuova missione sulla bacheca: ${titolo}.`); break; }
      case 'missione_fatta': { const l = await this.get('missioni', []), q = l.find(x => x.titolo === testo(e.titolo, 80)); if (!q) return; q.stato = 'completata'; await this.put('missioni', l); await this.annuncia(`Missione completata: ${q.titolo}!`); this.tutti({ t: 'suono', nome: 'vittoria' }); break; }
      case 'voto': { const opzioni = (Array.isArray(e.opzioni) ? e.opzioni : []).map(o => testo(o, 60)).filter(Boolean).slice(0, 4); if (opzioni.length < 2) return; await this.put('voto', { domanda: testo(e.domanda, 160), opzioni, voti: {}, t }); break; }
      case 'enigma': { if (!e.domanda || !e.risposta) return; await this.put('enigma', { domanda: testo(e.domanda, 400), risposta: testo(e.risposta, 60), indizio: testo(e.indizio, 160), tentativi: 0, t }); break; }
      case 'nemesi': { const n = await this.get('nemesi', null); await this.put('nemesi', { nome: testo(e.nome, 60) || n?.nome, descrizione: testo(e.descrizione, 300) || n?.descrizione, incontri: (n?.nome === e.nome ? n.incontri : 0) + 1, fughe: n?.fughe || 0, t }); break; }
      case 'nemesi_fuga': { const n = await this.get('nemesi', null); if (!n) return; n.fughe = (n.fughe || 0) + 1; n.ultimaFuga = testo(e.motivo, 160); await this.put('nemesi', n); await this.annuncia(`${n.nome} è fuggito... ma tornerà.`); break; }
      case 'scelta': { const l = await this.get('scelte', []); l.push({ descrizione: testo(e.descrizione, 200), peso: ['buona', 'cattiva', 'ambigua'].includes(e.peso) ? e.peso : 'ambigua', t }); await this.put('scelte', l.slice(-40)); break; }
      case 'sogno': { const p = await this.get('pg:' + e.pg); if (!p || !e.testo) return; p.sogni = [...(p.sogni || []), { testo: testo(e.testo, 500), t }].slice(-20); await this.put('pg:' + e.pg, p); this.invia(this.wsDi(e.pg), { t: 'sogno', testo: testo(e.testo, 500) }); return; }
      case 'segreto_fatto': { const p = await this.get('pg:' + e.pg); if (!p?.segreto || p.segreto.fatto) return; p.segreto.fatto = true; p.px = (p.px || 0) + 300; await this.put('pg:' + e.pg, p); this.invia(this.wsDi(e.pg), { t: 'scheda', per: e.pg, pg: p }); this.invia(this.wsDi(e.pg), { t: 'avviso', msg: 'Hai realizzato il tuo obiettivo segreto: +300 PX!' }); return; }
      case 'minaccia': { const l = await this.get('minacce', []), nome = testo(e.nome, 60); if (!nome) return; const x = l.find(m => m.nome === nome); if (x) x.livello = Math.min(5, x.livello + 1); else l.push({ nome, descrizione: testo(e.descrizione, 240), livello: 1, t }); await this.put('minacce', l.slice(-8)); break; }
      case 'minaccia_sventata': { const l = await this.get('minacce', []), x = l.find(m => m.nome === testo(e.nome, 60)); if (!x) return; x.sventata = true; await this.put('minacce', l); await this.annuncia(`Minaccia sventata: ${x.nome}.`); break; }
      case 'reputazione_luogo': { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }), luogo = testo(e.luogo, 60); if (!luogo) return; mo.reputazioneLuoghi = mo.reputazioneLuoghi || {}; mo.reputazioneLuoghi[luogo] = Math.max(-100, Math.min(100, (mo.reputazioneLuoghi[luogo] || 0) + (Number(e.delta) || 0))); await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); break; }
      case 'compagno': { const p = await this.get('pg:' + e.pg), sp = COMPAGNI_ANIMALI[e.specie]; if (!p || !sp) return; p.compagni = [...(p.compagni || []), { nome: testo(e.nome, 30) || e.specie, specie: e.specie, ...sp, pfMax: sp.pf }].slice(-3); await this.put('pg:' + e.pg, p); this.tutti({ t: 'scheda', per: e.pg, pg: p }); this.ctx.waitUntil(this.disegnaMostro(e.specie)); { const seg = await this.get('segnalini', {}), mio = seg[e.pg]; if (mio) { for (const k of Object.keys(seg)) if (k.startsWith(e.pg + '_c')) delete seg[k]; p.compagni.slice(-2).forEach((a, i) => { seg[`${e.pg}_c${i}`] = { x: mio.x, y: mio.y, nome: a.nome, tipo: 'alleato', animale: a.specie, padrone: e.pg, colore: mio.colore, pf: a.pf, ca: a.ca }; }); await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg }); } } await this.annuncia(`${p.nome} ha un nuovo compagno: ${testo(e.nome, 30) || e.specie} (${e.specie}).`); return; }
    }
    await this.aggiornaMondo();
  }
  async missioneAccetta(io, id) {
    const l = await this.get('missioni', []), q = l.find(x => x.id === id && x.stato === 'aperta'), p = await this.get('pg:' + io); if (!q) return;
    q.stato = 'accettata'; await this.put('missioni', l); await this.annuncia(`${p?.nome || 'Il gruppo'} accetta la missione: ${q.titolo}.`); await this.aggiornaMondo();
  }
  async vota(io, scelta) {
    const v = await this.get('voto', null); if (!v || !(scelta >= 0 && scelta < v.opzioni.length)) return;
    v.voti[io] = scelta; await this.put('voto', v);
    if (!await this.votoCompleto()) await this.aggiornaMondo();
  }
  // il voto si chiude quando hanno votato tutti i giocatori collegati: chi stasera non c'è (o è uscito) non lo blocca
  async votoCompleto() {
    const v = await this.get('voto', null); if (!v || !Object.keys(v.voti).length) return false;
    const membri = await this.get('membri', {}), qui = this.online().filter(id => membri[id]?.ruolo === 'giocatore');
    if (!qui.every(id => v.voti[id] !== undefined)) return false;
    await this.chiudiVoto(); return true;
  }
  async chiudiVoto() {
    const v = await this.get('voto', null); if (!v) return;
    const conta = v.opzioni.map((_, i) => Object.values(v.voti).filter(x => x === i).length), max = Math.max(...conta), vince = v.opzioni[conta.indexOf(max)];
    await this.put('voto', null); await this.annuncia(`Il gruppo ha votato "${v.domanda}": ${vince} (${conta.map((n, i) => `${v.opzioni[i]} ${n}`).join(', ')}).`, 'comando');
    await this.aggiornaMondo(); await this.programmaMaster(true);
  }
  async rispondiEnigma(io, me, risposta) {
    const en = await this.get('enigma', null); if (!en || !risposta.trim()) return;
    const norm = x => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\b(il|lo|la|i|gli|le|un|uno|una|l)\b/g, '').replace(/\s+/g, ' ').trim();
    const p = await this.get('pg:' + io), chi = p?.nome || me.nome;
    if (norm(risposta) && (norm(risposta) === norm(en.risposta) || norm(risposta).includes(norm(en.risposta)))) {
      await this.put('enigma', null); await this.annuncia(`${chi} risolve l'enigma: «${en.risposta}»!`, 'comando'); this.tutti({ t: 'suono', nome: 'successo' }); await this.aggiornaMondo(); return this.programmaMaster(true);
    }
    en.tentativi++; await this.put('enigma', en);
    await this.annuncia(`${chi} prova: «${testo(risposta, 60)}»... non è la risposta.${en.tentativi >= 3 && en.indizio ? ' Indizio: ' + en.indizio : ''}`);
    await this.aggiornaMondo();
  }
  async baseCompra(io, cosa) {
    const g = await this.get('gruppo', { oro: 0, oggetti: [] }), base = await this.get('base', null), p = await this.get('pg:' + io);
    const prezzo = !base ? 500 : STANZE_BASE[cosa]?.prezzo; if (!prezzo || (base && base.stanze.includes(cosa))) return;
    if ((g.oro || 0) < prezzo) return this.invia(this.wsDi(io), { t: 'errore', msg: `Servono ${prezzo} mo nel tesoro comune (ora ${g.oro || 0})` });
    g.oro -= prezzo; await this.put('gruppo', g); this.tutti({ t: 'gruppo', gruppo: g });
    if (!base) { await this.put('base', { nome: 'La casa del gruppo', stanze: [], t: Date.now() }); await this.annuncia(`${p?.nome || 'Il gruppo'} compra una casa per il gruppo (500 mo dal tesoro comune).`); }
    else { base.stanze.push(cosa); await this.put('base', base); await this.annuncia(`Nuova stanza nella casa del gruppo: ${STANZE_BASE[cosa].nome} (${STANZE_BASE[cosa].bonus}).`); }
    await this.aggiornaMondo();
  }
  async creaOggetto(ws, io, nomeRicetta) {
    const p = await this.get('pg:' + io), r = RICETTE.find(x => x.nome === nomeRicetta); if (!p || !r) return;
    const mancano = r.ingredienti.filter(i => !(p.equip || []).some(e => e.nome.toLowerCase().startsWith(i.toLowerCase())));
    if (mancano.length) return this.invia(ws, { t: 'errore', msg: `Mancano: ${mancano.join(', ')}` });
    if ((p.oro || 0) < r.costo) return this.invia(ws, { t: 'errore', msg: `Servono ${r.costo} mo` });
    const base = await this.get('base', null), sconto = base?.stanze.includes('laboratorio') ? 2 : 0;
    const bonus = Math.floor(((p.car?.[r.car] || 10) - 10) / 2) + (p.mestiere === r.mestiere ? 3 : 0) + sconto, tiro = 1 + Math.floor(Math.random() * 20), tot = tiro + bonus, ok = tot >= r.cd;
    for (const i of r.ingredienti) { const k = p.equip.findIndex(e => e.nome.toLowerCase().startsWith(i.toLowerCase())); if ((p.equip[k].qta || 1) > 1) p.equip[k].qta--; else p.equip.splice(k, 1); }
    p.oro -= r.costo;
    if (ok) { const es = p.equip.find(e => e.nome === r.risultato && !e.indossato); if (es) es.qta = (es.qta || 1) + 1; else p.equip.push({ nome: r.risultato, qta: 1, indossato: false }); }
    await this.put('pg:' + io, p); this.tutti({ t: 'scheda', per: io, pg: p });
    await this.annuncia(`${p.nome} prova a creare ${r.risultato}: ${tiro}${bonus >= 0 ? '+' : ''}${bonus} = ${tot} contro CD ${r.cd}: ${ok ? 'riuscito!' : 'fallito, ingredienti persi.'}`, 'scheda');
    if (ok) this.tutti({ t: 'suono', nome: 'pozione' });
  }
  // obiettivo segreto assegnato alla creazione del personaggio (lo sanno solo il giocatore e il master)
  segretoNuovo() { return { testo: SEGRETI[Math.floor(Math.random() * SEGRETI.length)], fatto: false }; }
  // le minacce ignorate crescono a ogni nuova sessione
  async minacceCrescono() { const l = await this.get('minacce', []); let su = 0; for (const m of l) if (!m.sventata && m.livello < 5) { m.livello++; su++; } if (su) { await this.put('minacce', l); await this.annuncia(`Mentre eravate lontani, ${su === 1 ? 'una minaccia è cresciuta' : su + ' minacce sono cresciute'}.`); } }
  // il mercante ambulante passa ogni tanto con oggetti rari diversi
  async forseMercante(luogo) { if (!luogo || ['dungeon', 'grotta'].includes(luogo.tipo) || Math.random() > 0.15 || await this.get('negozio')) return; const merci = [...RARI].sort(() => Math.random() - 0.5).slice(0, 5); await this.apriNegozio({ nome: 'Il mercante ambulante', merci }); await this.annuncia('Un mercante ambulante arriva con il suo carretto pieno di cose rare: oggi solo per poco.'); }
  // storia e famiglia del personaggio scritte con il master (dalle risposte del giocatore)
  async storia(io, m) {
    const pg = await this.get('pg:' + io); if (!pg) return;
    const campi = { origini: testo(m.origini, 200), famiglia: testo(m.famiglia, 300), segno: testo(m.segno, 150), sogno: testo(m.sogno, 150) };
    pg.famiglia = campi;
    const c = await this.get('campagna');
    const r = await this.g({ contents: [{ parts: [{ text: `Scrivi in italiano la storia di ${pg.nome}, ${pg.razza} ${pg.classe} in una campagna di D&D (${c.ambientazione}), in terza persona, massimo 120 parole, con un aggancio per l'avventura. Origini: ${campi.origini || '?'}. Famiglia (albero genealogico): ${campi.famiglia || '?'}. Segno particolare: ${campi.segno || '?'}. Cosa sogna o teme: ${campi.sogno || '?'}. Rispondi solo con il testo.` }] }], generationConfig: { temperature: 0.9 } }, 'regole');
    const storia = r.ok ? testo((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '', 1200).trim() : '';
    const ora = await this.get('pg:' + io); if (!ora) return; // riletta: nel frattempo la scheda può essere cambiata
    ora.famiglia = campi; if (storia) ora.storia = storia;
    await this.put('pg:' + io, ora);
    this.tutti({ t: 'scheda', per: io, pg: ora });
  }
  // diario del personaggio: il master scrive una pagina in prima persona, dal suo punto di vista, su quello che è successo di recente
  async paginaDiario(ws, io, me, capo, m) {
    const per = m.per && capo ? String(m.per) : io; if (me.ruolo === 'spettatore') return;
    const pg = await this.get('pg:' + per); if (!pg) return;
    if (this.inCorso?.has('d:' + per)) return; (this.inCorso = this.inCorso || new Set()).add('d:' + per);
    try {
      const [c, diario, memoria] = await Promise.all([this.get('campagna'), this.get('diario', []), this.get('memoria', '')]), ultima = (pg.pagine || []).slice(-1)[0];
      const fatti = diario.filter(d => !ultima || d.t > ultima.t).filter(d => ['narrazione', 'chat', 'parlato', 'comando', 'dado', 'combattimento', 'luogo', 'scheda'].includes(d.tipo)).slice(-50).map(d => `[${d.tipo}] ${d.testo}`).join('\n');
      const r = await this.g({ contents: [{ parts: [{ text: `Sei ${pg.nome}, ${pg.razza} ${pg.classe} di livello ${pg.livello} in una campagna di D&D (${c.ambientazione}). Scrivi in italiano una pagina del tuo diario personale, in prima persona, massimo 160 parole: cosa è successo, cosa hai provato, cosa pensi dei compagni e cosa temi o speri. Resta fedele ai fatti, con la tua voce e il tuo carattere. Niente titoli né date: solo il testo.${pg.storia ? `\nLa tua storia: ${String(pg.storia).slice(0, 400)}` : ''}${ultima ? `\nLa tua pagina precedente: ${ultima.testo.slice(0, 500)}` : ''}\nMemoria della campagna: ${memoria.slice(-1500)}\nUltimi eventi:\n${fatti || '(niente di nuovo: racconta la tua attesa)'}` }] }], generationConfig: { temperature: 0.9 } }, 'racconto');
      const t = r.ok ? testo((await r.json()).candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '', 1400).trim() : '';
      if (!t) return this.invia(ws, { t: 'avviso', msg: 'Il master non riesce a scrivere il diario adesso: riprova tra poco', errore: true });
      const ora = await this.get('pg:' + per); if (!ora) return;
      ora.pagine = [...(ora.pagine || []), { t: Date.now(), sessione: c.sessione || 1, testo: t }].slice(-30); await this.put('pg:' + per, ora);
      this.tutti({ t: 'scheda', per, pg: ora, nota: 'scrive una pagina del suo diario', da: io });
    } finally { this.inCorso.delete('d:' + per); }
  }
  // un personaggio caduto va nel memoriale con le sue imprese; il giocatore può creare un erede
  async caduto(chi, motivo) {
    const pg = await this.get('pg:' + chi); if (!pg) return;
    const diario = await this.get('diario', []), nome = pg.nome || '';
    const imprese = diario.filter(d => d.testo?.includes(nome.split(' ')[0]) && ['narrazione', 'combattimento', 'scheda'].includes(d.tipo)).slice(-5).map(d => testo(d.testo, 160));
    const eredita = (pg.equip || []).find(e => e.indossato) || (pg.equip || [])[0] || null;
    const mem = await this.get('memoriale', []);
    mem.push({ chi, nome, razza: pg.razza, classe: pg.classe, livello: pg.livello, t: Date.now(), motivo, imprese, eredita: eredita ? { nome: eredita.nome } : null, cognome: nome.split(' ').slice(1).join(' ') || nome });
    await this.put('memoriale', mem.slice(-30));
    await this.ctx.storage.delete('pg:' + chi);
    const ev = await this.diario('sistema', `${nome} è caduto${motivo ? ': ' + motivo : ''}. Il suo nome resta nel memoriale.`);
    this.tutti({ t: 'diario', ev }); this.tutti({ t: 'memoriale', memoriale: mem.slice(-30), caduto: chi });
    this.tutti({ t: 'suono', nome: 'sconfitta' });
  }
  async statistiche() {
    const st = await this.get('statistiche', { s: {}, t: {} }), membri = await this.get('membri', {}), nomi = {};
    for (const id of Object.keys(membri)) nomi[id] = (await this.get('pg:' + id))?.nome || membri[id].nome;
    nomi.gruppo = 'Il gruppo';
    const premio = (campo, titolo, fmt, min = 3) => { const [id, v] = Object.entries(st.t || {}).filter(([k]) => k !== 'gruppo').sort((a, b) => (b[1][campo] || 0) - (a[1][campo] || 0))[0] || []; return (v?.[campo] || 0) >= min ? { titolo, chi: nomi[id] || '?', motivo: fmt(v[campo]) } : null; };
    const premi = [premio('fallimenti', 'Re degli 1 naturali', n => `${n} uno naturali`, 2), premio('critici', 'Baciato dalla fortuna', n => `${n} venti naturali`, 2), premio('danniSubiti', 'Spugna del gruppo', n => `${n} danni presi`, 15), premio('danniFatti', 'Mano pesante', n => `${n} danni inflitti`, 15), premio('cure', 'Angelo custode', n => `${n} punti ferita curati`, 10), premio('speso', 'Mani bucate', n => `${n} monete spese`), premio('tiri', 'Lanciadadi compulsivo', n => `${n} tiri`, 20), premio('cadute', 'Abbonato al pavimento', n => `${n} volte a terra`, 2)].filter(Boolean);
    return { sessione: st.sessione, s: st.s, tot: st.t, nomi, trofei: trofei(st.s, nomi), premi }; // "tot": "t" è il tipo del messaggio
  }

  // «il vostro mese»: numeri del mese, trofei, luoghi nuovi, mostri sconfitti, illustrazioni e serate giocate
  async riepilogoMese(mese) {
    const st = await this.get('statistiche', { s: {}, t: {} }), mesi = Object.keys(st.m || {}).sort(), qui = /^\d{4}-\d{2}$/.test(mese) ? mese : mesi[mesi.length - 1] || new Date(Date.now() + 3600000).toISOString().slice(0, 7);
    const [membri, diario, riepiloghi] = await Promise.all([this.get('membri', {}), this.get('diario', []), this.get('riepiloghi', [])]), nomi = { gruppo: 'Il gruppo' };
    for (const id of Object.keys(membri)) nomi[id] = (await this.get('pg:' + id))?.nome || membri[id].nome;
    const delMese = t => new Date(t + 3600000).toISOString().slice(0, 7) === qui, d = diario.filter(x => delMese(x.t));
    return { mese: qui, mesi, numeri: st.m?.[qui] || {}, nomi, trofei: trofei(st.m?.[qui] || {}, nomi),
      luoghi: [...new Set(d.filter(x => x.tipo === 'luogo' && /per la prima volta/.test(x.testo)).map(x => x.testo.split(': ').slice(1).join(': ').replace(/\.$/, '')))].slice(0, 12),
      sconfitti: d.filter(x => / è sconfitto/.test(x.testo)).length, illustrazioni: d.filter(x => x.img).map(x => ({ img: x.img, testo: x.testo })).slice(-6),
      serate: riepiloghi.filter(r => delMese(r.t)).map(r => ({ titolo: r.titolo, img: r.img })), livelli: d.filter(x => x.tipo === 'scheda' && /livello \d/.test(x.testo)).map(x => x.testo).slice(-8) };
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
  // reputazione del gruppo nel luogo: da -100 a +100, prezzi fino al 25% più bassi o più alti
  async fattorePrezzo() { const mo = await this.get('mondo', {}), l = await this.get('luogo:' + await this.get('luogoAttuale')), r = mo.reputazioneLuoghi?.[l?.genitore ? (await this.get('luogo:' + l.genitore))?.nome : l?.nome] || 0; return 1 - Math.max(-100, Math.min(100, r)) / 400; }
  async compra(ws, io, me, m) {
    const n = await this.get('negozio'), merceBase = n?.merci.find(x => x.nome === m.merce), p = await this.get('pg:' + io);
    if (!merceBase || !p) return;
    const merce = { ...merceBase, prezzo: Math.max(1, Math.round(merceBase.prezzo * await this.fattorePrezzo())) };
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
    const prezzo = Math.max(0, Math.floor((n.merci.find(x => x.nome === og.nome)?.prezzo ?? prezzoBase(og.nome)) / 2 / await this.fattorePrezzo()));
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
    const chiedi = async (testoP) => { const r = await this.g({ contents: [{ parts: [{ text: testoP }] }], generationConfig: { temperature: 0.9, responseMimeType: 'application/json' } }, 'racconto'); return r.ok ? leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') : null; };
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
      for (let r = 4; r < 12 && !fatto; r++) for (let t = 0; t < 24 && !fatto; t++) { const a = (k * 1.7 + t) * 0.5, x = cx + Math.round(Math.cos(a) * r), y = cy + Math.round(Math.sin(a) * r * 0.7); if (libera(x, y)) { const nome = (mo.numero || 1) > 1 ? `${testo(mo.nome, 24)} ${i + 1}` : testo(mo.nome, 30); seg['n_' + Date.now().toString(36) + k] = { x, y, nome, colore: '#d84b3c', tipo: 'nemico', pf: Number(mo.pf) || 10, pfMax: Number(mo.pf) || 10, ca: Number(mo.ca) || 12 }; fatto = true; k++; } }
    }
    await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg });
    for (const mo of mostri.slice(0, 6)) { this.ctx.waitUntil(this.disegnaMostro(mo.nome)); await this.bestia(mo.nome, 'visti', Math.min(8, mo.numero || 1)); }
  }
  // carte da collezione: ogni tipo di mostro incontrato e sconfitto dal gruppo ("Goblin 2" conta come "Goblin")
  async bestia(nome, campo, quanti = 1) {
    const n = testo(String(nome || '').replace(/\s+\d+$/, ''), 40).trim(); if (!n) return;
    const b = await this.get('bestiario', {}), x = b[n] || { visti: 0, sconfitti: 0, prima: Date.now() };
    x[campo] = (x[campo] || 0) + quanti; if (campo === 'sconfitti' && x.visti < x.sconfitti) x.visti = x.sconfitti;
    b[n] = x; if (Object.keys(b).length > 150) return; await this.put('bestiario', b); this.tutti({ t: 'bestiario', bestiario: b });
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
    if (!ok && forza && this.erroreImg !== 'riserva') this.tutti({ t: 'avviso', msg: /4006|429|402|quota|error data/i.test(this.erroreImg || '') ? "Immagini gratuite finite per oggi: tornano dopo l'una di notte." : "L'illustrazione non è riuscita: riprova tra qualche minuto", motivo: this.erroreImg || null });
  }

  // ---------- connettore per Claude: lettura dello stato e preparazione delle sessioni ----------
  async interno(m) {
    const ris = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    if (m.azione === 'manuale_leggi') return ris(await this.get('manuale', { lezioni: [], problemi: [] }));
    if (m.azione === 'mondo_leggi') return ris(await this.mondoDaCondividere(String(m.chiave || '')));
    if (m.azione === 'vapid') {
      let k = await this.get('vapid', null);
      if (!k) { const c = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const jwk = await crypto.subtle.exportKey('jwk', c.privateKey), raw = new Uint8Array(await crypto.subtle.exportKey('raw', c.publicKey)); k = { jwk, pub: b64url(raw) }; await this.put('vapid', k); }
      return ris(k);
    }
    if (m.azione === 'manuale_aggiungi') {
      const man = await this.get('manuale', { lezioni: [], problemi: [] }), chiave = t => t.toLowerCase().replace(/[^a-zà-ù0-9 ]/g, '').slice(0, 70);
      for (const [lista, voci, max] of [[man.lezioni, m.lezioni, 200], [man.problemi, m.problemi, 300]]) for (const v of (Array.isArray(voci) ? voci : []).slice(0, 5)) {
        const t = testo(v, max).trim(); if (t.length < 8) continue;
        const es = lista.find(x => chiave(x.testo) === chiave(t)); if (es) { es.volte++; es.t = Date.now(); } else lista.push({ testo: t, volte: 1, t: Date.now(), da: testo(m.da, 40) });
      }
      man.lezioni = man.lezioni.sort((a, b) => b.volte - a.volte || b.t - a.t).slice(0, 60); man.problemi = man.problemi.sort((a, b) => b.t - a.t).slice(0, 120);
      await this.put('manuale', man); return ris({ ok: true });
    }
    const c = await this.get('campagna');
    if (!c) return ris({ errore: 'campagna inesistente' });
    if (m.azione === 'stato') {
      const membri = await this.get('membri', {}); const pg = [];
      for (const [id, mm] of Object.entries(membri)) { const p = await this.get('pg:' + id); pg.push({ giocatore: mm.nome, ruolo: mm.ruolo, personaggio: p ? `${p.nome}, ${p.razza} ${(p.classi || [{ classe: p.classe, livello: p.livello }]).map(x => x.classe + ' ' + x.livello).join('/')}, PF ${p.pf}/${p.pfMax}, CA ${p.ca}` : null }); }
      const attuale = await this.get('luogoAttuale');
      return ris({ campagna: c, membri: pg, luogo_attuale: attuale ? (await this.get('luogo:' + attuale))?.nome : null, luoghi: Object.values(await this.get('luoghi', {})).map(l => l.nome), memoria: await this.get('memoria', ''), mondo: await this.get('mondo', {}), tesoro: await this.get('gruppo', null), costi: await this.get('costi', null), suggerimenti: (await this.get('suggerimenti', [])).slice(-20), online: this.online().length });
    }
    if (m.azione === 'diario') return ris((await this.get('diario', [])).slice(-Math.min(200, m.n || 50)).map(d => `${new Date(d.t).toISOString().slice(0, 16)} [${d.tipo}] ${d.testo}`));
    if (m.azione === 'nota') { const mem = await this.get('memoria', ''); await this.put('memoria', `${mem}\nNote di preparazione del master: ${testo(m.testo, 1500)}`.slice(-7000)); return ris({ ok: true }); }
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
    // obiettivo segreto e sogni di un personaggio: solo al suo giocatore e al master
    const nascosto = obj.t === 'scheda' && (obj.pg?.segreto || obj.pg?.sogni) ? JSON.stringify({ ...obj, pg: { ...obj.pg, segreto: undefined, sogni: undefined } }) : null;
    for (const ws of this.ctx.getWebSockets()) {
      const m = this.membroDi(ws);
      if (!m || (filtro && !filtro(m))) continue;
      try { ws.send(nascosto && m !== obj.per && !ws.deserializeAttachment()?.vede ? nascosto : s); } catch {}
    }
  }
  online() { return [...new Set(this.ctx.getWebSockets().map(ws => this.membroDi(ws)).filter(Boolean))]; }
  async diario(tipo, testoEv, chi) {
    if (tipo === 'narrazione') testoEv = senzaRegia(testoEv);
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
    const io = membri[perMembro];
    for (const id of Object.keys(membri)) { const s = await this.get('pg:' + id); if (s) pg[id] = id === perMembro || io?.ruolo === 'master' ? s : { ...s, segreto: undefined, sogni: undefined }; }
    const vedeSegreti = io && (io.ruolo === 'master' || io.admin);
    const membriPubblici = Object.fromEntries(Object.entries(membri).map(([id, m]) => [id, { nome: m.nome, ruolo: m.ruolo, colore: m.colore, admin: !!m.admin, presenze: m.presenze || 0 }]));
    return {
      campagna: { ...campagna, invito: vedeSegreti || (campagna.masterTipo === 'ai' && io?.ruolo !== 'spettatore') ? campagna.invito : undefined, invitoSpettatori: io && io.ruolo !== 'spettatore' ? campagna.invitoSpettatori : undefined },
      membri: membriPubblici, online: this.online(), pg,
      luoghi: luoghiIdx, luogo: await this.luogoCon(attuale),
      segnalini, diario: diario.slice(-120), dadi: dadi.filter(d => !d.segreto || vedeSegreti || d.chi === perMembro).slice(-40),
      mondo: await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }), relazioni: await this.get('relazioni', {}),
      combattimento: await this.combattimentoValido(), aree: await this.get('aree', []), gruppo: await this.get('gruppo', { oro: 0, oggetti: [] }),
      mostri: await this.get('mostri', {}), volti: await this.get('volti', {}), negozio: await this.get('negozio', null),
      png: await this.get('png', {}), memoriale: await this.get('memoriale', []), ...(await this.mondoVivo(vedeSegreti)), serate: await this.get('serate', []), giocoTaverna: await this.get('giocoTaverna', null), noteMappa: { luogo: await this.get('luogoAttuale'), note: await this.get('note:' + await this.get('luogoAttuale'), []) }, disegni: { luogo: attuale, disegni: await this.get('disegni:' + attuale, []) }, avventure: Object.entries(AVVENTURE).map(([id, a]) => ({ id, titolo: a.titolo, livelli: a.livelli, tipo: a.tipo, seguito: a.seguito })),
      avventura: vedeSegreti ? await this.avventuraPerMaster() : undefined,
      cronaca: await this.get('cronaca', ''), appunti: vedeSegreti ? await this.get('appunti', '') : undefined, fatti: vedeSegreti ? await this.get('fatti', []) : undefined, giro: await this.statoGiro(), homebrew: vedeSegreti ? await this.get('homebrew', { mostri: [], oggetti: [] }) : undefined, viaggio: await this.get('viaggio', null), bestiario: await this.get('bestiario', {}), mondoChiave: io?.admin ? await this.get('mondoChiave', '') : undefined,
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
      // freno: al massimo 40 messaggi ogni 5 secondi per persona (i segnali della voce non contano)
      if (m.t !== 'rtc') { const ora = Date.now(), f = this.raffica.get(io) || { t: ora, n: 0 }; if (ora - f.t > 5000) { f.t = ora; f.n = 0; } f.n++; this.raffica.set(io, f); if (f.n > 40) return f.n === 41 ? this.invia(ws, { t: 'errore', msg: 'Troppi messaggi insieme: aspetta qualche secondo' }) : undefined; }
      // gli spettatori (amici esterni, TV) guardano e basta: niente che cambi la partita o consumi il master AI
      if (me.ruolo === 'spettatore' && !PER_SPETTATORI.includes(m.t)) return;
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
        case 'chat': { this.ctx.waitUntil(this.notaTattica(String(m.testo || ''))); const ev = await this.diario('chat', m.testo, io); this.tutti({ t: 'diario', ev }); if (m.alMaster) await this.chiamaMaster(io, me, true); return; }
        case 'parlato': return this.parlato(io, me, m);
        case 'sussurro': { // messaggio privato a un altro membro: non finisce nel diario, lo vedono solo i due
          if (me.ruolo === 'spettatore') return; const t = testo(m.testo, 400).trim(), a = String(m.a || ''), membri = await this.get('membri', {}); if (!t || !membri[a] || a === io) return;
          const dest = this.wsDi(a); if (!dest) return this.invia(ws, { t: 'avviso', msg: `${membri[a].nome} non è collegato: il messaggio non è partito`, errore: true });
          const msg = { t: 'sussurro', da: io, a, nome: me.nome, perNome: membri[a].nome, testo: t, quando: Date.now() }; this.invia(dest, msg); return this.invia(ws, msg);
        }
        case 'ritratto': return this.ritrattoPg(ws, io, me, capo, m);
        case 'al_master': { // un giocatore dice una cosa solo al master AI (un'azione di nascosto, un sospetto): gli altri non la vedono
          if (me.ruolo !== 'giocatore' || (await this.get('campagna')).masterTipo !== 'ai') return; const t = testo(m.testo, 400).trim(); if (!t) return;
          const p = await this.get('pg:' + io), l = await this.get('segretiMaster', []); l.push({ pg: io, nome: p?.nome || me.nome, testo: t, t: Date.now() }); await this.put('segretiMaster', l.slice(-12));
          this.invia(ws, { t: 'sussurro', da: io, a: 'master', nome: me.nome, perNome: 'il master', testo: t, quando: Date.now() });
          return this.chiamaMaster(io, me, true);
        }
        case 'aiuto': { // azione Aiuto: chi sta per tirare una prova tira con vantaggio
          if (me.ruolo !== 'giocatore') return; const per = String(m.per || ''), membri = await this.get('membri', {}), p = await this.get('pg:' + per), mio = await this.get('pg:' + io); if (!membri[per] || !p || per === io) return;
          const dest = this.wsDi(per); if (dest) this.invia(dest, { t: 'aiuto', da: io, nome: mio?.nome || me.nome });
          const ev = await this.diario('sistema', `${mio?.nome || me.nome} aiuta ${p.nome}: tira con vantaggio.`, io); return this.tutti({ t: 'diario', ev });
        }
        case 'carta': { // pesca dal mazzo del tavolo (54 carte); il master lo rimescola
          if (me.ruolo === 'spettatore') return; let mazzo = await this.get('mazzo', null);
          if (m.mischia) { if (!capo) return; await this.put('mazzo', null); const ev = await this.diario('sistema', 'Il mazzo viene rimescolato: 54 carte.', io); return this.tutti({ t: 'diario', ev }); }
          if (!Array.isArray(mazzo) || !mazzo.length) { mazzo = [...MAZZO]; for (let i = mazzo.length - 1; i > 0; i--) { const a = new Uint32Array(1); crypto.getRandomValues(a); const j = a[0] % (i + 1); [mazzo[i], mazzo[j]] = [mazzo[j], mazzo[i]]; } }
          const carta = mazzo.pop(); await this.put('mazzo', mazzo); const p = await this.get('pg:' + io);
          const ev = await this.diario('dado', `${p?.nome || me.nome} pesca una carta: ${carta} (ne restano ${mazzo.length}).`, io); this.tutti({ t: 'diario', ev }); return this.tutti({ t: 'carta', chi: io, nome: p?.nome || me.nome, carta, restano: mazzo.length });
        }
        case 'appunti': { // il mondo scritto prima da chi crea la campagna: il master AI lo usa come verità (solo master e amministratore lo leggono)
          if (!capo) return; if (typeof m.testo === 'string') { await this.put('appunti', testo(m.testo, 8000)); const ev = await this.diario('sistema', 'Gli appunti del mondo sono stati aggiornati.', io); this.tutti({ t: 'diario', ev }); }
          return this.invia(ws, { t: 'appunti', testo: await this.get('appunti', '') });
        }
        case 'ricorda': { // un fatto che il gruppo vuole far ricordare al master: entra nella memoria e nella cronaca
          if (!capo) return; const t = testo(m.testo, 300).trim(); if (!t) return;
          await this.put('memoria', `${await this.get('memoria', '')}\nDa ricordare (detto dai giocatori): ${t}`.slice(-7000)); await this.put('cronaca', `${await this.get('cronaca', '')}\n• ${t}`.slice(-3000)); // pieno: si perde il più vecchio, non il fatto appena aggiunto
          return this.tutti({ t: 'cronaca', cronaca: await this.get('cronaca', '') });
        }
        case 'comando': { const ev = await this.diario('comando', `${me.nome}: ${testo(m.testo, 300)}`, io); return this.tutti({ t: 'diario', ev }); }
        case 'storia': return this.storia(io, m);
        case 'viaggio': if (me.ruolo === 'spettatore' || (!capo && (await this.get('campagna')).masterTipo !== 'ai')) return; return this.viaggio(io, me, m);
        case 'homebrew': { // mostri e oggetti inventati da chi guida: il master AI li usa nella storia
          if (!capo) return; const hb = await this.get('homebrew', { mostri: [], oggetti: [] });
          if (m.togli) { hb.mostri = hb.mostri.filter(x => x.nome !== m.togli); hb.oggetti = hb.oggetti.filter(x => x.nome !== m.togli); }
          else if (m.mostro?.nome) { const x = { nome: testo(m.mostro.nome, 40).trim(), pf: Math.max(1, Math.min(500, Number(m.mostro.pf) || 10)), ca: Math.max(5, Math.min(30, Number(m.mostro.ca) || 12)), attacco: testo(m.mostro.attacco, 120), descrizione: testo(m.mostro.descrizione, 300) }; if (!x.nome) return; hb.mostri = [...hb.mostri.filter(y => y.nome !== x.nome), x].slice(-30); this.ctx.waitUntil(this.disegnaMostro(x.nome, x.descrizione)); }
          else if (m.oggetto?.nome) { const x = { nome: testo(m.oggetto.nome, 40).trim(), rarita: ['comune', 'non comune', 'raro', 'molto raro', 'leggendario'].includes(m.oggetto.rarita) ? m.oggetto.rarita : 'non comune', effetto: testo(m.oggetto.effetto, 240) }; if (!x.nome) return; hb.oggetti = [...hb.oggetti.filter(y => y.nome !== x.nome), x].slice(-30); }
          await this.put('homebrew', hb); return this.tutti({ t: 'homebrew', homebrew: hb }, x => { const mm = membri[x]; return mm && (mm.ruolo === 'master' || mm.admin); });
        }
        case 'diario_pg': return this.paginaDiario(ws, io, me, capo, m);
        case 'missione_accetta': return this.missioneAccetta(io, String(m.id || ''));
        case 'reazione': { if (!REAZIONI.includes(m.emoji)) return; const ora = Date.now(); if (ora - (this.reazioni.get(io) || 0) < 1200) return; this.reazioni.set(io, ora); return this.tutti({ t: 'reazione', emoji: m.emoji, nome: me.nome }); }
        case 'traduci': return this.traduci(ws, m);
        case 'meteo_vero': { if (!capo || !['sereno', 'nuvoloso', 'pioggia', 'temporale', 'neve', 'nebbia'].includes(m.meteo)) return; const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); mo.calendario = { giorno: 1, stagione: 'autunno', ...(mo.calendario || {}), meteo: m.meteo, meteoVero: true }; await this.put('mondo', mo); return this.tutti({ t: 'mondo', mondo: mo }); }
        case 'dungeon_giorno': if (!capo && (await this.get('campagna')).masterTipo === 'umano') return; return this.dungeonDelGiorno(io);
        case 'segnala_problema': { const ora = Date.now(); if (ora - (this.ultimoProblema || 0) < 3000) return; this.ultimoProblema = ora; return this.impara([], [testo(m.testo, 300)]); }
        case 'immagine_esterna': {
          const att = this.daDisegnare?.[m.id]; if (!att || Date.now() - att.t > 900000 || typeof m.dati !== 'string' || m.dati.length > 380000) return;
          const jpeg = Uint8Array.from(atob(m.dati), c => c.charCodeAt(0)); if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return; // solo JPEG veri
          delete this.daDisegnare[m.id];
          if (att.scopo === 'scena') { const id = await this.salvaIllustrazione(jpeg, att.didascalia); if (att.riepilogo) { const el = await this.get('riepiloghi', []), r = el.find(x => x.t === att.riepilogo); if (r) { r.img = id; await this.put('riepiloghi', el); } } return; }
          const id = 'i' + Date.now().toString(36) + Math.floor(Math.random() * 100); await this.ctx.storage.put('img:' + id, jpeg);
          const chiave = att.scopo === 'volto' ? 'volti' : 'mostri', mappa = await this.get(chiave, {}); mappa[att.chiave] = id; await this.put(chiave, mappa);
          return this.tutti({ t: chiave, [chiave]: mappa });
        }
        case 'nota_mappa': if (me.ruolo === 'spettatore') return; return this.notaMappa(io, me, m);
        case 'disegno': if (me.ruolo === 'spettatore') return; return this.disegno(io, me, capo, m);
        case 'gioco_apri': case 'gioco_entra': case 'gioco_via': case 'gioco_annulla': if (me.ruolo === 'spettatore') return; return this.giocoTaverna(io, me, capo, m);
        case 'serata_nuova': case 'serata_risposta': case 'serata_togli': return this.serata(io, me, capo, m);
        case 'push_chiave': return this.invia(ws, { t: 'push_chiave', pub: (await this.manuale('vapid'))?.pub || null });
        case 'push_iscrivi': { const e = String(m.endpoint || ''); let u; try { u = new URL(e); } catch { return; } if (u.protocol !== 'https:' || !/(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/.test(u.hostname)) return; const iscritti = await this.get('push', {}); iscritti[io] = e; await this.put('push', iscritti); return this.invia(ws, { t: 'push_ok' }); }
        case 'missione_nuova': if (!capo) return; return this.eventoMondo({ tipo: 'missione', titolo: m.titolo, descrizione: m.descrizione, ricompensa: m.ricompensa, entro: m.entro });
        case 'voto_apri': if (!capo) return; return this.eventoMondo({ tipo: 'voto', domanda: m.domanda, opzioni: m.opzioni });
        case 'voto': return this.vota(io, Number(m.scelta));
        case 'voto_chiudi': if (!capo) return; return this.chiudiVoto();
        case 'enigma_risposta': return this.rispondiEnigma(io, me, String(m.risposta || ''));
        case 'base': return this.baseCompra(io, String(m.cosa || ''));
        case 'crea_oggetto': return this.creaOggetto(ws, io, String(m.ricetta || ''));
        case 'mestiere': { const p = await this.get('pg:' + io); if (!p || !MESTIERI[m.mestiere]) return; p.mestiere = m.mestiere; await this.put('pg:' + io, p); return this.tutti({ t: 'scheda', per: io, pg: p }); }
        case 'compagno_nuovo': if (!capo) return; return this.eventoMondo({ tipo: 'compagno', pg: membri[m.per] ? m.per : io, nome: m.nome, specie: m.specie });
        case 'caduto': { const chi = capo && m.pg ? String(m.pg) : io; return this.caduto(chi, testo(m.motivo, 200)); }
        case 'suono': if (!capo || !SUONI.includes(m.nome)) return; return this.tutti({ t: 'suono', nome: m.nome }); // tavola dei suoni del master
        case 'narra': if (!capo) return; { const ev = await this.diario('narrazione', m.testo, io); return this.tutti({ t: 'narra', testo: ev.testo, png: testo(m.png, 40), chi: io }); }
        case 'rtc': return this.rtc(io, m);
        case 'impostazioni': return this.impostazioni(ws, io, me, capo, m);
        case 'mondo_condividi': { if (!me.admin) return; let k = await this.get('mondoChiave', ''); if (m.ritira) k = ''; else if (!k || m.nuovo) k = codiceCasuale(8); await this.put('mondoChiave', k); return this.invia(ws, { t: 'mondo_chiave', chiave: k }); }
        case 'mondo_importa': return this.importaMondo(ws, me, m);
        case 'nuovo_invito': if (!capo) return; { const c = await this.get('campagna'); c.invito = codiceCasuale(8); c.invitoSpettatori = codiceCasuale(10); await this.put('campagna', c); return this.tutti({ t: 'invito', invito: c.invito, invitoSpettatori: c.invitoSpettatori }, x => { const mm = membri[x]; return mm && (mm.ruolo === 'master' || mm.admin || c.masterTipo === 'ai'); }); }
        case 'suggerimento': { const s = await this.get('suggerimenti', []); s.push({ t: Date.now(), chi: me.nome, testo: testo(m.testo, 1500) }); while (s.length > 200) s.shift(); await this.put('suggerimenti', s); return this.invia(ws, { t: 'ok', cosa: 'suggerimento' }); }
        case 'interpreta': return this.interpreta(ws, io, me, m);
        case 'regola': return this.regola(ws, me, m);
        case 'riassunto': return this.inviaRiassunto(ws, m.formato);
        case 'stato': return this.invia(ws, { t: 'stato', stato: await this.statoCompleto(io) });
        case 'master_ora': if (!capo) return; await this.put('giroDetti', []); await this.put('giroScade', 0); return this.programmaMaster(true);
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
        case 'esporta': { if (!me.admin) return; const dati = {}; for (const [k, v] of await this.ctx.storage.list()) if (COPIA.test(k)) dati[k] = v; return this.invia(ws, { t: 'esportazione', dati, codice: (await this.get('campagna'))?.nome }); }
        case 'importa': {
          if (!me.admin || !m.dati || typeof m.dati !== 'object') return;
          const c = await this.get('campagna'), voci = Object.entries(m.dati).filter(([k]) => COPIA.test(k));
          if (!voci.length) return this.invia(ws, { t: 'errore', msg: 'Il file non contiene una campagna' });
          for (const [k, v] of voci) await this.put(k, k === 'campagna' ? { ...v, invito: c.invito, invitoSpettatori: c.invitoSpettatori, creata: c.creata, prova: c.prova } : v); // l'invito resta quello attuale
          await this.diario('sistema', `${me.nome} ripristina la campagna da una copia salvata.`);
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x) this.invia(s2, { t: 'stato', stato: await this.statoCompleto(x) }); }
          return;
        }
        case 'avventura_inizia': if (!capo) return; return this.iniziaAvventura(m.id);
        case 'avventura_scena': if (!capo) return; return this.scenaAvventura(m.scena);
        case 'avventura_leggi': if (!capo) return; { const avv = await this.get('avventura'), sc = AVVENTURE[avv?.id]?.scene.find(x => x.id === m.scena); if (!sc) return; const ev = await this.diario('narrazione', sc.leggi, 'master'); return this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master' }); }
        case 'statistiche': return this.invia(ws, { t: 'statistiche', ...(await this.statistiche()) });
        case 'mese': return this.invia(ws, { t: 'mese', ...(await this.riepilogoMese(String(m.mese || ''))) });
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
          const seg = await this.get('segnalini', {}); for (const k of Object.keys(seg)) if (k === chi || k.startsWith(chi + '_c')) delete seg[k]; await this.put('segnalini', seg);
          { const g = await this.get('giocoTaverna', null); if (g?.giocatori.includes(chi)) { for (const id of g.giocatori) if (id !== chi) { const p = await this.get('pg:' + id); if (p) { p.oro = (p.oro || 0) + g.posta; await this.put('pg:' + id, p); this.tutti({ t: 'scheda', per: id, pg: p }); } } await this.put('giocoTaverna', null); this.tutti({ t: 'gioco_taverna', gioco: null }); } } // chi esce a metà partita: monete restituite agli altri
          const iscritti = await this.get('push', {}); if (iscritti[chi]) { delete iscritti[chi]; await this.put('push', iscritti); }
          const ev = await this.diario('sistema', `${nome} lascia la campagna.`);
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x === chi) { s2.serializeAttachment({ membro: null }); try { s2.close(1000, 'uscito'); } catch {} } }
          if (!Object.keys(membri).length && (await this.get('campagna'))?.prova) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; } // partita bot finita: niente resta sul server
          for (const s2 of this.ctx.getWebSockets()) { const x = this.membroDi(s2); if (x) { this.invia(s2, { t: 'stato', stato: await this.statoCompleto(x) }); this.invia(s2, { t: 'diario', ev }); } }
          await this.votoCompleto();
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
    if (io) this.ctx.waitUntil(this.votoCompleto());
    if (io) this.ctx.waitUntil((async () => { const mm = await this.get('membri', {}); if (mm[io]) { mm[io].visto = Date.now(); await this.put('membri', mm); } })()); // per il riassunto di chi ritorna
  }

  async accetta(ws, id, membri, extra = {}) {
    ws.serializeAttachment({ membro: id, vede: membri[id]?.ruolo === 'master' || !!membri[id]?.admin });
    const camp = await this.get('campagna'); if (camp && !camp.invitoSpettatori) { camp.invitoSpettatori = codiceCasuale(10); await this.put('campagna', camp); } // campagne nate prima del link per spettatori
    const sess = camp?.sessione || 1; // una presenza per ogni sessione a cui partecipa: sblocca le cornici
    if (membri[id].sessioneVista !== sess) { membri[id].presenze = (membri[id].presenze || 0) + 1; membri[id].sessioneVista = sess; await this.put('membri', membri); }
    this.invia(ws, { t: 'benvenuto', io: id, ...extra, stato: await this.statoCompleto(id) });
    const visto = membri[id].visto || membri[id].dal || 0, persi = (await this.get('riepiloghi', [])).filter(r => r.t > visto);
    if (persi.length && visto) this.invia(ws, { t: 'bentornato', riepiloghi: persi.slice(-3) });
    membri[id].visto = Date.now(); await this.put('membri', membri);
    await this.prossimoControllo();
    this.tutti({ t: 'presenza', online: this.online(), entrato: id, membro: { nome: membri[id].nome, ruolo: membri[id].ruolo, colore: membri[id].colore, admin: !!membri[id].admin, presenze: membri[id].presenze || 0 } });
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
      invito: codiceCasuale(8), invitoSpettatori: codiceCasuale(10), creata: Date.now(), sessione: 1, solitaria: !!m.solitaria, prova: !!m.prova,
      sfida: m.sfida?.titolo ? { titolo: testo(m.sfida.titolo, 80), obiettivo: testo(m.sfida.obiettivo, 400), settimana: testo(m.sfida.settimana, 12) } : undefined
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
    const soloGuardare = !!m.invito && m.invito === c.invitoSpettatori; // il link per gli amici esterni fa entrare solo come spettatori
    if (!m.invito || (m.invito !== c.invito && !soloGuardare)) return this.invia(ws, { t: 'errore', msg: 'invito non valido o scaduto: chiedi un nuovo QR', codice: 'invito' });
    const membri = await this.get('membri', {});
    let ruolo = soloGuardare ? 'spettatore' : ['giocatore', 'spettatore', 'master'].includes(m.ruolo) ? m.ruolo : 'giocatore';
    const quanti = Object.values(membri).filter(x => (x.ruolo === 'spettatore') === (ruolo === 'spettatore')).length;
    if (quanti >= (ruolo === 'spettatore' ? 20 : 12)) return this.invia(ws, { t: 'errore', msg: 'stanza piena' });
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

  // ---------- mondi condivisi: chi ha creato la campagna dà un codice, un altro gruppo comincia la sua storia nello stesso mondo ----------
  // Si copiano ambientazione, appunti del mondo, fatti fissati dal master, luoghi con le loro mappe, fazioni e valute.
  // Non si copiano personaggi, diario, memoria, tesori: quelli sono la storia del gruppo, non il mondo.
  async mondoDaCondividere(chiave) {
    const k = await this.get('mondoChiave', ''); if (!k || chiave !== k) return { ok: false };
    const c = await this.get('campagna'), idx = await this.get('luoghi', {}), luoghi = {};
    for (const id of Object.keys(idx).slice(0, 40)) { const l = await this.get('luogo:' + id); if (l) { const { visto, visite, ...r } = l; luoghi[id] = { ...r, seme: l.seme || c.creata }; } }
    const mo = await this.get('mondo', { fazioni: {}, valute: {} }), png = await this.get('png', {});
    return { ok: true, nome: c.nome, ambientazione: c.ambientazione, appunti: await this.get('appunti', ''), fatti: await this.get('fatti', []), luoghi,
      fazioni: Object.fromEntries(Object.entries(mo.fazioni || {}).map(([n, f]) => [n, { descrizione: f.descrizione }])), valute: mo.valute || {},
      personaggi: Object.entries(png).slice(0, 30).map(([n, p]) => `${n}${p.luogo ? ` (${p.luogo})` : ''}${p.note?.length ? ': ' + p.note.join('; ') : ''}`) };
  }
  async importaMondo(ws, me, m) {
    if (!me.admin) return;
    const no = msg => this.invia(ws, { t: 'avviso', msg, errore: true });
    const mt = String(m.codice || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').match(/^([A-Z0-9]{6,12})-([A-Z0-9]{8})$/);
    if (!mt) return no('Codice del mondo non valido: è fatto di due parti unite da un trattino');
    const altro = this.env.TAVOLO.idFromName(mt[1]); if (altro.equals(this.ctx.id)) return no('Questo è il codice del mondo di questa stessa campagna');
    let w = null; try { w = await (await this.env.TAVOLO.get(altro).fetch('https://tavolo/interno', { method: 'POST', headers: { 'x-tavolo-interno': '1' }, body: JSON.stringify({ azione: 'mondo_leggi', chiave: mt[2] }) })).json(); } catch { /* sotto */ }
    if (!w?.ok) return no('Mondo non trovato: il codice è sbagliato oppure è stato ritirato da chi lo ha creato');
    const c = await this.get('campagna'), idx = await this.get('luoghi', {}); let nuovi = 0;
    for (const [id, l] of Object.entries(w.luoghi || {})) { if (idx[id] || !l?.celle || !l.nome || id.length > 80) continue; await this.put('luogo:' + id, l); idx[id] = { nome: l.nome, tipo: l.tipo, prima: Date.now() }; nuovi++; }
    await this.put('luoghi', idx);
    c.ambientazione = testo(w.ambientazione, 400) || c.ambientazione; c.mondoDa = testo(w.nome, 60); await this.put('campagna', c);
    const gente = (w.personaggi || []).length ? 'Personaggi del mondo: ' + w.personaggi.map(p => testo(p, 200)).join(' · ') : '';
    await this.put('appunti', testo([await this.get('appunti', ''), w.appunti, gente].filter(Boolean).join('\n\n'), 8000));
    const fatti = await this.get('fatti', []); for (const f of w.fatti || []) { const t = testo(f, 240); if (t && !fatti.includes(t)) fatti.push(t); } await this.put('fatti', fatti.slice(-40));
    const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] });
    for (const [n, f] of Object.entries(w.fazioni || {}).slice(0, 20)) if (!mo.fazioni[n]) mo.fazioni[testo(n, 60)] = { reputazione: 0, descrizione: testo(f?.descrizione, 200) }; // il nuovo gruppo parte da sconosciuto
    mo.valute = { ...(w.valute || {}), ...mo.valute }; await this.put('mondo', mo);
    await this.diario('sistema', `${me.nome} porta la campagna nel mondo «${c.mondoDa}»: ${nuovi} luoghi già pronti, con le loro mappe.`);
    for (const s of this.ctx.getWebSockets()) { const x = this.membroDi(s); if (x) this.invia(s, { t: 'stato', stato: await this.statoCompleto(x) }); }
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
      if (m.difficolta !== undefined) c.difficolta = DIFFICOLTA[m.difficolta] !== undefined ? m.difficolta : 'normale';
      if (m.giro !== undefined) { const era = c.giro; c.giro = !!m.giro; if (era && !c.giro && !c.differito) await this.sciogliGiro(); } // turni a giro: il master risponde quando tutti hanno detto la loro
      if (m.stileImg !== undefined) c.stileImg = STILI_IMG[m.stileImg] ? m.stileImg : 'realistico';
      if (m.differito !== undefined) { const era = c.differito; c.differito = [6, 12, 24, 48].includes(Number(m.differito)) || (this.env.IMG_FINTA && Number(m.differito) > 0) ? Number(m.differito) : 0; /* nelle prove in locale valgono anche attese di pochi secondi */ if (era && !c.differito) { await this.put('giroScade', 0); if (!c.giro) await this.sciogliGiro(); } } // gioco a distanza: ognuno scrive quando può, il master risponde quando hanno scritto tutti o dopo queste ore
      if (m.timerTurno !== undefined) c.timerTurno = [30, 60, 90, 120].includes(Number(m.timerTurno)) ? Number(m.timerTurno) : 0; // clessidra del turno, in secondi (0 = spenta)
      if (m.nuovaSessione) { c.sessione = (c.sessione || 1) + 1; c.invito = codiceCasuale(8); c.invitoSpettatori = codiceCasuale(10); await this.diario('sistema', `Inizia la sessione ${c.sessione}.`); this.ctx.waitUntil(this.evolviMondo(false)); await this.minacceCrescono(); for (const x of this.online()) if (membri[x] && membri[x].sessioneVista !== c.sessione) { membri[x].presenze = (membri[x].presenze || 0) + 1; membri[x].sessioneVista = c.sessione; } await this.put('membri', membri); }
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
    m.pg = JSON.parse(JSON.stringify(m.pg).replace(/</g, '‹')); // la scheda arriva dal telefono di un giocatore: niente HTML nei suoi campi (anche quelli numerici) verso gli altri
    const primaPg = await this.get('pg:' + per);
    m.pg.segreto = primaPg?.segreto || (m.pg.nome ? this.segretoNuovo() : undefined); m.pg.sogni = primaPg?.sogni; m.pg.ritratto = primaPg?.ritratto; m.pg.pagine = primaPg?.pagine; // segreti, sogni, ritratto illustrato e diario li scrive solo il server
    await this.put('pg:' + per, m.pg);
    await this.contaPf(per, primaPg, m.pg);
    this.tutti({ t: 'scheda', per, pg: m.pg, nota: m.nota ? testo(m.nota, 300) : null, da: io });
    if (m.nota) { const ev = await this.diario('scheda', `${m.pg.nome || me.nome}: ${testo(m.nota, 300)}`, io); this.tutti({ t: 'diario', ev }); }    if (!primaPg && m.pg.nome) { const avv = await this.get('avventura', null); if (avv && !avv.iniziata && AVVENTURE[avv.id]?.guidata) await this.programmaMaster(true); } // primi passi: appena il personaggio è pronto l'avventura comincia da sola
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
    const id = String(m.id || io), segPrima = await this.get('segnalini', {});
    const mio = id === io || segPrima[id]?.padrone === io; // il proprio animale lo muove il suo giocatore
    if (!mio && !capo) return;
    if (!capo) m = { x: m.x, y: m.y, aura: m.aura }; // un giocatore sposta solo il suo segnalino (e gli dà un'aura): non ne cambia tipo, nome o punti ferita
    const seg = await this.get('segnalini', {});
    let via = null;
    if (!m.rimuovi && seg[id] && (seg[id].tipo === 'pg' || seg[id].padrone) && (!capo || mio)) {
      const luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
      if (luogo) { via = percorso(luogo, seg[id], { x: m.x | 0, y: m.y | 0 }); if (!via) return this.invia(this.wsDi?.(io), { t: 'segnalini', segnalini: seg }); }
    }
    let x = Math.max(0, Math.min(63, m.x | 0)), y = Math.max(0, Math.min(63, m.y | 0));
    // mostri e PNG piazzati dal master: mai dentro un muro o un mobile, ma nella casella libera più vicina
    if (!m.rimuovi && capo && !via && (m.tipo || seg[id]?.tipo) !== 'pg') {
      const luogo = await this.get('luogo:' + await this.get('luogoAttuale'));
      if (luogo && x < luogo.w && y < luogo.h) { const presi = new Set(Object.entries(seg).filter(([k]) => k !== id).map(([, s]) => s.y * luogo.w + s.x)); ({ x, y } = vicine(luogo, { x, y }, presi)); }
    }
    if (m.rimuovi && capo) { if (seg[id]?.tipo === 'nemico') await this.bestia(seg[id].nome, 'sconfitti'); delete seg[id]; }
    else {
      const prima = seg[id] || {};
      seg[id] = { ...prima, x, y, nome: testo(m.nome, 30) || prima.nome, colore: m.colore || prima.colore, tipo: m.tipo || prima.tipo || 'pg', pf: m.pf ?? prima.pf, ca: m.ca ?? prima.ca };
      if (seg[id].tipo === 'nemico' && seg[id].pf !== undefined) seg[id].pfMax = Math.max(prima.pfMax || 0, seg[id].pf); // per la barra della vita
      if (m.aura !== undefined) { const a = Math.max(0, Math.min(12, m.aura | 0)); if (a) seg[id].aura = a; else delete seg[id].aura; }
      if (capo && m.ignoto !== undefined) { if (m.ignoto) seg[id].ignoto = true; else delete seg[id].ignoto; } // nome nascosto ai giocatori finché il master non lo svela
    }
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
    const r = ['dungeon', 'grotta'].includes(luogo.tipo) ? 5 : ['taverna', 'interno'].includes(luogo.tipo) ? 8 : ['citta', 'villaggio', 'porto', 'castello'].includes(luogo.tipo) ? 12 : 9;
    const v = (luogo.visto || '0'.repeat(luogo.w * luogo.h)).split(''), { vista } = griglia(luogo);
    let cambi = 0;
    for (const p of punti) for (let y = p.y - r; y <= p.y + r; y++) for (let x = p.x - r; x <= p.x + r; x++) {
      if (x < 0 || y < 0 || x >= luogo.w || y >= luogo.h || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue;
      const i = y * luogo.w + x; if (v[i] !== '0' || !vede(luogo, vista, p.x, p.y, x, y)) continue;
      v[i] = '1'; cambi++;
    }
    // nei paesi le zone illuminate (lampioni, falò, case) si vedono anche da lontano, come nei Varchi
    if (['citta', 'villaggio', 'porto', 'castello'].includes(luogo.tipo)) {
      const luci = [...(luogo.oggetti || []).filter(o => /lampione|falo|braciere|torcia|lanterna/.test(o.tipo)).map(o => ({ x: o.x, y: o.y, r: 3 })), ...luogo.edifici.filter(e => e.stato !== 'distrutto').map(e => ({ x: e.x + Math.floor(e.w / 2), y: e.y + e.h, r: 2 }))];
      for (const p of punti) for (const l of luci) {
        if ((l.x - p.x) ** 2 + (l.y - p.y) ** 2 > 22 * 22 || !vede(luogo, vista, p.x, p.y, Math.min(luogo.w - 1, l.x), Math.min(luogo.h - 1, l.y))) continue;
        for (let y = l.y - l.r; y <= l.y + l.r; y++) for (let x = l.x - l.r; x <= l.x + l.r; x++) { if (x < 0 || y < 0 || x >= luogo.w || y >= luogo.h) continue; const i = y * luogo.w + x; if (v[i] === '0' && vede(luogo, vista, Math.min(luogo.w - 1, l.x), Math.min(luogo.h - 1, l.y), x, y)) { v[i] = '1'; cambi++; } }
      }
    }
    if (!cambi && luogo.visto) return luogo;
    luogo.visto = v.join('');
    await this.put('luogo:' + id, luogo);
    if (!luogoDato) this.tutti({ t: 'nebbia', id, visto: luogo.visto });
    return luogo;
  }

  // ---------- viaggi a tappe: i giorni passano, lungo la strada può capitare un incontro (allora ci si ferma a combattere) ----------
  async viaggio(io, me, m) {
    if ((await this.get('combattimento', null))?.attivo) return this.invia(this.wsDi(io), { t: 'avviso', msg: 'Prima finite il combattimento', errore: true });
    let v = await this.get('viaggio', null);
    if (!m.riprendi) {
      const nome = testo(m.nome, 60).trim(), da = await this.get('luogoAttuale'); if (!nome || chiaveLuogo(nome) === da) return;
      const h = [...(da || '') + chiaveLuogo(nome)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7), giorni = 1 + h % 4, cavallo = !!m.cavallo;
      v = { verso: nome, giorni: cavallo ? Math.max(1, Math.ceil(giorni / 2)) : giorni, fatti: 0, cavallo, eventi: [], da: (await this.get('luoghi', {}))[da]?.nome || null };
      await this.annuncia(`Il gruppo parte ${cavallo ? 'a cavallo ' : ''}verso ${nome}: ${v.giorni === 1 ? 'un giorno' : v.giorni + ' giorni'} di viaggio.`);
    } else if (!v) return;
    const membri = await this.get('membri', {}), livelli = []; for (const [id, mm] of Object.entries(membri)) if (mm.ruolo === 'giocatore') { const p = await this.get('pg:' + id); if (p) livelli.push(p.livello || 1); }
    const liv = livelli.length ? Math.round(livelli.reduce((a, b) => a + b, 0) / livelli.length) : 1;
    while (v.fatti < v.giorni) {
      v.fatti++; await this.applicaEvento({ tipo: 'tempo', giorni: 1 });
      const tiro = tiraFormula('d20').totale, notte = v.fatti < v.giorni ? ' La sera il gruppo si accampa.' : '';
      if (tiro <= 6 && !m.riprendi) { // incontro: ci si ferma lungo la strada e si combatte (alla ripresa del viaggio niente secondo agguato nello stesso giorno)
        const inc = INCONTRI_VIAGGIO[(tiro + v.fatti) % INCONTRI_VIAGGIO.length], numero = Math.min(6, inc.numero + Math.max(0, liv - 2));
        v.eventi.push(`giorno ${v.fatti}: agguato di ${inc.nome.toLowerCase()} lungo la strada`); await this.put('viaggio', v); this.tutti({ t: 'viaggio', viaggio: v });
        await this.annuncia(`Giorno ${v.fatti} di viaggio: un agguato lungo la strada!`);
        await this.vai(io, me, `Strada per ${v.verso}`.slice(0, 60), 'aperto');
        await this.piazzaNemici([{ ...inc, numero }]);
        return this.programmaMaster(true);
      }
      m.riprendi = false;
      const ev = tiro >= 17 ? 'scoperta' : tiro >= 11 ? 'incontro tranquillo' : 'tranquillo';
      v.eventi.push(`giorno ${v.fatti}: ${ev}`); await this.annuncia(`Giorno ${v.fatti} di viaggio: ${ev === 'scoperta' ? 'lungo la strada il gruppo trova qualcosa di interessante.' : ev === 'incontro tranquillo' ? 'si incrociano altri viandanti.' : 'strada tranquilla.'}${notte}`);
    }
    await this.put('viaggio', null); await this.put('viaggioFatto', v); this.tutti({ t: 'viaggio', viaggio: null });
    await this.vai(io, me, v.verso);
    return this.programmaMaster(true);
  }

  async vai(io, me, nome, tipo) {
    nome = testo(nome, 60).trim();
    if (!nome) return;
    const c = await this.get('campagna');
    const id = chiaveLuogo(nome);
    let luogo = await this.luogoCon(id);
    const nuovo = !luogo || !luogo.visite; // i luoghi preparati in anticipo (avventure, prepara_luogo) non sono ancora stati visitati
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
      // i compagni animali seguono il loro personaggio e combattono nel suo stesso ordine
      (pg?.compagni || []).slice(-2).forEach((a, i) => { seg[`${mid}_c${i}`] = { ...posto(seg[mid]), nome: a.nome, tipo: 'alleato', animale: a.specie, padrone: mid, colore: mm.colore, pf: a.pf, ca: a.ca }; });
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
    this.tutti({ t: 'note_mappa', luogo: id, note: await this.get('note:' + id, []) });
    this.tutti({ t: 'disegni', luogo: id, disegni: await this.get('disegni:' + id, []) });
    if (precedente !== id && !luogo.genitore) await this.forseMercante(luogo);
  }

  async luogoCon(id) {
    const l = id ? await this.get('luogo:' + id) : null;
    if (l && (!l.oggetti || l.arrediV !== ARREDI_V)) {
      const c = await this.get('campagna'), nuovo = generaLuogo(l.nome, l.tipo, (l.seme || c?.creata || l.creato) + ':' + id, l.tipo === 'interno' ? l.edifici.map(e => e.nome) : undefined);
      l.celle = nuovo.celle; l.oggetti = nuovo.oggetti; l.arrediV = ARREDI_V;
      for (const e of nuovo.edifici) if (['ponte', 'guado'].includes(e.id) && !l.edifici.some(x => x.id === e.id)) l.edifici.push(e); // ponti e guadi arrivati dopo
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
  // un combattimento senza nessuno in ordine (rimasto da versioni vecchie) si chiude da solo
  async combattimentoValido() { const c = await this.get('combattimento', null); if (c?.attivo && !c.ordine?.length) { c.attivo = false; await this.put('combattimento', c); } return c; }
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
      if (!ordine.length) { if (io !== 'master') this.invia(this.wsDi(io), { t: 'errore', msg: 'Non c\'è nessuno da mettere in ordine: servono personaggi o nemici sulla mappa' }); return; }
      c = { attivo: true, round: 1, turno: 0, ordine, inizio: Date.now(), inizioTurno: Date.now() };
      await this.diario('combattimento', `Inizia il combattimento! Ordine: ${ordine.map(o => `${o.nome} (${o.iniz})`).join(', ')}.`, io);
    } else if (!c?.attivo) return;
    else if (az === 'prossimo') {
      c.turno++; if (c.turno >= c.ordine.length) { c.turno = 0; c.round++; }
      c.inizioTurno = Date.now();
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
    if (!m.togli && !m.pulisci && m.ts) await this.effettoArea(io, aree[aree.length - 1], m);
  }
  // incantesimo ad area con tiro salvezza: ogni creatura dentro tira (i dadi li tira il server), chi fallisce prende i danni pieni, chi supera la metà
  async effettoArea(io, a, m) {
    const CAR = { for: 'Forza', des: 'Destrezza', cos: 'Costituzione', int: 'Intelligenza', sag: 'Saggezza', car: 'Carisma' };
    const k = CAR[m.ts] ? m.ts : null, cd = Math.max(1, Math.min(40, m.cd | 0)); if (!k || !a) return;
    const formula = String(m.danni || '').replace(/\s+/g, '').slice(0, 12), danni = formula ? tiraFormula(formula) : null; // dadi non validi: nessun danno, resta il tiro salvezza
    const luogo = await this.get('luogo:' + await this.get('luogoAttuale')); if (!luogo) return;
    const dentro = new Set(celleArea(a, luogo).map(([x, y]) => x + ',' + y)), seg = await this.get('segnalini', {}), righe = [];
    for (const [id, s] of Object.entries(seg)) {
      if (!dentro.has(s.x + ',' + s.y) || !['pg', 'nemico'].includes(s.tipo) || s.padrone) continue;
      const pg = s.tipo === 'pg' ? await this.get('pg:' + id) : null; if (s.tipo === 'pg' && !pg) continue;
      const dichiarato = Number(m.bonusPg?.[id]);
      const bonus = pg ? Math.max(-5, Math.min(20, Number.isFinite(dichiarato) ? Math.round(dichiarato) : Math.floor(((pg.car?.[k] || 10) - 10) / 2))) : Math.max(-5, Math.min(15, Math.round(Number(m.bonusNemici)) || 2));
      const tiro = tiraFormula('d20' + (bonus ? (bonus > 0 ? '+' : '') + bonus : '')), riesce = tiro.totale >= cd;
      const q = danni ? (riesce ? (m.mezzo === false ? 0 : Math.floor(danni.totale / 2)) : danni.totale) : 0;
      righe.push(`${pg?.nome || s.nome || 'qualcuno'} ${riesce ? 'supera' : 'fallisce'} (${tiro.totale})${danni ? `, ${q} danni` : ''}`);
      if (q > 0) await this.applicaEvento(pg ? { tipo: 'danno', pg: id, quantita: q, motivo: a.nome || 'incantesimo ad area' } : { tipo: 'danno_nemico', nemico: id, quantita: q });
    }
    const ev = await this.diario('combattimento', `${a.nome || 'Area'}: tiro salvezza su ${CAR[k]}, CD ${cd}${danni ? `, danni ${formula} = ${danni.totale}` : ''}. ${righe.length ? righe.join('; ') + '.' : 'Nessuno nell\'area.'}`, io);
    this.tutti({ t: 'diario', ev });
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
    this.ctx.waitUntil(this.notaTattica(frase));
    const ev = await this.diario('parlato', `${me.nome}: ${frase}`, io);
    this.tutti({ t: 'diario', ev });
    const c = await this.get('campagna');
    if (c.masterTipo === 'ai' && me.ruolo !== 'spettatore') await this.chiamaMaster(io, me, !!m.alMaster);
  }
  // Turni a giro (fuori dal combattimento): il master risponde quando tutti i giocatori collegati hanno detto la loro, o dopo un minuto e mezzo.
  // Gioco a distanza: lo stesso giro, ma conta anche chi non è collegato e l'attesa è di ore; a chi manca arriva una notifica.
  async statoGiro() {
    const c = await this.get('campagna'); if (!(c?.giro || c?.differito) || c.masterTipo !== 'ai') return null;
    const membri = await this.get('membri', {}), detti = await this.get('giroDetti', []), on = c.differito ? Object.keys(membri) : this.online();
    const attesi = []; for (const id of on) if (membri[id]?.ruolo === 'giocatore' && await this.get('pg:' + id)) attesi.push(id);
    const mancanoId = attesi.filter(id => !detti.includes(id));
    return { detti: detti.filter(id => attesi.includes(id)), mancano: mancanoId.map(id => membri[id].nome), mancanoId, differito: c.differito || 0, scade: c.differito ? await this.get('giroScade', 0) : 0 };
  }
  // si spegne il giro mentre qualcuno aspetta: il master risponde subito a chi aveva già scritto, nessuna mossa resta senza risposta
  async sciogliGiro() { const d = await this.get('giroDetti', []); await this.put('giroDetti', []); if (d.length) await this.programmaMaster(true); }
  async chiamaMaster(io, me, subito) {
    const c = await this.get('campagna'), comb = await this.get('combattimento', null);
    if (!(c.giro || c.differito) || comb?.attivo || me.ruolo !== 'giocatore') return this.programmaMaster(subito);
    const detti = await this.get('giroDetti', []); if (!detti.includes(io)) detti.push(io); await this.put('giroDetti', detti);
    const g = await this.statoGiro(); this.tutti({ t: 'giro', giro: g });
    if (!g.mancano.length) { await this.put('giroDetti', []); await this.put('giroScade', 0); return this.programmaMaster(true); }
    if (c.differito) { // a distanza: l'orologio parte con il primo che scrive; chi manca e non è collegato riceve una notifica
      let scade = await this.get('giroScade', 0);
      if (!scade) { scade = Date.now() + c.differito * 3600000; await this.put('giroScade', scade); this.tutti({ t: 'giro', giro: { ...g, scade } }); await this.avvisaTurno(g.mancanoId); }
      const a = await this.ctx.storage.getAlarm(); if (!a || a > scade) await this.ctx.storage.setAlarm(scade);
      return;
    }
    await this.put('masterInAttesa', true);
    const gia = await this.ctx.storage.getAlarm(), limite = Date.now() + 90000;
    if (!gia || gia > limite || detti.length === 1) await this.ctx.storage.setAlarm(limite);
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
    const scade = await this.get('giroScade', 0);
    if (scade && Date.now() >= scade) { await this.put('giroScade', 0); await this.put('masterInAttesa', true); } // gioco a distanza: tempo scaduto, il master risponde a chi ha scritto
    if (await this.get('masterInAttesa', false)) {
      await this.put('masterInAttesa', false);
      await this.put('masterOccupato', true); await this.put('masterDal', Date.now());
      this.tutti({ t: 'master_pensa' });
      try { await this.turnoMaster(); } finally { await this.put('masterOccupato', false); const cg = await this.get('campagna'); if (cg?.giro || cg?.differito) { await this.put('giroDetti', []); await this.put('giroScade', 0); const g = await this.statoGiro(); this.tutti({ t: 'giro', giro: g }); if (cg.differito && g) await this.avvisaTurno(g.mancanoId); } }
    }
    if ((await this.get('daRiassumere', 0)) >= 25) await this.riassumi();
    if (await this.get('masterInAttesa', false)) return;
    await this.mandaPromemoria();
    await this.controllaSilenzio();
  }

  async contestoMaster() {
    const [c, membri, diario, memoria, attuale, luoghi] = await Promise.all([
      this.get('campagna'), this.get('membri', {}), this.get('diario', []), this.get('memoria', ''), this.get('luogoAttuale'), this.get('luoghi', {})]);
    const luogo = attuale ? await this.get('luogo:' + attuale) : null;
    const pgs = [];
    for (const [id, mm] of Object.entries(membri)) {
      if (mm.ruolo !== 'giocatore') continue;
      const p = await this.get('pg:' + id);
      if (p) pgs.push({ id, giocatore: mm.nome, nome: p.nome, storia: p.storia ? p.storia.slice(0, 400) : undefined, razza: p.razza, classe: p.classe, livello: p.livello, pf: `${p.pf}/${p.pfMax}`, ca: p.ca, caratteristiche: p.car, condizioni: p.condizioni || [], equipaggiato: (p.equip || []).filter(e => e.indossato).map(e => e.nome + (e.bonus ? ' +' + e.bonus : '')), oro: p.oro, classi: p.classi, talenti: p.talenti, incantesimi: (p.incantesimi || []).map(i => i.nome), slot_liberi: (p.slotLiberi || []).some((n, l) => l && n) ? Object.fromEntries(p.slotLiberi.map((n, l) => [`${l}° livello`, n]).filter(([k]) => k !== '0° livello')) : undefined, munizioni: (p.equip || []).filter(e => /^(Frecce|Quadrelli)\b/.test(e.nome)).map(e => `${e.nome} ×${e.qta || 1}`), aspetto: p.aspetto ? { altezza: p.aspetto.altezza, peso: p.aspetto.peso, corporatura: p.aspetto.corporatura } : undefined, mestiere: p.mestiere, compagni: p.compagni?.map(a => `${a.nome} (${a.specie})`), obiettivo_segreto: p.segreto && !p.segreto.fatto ? p.segreto.testo : undefined });
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
Quando un giocatore ha appena tirato un dado che avevi chiesto, risolvi l'esito. Con un 20 naturale racconta un momento epico da ricordare (e usa l'evento suono "raro"); con un 1 naturale un insuccesso buffo, mai umiliante.
Sii un arbitro onesto: se un tiro fallisce, l'azione fallisce davvero e ha una conseguenza (niente salvataggi all'ultimo momento, niente "ce la fai lo stesso"); i nemici giocano per vincere e i personaggi possono cadere. Non riproporre lo stesso tipo di scena o di incontro due volte di fila. Ogni avventura ha una fine: quando l'obiettivo è raggiunto o perso, chiudi con un epilogo che dica cosa è cambiato nel mondo e proponi un nuovo capitolo, invece di allungare la storia.
Decidi i fatti prima di raccontarli: quando compare qualcosa di nascosto (cosa c'è in un forziere, chi è il colpevole, cosa aspetta dietro una porta, il punto debole di un mostro) fissalo subito con l'evento "fatto" e poi rispettalo sempre. Prima di rispondere guarda "fatti_decisi" e "appunti_del_mondo": sono la verità del mondo, non cambiarli per assecondare i giocatori. I segreti scritti lì restano segreti finché il gruppo non li scopre giocando.${DIFFICOLTA[c.difficolta] ? '\n' + DIFFICOLTA[c.difficolta] : ''}
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
{"tipo":"fatto","testo":"una verità nascosta del mondo decisa adesso, max 25 parole"} (lo vedi solo tu, nei prossimi turni lo ritrovi in fatti_decisi)
{"tipo":"png_ricordo","nome":"Oste Bruno","ricordo":"cosa ha fatto il gruppo con lui o da lui, max 15 parole"} (memoria del PNG: quando il gruppo torna da lui lo saluta ricordandolo) e {"tipo":"png_nota","nome":"Oste Bruno","nota":"cosa si scopre di lui, max 15 parole"} (per la galleria dei PNG: aspetto, carattere, segreti scoperti dal gruppo; solo cose che il gruppo sa davvero)
{"tipo":"morte","pg":"<id>","motivo":"..."} (solo quando un personaggio muore davvero secondo le regole: va nel memoriale e il giocatore potrà creare un erede)
{"tipo":"missione","titolo":"...","descrizione":"...","ricompensa":"...","entro":giorni} ("entro" facoltativo: se la missione ha una scadenza nel calendario di gioco; passato il termine diventa scaduta) (missione secondaria facoltativa sulla bacheca, quando il gruppo è in una taverna, villaggio o città: 1-3 alla volta) e {"tipo":"missione_fatta","titolo":"..."}
{"tipo":"voto","domanda":"...","opzioni":["...","..."]} (quando il gruppo deve decidere insieme: ognuno vota dal telefono)
{"tipo":"enigma","domanda":"indovinello o rompicapo","risposta":"una o due parole","indizio":"..."} (porte, statue, guardiani: i giocatori rispondono dall'app)
{"tipo":"nemesi","nome":"...","descrizione":"..."} (il cattivo ricorrente: torna, si ricorda del gruppo, impara) e {"tipo":"nemesi_fuga","motivo":"..."} quando scappa per tornare più forte
{"tipo":"scelta","descrizione":"...","peso":"buona|cattiva|ambigua"} (scelte morali importanti: cambiano il finale della campagna)
{"tipo":"sogno","pg":"<id>","testo":"..."} (sogno o visione privata con un indizio segreto: la vede solo quel giocatore)
{"tipo":"privato","pg":"<id>","testo":"..."} (risposta che legge solo quel giocatore: usala per le azioni_segrete, per esempio l'esito di un furto di nascosto o di ciò che vede solo lui; nella narrazione per tutti non rivelare le azioni_segrete)
{"tipo":"riposo","lungo":true|false} (quando il gruppo riposa davvero nella storia: lungo = una notte, tornano punti ferita e slot degli incantesimi; breve = un'ora, tornano gli slot del patto)
{"tipo":"musica","umore":"tensione|mistero|festa|tristezza|calma|epica"} (cambia la musica secondo il momento della scena: un inseguimento, un funerale, una festa al villaggio; il combattimento ha già la sua musica)
{"tipo":"segreto_fatto","pg":"<id>"} (quando un personaggio realizza il suo obiettivo segreto) 
{"tipo":"minaccia","nome":"...","descrizione":"..."} (un pericolo che cresce se il gruppo lo ignora) e {"tipo":"minaccia_sventata","nome":"..."}
{"tipo":"reputazione_luogo","luogo":"nome del luogo","delta":n,"motivo":"..."} (come vi vede la gente di quel luogo: cambia i prezzi dei negozi)
{"tipo":"compagno","pg":"<id>","nome":"...","specie":"cane|lupo|falco|gatto|cavallo|pony|mulo|corvo"} (animale compagno o cavalcatura)
{"tipo":"suono","nome":"porta|colpo|magia|monete|pozione|vittoria|sconfitta|raro|ferito|successo"} (effetto sonoro su tutti i telefoni, nei momenti giusti: una porta che si apre, un colpo, un incantesimo, monete, una vittoria)
{"tipo":"nemico","nome":"Goblin","x":n,"y":n,"pf":7,"ca":15} (segnalino sulla mappa, griglia ${W}x${H})
{"tipo":"combattimento","azione":"inizia|prossimo|fine"} (inizia quando scoppia uno scontro: l'app tira l'iniziativa e gestisce i turni; "prossimo" quando un PNG o nemico ha finito il suo turno; "fine" quando lo scontro è finito)
{"tipo":"danno_nemico","nemico":"<id del segnalino>","quantita":n}
{"tipo":"png","nome":"Oste Bruno","x":n,"y":n} (mette sulla mappa un personaggio non giocante che è in scena; con "via":true lo toglie quando se ne va)
{"tipo":"bottino","oro":n,"oggetti":["..."]} (va nel tesoro comune del gruppo)
{"tipo":"fazione","nome":"Gilda dei Ladri","descrizione":"..."} (nuova fazione) e {"tipo":"reputazione","fazione":"...","delta":n,"motivo":"..."} (da -100 a +100: i PNG delle fazioni trattano il gruppo di conseguenza)
{"tipo":"tempo","giorni":n,"ora":0-23,"stagione":"primavera|estate|autunno|inverno","meteo":"sereno|nuvoloso|pioggia|temporale|neve|nebbia"} (quando passa il tempo o cambia il tempo atmosferico: la mappa mostra luce del giorno, notte, ombre del sole, pioggia, neve e nebbia; tieni coerenti ora e meteo con la narrazione)
Ogni luogo dove si parla con qualcuno ha il suo PNG con nome e volto (oste, fabbro, sacerdote...): se in png_incontrati c'è già uno con qui=true usa lui e fallo parlare ricordando ricorda_del_gruppo; dopo un'interazione importante salva un png_ricordo. I nemici intelligenti e la nemesi si adattano alle tattiche_del_gruppo più usate (resistenze, coperture, attaccano prima chi lancia incantesimi, imboscate a chi esplora da solo), senza diventare imbattibili.
Se nel contesto c'è "viaggio": racconta il viaggio a tappe (le tappe tranquille in una frase, le scoperte con un dettaglio concreto, le notti al campo); se è in_corso e c'è stato un agguato, descrivi l'agguato lungo la strada e chi attacca; all'arrivo descrivi il luogo raggiunto.\nOra e meteo cambiano la partita: di notte i PNG dormono, le botteghe sono chiuse, le guardie sospettose e i mostri più numerosi; con pioggia, nebbia o neve la vista è ridotta (svantaggio alle prove di Percezione basate sulla vista), le tracce si perdono e i viaggi sono più lenti; col temporale i fuochi si spengono e i rumori coprono i passi. Dillo nella narrazione quando conta.
Il mondo è vivo (vedi "mondo_vivo"): fai tornare la nemesi nei momenti giusti, ricordati delle scelte morali (il finale della campagna dipende da loro), fai crescere le minacce ignorate (livello 1-5: a 5 colpiscono), metti missioni sulla bacheca quando il gruppo è in città, aiuta in segreto ogni personaggio verso il suo obiettivo segreto e ogni tanto manda un sogno privato con un indizio. Se c'è un enigma aperto aspetta la risposta dei giocatori: non dire la soluzione. Se c'è un voto aperto aspetta il risultato. La casa del gruppo e i compagni animali esistono: usali nella storia.
{"tipo":"valuta","nome":"Corone di Argentea","cambio":0.5} (valuta locale e quanto vale in monete d'oro) e {"tipo":"valuta_pg","pg":"<id>","valuta":"...","quantita":n}
Durante il combattimento rispetta l'ordine di iniziativa e gioca tu i turni dei nemici quando tocca a loro.${c.sfida && !c.sfida.esito ? `
SFIDA DELLA SETTIMANA "${c.sfida.titolo}": ${c.sfida.obiettivo} È un'avventura breve per una serata: prepara subito la scena, tieni il ritmo alto e sii giusto. Quando il giocatore completa l'obiettivo usa {"tipo":"sfida_vinta"}; se il personaggio muore o la sfida non è più possibile usa {"tipo":"sfida_persa"}.` : ''}${c.solitaria ? `
PARTITA IN SOLITARIA: c'è un solo giocatore. Interpreti anche i suoi compagni alleati (${COMPAGNI.map(x => x.nome + ': ' + x.carattere).join('; ')}): falli parlare con la loro personalità, agire e combattere nel loro turno (descrivi le azioni e usa danno_nemico per i loro colpi), senza rubare la scena al giocatore. Dai qualche suggerimento in più su cosa si può fare e rispondi sempre subito.` : ''}${avv ? `
AVVENTURA PRONTA "${AVVENTURE[avv.id].titolo}": seguila (trovi scene, segreti e scena attuale in "avventura"), ma lascia libertà ai giocatori e adattala alle loro scelte. Quando il gruppo arriva alla scena successiva usa {"tipo":"avventura","scena":"<id della scena>"}: l'app li porta nel luogo e mette i nemici della scena; poi tu decidi se e quando inizia il combattimento.` : ''}${avv && AVVENTURE[avv.id].guidata ? `
PRIMA PARTITA: chi gioca non ha mai fatto un gioco di ruolo. Frasi corte, niente gergo e niente sigle. A ogni tua risposta aggiungi in fondo un solo suggerimento pratico su cosa si può fare adesso nell'app, una cosa alla volta e mai due volte la stessa: scrivere o dire a voce cosa fa il personaggio; rispondere a un personaggio; fare una prova quando la chiedi (compare il tasto Tira); toccare una casella della mappa per muoversi; in combattimento attaccare nel proprio turno e poi premere Fine turno; guardare la Scheda. Fai riuscire le idee sensate, tieni basso il pericolo e non far morire nessuno. Chiedi una prova facile (CD 10) appena arrivano in cantina. Dopo l'ultima scena chiudi l'avventura con i complimenti.` : ''}`;
    const contesto = {
      avventura: avv ? { titolo: AVVENTURE[avv.id].titolo, sinossi: AVVENTURE[avv.id].sinossi, scena_attuale: AVVENTURE[avv.id].scene[avv.scena]?.id, scene: AVVENTURE[avv.id].scene.map(x => ({ id: x.id, luogo: x.luogo, obiettivo: x.obiettivo, png: x.png, indizi: x.indizi, incontro: x.incontro?.map(n => `${n.numero} ${n.nome}`).join(', ') || null, tesoro: x.tesoro || null })), segreti: AVVENTURE[avv.id].segreti, ricompensa: AVVENTURE[avv.id].ricompensa } : undefined,
      memoria_campagna: memoria || '(inizio della campagna)',
      appunti_del_mondo: (await this.get('appunti', '')) || undefined,
      fatti_decisi: await this.get('fatti', []),
      viaggio: await (async () => { const v = await this.get('viaggio', null) || await this.get('viaggioFatto', null); if (v && !(await this.get('viaggio', null))) await this.put('viaggioFatto', null); return v ? { verso: v.verso, da: v.da, giorno: v.fatti, giorni: v.giorni, a_cavallo: v.cavallo, tappe: v.eventi, in_corso: v.fatti < v.giorni } : undefined; })(), // racconta il viaggio: le tappe tranquille in poche frasi, le scoperte con un dettaglio, l'agguato come scena
      creature_e_oggetti_inventati: await this.get('homebrew', undefined), // inventati da chi guida la campagna: usali quando la storia lo permette, con queste statistiche
      azioni_segrete: (await this.get('segretiMaster', [])).map(x => `${x.nome} (pg ${x.pg}), solo a te: ${x.testo}`),
      giro: c.differito ? 'gioco a distanza: i giocatori scrivono a ore di distanza e leggono la tua risposta più tardi. In ultimi_eventi trovi cosa ha dichiarato ognuno: risolvi tutto in una sola narrazione un po\' più ampia del solito, dai a ogni personaggio il suo momento e chiudi con la situazione chiara e una scelta aperta per ciascuno. Chi non ha scritto resta prudente sullo sfondo: non decidere al suo posto' : c.giro ? 'turni a giro: in ultimi_eventi trovi cosa ha dichiarato ogni giocatore; risolvi le azioni di tutti insieme, dando a ognuno il suo momento' : undefined,
      luogo_attuale: luogo ? { nome: luogo.nome, tipo: luogo.tipo, edifici: luogo.edifici.map(e => ({ id: e.id, nome: e.nome, stato: e.stato })), oggetti_di_scena: (luogo.oggetti || []).slice(0, 60).map(o => ({ id: o.id, tipo: o.nome || o.tipo, x: o.x, y: o.y, stato: o.stato !== 'integro' ? o.stato : undefined })), storia: (luogo.storia || []).slice(-8) } : null,
      luoghi_conosciuti: Object.values(luoghi).map(l => l.nome),
      personaggi: pgs,
      nemici_sulla_mappa: Object.entries(await this.get('segnalini', {})).filter(([, s2]) => s2.tipo === 'nemico').map(([id, s2]) => ({ id, nome: s2.nome, x: s2.x, y: s2.y, pf: s2.pf, ca: s2.ca })),
      combattimento: await this.get('combattimento', null),
      tesoro_del_gruppo: await this.get('gruppo', null),
      stagione_reale: stagione(),
      calendario_di_gioco: (c2 => c2 ? { ...c2, ...dataGioco(c2) } : null)((await this.get('mondo', {}))?.calendario), // giorno della settimana, festa di oggi o la prossima: usale nella storia
      fazioni_e_reputazione: (await this.get('mondo', {}))?.fazioni || {},
      valute_locali: (await this.get('mondo', {}))?.valute || {},
      relazioni_tra_personaggi: await this.get('relazioni', {}),
      mondo_vivo: await this.mondoVivo(true),
      png_incontrati: Object.entries(await this.get('png', {})).map(([nome, p]) => ({ nome, luogo: p.luogo, qui: !!(luogo && p.luogo === luogo.nome), ricorda_del_gruppo: p.ricordi, legami: p.legami, cosa_ha_fatto_nel_frattempo: p.novita })),
      tattiche_del_gruppo: await this.get('tattiche', {}),
      dungeon_del_giorno: await this.get('dungeonGiorno', null),
      ultimi_eventi: diario.map(d => `[${d.tipo}] ${d.testo}`)
    };
    const lezioni = await this.lezioniMaster(), silenzio = this.silenzio; this.silenzio = false;
    const istrTot = istr + (lezioni.length ? `\nMANUALE DEL MASTER (lezioni imparate in tutte le partite: seguile):\n- ${lezioni.join('\n- ')}` : '') + (silenzio ? '\nIL TAVOLO È IN SILENZIO DA QUALCHE MINUTO: fai succedere qualcosa di piccolo e interessante che inviti i giocatori ad agire (un rumore, un PNG che si avvicina, un dettaglio nuovo). Breve, 2-3 frasi, niente danni e niente combattimenti.' : '');
    const r = await this.g({
      systemInstruction: { parts: [{ text: istrTot }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(contesto) }] }],
      generationConfig: { temperature: 0.85, responseMimeType: 'application/json' }
    });
    if (!r.ok) { this.tutti({ t: 'avviso', msg: r.status === 429 ? 'Il master AI ha finito la quota di oggi: intanto il master improvvisa con le battute di riserva' : `Il master AI non risponde (${r.status}): intanto improvviso io`, errore: true }); return this.battutaDiRiserva(luogo, silenzio); }
    await this.put('segretiMaster', []); // il master le ha lette: al prossimo turno non tornano (se il master non risponde restano per il turno dopo)
    const j = await r.json();
    const out = leggiJSON(j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    if (!out) { await this.impara(['Rispondi sempre e solo con il JSON richiesto (narrazione, png, eventi), senza testo fuori dal JSON.'], []); return; }
    const narr = testo(out.narrazione, 1500).trim();
    const noti = new Set(TIPI_EVENTO), ignoti = (Array.isArray(out.eventi) ? out.eventi : []).map(e => e?.tipo).filter(t => t && !noti.has(t));
    if (ignoti.length) await this.impara([`Usa solo i tipi di evento dell'elenco: "${[...new Set(ignoti)].slice(0, 3).join('", "')}" non esiste.`], []);
    for (const e of (Array.isArray(out.eventi) ? out.eventi.slice(0, 16) : [])) { try { await this.applicaEvento(e); } catch {} }
    const nomePng = testo(out.png, 40).trim();
    if (narr && nomePng) { // memoria dei PNG: lo stesso personaggio non cambia nome tra un turno e l'altro
      const png = await this.get('png', {});
      png[nomePng] = { ...png[nomePng], luogo: png[nomePng]?.luogo || luogo?.nome || null, t: Date.now(), prima: png[nomePng]?.prima || Date.now() };
      const nomi = Object.keys(png).sort((a, b) => png[b].t - png[a].t).slice(0, 40); // shortcut: solo gli ultimi 40, la memoria lunga li riassume
      await this.put('png', Object.fromEntries(nomi.map(n => [n, png[n]])));
    }
    if (narr) {
      const ev = await this.diario('narrazione', narr, 'master');
      if (silenzio) { const d = await this.get('diario', []); const x = d.find(y => y.t === ev.t && y.testo === ev.testo); if (x) { x.silenzio = true; await this.put('diario', d); } }
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
      case 'privato': { const p = await this.get('pg:' + e.pg), t2 = testo(e.testo, 500).trim(); if (!p || !t2) return; return this.invia(this.wsDi(e.pg), { t: 'sussurro', da: 'master', a: e.pg, nome: 'Il master', perNome: p.nome, testo: t2, quando: Date.now() }); }
      case 'riposo': { // il gruppo riposa nella storia: si aggiornano tutte le schede (slot liberi = quelli che c'erano più quelli spesi)
        const membri = await this.get('membri', {});
        for (const [id, mm] of Object.entries(membri)) {
          if (mm.ruolo !== 'giocatore' || !(await this.get('pg:' + id))) continue;
          await pgMod(id, p => {
            const us = p.slotUsati || [], lib = p.slotLiberi || [];
            if (e.lungo) { p.pf = p.pfMax; p.ferite = []; p.condizioni = (p.condizioni || []).filter(c => c === 'invisibile'); p.slotLiberi = lib.map((n, l) => (n || 0) + (us[l] || 0)); p.slotUsati = []; }
            else if (p.patto) { const l = p.patto.livello; lib[l] = (lib[l] || 0) + (us[l] || 0); us[l] = 0; p.slotLiberi = lib; p.slotUsati = us; }
          }, e.lungo ? 'riposo lungo: tornano punti ferita e slot degli incantesimi' : 'riposo breve');
        }
        return;
      }
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
      case 'suono': if (SUONI.includes(e.nome)) this.tutti({ t: 'suono', nome: e.nome }); return;
      case 'musica': if (['tensione', 'mistero', 'festa', 'tristezza', 'calma', 'epica'].includes(e.umore)) this.tutti({ t: 'musica', umore: e.umore }); return;
      case 'fatto': { const t = testo(e.testo, 200).trim(); if (!t) return; const f = await this.get('fatti', []); if (!f.includes(t)) { f.push(t); await this.put('fatti', f.slice(-40)); } return; }
      case 'sfida_vinta': case 'sfida_persa': { const c = await this.get('campagna'); if (!c.sfida || c.sfida.esito) return; c.sfida.esito = e.tipo === 'sfida_vinta' ? 'vinta' : 'persa'; await this.put('campagna', c); await this.annuncia(c.sfida.esito === 'vinta' ? `Sfida della settimana vinta: ${c.sfida.titolo}!` : `Sfida della settimana persa: ${c.sfida.titolo}. Riprova la prossima volta!`); return this.tutti({ t: 'sfida', sfida: c.sfida }); }
      case 'missione': case 'missione_fatta': case 'voto': case 'enigma': case 'nemesi': case 'nemesi_fuga': case 'scelta': case 'sogno': case 'segreto_fatto': case 'minaccia': case 'minaccia_sventata': case 'reputazione_luogo': case 'compagno': return this.eventoMondo(e);
      case 'png_ricordo': { const png = await this.get('png', {}), n = testo(e.nome, 40); if (!n || !e.ricordo) return; png[n] = { ...png[n], t: png[n]?.t || Date.now(), ricordi: [...(png[n]?.ricordi || []), testo(e.ricordo, 140)].slice(-6) }; await this.put('png', png); return this.tutti({ t: 'png', png }); }
      case 'png_nota': { const png = await this.get('png', {}), n = testo(e.nome, 40); if (!n || !e.nota) return; png[n] = { ...png[n], luogo: png[n]?.luogo || null, t: png[n]?.t || Date.now(), note: [...(png[n]?.note || []), testo(e.nota, 120)].slice(-6) }; await this.put('png', png); return this.tutti({ t: 'png', png }); }
      case 'morte': { const d = await this.get('dungeonGiorno', null), qui = await this.get('luogo:' + await this.get('luogoAttuale')); if (d?.custode && qui?.nome === d.luogo) await this.eventoMondo({ tipo: 'nemesi', nome: d.custode, descrizione: `il custode di ${d.luogo}: ha sconfitto il gruppo e se ne ricorda` }); return this.caduto(String(e.pg || ''), testo(e.motivo, 200)); }
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
      case 'tempo': { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); const cal = mo.calendario || { giorno: 1, stagione: 'primavera' }; const primaG = cal.giorno || 1; cal.giorno = primaG + Math.max(0, Math.min(365, Number(e.giorni) || 0)); cal.inizioStagione = cal.inizioStagione || 1;
        if (STAGIONI.includes(e.stagione) && e.stagione !== cal.stagione) { cal.stagione = e.stagione; cal.inizioStagione = cal.giorno; } // il master cambia stagione: da oggi si conta da capo
        else while (cal.giorno - cal.inizioStagione >= 30) { cal.inizioStagione += 30; cal.stagione = STAGIONI[(STAGIONI.indexOf(cal.stagione) + 1) % 4] || 'primavera'; } // passati 30 giorni la stagione cambia da sola
        const festa = dataGioco(cal).festa; if (festa && cal.giorno !== primaG) await this.annuncia(`Oggi è la ${festa}!`);
        { const l = await this.get('missioni', []); let cambio = false; for (const q of l) if (q.stato !== 'completata' && q.stato !== 'scaduta' && q.scadenza && cal.giorno > q.scadenza) { q.stato = 'scaduta'; cambio = true; await this.annuncia(`Missione scaduta: ${q.titolo}.`); } if (cambio) { await this.put('missioni', l); await this.aggiornaMondo(); } } if (e.ora !== undefined && e.ora !== null && e.ora !== '') cal.ora = Math.max(0, Math.min(23, Number(e.ora) | 0)); if (['sereno', 'nuvoloso', 'pioggia', 'temporale', 'neve', 'nebbia'].includes(e.meteo)) cal.meteo = e.meteo; mo.calendario = cal; await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); return; }
      case 'valuta': { const mo = await this.get('mondo', { fazioni: {}, valute: {}, viaggi: [], notizie: [] }); const v = testo(e.nome, 40); if (!v) return; mo.valute[v] = { cambio: Math.max(0.001, Number(e.cambio) || 1) }; await this.put('mondo', mo); this.tutti({ t: 'mondo', mondo: mo }); return; }
      case 'valuta_pg': return pgMod(e.pg, p => { p.valute = { ...(p.valute || {}), [testo(e.valuta, 40)]: Math.max(0, (p.valute?.[e.valuta] || 0) + (Number(e.quantita) || 0)) }; }, `${Number(e.quantita) >= 0 ? 'ottiene' : 'spende'} ${Math.abs(Number(e.quantita) || 0)} ${testo(e.valuta, 40)}`);
      case 'combattimento': return this.combattimento('master', { nome: 'Master' }, true, { azione: ['inizia', 'prossimo', 'fine'].includes(e.azione) ? e.azione : 'inizia' });
      case 'bottino': { if (e.oro) await this.gruppo('master', { nome: 'Il master' }, { op: 'oro', delta: Number(e.oro) || 0 }); for (const o of (Array.isArray(e.oggetti) ? e.oggetti.slice(0, 6) : [])) await this.gruppo('master', { nome: 'Il master' }, { op: 'oggetto', nome: String(o), qta: 1 }); return; }
      case 'danno_nemico': {
        const seg = await this.get('segnalini', {}); const s2 = seg[e.nemico]; if (!s2) return;
        s2.pf = (s2.pf ?? 10) - n;
        if (s2.pf <= 0) { await this.conta('gruppo', { nemici: 1 }); await this.bestia(s2.nome, 'sconfitti'); delete seg[e.nemico]; const c = await this.get('combattimento'); if (c?.attivo) await this.combattimento('master', {}, true, { azione: 'togli', id: e.nemico }); const ev = await this.diario('combattimento', `${s2.nome} è sconfitto.`, 'master'); this.tutti({ t: 'diario', ev }); }
        await this.put('segnalini', seg); this.tutti({ t: 'segnalini', segnalini: seg }); return;
      }
      case 'png': return e.via ? this.segnalino('master', true, { id: 'p_' + testo(e.nome, 20).replace(/\W+/g, '_'), rimuovi: true }) : this.segnalino('master', true, { id: 'p_' + testo(e.nome, 20).replace(/\W+/g, '_'), x: e.x, y: e.y, nome: testo(e.nome, 40), colore: '#bfae86', tipo: 'png' });
      case 'nemico': this.ctx.waitUntil(this.disegnaMostro(e.nome)); await this.bestia(e.nome, 'visti'); return this.segnalino('master', true, { id: 'n_' + testo(e.nome, 20).replace(/\W+/g, '_') + '_' + (e.x | 0) + '_' + (e.y | 0), x: e.x, y: e.y, nome: e.nome, colore: '#d84b3c', tipo: 'nemico', pf: Number(e.pf) || undefined, ca: Number(e.ca) || undefined });
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
PNG conosciuti: ${JSON.stringify(Object.entries(await this.get('png', {})).slice(0, 20).map(([nome, p]) => ({ nome, luogo: p.luogo, legami: p.legami })))}
Per 1-3 PNG importanti decidi cosa hanno fatto nel frattempo e che legami hanno tra loro (amici, rivali, mentore e allievo, parenti, innamorati, nemici).
Rispondi SOLO JSON: {"png":[{"nome":"...","novita":"una frase","legame":{"con":"altro PNG","tipo":"..."}}],"notizie":"testo di massimo 80 parole da leggere ad alta voce, come un banditore","edifici":[{"luogo":"<id>","edificio":"<id>","stato":"integro|danneggiato|bruciato|distrutto"}],"fazioni":[{"nome":"...","delta":n}]}` }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }, 'mondo');
    if (!r.ok) return;
    const out = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
    if (!out) return;
    for (const e of (out.edifici || []).slice(0, 6)) await this.modificaLuogo('master', {}, true, { luogo: e.luogo, edificio: e.edificio, stato: e.stato });
    for (const f of (out.fazioni || []).slice(0, 4)) await this.applicaEvento({ tipo: 'reputazione', fazione: f.nome, delta: f.delta, motivo: 'tra una sessione e l\'altra' });
    const png = await this.get('png', {}); let cambiati = 0;
    for (const v of (Array.isArray(out.png) ? out.png : []).slice(0, 3)) { const p = png[testo(v.nome, 40)]; if (!p) continue; p.novita = testo(v.novita, 200); p.novitaSessione = c.sessione; const con = testo(v.legame?.con, 40), tipo = testo(v.legame?.tipo, 30); if (con && tipo && con !== v.nome) p.legami = [...(p.legami || []).filter(l => l.con !== con), { con, tipo }].slice(-4); cambiati++; }
    if (cambiati) { await this.put('png', png); this.tutti({ t: 'png', png }); }
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
      const domanda = `Ambientazione D&D: ${c.ambientazione}. Descrivi l'interno di "${ed.nome}" nel luogo "${padre.nome}"${ed.stato !== 'integro' ? ' (' + ed.stato + ')' : ''}. Rispondi SOLO JSON: {"descrizione":"massimo 60 parole in italiano, da leggere ad alta voce","stanze":["nome stanza 1", "... fino a 6 nomi brevi in italiano"],"png":"nome e ruolo di chi si trova dentro, o vuoto"}`;
      // si entra subito: se l'IA che descrive l'interno tarda più di 10 secondi si usano stanze qualsiasi, e la descrizione arriva appena è pronta
      const descrivi = (async () => { let info = null;
        if (this.env.AI) { try { const o = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: domanda }], max_tokens: 400 }); info = leggiJSON(o?.response || ''); if (info) info.da = 'cloudflare'; } catch {} }
        if (!info) { const r = await this.g({ contents: [{ parts: [{ text: domanda }] }], generationConfig: { temperature: 0.8, responseMimeType: 'application/json' } }, 'racconto'); if (r.ok) { info = leggiJSON((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''); if (info) info.da = 'gemini'; } }
        return info; })();
      let info = await Promise.race([descrivi, new Promise(r => setTimeout(() => r('tardi'), 10000))]); const tardi = info === 'tardi'; if (tardi) info = null;
      if (tardi) this.ctx.waitUntil(descrivi.then(async inf => { if (!inf?.descrizione) return; const l2 = await this.get('luogo:' + id); if (!l2 || l2.descrizione) return; l2.descrizione = testo(inf.descrizione, 600); l2.png = l2.png || testo(inf.png, 60); l2.generatoDa = inf.da; await this.put('luogo:' + id, l2); if (await this.get('luogoAttuale') === id) { const ev = await this.diario('narrazione', l2.descrizione, 'master'); this.tutti({ t: 'narra', testo: ev.testo, png: '', chi: 'master' }); } }).catch(() => {}));
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
    const r = await this.g({ contents: [{ parts: [{ text: `Aggiorna la memoria di una campagna di D&D. Memoria attuale:\n${memoria || '(vuota)'}\n\nNuovi eventi:\n${diario.slice(-60).map(d => `[${d.tipo}] ${d.testo}`).join('\n')}\n\nScrivi la memoria aggiornata in italiano, massimo 350 parole, in punti brevi: trama, PNG incontrati (nome, ruolo, atteggiamento), promesse e debiti, nemici, luoghi e come sono cambiati, fazioni e reputazione del gruppo, stile di gioco preferito dal gruppo. Solo il testo.\nPoi, su una riga nuova che comincia con ===CRONACA===, scrivi la cronaca per i giocatori: massimo 160 parole, in punti brevi che cominciano con "• ", solo ciò che i personaggi hanno vissuto e sanno davvero (niente segreti del master, niente note di preparazione, niente trame nascoste).` }] }], generationConfig: { temperature: 0.2 } }, 'memoria');
    if (!r.ok) return;
    const j = await r.json();
    const tutto = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '', [t, cron] = tutto.split(/\n?={2,}\s*CRONACA\s*={2,}\n?/i).map(x => (x || '').trim());
    if (t) { await this.put('memoria', testo(t, 6000)); await this.put('daRiassumere', 0); }
    if (cron) { await this.put('cronaca', testo(cron, 3000)); this.tutti({ t: 'cronaca', cronaca: testo(cron, 3000) }); }
    await this.estraiLezioni(diario);
  }

  async inviaRiassunto(ws, formato) {
    const memoria = await this.get('memoria', '');
    const diario = await this.get('diario', []);
    const COME = { completo: 'un riassunto completo di massimo 220 parole, in ordine di tempo, fedele ai fatti', cantastorie: 'un riassunto di massimo 110 parole nello stile di un cantastorie di piazza, con qualche rima e un tono epico', breve: 'un "Nella puntata precedente..." di massimo 90 parole' };
    const r = await this.g({ contents: [{ parts: [{ text: `Sei il narratore di una campagna di D&D. Scrivi in italiano ${COME[formato] || COME.breve}, da leggere ad alta voce (solo il testo da dire: niente indicazioni di tono, niente asterischi o titoli). Racconta solo cose successe davvero nella campagna: non inventare niente. Basati su:\n${memoria}\n${diario.slice(-30).map(d => d.testo).join('\n')}` }] }], generationConfig: { temperature: 0.7 } }, 'riassunto');
    if (!r.ok) return this.invia(ws, { t: 'errore', msg: 'riassunto non disponibile' });
    const j = await r.json();
    const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    this.tutti({ t: 'narra', testo: senzaRegia(t) || 'Nessuna avventura ancora da raccontare.', chi: 'master', riassunto: true });
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
