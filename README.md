<p align="center"><img src="sqlfk/web/logo.png" alt="SQL FK Finder" width="160"></p>

# sql-fk-finder

Notebook Jupyter per **trovare i collegamenti mancanti tra tabelle** di un database a partire dai file `.sql` con i `CREATE TABLE`.

Utile quando un database è stato creato senza chiavi esterne (`FOREIGN KEY`) e bisogna ricostruire le relazioni tra le tabelle guardando solo i nomi e i tipi delle colonne.

## Cosa fa

1. Legge tutti i file `.sql` di una cartella ed estrae tabelle, colonne, tipi, chiavi primarie e chiavi esterne già dichiarate (anche quelle aggiunte con `ALTER TABLE`, come nei dump di PostgreSQL; le tabelle di schemi diversi da `public`/`dbo` restano distinte) (anche dai `CREATE TABLE` con `ENGINE=`, `COMMENT`, `PARTITION BY` e altra sintassi che `sqlglot` non riesce a leggere).
2. Mostra lo **schema iniziale**: com'è collegato il database prima dell'analisi, con un riepilogo e uno schema grafico (`schema_iniziale.html`).
3. Divide le tabelle in **gruppi di entità** con nomi simili (clustering gerarchico: `ordini`, `ordini_righe`, `tbl_ordini`...).
4. Trova le **colonne con lo stesso nome** in più tabelle.
5. Trova le **colonne con nomi simili** (`CODART` / `Cod_Articolo`).
6. Propone le **chiavi esterne candidate** con un livello di affidabilità:
   - **alta**: la colonna ha lo stesso nome della chiave primaria di un'altra tabella
   - **media**: il nome della colonna rimanda al nome di una tabella (`id_articolo` → `articoli`)
   - **alta (PK composta)**: la tabella contiene tutte le colonne della chiave primaria su più colonne di un'altra tabella (`id_ordine` + `num_riga` → `ordini_righe`)
7. Per ogni tabella con **chiave primaria composta** analizza le colonne della chiave una per una: cerca una tabella con il nome del campo (`codice` → `codici`), verifica che il campo ci sia e se lì è chiave primaria; altrimenti cerca le tabelle in cui il campo è chiave primaria.
8. Controlla che i tipi coincidano ed elenca le **tabelle isolate**.
   Controlla anche la **qualità dello schema** secondo le regole di progettazione dei database relazionali: tabelle senza chiave primaria (integrità dell'entità), tipo di ogni relazione (1:1, 1:N, N:M con tabelle ponte, obbligatoria o facoltativa), avvisi di normalizzazione (1NF, 2NF, 3NF) e relazioni ridondanti. Le chiavi esterne proposte hanno le regole `ON DELETE` / `ON UPDATE` scelte nelle impostazioni (integrità referenziale).
9. Permette di **togliere entità** dall'analisi: scrivendo `piatto` vengono tolte tutte le tabelle `piatti`, `piatto_ingredienti`... (anche un gruppo intero con un clic)
10. Salva i risultati e disegna uno **schema interattivo** dei collegamenti.

Tutto si può usare da una **interfaccia grafica** dentro il notebook (ultima sezione).

Nell'app c'è anche un **diagramma delle tabelle** in stile DBeaver: ogni tabella con le sue colonne (PK, FK, UQ e tipi), le linee dalla colonna chiave esterna alla chiave puntata con la cardinalità, disposizione automatica, zoom, trascinamento, ricerca, filtro per gruppo ed esportazione in SVG.

## Diagnostica: errori e avvisi come un compilatore

Tutti i controlli vengono riportati come l'output di un compilatore, con file e riga del `.sql`:

```
esempio_5.sql:44: errore E010: la tabella log_accessi non ha una chiave primaria
    suggerimento: aggiungere una chiave artificiale: id_log_accessi INT NOT NULL AUTO_INCREMENT PRIMARY KEY
esempio_5.sql:24: avviso W301: fatture.ragione_sociale: dipendenza transitiva: fatture → id_cliente → clienti.ragione_sociale
    suggerimento: toglierla da fatture: si ricava da clienti con un join
```

| Gravità | Codici |
|---|---|
| **errore** | E001-E003 lettura dei file (parentesi non chiusa, tabella o colonna definita due volte) · E010-E011 chiave primaria mancante o su colonna inesistente · E020-E025 chiavi esterne dichiarate sbagliate (tabella o colonna inesistente, non puntano alla chiave, tipi diversi, tabella partizionata) |
| **avviso** | W026 FK su tabella MyISAM · W030 chiave esterna mancante · W031 tipi incompatibili · W033 colonna da chiave senza tabella · W034 relazione ridondante · W101-W103 prima forma normale · W201 seconda · W301 terza |
| **info** | I032 FK possibile (affidabilità media) · I035 tabella isolata · I036 tabella ponte N:M · I038 relazione facoltativa |

Da terminale, come un compilatore vero (codice di uscita 1 se ci sono errori, con `--werror` anche per gli avvisi):

```bash
python -m sqlfk.verifica esempi --senza-info
python -m sqlfk.verifica dump.sql --werror --togli piatto
```

Nell'app c'è la pagina **Problemi**: cliccando un problema si vede il punto del file con la riga evidenziata. Il report si scarica come `diagnostica.txt` ed è anche nel primo foglio dell'Excel.

## App desktop (gestionale)

Oltre al notebook c'è un'app con interfaccia grafica che fa le stesse cose: carichi i file `.sql` (una cartella intera o singoli file) e navighi tra panoramica, gruppi, schemi grafici, PK composte, FK candidate, entità da togliere e salvataggio dei risultati.

L'analisi è fatta in Python (modulo `sqlfk`, lo stesso usato dal notebook); l'interfaccia è una pagina web servita da un piccolo server locale che accetta solo connessioni dal computer stesso.

**Con un doppio clic**: `avvia_app.command` su Mac, `avvia_app.bat` su Windows (la prima volta scaricano Electron; su Mac, se il sistema blocca il file: tasto destro → Apri).

**Come app desktop (Electron)** — serve Node.js 18 o più recente:

```bash
cd app
npm install
npm start
```

L'app cerca da sola un Python con le librerie installate (`python3`, Anaconda, Homebrew...). Se ne usi uno in un percorso particolare, indicalo con la variabile `SQLFK_PYTHON`:

```bash
SQLFK_PYTHON=/percorso/del/python npm start
```

**Nel browser**, senza Electron:

```bash
python -m sqlfk.server --apri
```

e si apre `http://127.0.0.1:8765`. Con `--cartella percorso/dei/file` carica subito una cartella.

### Struttura del progetto

| Percorso | Contenuto |
|---|---|
| `collegamenti_tabelle_sql.ipynb` | il notebook, con le spiegazioni sezione per sezione |
| `sqlfk/analisi.py` | tutta l'analisi: lettura dei file, gruppi, chiavi primarie, FK candidate, salvataggio |
| `sqlfk/grafici.py` | gli schemi grafici interattivi |
| `sqlfk/server.py` | il server locale con le API usate dall'interfaccia |
| `sqlfk/verifica.py` | il controllo da terminale, come un compilatore |
| `sqlfk/web/` | l'interfaccia (HTML, CSS, JavaScript) |
| `sqlfk/web/diagramma.js` | il diagramma delle tabelle; la disposizione usa dagre (licenza MIT, in `sqlfk/web/vendor/`) |
| `app/` | l'app Electron, che avvia il server e mostra l'interfaccia |
| `avvia_app.command`, `avvia_app.bat` | avvio dell'app con un doppio clic (Mac, Windows) |
| `esempi/` | file `.sql` di prova |

## Installazione

```bash
pip install -r requirements.txt
```

oppure esegui la cella **0. Installazione** all'inizio del notebook.

Dopo l'installazione riavvia il kernel: altrimenti l'interfaccia grafica può mostrare *"Error displaying widget"*.

> Se eseguendo una cella compare *"Nessuna connessione selezionata"*, il notebook è aperto con il kernel SQL: scegli il kernel **Python 3** in alto a destra.

## Uso

1. Apri `collegamenti_tabelle_sql.ipynb` in Jupyter.
2. Nella cella **Configurazione** imposta:
   - `cartella`: la cartella con i tuoi file `.sql` (di default usa i file di prova in `esempi/`)
   - `DIALETTO`: `mysql`, `tsql` (SQL Server), `oracle`, `postgres`...
   - `ENTITA_DA_RIMUOVERE`: le entità da togliere dall'analisi, per esempio `["piatto"]`
   - `ON_DELETE`, `ON_UPDATE`: regole delle chiavi esterne proposte (`RESTRICT`, `CASCADE`, `SET NULL`...)
   - `SINONIMI`: gruppi di parole che indicano la stessa entità, per esempio `["comune = citta"]` (plurali italiani e inglesi e accenti sono già riconosciuti: `provincia`/`province`, `banco`/`banchi`, `category`/`categories`, `città`/`citta`)
   - `SOGLIA_GRUPPI`: quanto devono somigliarsi i nomi di due tabelle per stare nello stesso gruppo
3. Esegui tutte le celle (*Run → Run All Cells*): ogni sezione mostra i suoi risultati e l'ultima apre l'**interfaccia grafica**, con le schede *Panoramica*, *Gruppi*, *Tabelle*, *PK composte*, *FK candidate*, *Altri risultati*, *Togli entità* e *Salva*.

## Risultati

Nella cartella dei file `.sql` vengono creati:

| File | Contenuto |
|---|---|
| `possibili_collegamenti.xlsx` | un foglio per ogni analisi (tabelle, colonne, stesso nome, nomi simili, FK candidate, PK composte, da verificare, isolate, tabelle tolte) |
| `fk_candidate.sql` | gli `ALTER TABLE ... ADD FOREIGN KEY` proposti |
| `diagnostica.txt` | errori, avvisi e info con file e riga, come un compilatore |
| `create_table_con_fk.sql` | i `CREATE TABLE` dei file con le chiavi esterne già dentro: attive quelle ad affidabilità alta, le altre commentate con `--` e il motivo |
| `schema_iniziale.html` | il database prima dell'analisi: tabelle colorate per gruppo, chiavi esterne già dichiarate |
| `schema_collegamenti.html` | schema interattivo: frecce verdi = affidabilità alta, arancioni tratteggiate = media, tabelle grigie = isolate |

>  Le chiavi esterne trovate sono **proposte** basate sui nomi: vanno controllate prima di eseguire gli `ALTER TABLE`. Se il database contiene già dati, verifica prima che non ci siano valori orfani:
>
> ```sql
> SELECT COUNT(*) FROM tabella_figlia f
> LEFT JOIN tabella_padre p ON f.colonna = p.colonna
> WHERE f.colonna IS NOT NULL AND p.colonna IS NULL;
> ```

## Personalizzazione

- `GENERICHE`: colonne da ignorare perché compaiono ovunque senza essere collegamenti (`descrizione`, `note`, `data_ins`...).
- `SOGLIA_SIMILI`: quanto devono somigliarsi due nomi (da 0 a 1) per essere considerati simili.
