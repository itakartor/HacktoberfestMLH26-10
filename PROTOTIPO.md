# Prototipo — Real-Time Conversation Intelligence

Prototipo funzionante del sistema descritto in [README.md](README.md), [System Architecture](System%20Architecture),
[TestCase.md](TestCase.md) e [analisi_critica_use_case_scenari_rottura.md](analisi_critica_use_case_scenari_rottura.md).

Caso d'uso scelto per la prima versione, come raccomandato dall'analisi critica: **estrarre impegni, scadenze,
decisioni e domande aperte da chiamate di lavoro**, con template configurabili (commerciale, operativo,
decisionale, riunione).

## Avvio rapido (Windows)

```powershell
.\setup.ps1          # installa Ollama, scarica i modelli Gemma, npm install, crea .env
.\start.ps1         # avvia Ollama + server → http://localhost:3000  (oppure doppio clic su start.cmd)
.\stop.ps1          # ferma server + Ollama (-KeepOllama per lasciarlo acceso; oppure stop.cmd)
npm run seed         # (facoltativo, a server avviato) popola l'archivio con 3 conversazioni demo
```

Oppure, a mano:

```powershell
winget install Ollama.Ollama
ollama pull embeddinggemma
ollama pull gemma4:e4b-it-qat
npm install
copy .env.example .env     # inserire ELEVENLABS_API_KEY
npm run check              # verifica i prerequisiti
npm start
```

Non servono Docker né Python: PostgreSQL + pgvector girano **dentro il processo Node** tramite
[PGlite](https://pglite.dev) (dati in `data/pgdata`). Per usare un PostgreSQL esterno (es. `pgvector/pgvector:pg16`
in Docker) basta impostare `DATABASE_URL` nel `.env`: lo schema è identico.

## Come si usa

1. **Crea una conversazione**: titolo, progetto, template e conferma del consenso, che è obbligatoria.
2. **Avvia l'audio**:
   - *Microfono*: la tua voce, etichettata «Io».
   - *Audio scheda*: l'interlocutore. Si condivide la scheda di Meet/Teams/Zoom web con «Condividi audio».
     I due canali sono trascritti separatamente, così l'attribuzione del parlante è affidabile e si vede
     subito se un lato della chiamata **non** viene acquisito (F01).
   - In alternativa, **▶ Scenario demo** riproduce una conversazione scritta in streaming, senza microfono.
3. Durante la chiamata:
   - trascrizione **provvisoria** (grigia, corsivo) che viene sostituita da quella **definitiva**;
   - scheda del template con campi, stato e fonte (clic sulla fonte per evidenziare il segmento);
   - domande suggerite e alert, filtrati dal motore di regole con dedup, cooldown e budget al minuto;
   - informazioni estratte, ciascuna con stato, natura (dichiarazione/inferenza/ipotesi), certezza, citazione e fonte;
   - pulsanti ✓ Conferma / ✗ Contesta e ✎ correzione della trascrizione, con storico versioni.
4. **Termina chiamata**: il livello B rilegge tutto, consolida i dati, li confronta con le conversazioni
   precedenti dello stesso progetto e genera il report, scaricabile anche in Markdown.
5. **Chiedi all'archivio**: domande in linguaggio naturale con ricerca ibrida (testo + pgvector). Le risposte
   citano i segmenti. Se le evidenze non bastano, il sistema lo dichiara invece di inventare.

## Architettura

```text
Browser (index.html)
 ├─ AudioWorklet: mic / audio scheda → PCM16 16 kHz, 100 ms ──┐  WebSocket /ws
 └─ UI live ◄── eventi versionati (schema 1.0) ───────────────┤
                                                               ▼
Node.js (src/server.js) ── ElevenLabsChannel ×canale ──► ElevenLabs Scribe v2 Realtime (cloud)
   │                         partial / committed  ◄──────────┘
   ▼
Orchestrator (src/orchestrator.js)
   ├─ consolidamento: parziali sostituiti, finali idempotenti (ID segmento)
   ├─ debounce/batch: Gemma ogni ~2,5 s o 3 segmenti, mai a ogni parola
   ├─ Estrattore (src/extraction) ── Ollama: gemma4:e4b-it-qat, output JSON vincolato da schema
   │     └─ validazione Zod → grounding (citazione presente nel segmento) → guardrail linguistici
   │        → output non valido in quarantena, fallback a regole se Gemma non risponde
   ├─ Motore di regole (src/rules/engine.js): template, priorità, cooldown, conflitti, injection
   ├─ Persistenza: PostgreSQL/PGlite + pgvector (HNSW, coseno), event log idempotente
   ├─ Ricerca: embeddinggemma (768 dim) + ILIKE, filtro autorizzativo PRIMA del ranking
   └─ Report post-chiamata + confronto tra sessioni dello stesso progetto
```

| Componente | Scelta | Perché |
|---|---|---|
| STT streaming | ElevenLabs `scribe_v2_realtime`, VAD, `it` | Streaming con parziali/definitivi; chiave solo lato server |
| LLM | `gemma4:e4b-it-qat` su Ollama | Entra in 8 GB di VRAM; circa 7 s per batch di 3 segmenti misurati su RTX 5050 |
| Embedding | `embeddinggemma` (768) | Come da specifica, con prefissi task query/document |
| DB | PostgreSQL 16 + pgvector (PGlite) | Schema e query identici a un Postgres reale, zero installazione |
| Validazione | Zod 4 + JSON Schema passato a Ollama (`format`) | Output strutturato vincolato e poi rivalidato |
| UI | HTML/JS vanilla servito da Express | Nessun build step |

**Flussi verso servizi esterni** (README §12): solo l'**audio** va a ElevenLabs (cloud). Testo, estrazioni,
embedding e database restano sulla macchina. La UI lo segnala con il badge «Dati esterni». Il sistema quindi
**non** è completamente locale.

## Modello dati

- `sessions`: proprietario, progetto, template e versione (con storico dei cambi), fuso orario, consenso, interruzioni audio, report.
- `segments`: solo segmenti **definitivi**, con versione, stato (`final`/`corrected`) ed embedding; `segment_versions` conserva lo storico delle correzioni.
- `items`: ogni informazione estratta con `kind`, `epistemic` (dichiarazione / fatto_verificato / inferenza / ipotesi / raccomandazione),
  `certainty`, `status` (non_specificato / ambiguo / da_verificare / confermato / contestato / superato), `quote`, `source_segment_ids`,
  template e versione, estrattore e `superseded_by`; `item_history` è l'audit trail.
- `events`: event log versionato e idempotente (`event_id` univoco, `seq` per sessione).
- `suggestions`, `quarantine`, `metrics`.

Regole sugli stati: una dichiarazione chiara nasce `da_verificare`, mai `confermato`; diventa confermata solo con un clic umano.
Formulazioni vaghe, ipotetiche o condizionate restano `ambiguo`. Un aggiornamento esplicito («è stata spostata al…»)
marca il valore precedente come `superato`; valori diversi senza un marcatore di aggiornamento diventano entrambi `contestato`.
Nessun dato viene sovrascritto in silenzio.

## Template

File JSON in `templates/`, oppure dalla scheda *Template* della UI o con `POST /api/templates`. Ogni template definisce
campi obbligatori e facoltativi (con domanda associata e criticità), cosa cercare, la modalità
(sintetica / esplorativa / verifica / decisionale / monitoraggio / critica), le regole
(`text_matches`, `kind` + `certainty_in`, `field` + `status_in`, `after_segments`), il budget di suggerimenti al minuto,
l'escalation verso la conferma umana e i casi di test. Salvare un id esistente crea una nuova versione e archivia
la precedente in `templates/archive/`. Le sessioni e gli elementi conservano la versione con cui sono stati creati.

## Eventi (schema 1.0)

`audio_started`, `audio_stopped`, `transcript_partial`, `transcript_final`, `transcript_corrected`, `speaker_changed`,
`information_extracted`, `verification_required`, `question_suggested`, `decision_detected`, `action_item_detected`,
`connection_lost`, `connection_restored`, `extraction_failed`, `session_completed`, `report_ready`.

Campi: `event_id`, `session_id`, `seq`, `ts`, `type`, `schema_version`, `segment_id`, `speaker`, `payload`, `processing_state`.
I parziali sono effimeri: vengono trasmessi alla UI ma non salvati. Il definitivo indica `replaces` = ID provvisorio.

## API

| Metodo | Percorso | |
|---|---|---|
| GET | `/api/health` | stato STT, Gemma, embedding, DB, flussi esterni |
| GET/POST | `/api/sessions` | elenco / crea (richiede `consent: true`) |
| GET/DELETE | `/api/sessions/:id` | stato completo / elimina con cascata su tutti i derivati |
| POST | `/api/sessions/:id/complete` | termina la chiamata ed esegue il livello B |
| POST | `/api/sessions/:id/template` | cambio template tracciato |
| POST | `/api/sessions/:id/simulate` | scenario demo `{ scenario, fast }` |
| GET | `/api/sessions/:id/report`, `/report.md`, `/events` | report JSON / Markdown, event log |
| PATCH | `/api/segments/:id` | correzione manuale `{ text }`; `GET …/history` restituisce le versioni |
| PATCH | `/api/items/:id` | `{ status, note }`; `GET …/history` restituisce l'audit trail |
| POST | `/api/ask` | `{ question, session_id?, project? }` |
| GET | `/api/metrics` | latenze mediana/p95 e output in quarantena |
| GET/POST | `/api/templates` | elenco / salva una nuova versione |
| WS | `/ws?session=&user=` | eventi in uscita; in ingresso audio (byte 0 = canale) e comandi `start_audio` / `stop_audio` |

L'identità è un header `x-user-id` di demo (utenti `luca`, `giulia`). È **solo per il prototipo** e va sostituita con
un'autenticazione reale. L'isolamento è comunque applicato lato server in ogni query, prima di qualsiasi retrieval.

## Test

```powershell
npm test          # 40 test deterministici (Gemma finto, DB in memoria)
npm run e2e:stt   # percorso audio REALE: WAV italiano (sintesi Windows) → server → ElevenLabs → Gemma
```

| Test case | Dove |
|---|---|
| TC02 parziali senza duplicati, F02 idempotenza | `test/pipeline.test.js` |
| TC03 impegni e scadenze, TC17 date relative con fuso della sessione | `pipeline`, `linguistics`, `extractor` |
| TC04 informazioni mancanti, TC05 ambiguità, FC03 accordo condizionato, FC04 responsabile solo nominato | `linguistics`, `extractor` |
| TC06 / FC06 contraddizioni e aggiornamenti tra dichiarazioni | `pipeline` |
| TC09 perdita/ripristino connessione, TC10 persistenza e riavvio | `pipeline` |
| TC11 ricerca con fonti e rifiuto senza evidenze; citazioni inventate scartate | `pipeline` |
| TC12 template diversi sulla stessa frase, F13 / FC07 suggerimenti non ripetitivi | `rules` |
| TC13 / FC09 correzione manuale con propagazione e storico | `pipeline` |
| TC14 / F19 JSON non valido → quarantena + fallback | `extractor`, `pipeline` |
| TC15 / F15 istruzioni pronunciate trattate come dati | `rules`, `pipeline` |
| TC16 / FC08 isolamento tra utenti e cancellazione a cascata | `pipeline` |
| TC21 cambio template tracciato | `pipeline` |
| FC01 negazione persa, FC02 autocorrezione numerica | `linguistics`, `extractor` |

## Limiti noti (onestamente)

- **Diarizzazione**: per canale (mic / scheda), non per voce. Più persone sullo stesso canale hanno la stessa etichetta.
- **Autenticazione**: assente (header di demo). Manca la cifratura a riposo del DB embedded.
- **Latenze**: quelle nella scheda *Metriche* sono misure su questa macchina, non garanzie. WER, precisione e richiamo
  non sono ancora misurati su un dataset annotato (TestCase §5–7).
- La confidenza mostrata è **qualitativa e spiegata**, non una probabilità calibrata (F22).
- I documenti di partenza citano `gemma2:9b`. Con 8 GB di VRAM è stato scelto `gemma4:e4b-it-qat`, modificabile in `LLM_MODEL`.
- Ollama remoto: se `OLLAMA_URL` non è locale, anche il testo esce dalla macchina e la UI lo segnala.
