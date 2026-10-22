# 1. Introduzione

[Indice](README.md) · Successivo: [Installazione e avvio](02-installazione-e-avvio.md)

## Il problema

Molti database reali hanno tabelle collegate tra loro solo "a parole": la colonna `id_cliente` della tabella `fatture` contiene il codice di un cliente, ma nel database non c'è nessuna `FOREIGN KEY` che lo dica. Succede nei database vecchi, in quelli migrati da altri sistemi, nei dump senza vincoli, nei gestionali che controllano i collegamenti solo nel programma.

Senza chiavi esterne dichiarate:

- il database non controlla che i collegamenti siano validi (nascono dati orfani: fatture di clienti che non esistono);
- gli strumenti (diagrammi, generatori di codice, ontologie) non vedono le relazioni;
- chi deve capire il database deve ricostruirle a mano, tabella per tabella.

SQL FK Finder legge i file `.sql` (i `CREATE TABLE`) e **ricostruisce le relazioni mancanti**, spiegando quanto è sicura ogni proposta.

## Cosa fa

| Funzione | In breve |
|---|---|
| **Chiavi esterne mancanti** | Propone le chiavi esterne con un livello di affidabilità (alta, media) e lo script `ALTER TABLE` o i `CREATE TABLE` completi |
| **Chiavi primarie composte** | Analizza colonna per colonna le chiavi su più colonne e le collega alle tabelle giuste |
| **Diagnostica** | Errori, avvisi e info come un compilatore (integrità, normalizzazione, ridondanze), ognuno con la regola di progettazione e la correzione |
| **Gruppi e aree** | Raggruppa le tabelle per nome (sottogruppi) e per collegamenti (aree), riconosce le tabelle centrali e la categoria di ogni tabella (anagrafica, movimento, dettaglio, ponte...) |
| **Reverse engineering** | Per ogni tabella cosa rappresenta probabilmente e il significato delle colonne; il filo logico per leggere il database; il dizionario dei dati da scaricare |
| **File della cartella e XML** | Cerca tutti i file della cartella per nome (`ordini.sql`, `*.xml`) o per contenuto, li mostra come in un esplora risorse affiancati agli schemi del reverse engineering; apre i file XML come albero e trova le tabelle e le colonne del database che vi compaiono |
| **Diagrammi** | Diagramma delle tabelle in stile DBeaver, grafo interattivo, modello relazionale esportabile (PNG, SVG, Mermaid, PlantUML, Graphviz, DBML, JSON) |
| **Query sui dati** | Interroga i dati degli `INSERT` e dei `COPY` dei file con SQL, anche per dump da decine di GB |
| **Verifica con l'interfaccia** | Legge le finestre del programma Windows che usa il database, ne ricava le entità e controlla se le chiavi previste corrispondono a quello che il programma mostra |
| **Scelta con clingo** | Un risolutore logico (Answer Set Programming) sceglie l'insieme di chiavi esterne più coerente e spiega ogni scarto |
| **Ontologia** | Genera un'ontologia OWL e il mapping R2RML dallo schema |
| **Editor** | Disegna entità e relazioni da zero (o parte dal database caricato) e ottiene lo schema logico e l'SQL |
| **Progetti** | Salva e riapre il lavoro (file `.sqlfk`) |

## Cosa non fa

- **Non modifica mai i file `.sql`**: li legge e basta. Gli script proposti si eseguono a mano, dopo averli controllati.
- **Non si collega al tuo database** (MySQL, PostgreSQL...): lavora sui file. Le query si fanno su una copia SQLite costruita dai file.
- **Non usa la rete**: niente internet, nessuna porta aperta, nessun servizio esterno. Anche la lettura del programma Windows avviene in locale, con le funzioni di accessibilità del sistema.
- **Non usa intelligenza artificiale**: tutte le decisioni vengono da regole precise e algoritmi spiegati in [Come funziona](04-come-funziona.md). Ogni risultato si può ricostruire.

## Concetti di base

**Chiave primaria (PK)**: la colonna (o le colonne) che identifica ogni riga di una tabella, per esempio `id_cliente` in `clienti`.

**Chiave esterna (FK)**: una colonna di una tabella che contiene la chiave primaria di un'altra, per esempio `fatture.id_cliente → clienti.id_cliente`. La tabella con la FK è la *figlia*, quella puntata è il *padre*.

**Chiave dichiarata**: scritta nei file con `FOREIGN KEY ... REFERENCES` (o `ALTER TABLE ... ADD FOREIGN KEY`). Il programma la considera certa.

**Candidata**: una chiave esterna che il programma propone, con un'affidabilità:

- **alta**: la colonna ha lo stesso nome della chiave primaria di un'altra tabella, oppure contiene tutte le colonne di una chiave primaria composta;
- **media**: il nome della colonna richiama il nome di una tabella (`id_articolo` → `articoli`) ma non coincide con la sua chiave.

**Relazione 1:N, 1:1, N:M**: una provincia ha molti comuni (1:N); un cittadino ha una tessera sanitaria (1:1); un piatto ha molti ingredienti e un ingrediente sta in molti piatti (N:M, con una *tabella ponte* `piatto_ingredienti`).

**Relazione ridondante**: `comuni → regioni` quando ci sono già `comuni → province` e `province → regioni`: la regione si ricava dalla provincia.

## Gli esempi

Nella cartella `esempi` ci sono piccoli database di prova (anagrafiche, ordini, territorio, piatti e ingredienti, casi di errore) più `dati_esempio.sql` con qualche riga di dati. Sono il modo più veloce per vedere tutte le funzioni: carica la cartella `esempi` e segui la [guida all'uso](03-guida-all-uso.md). Sugli esempi la diagnostica dà sempre **2 errori, 18 avvisi, 15 info**: è anche il riferimento usato dal controllo dell'app.
