# 5. Diagnostica: codici e regole

[Indice](README.md) · Precedente: [Come funziona](04-come-funziona.md) · Successivo: [Architettura](06-architettura.md)

La diagnostica mostra i problemi del database **come un compilatore**: per ognuno gravità, codice, file e riga, tabella e colonna, messaggio e suggerimento. Si vede nella pagina *Problemi*, nel file `diagnostica.txt` e da terminale con `python -m sqlfk.verifica` (vedi [Riga di comando](07-riga-di-comando.md)).

| Gravità | Significato |
|---|---|
| **errore** | il database è sbagliato: va corretto |
| **avviso** | probabilmente c'è qualcosa da sistemare: va controllato |
| **info** | un'informazione utile, non per forza un problema |

Le lettere del codice indicano la gravità (E errore, W avviso, I info); il numero indica l'argomento (00 lettura, 01 chiave primaria, 02 chiavi dichiarate, 03 chiavi mancanti, 1xx/2xx/3xx forme normali).

## Tutti i codici

| Codice | Gravità | Regola | Significato | Come correggere |
|---|---|---|---|---|
| E001 | errore | R0 | un `CREATE TABLE` non è chiuso (manca la parentesi): la tabella non è stata letta | chiudere la parentesi |
| E002 | errore | R0 | la stessa tabella è definita due volte: vale l'ultima | togliere o rinominare una delle due |
| E003 | errore | R0 | la stessa colonna è definita due volte in una tabella | togliere o rinominare la colonna |
| E010 | errore | R1 | la tabella non ha una chiave primaria | dichiarare la chiave, o aggiungerne una artificiale (`id_tabella INT AUTO_INCREMENT PRIMARY KEY`) |
| E011 | errore | R1 | la chiave primaria usa una colonna che non esiste | correggere il nome nella `PRIMARY KEY` |
| E020 | errore | R2 | una chiave esterna punta a una tabella che non esiste | creare la tabella o correggere il nome |
| E021 | errore | R2 | una chiave esterna usa colonne che non esistono nella tabella | correggere il nome della colonna |
| E022 | errore | R2 | una chiave esterna punta a colonne che non esistono nella tabella padre | correggere il nome della colonna puntata |
| E023 | errore | R2 | una chiave esterna non punta alla chiave primaria (né a una colonna `UNIQUE`) del padre | farla puntare alla chiave primaria |
| E024 | errore | R2 | una chiave esterna collega tipi diversi | usare lo stesso tipo nelle due colonne |
| E025 | errore | R2 | MySQL non accetta chiavi esterne su tabelle partizionate | togliere il partizionamento o rinunciare alla chiave |
| W026 | avviso | R2 | tabella MyISAM: MySQL ignora le sue chiavi esterne | `ALTER TABLE ... ENGINE=InnoDB` |
| W027 | avviso | R2 | una chiave esterna collega tipi diversi ma compatibili (`INT` / `BIGINT`) | funziona, ma conviene usare lo stesso tipo |
| W030 | avviso | R3 | manca una chiave esterna (candidata ad affidabilità alta) | aggiungerla con lo script proposto, dopo averla controllata sui dati |
| W031 | avviso | R3 | una colonna sembra una chiave esterna ma i tipi sono diversi | allineare i tipi, poi aggiungere la chiave |
| I032 | info | R3 | possibile chiave esterna (affidabilità media) | verificarla sui dati prima di aggiungerla |
| W033 | avviso | R3 | una colonna sembra una chiave esterna ma non c'è una tabella a cui collegarla | controllare se la tabella manca dai file o ha un nome diverso |
| W034 | avviso | R4 | il collegamento è probabilmente ridondante: c'è già un percorso tra le due tabelle | non aggiungere questa chiave (o togliere la colonna) |
| I035 | info | R5 | la tabella non è collegata a nessun'altra | verificare se è davvero indipendente (configurazioni, log) |
| I036 | info | R5 | tabella ponte di una relazione N:M | nessuna azione: è la rappresentazione corretta |
| I038 | info | R5 | la relazione è facoltativa: la colonna può essere NULL | se ogni riga deve avere il padre, dichiararla `NOT NULL` |
| W101 | avviso | R6 | campo composto (per esempio `generalita`, `indirizzo_completo`) | dividerlo in più colonne |
| W102 | avviso | R6 | gruppo di colonne ripetute (`telefono1`, `telefono2`...) | spostare i valori in una tabella collegata, una riga per valore |
| W103 | avviso | R6 | tipo non atomico (`SET`, `JSON`, `ARRAY`) | usare una tabella collegata |
| W201 | avviso | R7 | in una chiave composta, una colonna dipende solo da una parte della chiave (2NF) | spostarla nella tabella identificata da quella parte |
| W301 | avviso | R8 | una colonna dipende da un'altra colonna non chiave (3NF) | toglierla e ricavarla con un join |

## Le regole di progettazione

Ogni codice appartiene a una regola. Le regole (con il perché, la correzione e un esempio sbagliato e uno corretto) si vedono nella pagina *Regole di progettazione* e da terminale con `python -m sqlfk.verifica --spiega CODICE`.

| Regola | Titolo | Codici |
|---|---|---|
| R0 | Il codice SQL deve essere corretto e senza doppioni | E001, E002, E003 |
| R1 | Integrità dell'entità: ogni tabella ha una chiave primaria | E010, E011 |
| R2 | Integrità referenziale: ogni chiave esterna punta a una riga che esiste | E020-E025, W026, W027 |
| R3 | Ogni collegamento tra tabelle è una chiave esterna dichiarata | W030, W031, I032, W033 |
| R4 | Niente relazioni ridondanti | W034 |
| R5 | Relazioni e cardinalità rappresentate correttamente | I035, I036, I038 |
| R6 | Prima forma normale: valori atomici | W101, W102, W103 |
| R7 | Seconda forma normale: dipendere da tutta la chiave | W201 |
| R8 | Terza forma normale: niente dipendenze transitive | W301 |

## Esempio

Sugli esempi (`esempi`) la diagnostica dà **2 errori, 18 avvisi, 15 info**. Un estratto dell'uscita da terminale:

```
esempio_1.sql:12: avviso W030: manca la chiave esterna articoli.COD_CAT → categorie(CODCAT) (relazione 1:N)
esempio_2.sql:10: errore E010: la tabella righe non ha una chiave primaria
esempio_5.sql:41: avviso W034: il collegamento comuni.id_regione → regioni(id_regione) è probabilmente ridondante: c'è già comuni → province → regioni
```

Con `--regole` sotto ogni problema compare anche la regola violata.
