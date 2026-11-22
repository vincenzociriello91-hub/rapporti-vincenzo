// Ricevitore rapporti delle app di Vincenzo (Cloudflare Worker).
// Riceve rapporti GIÀ CIFRATI dalle app e li salva nel repository privato <App>-rapporti su GitHub.
// POST https://<worker>/r/<App>   corpo: oggetto o array di { key, iv, data, ... }
// Segreto richiesto: GITHUB_TOKEN (fine-grained, Contents: read and write sui repository *-rapporti).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const risposta = (stato, corpo) => new Response(JSON.stringify(corpo), { status: stato, headers: { ...CORS, 'Content-Type': 'application/json' } });
const MAX = 1024 * 1024; // 1 MB per invio
import { Tavolo, apriTavolo } from './tavolo.js';
export { Tavolo }; // stanze di gioco di Tavolo d'Avventura (Durable Object)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/salute')) return risposta(200, { ok: true, servizio: 'rapporti', token: !!env.GITHUB_TOKEN, assistente: !!env.GEMINI_KEY });
    if (req.method === 'POST' && url.pathname === '/chiedi') return chiedi(req, env);
    if (req.method === 'POST' && url.pathname === '/gemini') return gemini(req, env);
    if (req.method === 'GET' && url.pathname === '/prova-assistente') return provaAssistente(env);
    const md = url.pathname.match(/^\/tavolo\/([A-Za-z0-9]{6,12})\/media\/(voce|img)\/[a-z0-9]{4,30}$/);
    if (req.method === 'GET' && md) return env.TAVOLO.get(env.TAVOLO.idFromName(md[1].toUpperCase())).fetch(req);
    // grafica comprata (privata): solo per chi è membro della campagna
    const gr = url.pathname.match(/^\/tavolo\/([A-Za-z0-9]{6,12})\/grafica\/atlante\.(png|json)$/);
    if (req.method === 'GET' && gr) return env.TAVOLO.get(env.TAVOLO.idFromName(gr[1].toUpperCase())).fetch(req);
    const t = url.pathname.match(/^\/tavolo\/([A-Za-z0-9]{6,12})\/ws$/);
    if (req.method === 'GET' && t) return apriTavolo(req, env, t[1]);
    if (req.method === 'GET' && url.pathname === '/turn') return turn(req, env);
    if (url.pathname === '/mcp') return mcp(req, env, url);
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{2,40})$/);
    if (req.method !== 'POST' || !m) return risposta(404, { errore: 'percorso' });
    if (!env.GITHUB_TOKEN) return risposta(500, { errore: 'GITHUB_TOKEN mancante' });
    const app = m[1];
    const consentite = (env.APP_CONSENTITE || '').split(',').map(s => s.trim()).filter(Boolean);
    if (consentite.length && !consentite.includes(app)) return risposta(403, { errore: 'app non consentita' });
    const testo = await req.text();
    if (testo.length > MAX) return risposta(413, { errore: 'troppo grande' });
    let dati; try { dati = JSON.parse(testo); } catch { return risposta(400, { errore: 'JSON non valido' }); }
    const lista = Array.isArray(dati) ? dati : [dati];
    // Accetta solo rapporti cifrati: niente testo in chiaro nel repository
    if (!lista.length || lista.length > 50 || !lista.every(x => x && typeof x.key === 'string' && typeof x.iv === 'string' && typeof x.data === 'string')) return risposta(400, { errore: 'formato' });
    const owner = env.OWNER || 'vincenzociriello91-hub';
    const repo = `${app}-rapporti`;
    const ora = new Date();
    const giorno = ora.toISOString().slice(0, 10);
    const nome = `rapporti/${giorno}/${ora.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`;
    const contenuto = btoa(unescape(encodeURIComponent(JSON.stringify(lista))));
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${nome}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rapporti-worker', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ message: `Rapporto ${app} ${ora.toISOString()}`, content: contenuto })
    });
    if (!r.ok) return risposta(502, { errore: 'github', stato: r.status });
    return risposta(201, { ok: true, salvati: lista.length, file: nome });
  }
};


// Chiamata a Gemini: pensiero ridotto per rispondere in pochi secondi; se il modello non accetta l'opzione, riprova senza.
async function chiamaGemini(env, corpo) {
  // Se un modello è sovraccarico (503/429) o non esiste (404), passa al successivo.
  const modelli = [...new Set([env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'])];
  let r;
  for (const modello of modelli) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modello)}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`;
    const invia = c => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    r = await invia({ ...corpo, generationConfig: { ...corpo.generationConfig, thinkingConfig: { thinkingBudget: 0 } } });
    if (r.status === 400) r = await invia(corpo);
    if (![404, 429, 500, 503].includes(r.status)) { r.modello = modello; return r; }
  }
  return r;
}

// Assistente: domanda in parole normali → risposta di Gemini (la chiave resta qui, mai nell'app)
// POST /chiedi  { domanda, contesto }  → { risposta, prodotti: [{desc,qta,um}] }
const ORIGINI = ['https://vincenzociriello91-hub.github.io', 'http://localhost:8765'];
async function chiedi(req, env) {
  if (!env.GEMINI_KEY) return risposta(503, { errore: 'GEMINI_KEY mancante' });
  const origine = req.headers.get('Origin') || '';
  if (!ORIGINI.includes(origine)) return risposta(403, { errore: 'origine' });
  let b; try { b = JSON.parse(await req.text()); } catch { return risposta(400, { errore: 'JSON' }); }
  const domanda = String(b.domanda || '').slice(0, 600).trim();
  const contesto = String(b.contesto || '').slice(0, 8000);
  if (domanda.length < 2) return risposta(400, { errore: 'domanda vuota' });
  const istruzioni = `Sei l'assistente del banco di un grossista di materiale elettrico in Italia (Elettrocampania).
Rispondi in italiano semplice, adatto anche a un privato che non è del mestiere, ma preciso per un elettricista.
Capisci cosa vuole davvero chi chiede, anche se la domanda è scritta male o è vaga.
Dai una risposta pratica e breve (massimo 120 parole): cosa serve, quale misura o modello, quante unità, a cosa fare attenzione.
Se un dato essenziale manca, dai comunque la risposta più probabile e indica in una frase quale dato serve per essere sicuri.
Per lavori su impianti fissi ricorda, solo se pertinente, che l'installazione va fatta da un elettricista abilitato.
Usa i dati del contesto (sono tabelle e calcoli dell'app) quando servono; non inventare codici articolo.
Rispondi SOLO con JSON: {"risposta":"testo","prodotti":[{"desc":"descrizione breve del prodotto","qta":numero,"um":"pz|m|conf"}]}`;
  const r = await chiamaGemini(env, { systemInstruction: { parts: [{ text: istruzioni }] }, contents: [{ role: 'user', parts: [{ text: `Domanda: ${domanda}\n\nContesto dall'app:\n${contesto}` }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } });
  if (!r.ok) return risposta(502, { errore: 'gemini', stato: r.status });
  const j = await r.json();
  const testo = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  try { const o = JSON.parse(testo.match(/\{[\s\S]*\}/)[0]); return risposta(200, { risposta: String(o.risposta || ''), prodotti: Array.isArray(o.prodotti) ? o.prodotti.slice(0, 20) : [] }); }
  catch { return risposta(200, { risposta: testo.slice(0, 2000), prodotti: [] }); }
}

// Foto del pezzo e Ascolto: testo (+ fino a 4 foto JPEG) → testo di Gemini, con la chiave lato server
// POST /gemini  { testo, immagini: [base64] }  → { testo }
async function gemini(req, env) {
  if (!env.GEMINI_KEY) return risposta(503, { errore: 'GEMINI_KEY mancante' });
  if (!ORIGINI.includes(req.headers.get('Origin') || '')) return risposta(403, { errore: 'origine' });
  let b; try { b = JSON.parse(await req.text()); } catch { return risposta(400, { errore: 'JSON' }); }
  const testo = String(b.testo || '').slice(0, 6000);
  const immagini = (Array.isArray(b.immagini) ? b.immagini : []).slice(0, 4).filter(x => typeof x === 'string' && x.length < 2000000);
  if (testo.length < 2) return risposta(400, { errore: 'testo vuoto' });
  const parts = [{ text: testo }, ...immagini.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))];
  const r = await chiamaGemini(env, { contents: [{ parts }], generationConfig: { temperature: 0.2 } });
  if (!r.ok) return risposta(502, { errore: 'gemini', stato: r.status });
  const j = await r.json();
  return risposta(200, { testo: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '' });
}

// Diagnostica: una domanda fissa, restituisce esito e tempo (per controllare che Gemini risponda)
async function provaAssistente(env) {
  if (!env.GEMINI_KEY) return risposta(503, { errore: 'GEMINI_KEY mancante' });
  const t0 = Date.now();
  const r = await chiamaGemini(env, { contents: [{ parts: [{ text: 'Rispondi solo: ok' }] }], generationConfig: { temperature: 0 } });
  const testo = r.ok ? ((await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') : (await r.text()).slice(0, 300);
  return risposta(200, { stato: r.status, ms: Date.now() - t0, modello: r.modello || '-', testo });
}


// Server di inoltro per la voce (Cloudflare Realtime TURN): credenziali brevi per le app.
// Segreti facoltativi: TURN_KEY_ID e TURN_API_TOKEN. Senza, l'app usa solo STUN.
async function turn(req, env) {
  const stun = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (!['https://vincenzociriello91-hub.github.io', 'http://localhost:8765'].includes(req.headers.get('Origin') || '')) return risposta(403, { errore: 'origine' });
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return risposta(200, { iceServers: stun, turn: false });
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, { method: 'POST', headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) });
  if (!r.ok) return risposta(200, { iceServers: stun, turn: false, stato: r.status });
  const j = await r.json();
  return risposta(200, { iceServers: [...stun, ...(Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers])], turn: true });
}

// Connettore "D&D" per Claude (MCP su HTTP): legge le campagne e aiuta a preparare le sessioni.
// Segreto MCP_CHIAVE: l'indirizzo del connettore è /mcp?chiave=<MCP_CHIAVE>
const STRUMENTI = [
  { name: 'manuale_master', description: "Manuale di esperienza del master AI di Tavolo d'Avventura: lezioni imparate in tutte le partite e problemi segnalati dai telefoni e dalla partita bot.", inputSchema: { type: 'object', properties: {} } },
  { name: 'stato_campagna', description: "Stato di una campagna di Tavolo d'Avventura: membri, personaggi, luoghi, memoria del master, fazioni, tesoro, uso dell'AI, suggerimenti.", inputSchema: { type: 'object', properties: { codice: { type: 'string', description: 'Codice della campagna (8 caratteri)' } }, required: ['codice'] } },
  { name: 'diario_campagna', description: 'Ultimi eventi del diario della campagna.', inputSchema: { type: 'object', properties: { codice: { type: 'string' }, n: { type: 'number', description: 'Quanti eventi (max 200)' } }, required: ['codice'] } },
  { name: 'nota_preparazione', description: 'Aggiunge una nota di preparazione alla memoria del master AI (trame, PNG, segreti per la prossima sessione).', inputSchema: { type: 'object', properties: { codice: { type: 'string' }, testo: { type: 'string' } }, required: ['codice', 'testo'] } },
  { name: 'prepara_luogo', description: 'Crea in anticipo un luogo con la sua mappa (citta, villaggio, taverna, dungeon, foresta, grotta, castello, porto, aperto).', inputSchema: { type: 'object', properties: { codice: { type: 'string' }, nome: { type: 'string' }, tipo: { type: 'string' } }, required: ['codice', 'nome'] } },
  { name: 'imposta_fazione', description: 'Crea o aggiorna una fazione e la reputazione del gruppo con essa.', inputSchema: { type: 'object', properties: { codice: { type: 'string' }, nome: { type: 'string' }, descrizione: { type: 'string' }, delta: { type: 'number' }, motivo: { type: 'string' } }, required: ['codice', 'nome'] } }
];
async function mcp(req, env, url) {
  if (!env.MCP_CHIAVE) return risposta(503, { errore: 'connettore non attivo: manca MCP_CHIAVE' });
  if (url.searchParams.get('chiave') !== env.MCP_CHIAVE) return risposta(401, { errore: 'chiave' });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let m; try { m = await req.json(); } catch { return risposta(400, { errore: 'JSON' }); }
  const ok = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'Content-Type': 'application/json' } });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tavolo-davventura', version: '1.0.0' } });
  if (m.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
  if (m.method === 'ping') return ok({});
  if (m.method === 'tools/list') return ok({ tools: STRUMENTI });
  if (m.method === 'tools/call') {
    const a = m.params?.arguments || {}, nome = m.params?.name;
    if (nome === 'manuale_master') { const r = await env.TAVOLO.get(env.TAVOLO.idFromName('__MANUALE__')).fetch('https://tavolo/interno', { method: 'POST', headers: { 'x-tavolo-interno': '1' }, body: JSON.stringify({ azione: 'manuale_leggi' }) }); return ok({ content: [{ type: 'text', text: JSON.stringify(await r.json(), null, 1).slice(0, 60000) }] }); }
    const codice = String(a.codice || '').toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(codice)) return ok({ content: [{ type: 'text', text: 'Codice campagna non valido' }], isError: true });
    const azione = { stato_campagna: 'stato', diario_campagna: 'diario', nota_preparazione: 'nota', prepara_luogo: 'prepara_luogo', imposta_fazione: 'fazione' }[nome];
    if (!azione) return ok({ content: [{ type: 'text', text: 'Strumento sconosciuto' }], isError: true });
    const stub = env.TAVOLO.get(env.TAVOLO.idFromName(codice));
    const r = await stub.fetch('https://tavolo/interno', { method: 'POST', headers: { 'x-tavolo-interno': '1' }, body: JSON.stringify({ azione, ...a }) });
    return ok({ content: [{ type: 'text', text: JSON.stringify(await r.json(), null, 1).slice(0, 60000) }] });
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'metodo sconosciuto' } }), { headers: { 'Content-Type': 'application/json' } });
}
