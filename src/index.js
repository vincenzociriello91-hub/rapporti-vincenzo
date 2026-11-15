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
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/salute')) return risposta(200, { ok: true, servizio: 'rapporti', token: !!env.GITHUB_TOKEN });
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
