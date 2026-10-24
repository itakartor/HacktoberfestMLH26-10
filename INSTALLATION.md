# Installazione

Guida alla prima installazione. Ci sono due strade:

| | Per chi | Cosa serve |
|---|---|---|
| **[A. Docker](#a-docker-consigliato)** | Chiunque, su Windows, macOS o Linux | Docker; opzionale una GPU NVIDIA |
| **[B. Nativa](#b-installazione-nativa)** | Sviluppo, o PC senza Docker | Node.js 22+ e Ollama |

In entrambi i casi l'app è su **http://localhost:3000**.

---

## Prima di iniziare: la chiave ElevenLabs

La trascrizione live usa **ElevenLabs Scribe v2 Realtime**. Senza chiave l'app funziona comunque con scenari demo,
import di testo, documenti e ricerca, ma non con il microfono.

1. Crea un account su [elevenlabs.io](https://elevenlabs.io) e apri *Developers → API Keys*.
2. Crea una chiave con il permesso **Speech to Text**. Gli altri permessi non servono.
3. Copia il file di esempio e incolla la chiave:

   ```bash
   cp .env.example .env        # Windows: copy .env.example .env
   ```

   ```ini
   ELEVENLABS_API_KEY=sk_...
   ```

> ⚠️ `.env` è in `.gitignore`: **non committare mai la chiave** e non scriverla in file tracciati come README o note.
> Se è finita in un commit, revocala dalla dashboard ElevenLabs e creane una nuova: cancellarla dal file non basta,
> resta nella storia git.

---

## A. Docker (consigliato)

### 1. Installa Docker

- **Windows / macOS**: [Docker Desktop](https://docs.docker.com/desktop/). Su Windows usa il backend WSL2.
- **Linux**: [Docker Engine](https://docs.docker.com/engine/install/) con il plugin `docker compose`.

### 2. Avvia lo stack

```bash
git clone https://github.com/itakartor/HacktoberfestMLH26-10.git
cd HacktoberfestMLH26-10
cp .env.example .env            # e inserisci la chiave (vedi sopra)

# CPU (funziona ovunque, più lento)
docker compose up -d --build

# GPU NVIDIA (consigliato se disponibile)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Cosa parte:

| Servizio | Immagine | Ruolo |
|---|---|---|
| `app` | build locale (`Dockerfile`, Node 22) | server web, API, WebSocket, pipeline |
| `db` | `pgvector/pgvector:pg16` | PostgreSQL 16 + pgvector (volume `pgdata`) |
| `ollama` | `ollama/ollama` | Gemma ed embedding (volume `ollama`) |
| `ollama-pull` | `ollama/ollama` | job una tantum che scarica i modelli e poi termina |

Al **primo avvio** `ollama-pull` scarica circa 7 GB di modelli; l'app parte solo quando il download è finito:

```bash
docker compose logs -f ollama-pull     # avanzamento download
docker compose ps                      # tutti "healthy", ollama-pull "exited (0)"
```

### 3. Verifica e dati demo

Apri http://localhost:3000. In alto i badge devono essere verdi: *STT ElevenLabs*, *Gemma pronto*, *Embedding ok*,
*DB postgres*. Poi premi **«Carica dati demo»** oppure, da terminale, con Node installato sull'host:

```bash
npm run seed
```

### GPU

- **Windows**: Docker Desktop con WSL2 e driver NVIDIA aggiornati. Non serve altro.
- **Linux**: installa il [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).
- **macOS**: niente GPU nei container. Usa la modalità CPU con un modello più piccolo (vedi [Scelta del modello](#scelta-del-modello)),
  oppure l'installazione nativa, dove Ollama usa la GPU Apple.

Per controllare che la GPU sia vista: `docker compose exec ollama nvidia-smi`.

### Riusare modelli già scaricati

Se Ollama è già installato sull'host e i modelli sono già scaricati, puoi montarli invece di riscaricarli:

```bash
# Windows (PowerShell)
$env:OLLAMA_DATA="C:/Users/<utente>/.ollama"; docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# Linux / macOS
OLLAMA_DATA=~/.ollama docker compose up -d
```

### Comandi utili

```bash
docker compose logs -f app        # log applicativi
docker compose restart app        # riavvio dopo una modifica a .env
docker compose up -d --build app  # ricostruisce l'app dopo modifiche al codice
docker compose down               # ferma tutto (i dati restano nei volumi)
docker compose down -v            # ⚠️ ferma ed ELIMINA dati e modelli
```

Backup e ripristino del database:

```bash
docker compose exec db pg_dump -U convintel convintel > backup.sql
docker compose exec -T db psql -U convintel convintel < backup.sql
```

---

## B. Installazione nativa

### Windows: script automatici

```powershell
.\setup.ps1     # solo la prima volta: Node (se manca), Ollama, modelli Gemma, npm install, .env
.\start.ps1     # avvia Ollama + server e apre il browser (oppure doppio clic su start.cmd)
.\stop.ps1      # ferma server e Ollama  (-KeepOllama per lasciare Ollama acceso)
```

Se PowerShell blocca gli script: `powershell -ExecutionPolicy Bypass -File .\setup.ps1`, oppure usa `start.cmd` / `stop.cmd`.

### macOS / Linux, o Windows a mano

```bash
# 1. Prerequisiti
#    Node.js 22+  → https://nodejs.org
#    Ollama       → https://ollama.com/download   (Windows: winget install Ollama.Ollama)

# 2. Modelli (in caso di errori di rete basta rilanciare: riprende da dove era rimasto)
ollama pull embeddinggemma
ollama pull gemma4:e4b-it-qat

# 3. App
npm install
cp .env.example .env      # inserisci ELEVENLABS_API_KEY
npm run check             # verifica Node, chiave, Ollama e modelli
npm start                 # → http://localhost:3000
```

Nell'installazione nativa il database è **PostgreSQL + pgvector embedded** (PGlite, dentro il processo Node):
non c'è nulla da installare e i dati stanno in `data/pgdata/`. Per usare un Postgres esterno basta impostare
`DATABASE_URL` nel `.env`.

---

## Scelta del modello

Il modello si sceglie con `LLM_MODEL` nel `.env`. Le dimensioni sono quelle pubblicate sulla
[libreria Ollama](https://ollama.com/library/gemma4/tags).

| Modello | Download | Quando usarlo |
|---|---|---|
| `gemma4:e2b-it-qat` | ~4,3 GB | GPU da 4–6 GB, solo CPU, Mac con poca RAM |
| `gemma4:e4b-it-qat` *(default)* | ~6,1 GB | GPU da 8 GB: buon compromesso tra qualità e latenza |
| `gemma4:12b-it-qat` | ~7,2 GB | GPU da 12 GB o più: estrazione più accurata, più lenta |

Gli embedding usano sempre `embeddinggemma` (768 dimensioni). Se lo cambi con un modello di dimensione diversa
devi ricreare il database.

Misure indicative su RTX 5050 Laptop (8 GB) con il modello di default: circa **3–7 s** per analizzare un gruppo
di 3 frasi, circa **6 s** dalla frase definitiva al feedback. Sono misure su una macchina, non garanzie: le metriche
della tua installazione sono nella scheda *Metriche* della UI.

---

## Configurazione

Tutte le variabili sono facoltative tranne la chiave STT, che serve per l'audio live.

| Variabile | Default | Descrizione |
|---|---|---|
| `ELEVENLABS_API_KEY` | — | Chiave ElevenLabs con permesso Speech to Text |
| `STT_LANGUAGE` | `it` | Lingua della trascrizione |
| `STT_MODEL` | `scribe_v2_realtime` | Modello STT realtime |
| `PORT` | `3000` | Porta HTTP dell'app (in Docker: `APP_PORT` per la porta sull'host) |
| `DATABASE_URL` | *(vuoto = PGlite embedded)* | Postgres esterno, es. `postgres://user:pass@host:5432/db` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Endpoint Ollama |
| `LLM_MODEL` | `gemma4:e4b-it-qat` | Modello di ragionamento |
| `EMBED_MODEL` | `embeddinggemma` | Modello di embedding (768 dimensioni) |
| `LLM_TIMEOUT_MS` | `60000` (Docker `180000`) | Timeout per singola chiamata al modello |
| `EXTRACTION_DEBOUNCE_MS` | `2500` | Attesa prima di analizzare i nuovi segmenti |
| `EXTRACTION_MAX_BATCH` | `3` | Segmenti che fanno partire subito l'analisi |
| `CONTEXT_WINDOW_SEGMENTS` | `10` | Segmenti precedenti passati come contesto |
| `MAX_SUGGESTIONS_PER_MINUTE` | `3` | Suggerimenti non urgenti al minuto (gli alert urgenti passano sempre) |
| `FIELD_QUESTION_COOLDOWN_MS` | `90000` | Tempo prima di riproporre la stessa domanda |
| `MIN_SEGMENTS_BEFORE_QUESTIONS` | `3` | Senza Gemma: segmenti minimi prima di proporre le domande guida |
| `SEARCH_MIN_SIMILARITY` | `0.35` | Soglia della ricerca semantica |
| `POSTGRES_PASSWORD` | `convintel` | Solo Docker: password del database |
| `OLLAMA_DATA` | volume `ollama` | Solo Docker: cartella host con i modelli |
| `TEMPLATES_DIR` | `templates/` (Docker: volume) | Dove vengono salvati i template creati dalla UI |

---

## Audio: cosa sapere

- **Microfono**: il browser chiede il permesso la prima volta. Funziona su `http://localhost`; da un altro PC serve
  **HTTPS** (es. un reverse proxy), perché i browser bloccano il microfono sulle pagine http non locali.
- **Interlocutore**: spunta *Audio scheda*, scegli la **scheda** della call (Meet, Teams o Zoom web) e attiva
  **«Condividi audio della scheda»**. Se dimentichi l'audio, l'app avvisa che l'interlocutore non viene trascritto.
- **Chrome o Edge** sono consigliati per la condivisione dell'audio di una scheda.

---

## Risoluzione dei problemi

| Sintomo | Causa probabile e soluzione |
|---|---|
| Badge **«Gemma offline → regole»** | Ollama non è attivo o il modello manca. Nativa: `ollama serve`, `ollama pull gemma4:e4b-it-qat`. Docker: `docker compose logs ollama-pull`. L'app intanto usa l'estrazione di riserva a regole. |
| `ollama pull` fallisce con `no such host` / errori DNS | Errore di rete temporaneo verso il CDN dei modelli: rilancia, riprende da dove era rimasto (gli script ritentano da soli). |
| La prima analisi impiega oltre un minuto | Al primo utilizzo la GPU prepara i kernel e carica il modello: dalla seconda è veloce. Il server fa un warm-up all'avvio. |
| **«STT: ElevenLabs HTTP 401»** / `auth_error` | Chiave errata o senza permesso *Speech to Text*. Correggi `.env` e riavvia (`docker compose restart app`). |
| Nessuna trascrizione dell'interlocutore | Non è stato condiviso l'audio della scheda: ricondividi con «Condividi audio». |
| `EADDRINUSE` / porta 3000 occupata | Un'altra istanza è attiva (Docker e nativa insieme?). `.\stop.ps1` oppure `docker compose down`, oppure cambia `PORT` / `APP_PORT`. |
| Docker: `could not select device driver "nvidia"` | Manca il supporto GPU: usa il comando senza `docker-compose.gpu.yml` o installa il NVIDIA Container Toolkit. |
| Ricerca semantica assente (*«Embedding off → solo testo»*) | Manca `embeddinggemma`: `ollama pull embeddinggemma`. I blocchi senza embedding vengono indicizzati al riavvio successivo. |
| Script `.ps1` bloccati | `powershell -ExecutionPolicy Bypass -File .\start.ps1` oppure doppio clic su `start.cmd`. |

---

## Aggiornare e disinstallare

```bash
git pull
docker compose up -d --build          # Docker
npm install && npm start              # nativa
```

Per disinstallare: `docker compose down -v` (Docker), oppure cancella la cartella del progetto (nativa; i dati sono
in `data/`). I modelli Ollama si rimuovono con `ollama rm <modello>`.
