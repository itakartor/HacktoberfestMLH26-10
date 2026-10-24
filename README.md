<div align="center">

# 🎙️ Conversation Intelligence

**Trascrive le chiamate in tempo reale, estrae impegni, decisioni e scadenze con Gemma
e li conserva come memoria verificabile, sempre collegata alla frase da cui derivano.**

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=nodedotjs&logoColor=white)
![Gemma](https://img.shields.io/badge/Gemma_4-Ollama-4285F4?logo=google&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)
![ElevenLabs](https://img.shields.io/badge/STT-ElevenLabs_Scribe-000000)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Tests](https://img.shields.io/badge/test-51%20passing-brightgreen)

<img src="docs/screenshots/demo-live.gif" alt="Demo: trascrizione live, alert e scheda che si compilano durante la chiamata" width="900">

*HacktoberfestMLH26

</div>

---

## Perché

Dopo una chiamata di lavoro restano appunti sparsi e ricordi diversi. Un riassunto automatico non basta:
se *«potremmo partire il mese prossimo»* diventa *«si parte il mese prossimo»*, l'errore finisce nella memoria
e da lì in una decisione sbagliata.

Questo prototipo **supporta chi decide, senza sostituirlo**. Ogni informazione estratta ha una citazione letterale
e la fonte; ciò che è stato *detto* resta distinto da ciò che è *verificato*; le formulazioni incerte o condizionate
non diventano mai fatti.

## Cosa fa

| | |
|---|---|
| 🎧 **Trascrizione live** | Microfono e audio della scheda (Meet/Teams/Zoom web) come canali separati, con testo provvisorio sostituito da quello definitivo. |
| 🧠 **Estrazione con Gemma** | Impegni, decisioni, scadenze, rischi e campi del template, con citazione, fonte, stato e confidenza motivata. |
| 🛡️ **Guardrail** | Accordi condizionati, autocorrezioni («cinquemila, anzi cinquantamila»), negazioni e istruzioni ostili pronunciate in chiamata vengono riconosciuti. |
| 🔔 **Domande al momento giusto** | Al massimo una domanda alla volta, riformulata sul contesto e mai su ciò che è già stato detto; alert solo per conflitti, accordi condizionati e istruzioni ostili. |
| 🗂️ **Template come traccia** | Un template è solo obiettivo e punti da toccare, ciascuno con una domanda guida. Si crea dalla UI in un minuto e Gemma lo usa come linea guida. |
| 📑 **Report post-chiamata** | Sintesi, cose da verificare, confronto con le chiamate precedenti e con i documenti, export in Markdown. |
| 🔎 **Archivio** | Domande in linguaggio naturale su tutte le conversazioni e i documenti, con le fonti; se le evidenze non bastano, lo dice. |
| 📄 **Documenti e import** | Listini, contratti e note (.txt, .md, .pdf) come fonti di riferimento; import di conversazioni passate da testo. |

## 🚀 Quick start con Docker

Serve solo **[Docker](https://docs.docker.com/get-docker/)**. Opzionale: una GPU NVIDIA.

```bash
git clone https://github.com/itakartor/HacktoberfestMLH26-10.git
cd HacktoberfestMLH26-10
cp .env.example .env          # inserisci ELEVENLABS_API_KEY (serve solo per l'audio live)

docker compose up -d --build  # CPU: funziona ovunque
# oppure, con GPU NVIDIA (molto più veloce):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Apri **http://localhost:3000** e premi **«Carica dati demo»**: in circa 2 minuti trovi 4 documenti e 4 conversazioni
già elaborate su cui provare ricerca e report.

> Al primo avvio vengono scaricati i modelli Gemma (circa 7 GB), una volta sola. Lo stato si vede con
> `docker compose logs -f ollama-pull`.

Senza Docker (Windows): `.\setup.ps1` la prima volta, poi `.\start.ps1` / `.\stop.ps1`.
Tutte le opzioni, le varianti per macOS e Linux e la risoluzione dei problemi sono in **[INSTALLATION.md](INSTALLATION.md)**.

## 📸 Screenshot

<table>
<tr>
<td width="50%"><img src="docs/screenshots/live.jpg" alt="Vista live"><br><sub><b>Live</b>: trascrizione per parlante, alert collegati alla fonte (accordo condizionato, istruzione ostile, sconto)</sub></td>
<td width="50%"><img src="docs/screenshots/schede.png" alt="Scheda e informazioni estratte"><br><sub><b>Traccia della chiamata</b> e informazioni estratte, con stato, certezza, citazione e fonte</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/report.png" alt="Report post-chiamata"><br><sub><b>Report post-chiamata</b>: sintesi di Gemma (da verificare) e scheda consolidata</sub></td>
<td><img src="docs/screenshots/report-confronti.png" alt="Confronti"><br><sub><b>Confronti</b> con i documenti di riferimento e con le conversazioni precedenti, senza sovrascrivere niente</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/archivio-ricerca.png" alt="Ricerca nell'archivio"><br><sub><b>Archivio</b>: risposta con fonti miste, conversazioni e documenti</sub></td>
<td><img src="docs/screenshots/documenti.png" alt="Documenti"><br><sub><b>Documenti</b>: caricamento di file o testo, indicizzazione per blocchi</sub></td>
</tr>
</table>

## Come si usa

1. **Crea una conversazione**: titolo, progetto, template e conferma del consenso, che è obbligatoria.
2. **Avvia l'audio**. Spunta *Audio scheda* e condividi la scheda della call con «Condividi audio» per trascrivere
   anche l'interlocutore. Senza microfono si può usare **▶ Scenario demo**.
3. **Durante la chiamata** si compilano scheda, alert e domande suggerite. Clicca una fonte (`S4`) per vedere la frase,
   ✓/✗ per confermare o contestare, ✎ per correggere la trascrizione.
4. **Termina la chiamata** per ottenere il report, che si può scaricare in Markdown.
5. **Archivio**: fai domande su tutto lo storico, carica documenti, importa conversazioni passate.

## Architettura in breve

```text
Browser ──PCM 16 kHz──► Node.js ──► ElevenLabs Scribe v2 Realtime (STT streaming)
   ▲                      │
   └── eventi live ───────┤ orchestratore → Gemma 4 (Ollama) → validazione + grounding → regole
                          │
                          └► PostgreSQL + pgvector: sessioni, segmenti, elementi, documenti, eventi
```

Tutto gira sulla tua macchina **tranne lo STT**: l'audio va a ElevenLabs, e la UI lo segnala.
I dettagli (flussi, modello dati, guardrail, scelte tecniche) sono in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Test

```bash
npm test          # 51 test deterministici: parziali, idempotenza, guardrail, isolamento, correzioni, import…
npm run e2e:stt   # percorso audio reale: voce italiana sintetica → ElevenLabs → Gemma (server avviato)
```

I test coprono i casi di [TestCase.md](TestCase.md) e gli scenari di rottura di
[analisi_critica_use_case_scenari_rottura.md](analisi_critica_use_case_scenari_rottura.md). La corrispondenza
test ↔ caso è in [ARCHITECTURE.md](ARCHITECTURE.md#test).

## Documentazione

| Documento | Contenuto |
|---|---|
| [INSTALLATION.md](INSTALLATION.md) | Prima installazione (Docker o nativa), configurazione, modelli per hardware, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Componenti, flussi, eventi, modello dati, guardrail, sicurezza, scelte e limiti |
| [docs/prompt-master.md](docs/prompt-master.md) | Specifica originale del progetto |
| [System Architecture](System%20Architecture) | Specifica iniziale dello stack (DB e AI) |
| [TestCase.md](TestCase.md) · [Analisi critica](analisi_critica_use_case_scenari_rottura.md) | Casi di test e scenari di rottura |

## Limiti noti

- **Diarizzazione per canale** (tu / interlocutore), non per singola voce.
- **Autenticazione di demo** (selettore utente): l'isolamento dei dati è applicato lato server, ma prima di un uso reale va aggiunto un login vero.
- **Metriche di qualità non ancora misurate**: errore di trascrizione (WER), precisione e richiamo vanno misurati su un dataset annotato. Le latenze mostrate sono misure, non garanzie.

<sub>Una dichiarazione non diventa un fatto solo perché è stata salvata, riassunta o ripetuta dal modello.</sub>
