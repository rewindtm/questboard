# Questboard

Coordina lo sviluppo di un gioco: board Kanban, task con checklist e storico, e sincronizzazione bidirezionale in tempo reale con un forum Discord. By [rewi.dev](https://rewi.dev).

Si può usare **con o senza Discord**: un progetto senza forum collegato funziona come un normale task manager.

- Node.js + Express, EJS con partial, Tailwind via CDN (nessuna build CSS), Barlow
- PostgreSQL (dati, sessioni, outbox), discord.js, Socket.IO
- JavaScript puro, nessun framework frontend

## Requisiti

- Node.js 20 o superiore (sviluppato su Node 24)
- PostgreSQL 14 o superiore
- (opzionale) un'applicazione Discord con bot e login OAuth2

## Installazione

```bash
npm install
cp .env.example .env     # poi compila i valori
npm run db:migrate       # applica le migrazioni versionate in migrations/
```

Crea un database e un utente PostgreSQL, poi imposta `DATABASE_URL`:

```
DATABASE_URL=postgresql://utente:password@host:5432/nome_db
```

## Avvio

```bash
npm run dev     # nodemon --watch: web, Socket.IO, bot e worker, riavvio automatico
npm start       # produzione: node src/index.js
```

In sviluppo le migrazioni partono da sole all'avvio. **In produzione no**: esegui `npm run db:migrate` a ogni aggiornamento. Un solo processo gestisce web, bot e worker: non avviare più istanze contemporaneamente (l'outbox è sicura, ma il bus eventi per Socket.IO è in-process).

La chiusura (SIGINT/SIGTERM) è ordinata: ferma il worker, chiude Socket.IO e il pool.

## Configurazione (`.env`)

| Variabile | Note |
|---|---|
| `NODE_ENV`, `PORT` | `production` richiede `SESSION_SECRET` e `APP_BASE_URL` https |
| `DATABASE_URL` | connessione PostgreSQL |
| `SESSION_SECRET` | almeno 32 caratteri casuali |
| `APP_BASE_URL` | URL pubblico dell'app (usato nei link dei post Discord) |
| `TRUST_PROXY` | automatico se `APP_BASE_URL` è https (dietro reverse proxy, necessario per IP e cookie sicuri); `0` per disattivarlo |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_CALLBACK_URL` | login OAuth2 |
| `DISCORD_BOT_TOKEN` | bot; se manca, l'integrazione risulta "non configurata" e nulla viene inviato |
| `BOOTSTRAP_ADMIN_DISCORD_ID` | Discord user ID del primo amministratore |
| `ENABLE_LOCAL_AUTH`, `BOOTSTRAP_ADMIN_LOGIN`, `BOOTSTRAP_ADMIN_PASSWORD` | login locale per usare Questboard senza Discord (password ≥ 12 caratteri) |

Nessun segreto viene mai esposto al frontend né scritto nei log. `.env` è escluso da git.

## Primo amministratore

Il primo admin non è "il primo che visita il sito": è esplicito.

- Con Discord: imposta `BOOTSTRAP_ADMIN_DISCORD_ID` con il tuo user ID (modalità sviluppatore di Discord → tasto destro sul tuo profilo → *Copia ID utente*). Al login diventi amministratore e puoi creare progetti.
- Senza Discord: abilita `ENABLE_LOCAL_AUTH=1` e imposta `BOOTSTRAP_ADMIN_LOGIN` e `BOOTSTRAP_ADMIN_PASSWORD`.

Fare login non dà accesso a nulla: serve essere membri del team del progetto (sezione **Team**, per Discord ID o account locale).

### Ruoli (per progetto)

- **Admin / Game Director**: tutto, compresa l'approvazione di "completato", impostazioni e team.
- **Developer**: aggiorna i task assegnati a lui, fino a "da verificare".
- **Tester**: crea segnalazioni; può verificare ("completato") solo se l'admin gli ha dato il permesso.

## Discord

### OAuth2 (login)

1. Su <https://discord.com/developers/applications> crea un'applicazione.
2. *OAuth2 → Redirects*: aggiungi `DISCORD_CALLBACK_URL` (es. `http://localhost:3000/auth/discord/callback`).
3. Copia Client ID e Client Secret nel `.env`. Lo scope richiesto è solo `identify`.

### Bot

1. *Bot*: crea il bot, copia il token in `DISCORD_BOT_TOKEN`. Non servono intent privilegiati (solo `Guilds`).
2. Invita il bot nel server con scope `bot`.
3. Nel canale forum il bot ha bisogno di: *View Channel*, *Send Messages*, *Send Messages in Threads*, *Read Message History*, *Manage Threads*, *Embed Links*.

### Collegare un progetto a un forum

*Impostazioni* del progetto: inserisci ID del server e ID del canale forum (modalità sviluppatore → *Copia ID*), poi **Verifica forum**. Questboard controlla server, tipo di canale, permessi del bot e carica i tag del forum.

**Mappatura dei tag**: associa esplicitamente ogni stato (da fare, in corso, da verificare, completato) e ogni priorità a un tag del forum. Ogni post usa al massimo 2 tag (stato + priorità); i tag non mappati vengono ignorati. Gli errori di configurazione sono mostrati in chiaro.

Lascia vuoti i due ID per usare il progetto senza Discord.

### Cosa succede

- Dal dettaglio del task un admin usa **Pubblica su Discord**: il bot crea un thread nel forum con codice e titolo, descrizione, checklist, assegnatario, priorità/stato/categoria, scadenza, build, link al task e un menu per cambiare stato.
- Le modifiche successive aggiornano titolo, messaggio, componenti e tag. L'assegnatario viene menzionato solo alla pubblicazione o al cambio di assegnatario.
- Il cambio di stato da Discord avviene **solo** dal menu del post (chi lo usa è sottoposto agli stessi permessi del sito). I menu funzionano anche dopo un riavvio.
- Tutto passa da una **outbox** persistente su PostgreSQL: retry con backoff esponenziale, rispetto dei rate limit, un solo job attivo per task, nessuna pubblicazione duplicata (anche dopo un crash: il post viene ritrovato tramite un riferimento stabile).

### Recupero da errori di sincronizzazione

Lo stato di ogni task è visibile nel dettaglio (Sincronizzato / In attesa / Errore / Post eliminato).

| Stato | Causa tipica | Cosa fare |
|---|---|---|
| In attesa | Discord non raggiungibile o rate limit | Nulla: il worker riprova da solo con backoff |
| Errore | permessi mancanti, forum non valido, tentativi esauriti | Correggi la causa (permessi del bot, impostazioni del progetto) poi, come admin, **Riprova la sincronizzazione** |
| Post eliminato | thread cancellato o non più accessibile | Non viene mai ricreato in automatico: un admin sceglie **Ripubblica su Discord** |
| Mai pubblicato | pubblicazione fallita | **Riprova la pubblicazione** |

I task restano sempre salvati nel database: un problema di Discord non blocca il lavoro.

## Dati demo

```bash
npm run db:seed-demo
```

Crea il progetto "Grimthorn Keep" con builds, membri e task di esempio. Richiede che esista già un amministratore di bootstrap (avvia l'app almeno una volta), non contatta mai Discord, è idempotente e **si rifiuta di girare con `NODE_ENV=production`**.

## Test

```bash
npm test
```

Avvia un PostgreSQL embedded temporaneo (o usa `TEST_DATABASE_URL`, un server con permesso `CREATE DATABASE`) e un database isolato per ogni file. Non tocca mai `DATABASE_URL`. Discord è sempre simulato: nessun messaggio reale viene inviato.

Coperti: permessi web e Discord, creazione/modifica/transizioni, conflitti di versione, atomicità task+storico+outbox, retry/backoff/rate limit, assenza di duplicati e riconciliazione dopo crash, componenti dopo un riavvio, flusso OAuth (state, replay), CSRF, accesso senza team, escape XSS, autenticazione Socket.IO, isolamento tra progetti, snapshot e rimozione dal team.

## Sicurezza

Query parametrizzate, validazione server (zod), CSRF su ogni metodo non sicuro, OAuth `state` monouso, rotazione dell'ID di sessione al login, cookie `httpOnly`/`sameSite`/`secure`, Content-Security-Policy, escape in EJS e nel frontend, limiti sugli input, rate limit sulle rotte di login, controllo server-side delle transizioni di stato, concorrenza ottimistica con interfaccia di conflitto.

## Non verificato

Dichiarato esplicitamente per evitare false sicurezze:

- **Discord reale**: OAuth2, bot, creazione/modifica dei thread nel forum, tag, menu e permessi non sono stati provati contro l'API reale. Sono coperti solo da test con un adattatore simulato.
- **Layout responsive**: controllato a larghezza ridotta in un browser, non su dispositivi reali.
- **Più istanze**: l'applicazione è pensata per un solo processo.
- **Tailwind CDN**: adatto a un'app interna; per un'esposizione pubblica intensa valuta di compilare il CSS.
- **Verifica visiva**: milestone, team, archivio e impostazioni rispondono 200 e si renderizzano senza errori, ma non sono state ispezionate schermata per schermata; login e board sì.

## Licenza

MIT © rewi.dev
