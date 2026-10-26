# Gestionale ordini di prova

Un piccolo programma con finestre e tasti (clienti, ordini, magazzino) che usa MySQL. Serve a provare la pagina
**Ascolta il database** di SQL FK Finder senza un programma vero.

## Avvio

```bash
./avvia.sh
```

Serve MySQL (o MariaDB) installato (sul Mac: `brew install mysql`) e un Python 3 con tkinter. Lo script:

- avvia un **MySQL privato** della demo (dati in `.mysql/`, solo socket `/tmp/sqlfk-demo-<utente>.sock`, nessuna porta
  di rete) con il **general log** acceso nel file `query.log` di questa cartella. Un MySQL già installato non viene toccato;
- crea il database `negozio` con qualche dato e scrive il dump nella cartella `database/`: un file `.sql` per ogni
  tabella (struttura e dati), uno per la vista `v_ordini_aperti` e `procedure.sql` con la procedura `chiudi_ordine`;
- apre il gestionale.

`./ferma.sh` ferma il MySQL della demo. Per ricominciare da zero cancella la cartella `.mysql`.

## Prova

1. In SQL FK Finder carica la **cartella** `database` (tutti i file `.sql`: serve per il confronto con le chiavi del database).
2. Apri *Reverse engineering → Ascolta il database*, scegli `query.log` di questa cartella e premi *Leggi il file*.
3. *Registra il rumore* per qualche secondo senza toccare il gestionale, poi *Fine*: il gestionale controlla le
   notifiche ogni 3 secondi da solo, e queste query non si conteranno.
4. Per ogni tasto: scrivi il nome dell'azione, *Inizia*, premi il tasto nel gestionale, *Fine*. Per esempio
   *Nuovo ordine → Salva ordine*, *Dettaglio*, *Spedisci*, *Annulla ordine*, *Carico merce*, *Elimina cliente*.

Nel database è dichiarata solo la chiave `ordini.cliente → clienti.id`: le altre (`ordini_righe.ordine → ordini.id`,
`ordini_righe.prodotto → prodotti.codice`, `magazzino.prodotto → prodotti.codice`, `prodotti.categoria → categorie.id`,
`movimenti.prodotto`) l'ascolto le ritrova dalle query del programma.
