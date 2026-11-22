# Ricevitore rapporti

Cloudflare Worker che riceve i rapporti cifrati delle app e li salva in `<App>-rapporti/rapporti/AAAA-MM-GG/` su GitHub.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vincenzociriello91-hub/AssistenteBanco/tree/main/ricevitore)

- Segreto: `GITHUB_TOKEN` (fine-grained, *Contents: read and write* sui repository `*-rapporti`).
- Le app inviano a `POST https://rapporti-vincenzo.<tuo-sottodominio>.workers.dev/r/<NomeApp>`.
- Accetta solo rapporti già cifrati (campi `key`, `iv`, `data`): il contenuto si legge solo con la chiave privata.

## Tavolo d'Avventura (stanze di gioco D&D)

- `GET /tavolo/<CODICE>/ws` (WebSocket): una stanza per campagna, Durable Object `Tavolo` (SQLite, piano gratuito).
- Tiene membri, schede, luoghi e mappe persistenti, dadi, diario e memoria del master; inoltra la segnalazione della voce (WebRTC).
- Master AI con Gemini (stesso segreto `GEMINI_KEY`): narrazione, eventi sulla scheda e sulla mappa, riassunti, domande sulle regole.
- Origini ammesse: `vincenzociriello91-hub.github.io` e `localhost:8765`. Codice in `src/tavolo.js`.
