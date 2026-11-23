// Tavolo d'Avventura: intelligenza artificiale (Gemini con i modelli in fila, voce, Claude, immagini).
import { testo } from './tavolo-util.js';
// ---------- Gemini (modelli in fila: se uno è sovraccarico si passa al successivo) ----------
// per 10 minuti si riparte dall'ultimo modello che ha risposto (gli altri possono essere esauriti o lenti)
export const BUONI = {};
export async function chiamaGemini(env, corpo, leggero) {
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
export const VOCI_PNG = ['Algenib', 'Fenrir', 'Puck', 'Kore', 'Leda', 'Orus', 'Aoede', 'Enceladus', 'Gacrux', 'Umbriel', 'Zephyr', 'Iapetus'];
export async function sintesiVocale(env, testoV, png) {
  if (!env.GEMINI_KEY) return null;
  const h = [...String(png || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const voceNome = png ? VOCI_PNG[h % VOCI_PNG.length] : (env.VOCE_NARRATORE || 'Charon');
  const stile = png ? `Recita in italiano dando voce a ${png}, con il tono adatto al personaggio:` : 'Leggi in italiano come il narratore di un\'avventura fantasy, con voce calda, espressiva e coinvolgente:';
  // i modelli 3.8 leggono parola per parola tutto il testo (anche la regia): a loro va solo la battuta, ai modelli più vecchi la regia davanti
  const corpo = m => ({ contents: [{ parts: [{ text: /^gemini-3\.8/.test(m) ? testo(testoV, 1500) : `${stile}\n${testo(testoV, 1500)}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voceNome } } } } });
  for (const modello of [...new Set([env.GEMINI_TTS, 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))]) {
    const r = await fetch(`${env.GEMINI_BASE || 'https://generativelanguage.googleapis.com'}/v1beta/models/${modello}:generateContent?key=${encodeURIComponent(env.GEMINI_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo(modello)) });
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
export const STILE_IMG = 'Realistic cinematic fantasy illustration, Dungeons and Dragons, dramatic volumetric lighting, highly detailed, painterly realism, no text, no watermark. ';
// stile delle illustrazioni a scelta di chi crea la campagna (Altro → Campagna)
export const STILI_IMG = {
  realistico: STILE_IMG,
  acquerello: 'Soft watercolor fantasy illustration, storybook art, delicate washes, visible paper texture, warm light, no text, no watermark. ',
  fumetto: 'Comic book fantasy illustration, bold ink outlines, cel shading, vivid flat colors, dynamic composition, no text, no speech bubbles, no watermark. ',
  pixel: '16-bit pixel art fantasy scene, SNES era JRPG style, limited color palette, crisp pixels, detailed sprites and tiles, no text, no watermark. ',
  inchiostro: 'Black ink and sepia fantasy illustration, old manuscript engraving, fine crosshatching, parchment paper, no text, no watermark. ',
  olio: 'Classical oil painting, fantasy scene, old masters chiaroscuro, rich brushwork, museum quality, no text, no watermark. '
};
export async function generaImmagine(env, prompt, piccola, stile = STILE_IMG) {
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
export async function chiamaClaude(env, corpo) {
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
export function leggiJSON(t) { try { return JSON.parse(t); } catch {} try { return JSON.parse(t.match(/\{[\s\S]*\}/)[0]); } catch { return null; } }
