# 8. Domande frequenti e problemi

[Indice](README.md) · Precedente: [Riga di comando](07-riga-di-comando.md)

## Avvio

**Windows dice "Windows ha protetto il PC".**
L'app non è firmata digitalmente. Clicca *Ulteriori informazioni* → *Esegui comunque*.

**Il Mac dice che l'app non può essere aperta.**
Clic destro sull'app → *Apri* → *Apri*. Serve solo la prima volta.

**Come so se l'app funziona su questo computer?**
Al primo avvio si controlla da sola; poi *Impostazioni → Controlla l'app*. Ogni voce deve essere OK (la lettura delle finestre è INFO su Mac e Linux). Il risultato è anche in `autoverifica.txt` (pulsante *Apri la cartella*).

**Dai sorgenti l'app dice "Python non trovato".**
Serve un Python 3 con le librerie: `pip install -r requirements.txt`. Per usarne uno preciso: `SQLFK_PYTHON=/percorso/python npm start`. Gli eseguibili hanno Python incluso e non hanno questo problema.

## File

**Il file è grandissimo (decine di GB): lo legge?**
Sì: si legge a blocchi e se ne tiene solo la struttura. Nel browser i file sopra 64 MB si aprono scrivendo il percorso nel campo in alto; nell'app basta *Carica*.

**Sono state trovate 0 tabelle.**
Controlla il **dialetto** nelle Impostazioni (per i dump PostgreSQL scegli `postgres`, per SQL Server `tsql`) e che i file contengano davvero dei `CREATE TABLE` (un dump di soli dati non basta).

**Errori e avvisi indicano righe che non corrispondono.**
Nei file grandi l'app tiene solo la struttura ma i numeri di riga restano quelli del file originale. Se il file è stato modificato dopo il caricamento, ricaricalo.

**Troppe tabelle "senza chiave primaria" in un dump PostgreSQL.**
pg_dump aggiunge le chiavi primarie alla fine con `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY`: l'app le legge, ma solo se il file con gli `ALTER` è tra quelli caricati.

## Chiavi esterne

**Quanto mi posso fidare delle proposte?**
L'affidabilità **alta** è quasi sempre corretta; la **media** va verificata sui dati. La *Scelta con clingo* elimina conflitti, cicli e ridondanze; la *Verifica con l'interfaccia* conferma quelle che il programma usa davvero. Prima di eseguire uno script `ALTER TABLE` controlla sempre che nei dati non ci siano valori orfani.

**Una tabella di configurazione viene proposta come padre di tutto.**
Aggiungi le sue colonne alle **colonne generiche** o toglila con *Togli entità*.

**Le mie tabelle hanno nomi in un'altra lingua o abbreviati.**
Usa i **sinonimi** nelle Impostazioni (`cliente = customer = cli`).

## Query

**La costruzione del database delle query è lenta.**
Si fa una volta sola (circa 30 secondi per GB per PostgreSQL, 70 per MySQL), poi il database si riapre subito. Si può interrompere e riprendere.

**Lo spazio su disco non basta.**
Il database su disco richiede circa 1,2 volte i file. Libera spazio o avvia l'app con `SQLFK_CACHE` impostata a una cartella su un altro disco. *Cancella i database su disco* libera quelli vecchi.

**Una query non funziona.**
Le query si eseguono in SQLite; se SQLite non le capisce, l'app le traduce dal dialetto dei file e mostra "Eseguita come". Alcune funzioni proprie di un database (procedure, funzioni personalizzate) non esistono in SQLite.

## Verifica con l'interfaccia

**La pagina dice che la lettura delle finestre funziona solo su Windows.**
È così: usa UI Automation di Windows. Sul Mac e su Linux puoi analizzare le schermate lette su Windows aprendo il progetto salvato.

**Il mio programma non compare nell'elenco delle finestre.**
Deve essere aperto e con una finestra visibile; premi *Aggiorna l'elenco*. Se il programma è avviato come amministratore, avvia anche l'app come amministratore.

**Alcune schermate non vengono lette.**
*Leggi tutte le schede* passa solo per schede e alberi di navigazione. Per le schermate che si aprono con un pulsante usa *Registra mentre navigo* e aprile tu. I programmi Java vanno letti con **Java Access Bridge** attivo (Pannello di controllo di Java, o `jabswitch -enable`).

**Il programma ha campi senza etichetta.**
Alcuni programmi non collegano le etichette ai campi: l'app usa il testo subito prima del campo. Se una classe non si collega alla tabella giusta, i collegamenti per valore diventano più sicuri costruendo prima il database delle query (pagina *Query sui dati*).

**L'app può modificare qualcosa nel programma letto?**
No: non preme pulsanti, non usa i comandi dei menu, non scrive nei campi. Apre e richiude i menu a tendina solo per leggerne le voci.

## Rete e privacy

**L'app manda dati da qualche parte?**
No. Non usa internet e non apre porte: l'interfaccia si carica da un protocollo interno, Electron e Python si parlano con le pipe del processo, ogni richiesta verso internet è bloccata. Il controllo dell'app lo verifica (voci *Internet* e *Connessioni di rete*). Vedi [Architettura](06-architettura.md#perché-non-usa-la-rete).

**Quando serve internet?**
Solo per **creare** gli eseguibili (sul computer di chi li crea), per scaricare Electron, Python e le librerie. Mai per usarli.
