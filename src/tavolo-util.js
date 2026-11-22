// Tavolo d'Avventura: piccoli attrezzi comuni (testo sicuro, codici casuali, impronte).
export const casuale = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return a; };
export const codiceCasuale = (len = 10) => { const alfa = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return [...casuale(len)].map(x => alfa[x % alfa.length]).join(''); };
export const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
export const testo = (s, max = 2000) => String(s ?? '').slice(0, max);
