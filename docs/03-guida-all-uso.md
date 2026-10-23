# 3. Guida all'uso

[Indice](README.md) · Precedente: [Installazione e avvio](02-installazione-e-avvio.md) · Successivo: [Come funziona](04-come-funziona.md)

## Percorso consigliato

1. **Carica** i file `.sql` (barra in alto).
2. Guarda la **Panoramica** e i **Problemi** (errori e avvisi).
3. Leggi il **Reverse engineering** (cosa rappresenta ogni tabella, il filo logico); se nella cartella ci sono altri file (codice, configurazioni, mapping XML) guardali in **File della cartella** e **File XML** accanto alle schede delle tabelle; togli le entità che non interessano (**Togli entità**) e controlla **Aree e gruppi**.
4. Controlla le **FK candidate**; se i file hanno i dati, verificale con **Chiavi verificate sui dati**; poi falle scegliere a **clingo** (*Scelta con clingo*).
5. Se hai il programma che usa il database: **Verifica con l'interfaccia** (su Windows), poi di nuovo *Scelta con clingo* con le conferme del programma.
6. Guarda il risultato negli **Schemi grafici** e nel **Modello relazionale**.
7. **Salva risultati** (Excel, script SQL, schemi) e **Salva progetto** per riprendere il lavoro.

## La barra in alto

In alto c'è una barra a schede come quella di Word: ogni scheda è una funzionalità e mostra i suoi pulsanti, divisi in gruppi. Cliccando una scheda si vedono i pulsanti; aprendo una pagina la barra passa da sola alla scheda che la contiene. I pulsanti grigi si attivano dopo aver caricato i file. La pagina **Come si usa** (schede *Home* e *Guida*) spiega cosa fa ogni pulsante e ha il pulsante per aprirlo.

| Scheda | Gruppi e pulsanti |
|---|---|
| **Home** | *Carica*: Carica cartella, Carica file .sql, percorso + Apri · *Progetto*: Apri progetto, Salva progetto · *Inizia*: Panoramica, Problemi, Come si usa |
| **Analisi** | *Chiavi*: Tabelle, PK composte, FK candidate, Scelta con clingo, Verificate sui dati · *Qualità*: Qualità schema, Regole, Altri risultati · *Struttura*: Aree e gruppi, Togli entità |
| **Reverse engineering** | *Capire il database*: Reverse engineering, Viste e procedure · *Il programma*: Verifica con l'interfaccia · *La cartella*: File della cartella, File XML |
| **Diagrammi** | *Schemi*: Schemi grafici, Modello relazionale · *Disegno*: Editor del database, Disegno affiancato |
| **Dati** | *Tabelle*: Dati delle tabelle, Peso delle tabelle · *SQL*: Query sui dati |
| **Esporta** | *Genera*: Codice generato, Ontologia · *Salva*: Salva risultati |
| **Guida** | *Aiuto*: Come si usa, Regole di progettazione · *App*: Impostazioni |

I comandi per caricare e salvare (scheda *Home*):

| Comando | Cosa fa |
|---|---|
| **Carica cartella** | legge tutti i file `.sql` di una cartella |
| **Carica file .sql** | legge uno o più file scelti |
| **Apri progetto** | riapre un lavoro salvato (`.sqlfk`) |
| **Salva progetto** | salva file letti, impostazioni, tabelle tolte, disposizione del diagramma, modello dell'editor, lavagna e schermate lette del programma |
| campo del **percorso** + *Apri* | legge una cartella o un file scrivendone il percorso (utile nel browser per i file grandi) |

Sotto la barra c'è il riepilogo: errori, avvisi, tabelle, aree, gruppi, chiavi primarie composte, chiavi dichiarate e candidate, tabelle isolate.

**File grandi.** I file si leggono a blocchi: un dump da 1 GB si legge in pochi secondi, anche da 30 GB funziona. Durante la lettura compare una barra con la percentuale, il tempo che manca e il pulsante *Interrompi*. Dei file sopra 64 MB si tiene solo la struttura (CREATE, ALTER...): i numeri di riga restano quelli del file e i dati si usano nella pagina *Query sui dati*.

## Le pagine

### Panoramica
Il database com'è nei file, prima dell'analisi: tabelle, colonne, chiavi primarie (semplici, composte, mancanti), chiavi esterne già dichiarate, tabelle collegate e isolate, gruppi. In fondo l'elenco delle chiavi dichiarate e gli eventuali errori di lettura dei file.

### Editor del database
Per disegnare un database da zero o modificarne uno: aggiungi entità con attributi (tipo, chiave primaria, obbligatorio), collegale con relazioni 1:N, 1:1 o N:M (per le N:M crea da solo la tabella ponte, anche con attributi propri). Mostra lo schema logico, gli avvisi e l'SQL (`CREATE TABLE` in ordine giusto, con le chiavi esterne). *Importa il database caricato* parte dalle tabelle caricate; *Analizza questo schema* lo passa a tutte le altre pagine come se fossero file caricati.

### Disegno affiancato
A sinistra il **diagramma del database caricato**, a destra una **lavagna bianca** (lo stesso editor della pagina *Editor del database*).

- A sinistra cerchi per tabella/entità e per attributo (con *anche le collegate*) e **clicchi le tabelle** da copiare: diventano colorate. *Scegli le visibili* prende tutte quelle mostrate dalla ricerca, *Nessuna* toglie la scelta.
- **Copia nella lavagna** porta le tabelle scelte (con *con le tabelle collegate* anche quelle collegate) con tutte le colonne e i collegamenti tra loro e con le tabelle già nella lavagna; mantengono la disposizione del diagramma e vanno a destra di quello che c'è già. Una tabella già presente non si copia due volte.
- Nella lavagna **migliori il disegno**: sposti le tabelle, clicchi un'entità per cambiarne nome e attributi (riquadro *Entità scelta nella lavagna* sotto), aggiungi entità e relazioni, elimini. Sotto c'è anche l'SQL del disegno.
- **Scarica il disegno** salva un file `.json`; **Apri un disegno** lo riapre per continuare (anche un file di progetto `.sqlfk`). Il disegno si salva anche con *Salva progetto*. *Scarica SQL* e *Scarica PNG* esportano il disegno; *Porta nell'Editor* lo copia nella pagina *Editor del database*, per analizzarlo come un database caricato.

### Problemi
La diagnostica come un compilatore: ogni riga ha gravità (errore, avviso, info), codice, file e riga, tabella e colonna, messaggio e suggerimento. Si filtra per gravità e per regola; cliccando una riga si vede il **pezzo di file** con la riga evidenziata e la **regola di progettazione** violata, con esempio sbagliato e corretto. Elenco completo dei codici: [Diagnostica](05-diagnostica.md).

### Reverse engineering
Per capire un database che non conosci, senza perdersi nel groviglio delle linee:

- **il filo logico**: area per area, le tabelle nell'ordine in cui conviene leggerle (prima quelle da cui dipendono le altre: anagrafiche ed elenchi; poi movimenti, righe di dettaglio, tabelle ponte), una frase per tabella;
- **la scheda di ogni tabella**: cosa rappresenta probabilmente (per esempio *"probabilmente le righe di dettaglio di «ordini»"*), da quali tabelle dipende e quali la usano, il **significato probabile di ogni colonna** (identificativo, riferimento a un'altra tabella, possibile riferimento, data, importo, quantità, stato, tipologia, nome, recapito, codice...) e un **mini-diagramma** con solo la tabella, sopra quelle da cui dipende e sotto quelle che la usano, con le sole colonne che le collegano;
- a sinistra l'elenco delle tabelle per area, con la stessa ricerca per **entità** e per **attributo** del diagramma;
- **Scarica il dizionario dei dati (HTML)**: un documento con la sintesi, il filo logico e la scheda di ogni tabella, con i collegamenti tra le schede.

Le descrizioni sono **ipotesi** ricavate da nomi, chiavi, collegamenti e colonne tipiche: vanno confermate con chi conosce il programma, con i dati (*Query sui dati*) o con l'interfaccia del programma (*Verifica con l'interfaccia*).

### File della cartella
Tutti i file della cartella caricata, **sottocartelle comprese** (non solo i `.sql`), come in un esplora risorse: a sinistra l'albero delle cartelle, al centro il file aperto.

- **Cerca per nome**: `ordini.sql` mostra prima i file **con lo stesso nome** (anche in sottocartelle diverse, per esempio una copia di backup), poi quelli che lo contengono nel nome; con `*` e `?` è un modello (`*.xml`, `ordini_*.sql`). Il menu sotto filtra per tipo (solo `.sql`, solo XML, gli altri).
- **Cerca nel contenuto**: scrivi un testo (il nome di una tabella o di una colonna) e premi Invio: l'elenco dei file che lo contengono, quante volte e le righe; cliccando una riga si apre il file a quella riga. Se il campo del nome è pieno, si cerca solo nei file con quel nome.
- **Il file aperto** si legge con le righe numerate e la ricerca nel file (Invio per la riga successiva). I file grandi si leggono **a pezzi** da 512 KB (*Carica il pezzo successivo*), quindi si aprono anche dump da decine di GB; la codifica (UTF-8, UTF-16 dei file di Windows, Windows-1252) si riconosce da sola; i file binari non si mostrano.
- **Le tabelle del file**: per un `.sql` sopra il testo compaiono le tabelle che definisce, con la riga; cliccandone una si va alla riga e se ne apre la scheda accanto. Le tabelle che non sono nell'analisi (per esempio un `.sql` in una sottocartella, che non viene caricato) hanno il bordo tratteggiato.
- **Affianca uno schema** (fino a due): accanto al file la **scheda della tabella** del reverse engineering, lo **schema delle tabelle del file** (le tabelle del file in evidenza, quelle collegate attenuate) o il **filo logico**. Gli schemi restano quando apri un altro file e si aggiornano con le sue tabelle.
- **Scegli un'altra cartella** (o il suo percorso) per guardare un'altra cartella senza cambiare il database caricato; *Torna alla cartella caricata* per tornare indietro.

I file si leggono soltanto: l'app non li modifica e non esce dalla cartella scelta.

### File XML
I file XML della cartella (anche `.xsd`, `.config`, `.xaml`, `.resx`, mapping `.hbm.xml`, `.edmx`...), oppure uno aperto dal computer, in quattro viste:

- **Albero**: ogni elemento con i suoi attributi e il testo; si apre e chiude con un clic (i figli si disegnano solo quando servono, quindi vanno bene anche file grandi). La ricerca trova elementi, attributi, valori e testo e porta al punto nell'albero.
- **Riepilogo**: elemento principale, numero di elementi, attributi, profondità, namespace e la tabella degli elementi (quante volte compaiono, con quali attributi, un percorso di esempio come `/hibernate-mapping/class[2]/property`).
- **Tabelle del database**: le tabelle del database caricato che compaiono nel file (come nome di un elemento, di un attributo, come valore o come testo) e le loro **colonne** trovate vicino all'elemento che nomina la tabella, come nei mapping degli ORM (`<class table="fatture"><property column="importo"/>`). *mostra* porta al punto nell'albero, il nome apre la scheda della tabella accanto.
- **Testo**: il file con le righe numerate. Se l'XML non è valido compare l'errore (riga e colonna) e il testo.

Anche qui si possono **affiancare** la scheda di una tabella, lo schema delle tabelle trovate nel file o il filo logico.

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
- *Linee solo della tabella sotto il mouse*: le linee restano nascoste e compaiono solo per la tabella su cui passi il mouse, così il diagramma non diventa un groviglio.
- **Vista a grafo**: grafo interattivo (pyvis), anche in una finestra a parte.

### Modello relazionale
Lo schema logico, una riga per tabella (`Fatture(numero, data, id_cliente → Clienti)`), con esportazione in testo, Markdown, Mermaid, PlantUML, Graphviz DOT, DBML, JSON e come immagine.

### Togli entità
Scrivi il nome di una tabella, anche completo (`piatto_ingredienti`), o di un'entità (`piatto`): mentre scrivi compaiono le tabelle **con lo stesso nome**, quelle **che lo contengono** nel nome e quelle **della stessa entità** (riconosce plurali, accenti, prefissi, sinonimi). Nessuna è spuntata: scegli tu quali togliere (o *Seleziona tutte*) e premi *Togli*. Le tabelle tolte sono escluse da tutte le analisi e la ricerca resta, per continuare; si rimettono quando vuoi (*Rimetti selezionate*, *Rimetti tutte*). Utile per concentrarsi su una parte del database.

### Dati delle tabelle
Le tabelle popolate dai file (`INSERT`, `COPY`): a sinistra l'elenco con il numero di righe (con *anche le vuote* compaiono anche quelle senza dati), a destra la tabella scelta.

- **Struttura**: colonne, tipi, chiave primaria, colonne obbligatorie e a quale tabella è collegata ogni chiave esterna (dichiarata o trovata).
- **Dati**: 100 righe per pagina (*Precedente*, *Successiva*), con la ricerca di un valore in tutte le colonne (Invio).
- **Righe collegate**: cliccando una riga si vedono le righe a cui punta (per esempio il cliente di un ordine) e quelle che puntano a lei (le righe dell'ordine), seguendo gli stessi collegamenti del diagramma. Se un valore non esiste nella tabella collegata la riga è segnalata come **orfana**. *Apri* porta alla tabella collegata con il filtro su quei valori; così si va da una tabella all'altra, e *Indietro* torna al passo prima.

### Peso delle tabelle
Tutte le tabelle dei file, **anche le più leggere e quelle vuote**, con colonne, righe e **spazio** occupato dai dati (nel database delle query). Si ordinano dalle più leggere, dalle più pesanti, per righe o per nome, e si cercano per nome. Spunta le tabelle (*Scegli le vuote* le prende tutte) e premi **Togli dall'analisi**: spariscono da tutte le analisi e dagli schemi; con *mostra anche le tolte* si vedono ancora e si rimettono con **Rimetti nell'analisi**. I file `.sql` non vengono mai modificati. Cliccando il nome di una tabella se ne vedono i dati.

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

### Chiavi verificate sui dati
Serve un dump con i dati (`INSERT` o `COPY`); usa il database della pagina *Query sui dati* (se è grande va costruito prima, una volta sola). *Verifica con i dati* lavora in background con l'avanzamento e si può interrompere; *Scarica (Excel)* salva i tre risultati.

- **Chiavi esterne controllate sui dati**: per ogni chiave dichiarata o trovata (anche ad affidabilità media, se la casella è spuntata), i valori della colonna figlia, quanti non esistono nella tabella collegata (**orfani**, contati sulle righe e sui valori diversi), la percentuale trovata, qualche esempio di orfano e l'esito: **confermata** (nessun orfano), **pochi orfani** (almeno il 95%), **dubbia** (almeno la metà), **probabilmente sbagliata**, **senza dati**.
- **Collegamenti trovati dai valori**: colonne i cui valori sono **tutti** nella chiave primaria (o in una colonna UNIQUE) di un'altra tabella, anche se i nomi non si somigliano (`ordini.agente` → `agenti.matricola`). *Forte* se ci sono almeno 10 valori diversi che non sono una semplice sequenza 1, 2, 3... e la colonna copre quella chiave meglio delle altre; *debole* altrimenti (nascosti di default).
- **Profilo delle colonne**: righe, NULL, valori diversi e una classificazione con il suggerimento: tabella vuota, sempre vuota, quasi vuota, costante, possibile ENUM, possibile chiave naturale. Cliccando una colonna si vedono i suoi **valori più frequenti** (utile per capire i codici).

### Viste e procedure
Le viste, le procedure, le funzioni e i trigger dei file `.sql`, con la **matrice CRUD**: per ogni oggetto e tabella se la inserisce (C), la legge (R), la modifica (U) o la cancella (D). Il dettaglio dice l'istruzione, se la tabella è nello schema e se è stata riconosciuta con l'albero sintattico (sqlglot) o con le espressioni regolari (codice procedurale); cliccando una riga si vede il pezzo di file. *Scarica (Excel)* salva matrice e dettaglio.

### Codice generato
- **Modelli SQLAlchemy (Python)**: una classe per tabella con colonne, tipi, chiavi primarie, `ForeignKey` (dichiarate e trovate ad affidabilità alta, segnate con un commento) e `relationship()`; le tabelle senza chiave primaria diventano `Table`. Si scarica come `modelli_sqlalchemy.py`.
- **Script di normalizzazione (SQL)**: una bozza per correggere i problemi della pagina *Qualità schema*: divide i campi composti, sposta gruppi ripetuti e colonne con più valori in tabelle figlie (1NF), controlla e toglie le copie di colonne di altre tabelle (2NF, 3NF). Si sceglie il dialetto; i `DROP COLUMN` sono commentati. Va rivisto e provato su una copia del database.

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
