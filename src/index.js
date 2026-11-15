// Ricevitore rapporti delle app di Vincenzo (Cloudflare Worker).
// Riceve rapporti GIÀ CIFRATI dalle app e li salva nel repository privato <App>-rapporti su GitHub.
// POST https://<worker>/r/<App>   corpo: oggetto o array di { key, iv, data, ... }
// Segreto richiesto: GITHUB_TOKEN (fine-grained, Contents: read and write sui repository *-rapporti).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const risposta = (stato, corpo) => new Response(JSON.stringify(corpo), { status: stato, headers: { ...CORS, 'Content-Type': 'application/json' } });
const MAX = 1024 * 1024; // 1 MB per invio

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/salute')) return risposta(200, { ok: true, servizio: 'rapporti', token: !!env.GITHUB_TOKEN, assistente: !!env.GEMINI_KEY });
    if (req.method === 'POST' && url.pathname === '/chiedi') return chiedi(req, env);
    if (req.method === 'POST' && url.pathname === '/gemini') return gemini(req, env);
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
  const modello = env.GEMINI_MODEL || 'gemini-flash-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modello)}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: istruzioni }] }, contents: [{ role: 'user', parts: [{ text: `Domanda: ${domanda}\n\nContesto dall'app:\n${contesto}` }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } })
  });
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
  const modello = env.GEMINI_MODEL || 'gemini-flash-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modello)}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } })
  });
  if (!r.ok) return risposta(502, { errore: 'gemini', stato: r.status });
  const j = await r.json();
  return risposta(200, { testo: j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '' });
}
