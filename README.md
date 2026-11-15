# Ricevitore rapporti

Cloudflare Worker che riceve i rapporti cifrati delle app e li salva in `<App>-rapporti/rapporti/AAAA-MM-GG/` su GitHub.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vincenzociriello91-hub/AssistenteBanco/tree/main/ricevitore)

- Segreto: `GITHUB_TOKEN` (fine-grained, *Contents: read and write* sui repository `*-rapporti`).
- Le app inviano a `POST https://rapporti-vincenzo.<tuo-sottodominio>.workers.dev/r/<NomeApp>`.
- Accetta solo rapporti già cifrati (campi `key`, `iv`, `data`): il contenuto si legge solo con la chiave privata.
