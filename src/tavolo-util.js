// Tavolo d'Avventura: piccoli attrezzi comuni (testo sicuro, codici casuali, impronte).
export const casuale = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return a; };
export const codiceCasuale = (len = 10) => { const alfa = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return [...casuale(len)].map(x => alfa[x % alfa.length]).join(''); };
export const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
export const testo = (s, max = 2000) => String(s ?? '').slice(0, max);
// due nomi dello stesso PNG ("Hilde" e "Hilde, minatrice ferita", "Oste" e "Tobia l'oste"): le parole dell'uno stanno tutte nell'altro (articoli esclusi); "Guardia 1" e "Guardia 2" restano due
const ARTICOLI = new Set(['il', 'lo', 'la', 'l', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'della', 'dei', 'da', 'e']);
export function stessoPng(a, b) {
  const parole = s => String(s || '').toLowerCase().split(/[^\p{L}\d]+/u).filter(w => w && !ARTICOLI.has(w));
  const A = parole(a), B = parole(b); if (!A.length || !B.length) return false;
  if (/^\d+$/.test(A.at(-1)) || /^\d+$/.test(B.at(-1))) return A.join(' ') === B.join(' ');
  const [corto, lungo] = A.length <= B.length ? [A, B] : [B, A];
  return corto.every(w => lungo.includes(w));
}
