# 3. Guida all'uso

[Indice](README.md) · Precedente: [Installazione e avvio](02-installazione-e-avvio.md) · Successivo: [Come funziona](04-come-funziona.md)

## Percorso consigliato

1. **Carica** i file `.sql` (barra in alto).
2. Guarda la **Panoramica** e i **Problemi** (errori e avvisi).
3. Togli le entità che non interessano (**Togli entità**) e controlla **Aree e gruppi**.
4. Controlla le **FK candidate** e falle scegliere a **clingo** (*Scelta con clingo*).
5. Se hai il programma che usa il database: **Verifica con l'interfaccia** (su Windows), poi di nuovo *Scelta con clingo* con le conferme del programma.
6. Guarda il risultato negli **Schemi grafici** e nel **Modello relazionale**.
7. **Salva risultati** (Excel, script SQL, schemi) e **Salva progetto** per riprendere il lavoro.

## La barra in alto

| Comando | Cosa fa |
|---|---|
| **Carica cartella** | legge tutti i file `.sql` di una cartella |
| **Carica file .sql** | legge uno o più file scelti |
| **Apri progetto** | riapre un lavoro salvato (`.sqlfk`) |
| **Salva progetto** | salva file letti, impostazioni, tabelle tolte, disposizione del diagramma, modello dell'editor e schermate lette del programma |
| campo del **percorso** + *Apri* | legge una cartella o un file scrivendone il percorso (utile nel browser per i file grandi) |

Sotto la barra c'è il riepilogo: errori, avvisi, tabelle, aree, gruppi, chiavi primarie composte, chiavi dichiarate e candidate, tabelle isolate.

**File grandi.** I file si leggono a blocchi: un dump da 1 GB si legge in pochi secondi, anche da 30 GB funziona. Durante la lettura compare una barra con la percentuale, il tempo che manca e il pulsante *Interrompi*. Dei file sopra 64 MB si tiene solo la struttura (CREATE, ALTER...): i numeri di riga restano quelli del file e i dati si usano nella pagina *Query sui dati*.

## Le pagine

### Panoramica
Il database com'è nei file, prima dell'analisi: tabelle, colonne, chiavi primarie (semplici, composte, mancanti), chiavi esterne già dichiarate, tabelle collegate e isolate, gruppi. In fondo l'elenco delle chiavi dichiarate e gli eventuali errori di lettura dei file.

### Editor del database
Per disegnare un database da zero o modificarne uno: aggiungi entità con attributi (tipo, chiave primaria, obbligatorio), collegale con relazioni 1:N, 1:1 o N:M (per le N:M crea da solo la tabella ponte, anche con attributi propri). Mostra lo schema logico, gli avvisi e l'SQL (`CREATE TABLE` in ordine giusto, con le chiavi esterne). *Importa il database caricato* parte dalle tabelle caricate; *Analizza questo schema* lo passa a tutte le altre pagine come se fossero file caricati.

### Problemi
La diagnostica come un compilatore: ogni riga ha gravità (errore, avviso, info), codice, file e riga, tabella e colonna, messaggio e suggerimento. Si filtra per gravità e per regola; cliccando una riga si vede il **pezzo di file** con la riga evidenziata e la **regola di progettazione** violata, con esempio sbagliato e corretto. Elenco completo dei codici: [Diagnostica](05-diagnostica.md).

### Aree e gruppi
- **Albero area → sottogruppo → tabelle**: le aree sono insiemi di sottogruppi molto collegati tra loro; i sottogruppi sono tabelle con nomi simili. Ogni tabella ha la sua **categoria** (codifica, anagrafica, movimento, dettaglio, ponte, storico, dipendente, isolata) e le tabelle **centrali** sono segnate con un asterisco.
- **Collegamenti tra aree e tra sottogruppi**: quante chiavi esterne, di che tipo, quali colonne.
- *Diagramma dell'area* apre il diagramma filtrato su quell'area; cliccando un sottogruppo si può toglierlo o rimetterlo nell'analisi.

### Schemi grafici
- **Diagramma delle tabelle** (stile DBeaver): ogni tabella con le colonne (PK, FK, UQ, tipi) e le linee tra le colonne collegate, con cardinalità. *Solo FK dichiarate* / *FK dichiarate e trovate*, *anche affidabilità media*. Le tabelle si trascinano (la disposizione si salva nel progetto); *Scarica SVG* / *Scarica PNG*.
- **Disposizione**: *disposte per collegamenti* (le tabelle collegate vicine), oppure **raccolte per gruppi** o **raccolte per aree**: ogni gruppo (o area) è un riquadro separato con il suo nome e il numero di tabelle, i riquadri sono in ordine di nome e le tabelle senza gruppo stanno in fondo. Le linee tra gruppi diversi sono più leggere e tornano piene passando il mouse su una tabella. Dalla pagina *Aree e gruppi*: *Vedi i gruppi nel diagramma*, *Vedi le aree nel diagramma*.
- **Cerca** (le altre tabelle spariscono):
  - **tabella / entità**: restano solo le tabelle con quel nome, anche al plurale o con i sinonimi (`cliente` trova `clienti`, `tbl_cliente`...);
  - **attributo / colonna**: restano solo le tabelle che hanno una colonna con quel nome, evidenziata in giallo;
  - **insieme**: se più tabelle hanno lo stesso nome, l'attributo le distingue (per esempio `taxa` + `species` lascia solo le tabelle `taxa` che hanno la colonna `species`);
  - *anche le collegate* aggiunge, più chiare, le tabelle collegate direttamente a quelle trovate; *Mostra tutte* toglie la ricerca.
- Filtri per area o gruppo e colori per gruppo, area o categoria.
- **Vista a grafo**: grafo interattivo (pyvis), anche in una finestra a parte.

### Modello relazionale
Lo schema logico, una riga per tabella (`Fatture(numero, data, id_cliente → Clienti)`), con esportazione in testo, Markdown, Mermaid, PlantUML, Graphviz DOT, DBML, JSON e come immagine.

### Togli entità
Scrivi un'entità (per esempio `piatto`) e vedi tutte le sue tabelle (riconosce plurali, accenti, prefissi, sinonimi). *Togli entità dall'analisi* le esclude da tutte le analisi; si rimettono quando vuoi (*Rimetti selezionate*, *Rimetti tutte*). Utile per concentrarsi su una parte del database.

### Query sui dati
Un database SQLite costruito dai dati dei file (`INSERT`, `COPY ... FROM stdin`).
- A sinistra le tabelle con il numero di righe e le colonne. Si cercano con due campi, come nel diagramma: **tabella / entità** e **attributo / colonna** (insieme restringono la ricerca; le colonne trovate sono in giallo). Clic sul nome: prime 100 righe; clic su una colonna: la inserisce nella query.
- L'editor esegue con *Esegui* o Ctrl+Invio (Cmd+Invio sul Mac); se selezioni una parte, esegue solo quella. Le query si scrivono in SQLite **o nel dialetto dei file** (MySQL, PostgreSQL, SQL Server...): se serve vengono tradotte. I nomi con lo schema (`public.clienti`) funzionano.
- Di ogni risultato si vedono le prime 1000 righe; *Scarica CSV completo* scarica tutte le righe, anche milioni. *Interrompi* ferma una query lunga.
- `INSERT`, `UPDATE`, `DELETE`, `DROP` chiedono conferma e cambiano solo il database SQLite, mai i file. *Ricarica i dati dai file* annulla le modifiche.
- Con molti dati (oltre 256 MB) il database si costruisce **su disco** una volta sola (con la stima di tempo e spazio, interrompibile) e si riapre subito le volte dopo. *Cancella i database su disco* libera lo spazio. Si scarica come file `.sqlite` o script SQL.

### Verifica con l'interfaccia (Windows)
Per il programma che usa il database (per esempio un gestionale scaricato):

1. **Scegli la finestra del programma** dall'elenco delle finestre aperte.
2. **Fai tutto da solo**: legge tutte le schede del programma, analizza e salva `rapporto.html`, `rapporto.txt` e `dettagli.xlsx` in `Documenti/SQL FK Finder/rapporti/<programma data>`, con il pulsante *Apri la cartella*. In alternativa: *Leggi questa schermata*, *Leggi tutte le schede* (passa tra schede e voci degli alberi di navigazione), *Registra mentre navigo* (legge ogni schermata che apri tu, anche le finestre secondarie: serve per le schermate che si aprono con un pulsante).
3. **Analizza le schermate lette** mostra:
   - la **sintesi** in parole semplici;
   - la **mappa del programma**: le entità con la loro tabella e le colonne collegate, e le frecce colorate (verde = prevista e confermata, blu = già chiave esterna, rosso = usata dal programma ma non prevista, grigio = indizio debole);
   - **come comunicano le parti**, schermata per schermata, una frase per ogni collegamento, con l'SQL per aggiungere quelli mancanti;
   - precisione e richiamo delle previsioni, e le tabelle di dettaglio;
   - *Scarica il rapporto (HTML)* e *Scarica i dettagli in Excel*.

Il programma viene solo letto: **non si premono pulsanti, non si usano i comandi dei menu, non si scrive nei campi** (i menu a tendina si aprono e richiudono solo per leggerne le voci). Se il database delle query è pronto, anche i valori mostrati vengono confrontati con i dati e i collegamenti diventano più sicuri. Le schermate lette si salvano nel progetto, quindi l'analisi si può rifare anche su Mac o Linux.

### Tabelle
Ogni tabella con numero di colonne, chiave primaria (dichiarata o indovinata) e numero di colonne della chiave.

### PK composte
Per ogni tabella con chiave primaria su più colonne, ogni colonna della chiave analizzata da sola: a quale tabella appartiene, se lì è chiave primaria, e il collegamento completo quando la tabella contiene tutta la chiave di un'altra.

### FK candidate
Tutte le chiavi esterne proposte con affidabilità, tipi, relazione (1:1, 1:N), obbligatorietà e l'SQL per aggiungerle. Si filtra per affidabilità e si copiano le istruzioni SQL delle righe filtrate.

### Scelta con clingo
clingo sceglie, tra tutte le candidate, l'**insieme di chiavi esterne più coerente** (dettagli in [Come funziona](04-come-funziona.md#9-scelta-con-clingo-asp)). Opzioni: *anche le candidate ad affidabilità media*, *usa le schermate lette del programma*. Risultato: riepilogo (candidate, scelte, scartate, ottimo dimostrato), chiavi scelte con il motivo, **candidate scartate con il motivo**, differenze con la scelta automatica, le regole usate. Si scaricano le chiavi scelte (`.sql`) e il programma ASP con i fatti (`.lp`, utilizzabile con clingo da terminale).

### Qualità schema
I controlli di progettazione raccolti per tipo: tabelle senza chiave primaria, tabelle ponte (N:M), problemi di normalizzazione (1NF, 2NF, 3NF), relazioni ridondanti, con le regole ON DELETE / ON UPDATE scelte nelle Impostazioni.

### Regole di progettazione
Le regole R0-R8 (codice corretto, integrità dell'entità e referenziale, chiavi esterne dichiarate, ridondanze, cardinalità, forme normali) con il numero di problemi trovati per ciascuna e gli esempi sbagliato / corretto.

### Altri risultati
Colonne con lo stesso nome in più tabelle, colonne con nomi simili, colonne che sembrano chiavi esterne ma non hanno una tabella a cui collegarsi, tabelle isolate.

### Ontologia
Ontologia OWL (Turtle) e mapping R2RML generati dallo schema: classi dalle tabelle, proprietà dalle colonne e dalle chiavi esterne (dichiarate e trovate ad affidabilità alta), nomi in italiano o inglese secondo la lingua delle tabelle. Si apre in Protégé.

### Salva risultati
Scrive in una cartella (o scarica): Excel con un foglio per ogni analisi, `fk_candidate.sql` (ALTER TABLE), `create_table_con_fk.sql` (CREATE TABLE con le chiavi), `diagnostica.txt`, ontologia e mapping, schemi HTML.

### Impostazioni
- **Controllo dell'app** (vedi [Installazione e avvio](02-installazione-e-avvio.md#controllo-dellapp)).
- **Dialetto SQL** dei file (mysql, tsql, oracle, postgres, sqlite).
- **Soglie**: nomi simili delle colonne e gruppi di tabelle (tra 0 e 1).
- **Regole ON DELETE / ON UPDATE** delle chiavi proposte.
- **Colonne generiche** (che non sono mai chiavi esterne: `id`, `nome`, `note`...) e **parole che non indicano entità** (`tbl`, `tmp`, `log`...).
- **Sinonimi**: gruppi di parole che indicano la stessa entità, per esempio `comune = citta = paese`, `cliente = customer`.
