# sql-fk-finder

Notebook Jupyter per **trovare i collegamenti mancanti tra tabelle** di un database a partire dai file `.sql` con i `CREATE TABLE`.

Utile quando un database è stato creato senza chiavi esterne (`FOREIGN KEY`) e bisogna ricostruire le relazioni tra le tabelle guardando solo i nomi e i tipi delle colonne.

## Cosa fa

1. Legge tutti i file `.sql` di una cartella ed estrae tabelle, colonne, tipi e chiavi primarie (anche dai `CREATE TABLE` con `ENGINE=`, `COMMENT`, `PARTITION BY` e altra sintassi che `sqlglot` non riesce a leggere).
2. Trova le **colonne con lo stesso nome** in più tabelle.
3. Trova le **colonne con nomi simili** (`CODART` / `Cod_Articolo`).
4. Propone le **chiavi esterne candidate** con un livello di affidabilità:
   - **alta**: la colonna ha lo stesso nome della chiave primaria di un'altra tabella
   - **media**: il nome della colonna rimanda al nome di una tabella (`id_articolo` → `articoli`)
5. Controlla che i tipi coincidano ed elenca le **tabelle isolate**.
6. Salva i risultati e disegna uno **schema interattivo** dei collegamenti.

## Installazione

```bash
pip install -r requirements.txt
```

## Uso

1. Apri `collegamenti_tabelle_sql.ipynb` in Jupyter.
2. Nella cella **Configurazione** imposta:
   - `cartella`: la cartella con i tuoi file `.sql` (di default usa i file di prova in `esempi/`)
   - `DIALETTO`: `mysql`, `tsql` (SQL Server), `oracle`, `postgres`...
3. Esegui tutte le celle (*Run → Run All Cells*).

## Risultati

Nella cartella dei file `.sql` vengono creati:

| File | Contenuto |
|---|---|
| `possibili_collegamenti.xlsx` | un foglio per ogni analisi (tabelle, colonne, stesso nome, nomi simili, FK candidate, da verificare, isolate) |
| `fk_candidate.sql` | gli `ALTER TABLE ... ADD FOREIGN KEY` proposti |
| `schema_collegamenti.html` | schema interattivo: frecce verdi = affidabilità alta, arancioni tratteggiate = media, tabelle grigie = isolate |

> ⚠️ Le chiavi esterne trovate sono **proposte** basate sui nomi: vanno controllate prima di eseguire gli `ALTER TABLE`. Se il database contiene già dati, verifica prima che non ci siano valori orfani:
>
> ```sql
> SELECT COUNT(*) FROM tabella_figlia f
> LEFT JOIN tabella_padre p ON f.colonna = p.colonna
> WHERE f.colonna IS NOT NULL AND p.colonna IS NULL;
> ```

## Personalizzazione

- `GENERICHE`: colonne da ignorare perché compaiono ovunque senza essere collegamenti (`descrizione`, `note`, `data_ins`...).
- `SOGLIA_SIMILI`: quanto devono somigliarsi due nomi (da 0 a 1) per essere considerati simili.
