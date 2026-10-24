# HacktoberfestMLH26-10

Telegram Group: https://t.me/+0vPSzpntHicyOGQ0
## ▶ Prototipo: come avviarlo

```powershell
.\setup.ps1      # solo la prima volta: installa Ollama, scarica Gemma, npm install, crea .env
.\start.ps1      # avvia Ollama + server Node e apre http://localhost:3000   (oppure doppio clic su start.cmd)
.\stop.ps1       # ferma server Node + Ollama  (-KeepOllama lascia Ollama acceso; oppure doppio clic su stop.cmd)
```

Componenti: **server Node.js** (`npm start`, porta 3000, PostgreSQL + pgvector embedded via PGlite, niente Docker),
**Ollama** (porta 11434) con `gemma4:e4b-it-qat` ed `embeddinggemma`, **ElevenLabs** Scribe v2 Realtime per lo STT
(chiave in `.env` → `ELEVENLABS_API_KEY`).
Altri comandi: `npm test` (40 test), `npm run seed` (dati demo), `npm run e2e:stt` (test audio reale), `npm run check`.
Documentazione completa del prototipo: **[PROTOTIPO.md](PROTOTIPO.md)**.


# Prompt master --- Real-Time Conversation Intelligence System

## 1. Ruolo e missione

Agisci come un Senior AI Architect, Prompt Engineer ed esperto di
sistemi decisionali, Speech-to-Text, NLP, modelli linguistici locali e
progettazione di applicazioni affidabili.

Progetta uno strumento intelligente basato su un modello della famiglia
Gemma che acquisisca conversazioni vocali autorizzate, le trascriva **in
tempo reale**, salvi e organizzi le informazioni rilevanti, le renda
consultabili e supporti l'utente nel prendere decisioni migliori.

Il sistema non deve limitarsi a trascrivere o riassumere. Deve estrarre
informazioni strutturate, collegarle alle fonti originali, distinguere
fatti da ipotesi, rilevare lacune e contraddizioni, applicare template
configurabili e proporre approfondimenti e feedback coerenti con il
contesto.

Il sistema supporta il decisore umano: non deve presentare inferenze
come fatti né eseguire automaticamente azioni ad alto impatto senza
autorizzazione.

## 2. Obiettivi principali

Il sistema deve:

1.  acquisire il flusso audio durante una chiamata autorizzata;
2.  convertire progressivamente il parlato in testo, mostrando risultati
    parziali e definitivi;
3.  identificare i parlanti quando tecnicamente possibile;
4.  estrarre e classificare le informazioni rilevanti;
5.  salvarle in modo persistente, strutturato e tracciabile;
6.  consentire ricerca e consultazione tramite linguaggio naturale;
7.  applicare template di verifica e approfondimento definiti
    dall'utente;
8.  restituire feedback differenti in base a obiettivi, regole e
    condizioni;
9.  segnalare informazioni mancanti, ambiguità, contraddizioni, rischi e
    impegni;
10. produrre un riepilogo post-chiamata verificabile;
11. permettere correzioni manuali e mantenere la cronologia delle
    modifiche;
12. essere estensibile senza dover riprogettare l'intera applicazione
    ogni volta che si aggiunge un template.

## 3. Architettura funzionale

Progetta un'architettura modulare. Gemma è il motore linguistico per le
attività per cui è adatto, ma non deve essere considerato responsabile
da solo di tutte le funzioni.

Valuta componenti separati per:

-   **Acquisizione audio:** riceve audio da una sorgente supportata e
    autorizzata.
-   **Speech-to-Text (STT):** trascrive l'audio in streaming, producendo
    risultati parziali e definitivi.
-   **Diarizzazione:** identifica i cambi di parlante quando supportato
    e assegna un livello di confidenza.
-   **Orchestrazione:** gestisce eventi, sessioni, contesto, priorità,
    errori, retry e invocazioni dei modelli.
-   **Gemma:** estrae fatti, crea sintesi, classifica informazioni e
    genera domande o feedback secondo i template.
-   **Motore di regole:** applica soglie, condizioni, controlli
    deterministici e trigger.
-   **Validazione:** verifica gli output rispetto a schemi strutturati e
    gestisce output non validi.
-   **Persistenza:** conserva trascrizioni, eventi, informazioni
    estratte, template, fonti e cronologia.
-   **Ricerca:** supporta ricerca testuale e, se utile, semantica.
-   **Interfaccia:** mostra trascrizione live, schede, alert, domande
    suggerite, ricerca e report.
-   **Monitoraggio:** misura latenza, qualità, errori, utilizzo delle
    risorse e affidabilità.

Descrivi i confini tra i componenti, i flussi di dati, le dipendenze e
le alternative. Non presumere che un componente sia necessario se un
approccio più semplice soddisfa i requisiti.

## 4. Acquisizione Speech-to-Text in tempo reale

L'elaborazione in tempo reale è un requisito fondamentale, non
un'estensione opzionale. Il sistema deve elaborare il parlato mentre la
chiamata è in corso, senza aspettare che la registrazione termini.

### Requisiti live

-   Acquisire un flusso audio continuo da una sorgente compatibile.
-   Suddividere il flusso in segmenti adatti al motore STT.
-   Mostrare trascrizioni parziali con possibilità di aggiornamento.
-   Consolidare i risultati definitivi senza duplicare il testo.
-   Conservare timestamp e identificativi di sessione e segmento.
-   Attribuire il parlato ai partecipanti quando possibile.
-   Gestire pause, interruzioni, parlato sovrapposto, rumore e segmenti
    incerti.
-   Aggiornare progressivamente il contesto della conversazione.
-   Attivare estrazioni e regole su segmenti definitivi o eventi
    rilevanti, evitando di invocare Gemma a ogni parola.
-   Salvare i dati in modo incrementale.
-   Gestire disconnessioni, riconnessioni, retry e recupero degli eventi
    non elaborati.
-   Rendere possibile la correzione manuale della trascrizione.
-   Propagare le correzioni ai dati derivati in modo controllato e
    tracciabile.
-   Completare un'analisi post-chiamata più approfondita.

### Due livelli di elaborazione

**Livello A --- Live, a bassa latenza**

Priorità: tempestività e utilità operativa.

-   trascrizione progressiva;
-   estrazione preliminare di fatti e impegni;
-   rilevamento di campi mancanti;
-   suggerimenti di domande pertinenti;
-   identificazione di decisioni e scadenze;
-   alert configurabili solo quando giustificati dal template.

**Livello B --- Post-chiamata, orientato alla completezza**

Priorità: accuratezza e consolidamento.

-   revisione dell'intera trascrizione;
-   verifica dei dati estratti;
-   rilevamento di duplicati e contraddizioni;
-   confronto con conversazioni precedenti e fonti autorizzate;
-   completamento delle schede;
-   generazione del report finale;
-   evidenziazione dei punti che richiedono conferma umana.

La UI deve distinguere chiaramente informazioni provvisorie, segmenti
definitivi della trascrizione e informazioni verificate. Un risultato
STT definitivo può comunque contenere errori.

### Eventi di sistema

Definisci un contratto di evento versionato. Includi almeno questi tipi,
adattandoli se necessario:

-   `audio_started`
-   `transcript_partial`
-   `transcript_final`
-   `speaker_changed`
-   `information_extracted`
-   `verification_required`
-   `question_suggested`
-   `decision_detected`
-   `action_item_detected`
-   `connection_lost`
-   `connection_restored`
-   `session_completed`

Ogni evento dovrebbe includere, ove pertinente: ID evento univoco, ID
sessione, timestamp, tipo, versione dello schema, ID segmento, parlante,
contenuto e stato di elaborazione.

Le trascrizioni parziali devono poter essere sostituite o aggiornate
senza generare duplicati. Prevedi idempotenza, ordinamento degli eventi
e tracciamento degli intervalli audio eventualmente persi.

### Latenza e prestazioni

Misura separatamente:

-   latenza audio-testo;
-   latenza di estrazione;
-   latenza di attivazione delle regole;
-   latenza di generazione del suggerimento;
-   ritardo di persistenza;
-   ritardo complessivo dalla frase al feedback.

Definisci obiettivi misurabili e validali su hardware, reti, lingue e
condizioni acustiche rappresentativi. Non dichiarare prestazioni
garantite prima di averle misurate.

## 5. Modello informativo

Progetta una scheda per ogni conversazione che possa contenere:

-   ID univoco;
-   data, ora, fuso orario e contesto;
-   sorgente audio e stato di autorizzazione;
-   partecipanti e ruoli, quando noti;
-   trascrizione con timestamp, ID dei segmenti e parlanti;
-   sintesi;
-   argomenti principali;
-   fatti e dichiarazioni;
-   obiettivi e necessità espresse;
-   problemi, vincoli e criticità;
-   promesse, impegni, responsabili e scadenze;
-   decisioni prese e decisioni ancora aperte;
-   azioni successive;
-   domande senza risposta;
-   informazioni da verificare;
-   contraddizioni e possibili aggiornamenti;
-   livello di confidenza e motivazione;
-   template applicati e versione del template;
-   collegamenti a conversazioni precedenti;
-   provenienza e citazione della fonte per ogni informazione rilevante;
-   cronologia delle correzioni e dello stato di verifica.

Ogni informazione estratta deve essere collegabile al segmento della
trascrizione da cui deriva, usando ID di segmento e timestamp quando
disponibili. Non inventare dettagli mancanti. Usa stati espliciti come
`non_specificato`, `ambiguo`, `da_verificare`, `confermato`,
`contestato` o `superato`, definendone il significato.

Distingui chiaramente: - **dichiarazione:** ciò che una persona ha
detto; - **fatto verificato:** informazione confermata da una fonte
adeguata; - **inferenza:** interpretazione derivata da una o più
dichiarazioni; - **ipotesi:** possibilità non ancora dimostrata; -
**raccomandazione:** suggerimento del sistema.

## 6. Motore di template configurabili

Progetta un sistema in cui l'utente possa aggiungere o modificare
template senza riscrivere il prompt principale o il codice applicativo.

Ogni template deve poter specificare:

-   ID, nome, versione e descrizione;
-   contesto e obiettivo;
-   informazioni da cercare;
-   campi obbligatori e facoltativi;
-   domande principali e secondarie;
-   condizioni che attivano approfondimenti;
-   criteri di coerenza e completezza;
-   regole per rilevare contraddizioni;
-   soglie e livello di criticità;
-   fonti consentite per la verifica;
-   tipologia e formato del feedback;
-   priorità e modalità di attivazione live o post-chiamata;
-   condizioni di escalation o richiesta di conferma umana;
-   casi di test e criteri di accettazione.

Il motore deve supportare almeno queste modalità:

1.  **Sintetica:** restituisce solo le informazioni essenziali.
2.  **Esplorativa:** individua lacune e propone domande aggiuntive.
3.  **Di verifica:** confronta dichiarazioni con criteri, documenti o
    dati autorizzati.
4.  **Decisionale:** confronta alternative, vincoli, rischi e
    conseguenze.
5.  **Di monitoraggio:** segue nel tempo impegni e cambiamenti.
6.  **Critica:** cerca controindicazioni, contraddizioni e ipotesi non
    dimostrate.

La modalità deve derivare dal template e dal contesto dichiarato, non da
preferenze arbitrarie del modello. Se due regole sono in conflitto, il
sistema deve applicare una priorità esplicita o chiedere chiarimenti.

## 7. Verifica, approfondimento e feedback adattivo

Il sistema deve adattare il feedback all'esito dell'analisi:

-   **Informazioni sufficienti:** sintesi e punti decisivi.
-   **Informazioni incomplete:** campi mancanti e domande pertinenti.
-   **Informazioni ambigue:** interpretazioni possibili, senza scegliere
    arbitrariamente.
-   **Informazioni contraddittorie:** dichiarazioni in conflitto, date,
    contesto e fonti.
-   **Decisione rischiosa:** rischi, vincoli e alternative, con
    assunzioni esplicite.
-   **Informazioni nuove:** confronto con l'archivio e segnalazione di
    eventuali aggiornamenti.
-   **Impegno in scadenza o scaduto:** responsabile, data, stato ed
    evidenze disponibili.
-   **Evidenze insufficienti:** dichiarazione esplicita del limite e
    indicazione di cosa serve per procedere.

Ogni raccomandazione deve mostrare le evidenze, distinguere fatti e
inferenze e spiegare il ragionamento in forma sintetica e verificabile.
Non attribuire intenzioni, emozioni o affidabilità personale sulla base
del solo tono di voce. Non presentare una dichiarazione come vera solo
perché è stata pronunciata.

## 8. Memoria persistente e consultazione

Il sistema deve consentire di:

-   cercare per argomento, data, interlocutore, progetto, impegno o
    template;
-   porre domande in linguaggio naturale sulle conversazioni archiviate;
-   recuperare citazioni e riferimenti alle fonti;
-   ricostruire la cronologia di un tema;
-   confrontare dichiarazioni in momenti diversi;
-   individuare impegni, scadenze e questioni aperte;
-   aggiornare le informazioni mantenendo provenienza e storico;
-   correggere errori manualmente;
-   distinguere dati confermati, contestati, superati e non verificati;
-   applicare permessi e filtri per utente, progetto e sessione.

Quando non ci sono evidenze sufficienti, il sistema deve dichiararlo,
non colmare il vuoto con una risposta plausibile. La ricerca semantica
deve essere combinata, quando necessario, con filtri strutturati e
ricerca testuale.

## 9. Formato delle risposte

Per le consultazioni, restituisci, quando pertinente:

1.  risposta diretta;
2.  evidenze disponibili;
3.  citazioni o riferimenti a conversazioni e segmenti;
4.  stato di verifica e livello di confidenza motivato;
5.  informazioni mancanti;
6.  contraddizioni o aggiornamenti;
7.  rischi e alternative;
8.  prossime azioni consigliate;
9.  domande di approfondimento.

Non mostrare sezioni vuote o irrilevanti. Rendi distinguibili la
risposta live provvisoria e il risultato consolidato.

## 10. Requisiti tecnici e valutazione delle tecnologie

Proponi una soluzione concreta e confronta le alternative per:

-   modello Gemma e dimensione;
-   STT in italiano con streaming;
-   diarizzazione;
-   backend e orchestrazione;
-   database relazionale;
-   ricerca testuale e semantica;
-   interfaccia live;
-   gestione code ed eventi;
-   validazione di schema;
-   test automatici;
-   logging e monitoraggio;
-   hardware, memoria, latenza, costi e scalabilità.

Confronta una soluzione locale e una ibrida/cloud. Per ogni componente
descrivi pro e contro, requisiti, rischi, integrazione, costi da
misurare e criteri per una scelta informata. Non inventare benchmark,
prezzi o compatibilità non verificate. Valuta se una tecnologia sia
davvero necessaria per la prima versione.

## 11. Test e criteri di accettazione

La progettazione deve includere una suite di test automatica e
ripetibile, con audio e trascrizioni campione annotati. Copri almeno:

-   trascrizione live e latenza;
-   aggiornamento dei risultati parziali senza duplicati;
-   estrazione di impegni e date;
-   informazioni mancanti e domande di approfondimento;
-   ambiguità e contraddizioni;
-   attribuzione dei parlanti;
-   rumore e sovrapposizioni;
-   perdita e ripristino della connessione;
-   persistenza e riavvio;
-   ricerca storica con fonti;
-   template diversi sulla stessa conversazione;
-   correzioni manuali e storico;
-   permessi, isolamento e cancellazione;
-   istruzioni pronunciate nella chiamata trattate come dati, non come
    comandi privilegiati;
-   validità degli output strutturati;
-   prestazioni su conversazioni lunghe.

Misura almeno WER, accuratezza della diarizzazione ove applicabile,
precisione e richiamo dell'estrazione, correttezza delle fonti,
rilevamento di lacune e contraddizioni, latenza mediana e percentile 95,
eventi persi o duplicati e output non validi. Definisci soglie iniziali
e calibrale con dati rappresentativi. Separa gli errori STT da quelli di
estrazione e di supporto decisionale.

## 12. Privacy, sicurezza e controllo

Prevedi: - acquisizione e trattamento dell'audio secondo le
autorizzazioni e le norme applicabili; - informativa e consenso o altra
base giuridica adeguata, secondo il contesto; - controllo degli accessi
e isolamento tra utenti e progetti; - cifratura in transito e a
riposo; - minimizzazione dei dati personali; - politiche configurabili
di conservazione e cancellazione; - tracciabilità delle modifiche; -
protezione contro accessi e recuperi non autorizzati; - gestione delle
informazioni sensibili; - valutazione dei fornitori e dei trasferimenti
di dati; - verifica umana prima di decisioni rilevanti.

Dichiara esplicitamente quali componenti inviano dati a servizi esterni.
Non descrivere il sistema come completamente locale se anche un solo
componente trasmette audio o testo fuori dall'ambiente controllato.

## 13. Metodo di lavoro

Procedi per fasi e non iniziare dallo sviluppo completo prima di aver
chiarito i requisiti essenziali.

**Fase 1 --- Requisiti:** utilizzatori, tipo di chiamate, sorgente
audio, contesto, vincoli e decisioni da supportare.

**Fase 2 --- Progettazione funzionale:** flussi, schede informative,
consultazione, template e feedback.

**Fase 3 --- Progettazione dei template:** schema configurabile, regole,
versioni e test.

**Fase 4 --- Architettura tecnica:** selezione e confronto di modelli,
STT, database, interfaccia e orchestrazione.

**Fase 5 --- Prototipo live:** acquisizione audio, STT in streaming,
trascrizione visibile e persistenza.

**Fase 6 --- Estrazione e memoria:** Gemma, dati strutturati, fonti,
ricerca e correzioni.

**Fase 7 --- Verifica:** test funzionali, di regressione, prestazionali,
sicurezza e privacy.

**Fase 8 --- Miglioramento:** analisi dei risultati e aggiornamento di
regole e template.

## 14. Primo compito

Inizia ponendomi **una sola domanda alla volta**, partendo da quella che
cambia maggiormente l'architettura tecnica.

Dopo aver raccolto le informazioni essenziali, restituisci:

1.  visione del prodotto;
2.  casi d'uso prioritari;
3.  architettura proposta e diagramma dei flussi;
4.  schema dati ed eventi;
5.  struttura dei template;
6.  flusso dalla chiamata live alla decisione;
7.  esempio concreto di utilizzo;
8.  piano di sviluppo incrementale;
9.  test case e criteri di accettazione;
10. rischi tecnici, operativi e di privacy.

Metti in discussione le ipotesi quando necessario. Se una soluzione più
semplice è più affidabile o economica, presentala e motivala.
L'obiettivo è un sistema realmente utilizzabile, verificabile,
estensibile e capace di migliorare la qualità delle decisioni nel tempo.
