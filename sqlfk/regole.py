"""Regole di buona progettazione di un database relazionale, collegate ai codici della diagnostica.

Ogni regola dice cosa chiede, perché conta, come si corregge, con un esempio sbagliato e uno corretto.
I concetti sono quelli classici della progettazione (modello relazionale, regole di integrità,
normalizzazione); i testi sono scritti per questo progetto.
"""

REGOLE = [
    {
        "id": "R0", "titolo": "Il codice SQL deve essere corretto e senza doppioni",
        "codici": ["E001", "E002", "E003"],
        "regola": "Ogni CREATE TABLE deve essere completo (parentesi chiuse) e ogni tabella e ogni colonna deve avere un nome unico.",
        "perche": "Un file che non si legge, o una tabella definita due volte, fa sì che il database reale sia diverso da quello che si crede: l'ultima definizione sovrascrive la prima.",
        "correzione": "Correggere il file: chiudere le parentesi, togliere o rinominare la tabella o la colonna doppia.",
        "sbagliato": "CREATE TABLE clienti (id INT, nome VARCHAR(40), nome VARCHAR(40));",
        "corretto": "CREATE TABLE clienti (id INT PRIMARY KEY, nome VARCHAR(40), cognome VARCHAR(40));",
    },
    {
        "id": "R1", "titolo": "Integrità dell'entità: ogni tabella ha una chiave primaria",
        "codici": ["E010", "E011"],
        "regola": "Ogni tabella deve avere una chiave primaria: una colonna (o un insieme di colonne) il cui valore esiste sempre, non è mai NULL ed è diverso per ogni riga. Se nessun dato naturale va bene, si usa una chiave artificiale (un numero progressivo).",
        "perche": "Senza chiave primaria non si può indicare una riga precisa: non si possono collegare altre tabelle a quella riga, e possono esistere righe doppie indistinguibili.",
        "correzione": "Dichiarare PRIMARY KEY sulla colonna che identifica la riga, oppure aggiungere una chiave artificiale.",
        "sbagliato": "CREATE TABLE log_accessi (utente VARCHAR(40), istante DATETIME);",
        "corretto": "CREATE TABLE log_accessi (id_log INT AUTO_INCREMENT PRIMARY KEY, utente VARCHAR(40), istante DATETIME);",
    },
    {
        "id": "R2", "titolo": "Integrità referenziale: ogni chiave esterna punta a una riga che esiste",
        "codici": ["E020", "E021", "E022", "E023", "E024", "E025", "W026", "W027"],
        "regola": "Una chiave esterna deve puntare alla chiave primaria (o a una colonna UNIQUE) di una tabella esistente, con colonne esistenti e dello stesso tipo; ogni valore della chiave esterna deve esistere nella tabella padre. Vanno decise anche le regole per cancellazioni e modifiche del padre: RESTRICT (vietate se ci sono figli), CASCADE (si propagano ai figli), SET NULL (i figli restano senza padre, solo se la colonna può essere NULL). Le regole che lasciano figli senza padre vanno evitate quando il padre è obbligatorio.",
        "perche": "Se la chiave esterna punta a qualcosa che non esiste, o a una colonna che non identifica una riga, il collegamento non garantisce niente e nascono dati orfani (fatture di clienti che non esistono).",
        "correzione": "Far puntare la chiave esterna alla chiave primaria del padre, con lo stesso tipo; scegliere ON DELETE e ON UPDATE (in Impostazioni); in MySQL usare tabelle InnoDB.",
        "sbagliato": "FOREIGN KEY (id_cliente) REFERENCES clienti (nome)   -- nome non è la chiave, id_cliente BIGINT e clienti.id INT",
        "corretto": "FOREIGN KEY (id_cliente) REFERENCES clienti (id_cliente) ON DELETE RESTRICT ON UPDATE CASCADE",
    },
    {
        "id": "R3", "titolo": "Ogni collegamento tra tabelle è una chiave esterna dichiarata",
        "codici": ["W030", "W031", "I032", "W033"],
        "regola": "Quando una colonna contiene il codice di una riga di un'altra tabella (id_cliente, cod_articolo), il collegamento va dichiarato con FOREIGN KEY, non lasciato implicito nei nomi.",
        "perche": "Solo una chiave esterna dichiarata fa controllare al database l'integrità referenziale; senza, il collegamento esiste solo nella testa di chi ha scritto il programma e i dati si sporcano col tempo.",
        "correzione": "Aggiungere la chiave esterna (lo script ALTER TABLE o CREATE TABLE proposto), dopo aver verificato sui dati che non ci siano orfani; se i tipi sono diversi, allinearli prima.",
        "sbagliato": "CREATE TABLE fatture (numero INT PRIMARY KEY, id_cliente INT);   -- collegamento solo nel nome",
        "corretto": "CREATE TABLE fatture (numero INT PRIMARY KEY, id_cliente INT NOT NULL,\n  FOREIGN KEY (id_cliente) REFERENCES clienti (id_cliente));",
    },
    {
        "id": "R4", "titolo": "Niente relazioni ridondanti",
        "codici": ["W034"],
        "regola": "Una relazione diretta tra due tabelle non deve ripetere un collegamento già ottenibile passando per altre tabelle.",
        "perche": "Lo stesso fatto memorizzato due volte può diventare contraddittorio: un comune collegato a una regione diversa da quella della sua provincia.",
        "correzione": "Togliere la colonna che crea il percorso duplicato e ricavare il dato con un join.",
        "sbagliato": "comuni (id_comune, id_provincia, id_regione)   -- la regione si ricava già dalla provincia",
        "corretto": "comuni (id_comune, id_provincia)   e   province (id_provincia, id_regione)",
    },
    {
        "id": "R5", "titolo": "Relazioni e cardinalità rappresentate correttamente",
        "codici": ["I035", "I036", "I038"],
        "regola": "Una relazione 1:N si realizza con una chiave esterna nella tabella dal lato N; una 1:1 con una chiave esterna anche UNIQUE; una N:M con una tabella ponte la cui chiave primaria è formata dalle due chiavi esterne (gli attributi della relazione vanno nella tabella ponte). Se la partecipazione è obbligatoria, la chiave esterna è NOT NULL.",
        "perche": "La struttura delle tabelle deve rispecchiare le cardinalità del modello E-R: altrimenti il database permette situazioni che nella realtà non possono esistere (un ordine senza cliente).",
        "correzione": "Dichiarare NOT NULL le chiavi esterne obbligatorie; usare una tabella ponte per le N:M; verificare che una tabella isolata sia davvero indipendente.",
        "sbagliato": "piatti (id_piatto, ingrediente1, ingrediente2, ingrediente3)",
        "corretto": "piatto_ingredienti (id_piatto, id_ingrediente, grammi, PRIMARY KEY (id_piatto, id_ingrediente))",
    },
    {
        "id": "R6", "titolo": "Prima forma normale: valori atomici",
        "codici": ["W101", "W102", "W103"],
        "regola": "Ogni campo contiene un solo valore, non scomponibile: niente campi composti (nome e cognome insieme), niente liste in un campo, niente gruppi di colonne ripetute (telefono1, telefono2, telefono3).",
        "perche": "Con valori non atomici non si può cercare, ordinare o collegare per una parte del dato, e il numero di valori è limitato dal numero di colonne.",
        "correzione": "Dividere il campo composto in più colonne; spostare i valori ripetuti in una tabella collegata, una riga per valore.",
        "sbagliato": "clienti (id_cliente, generalita, telefono1, telefono2)",
        "corretto": "clienti (id_cliente, cognome, nome)   e   clienti_telefoni (id_cliente, telefono)",
    },
    {
        "id": "R7", "titolo": "Seconda forma normale: dipendere da tutta la chiave",
        "codici": ["W201"],
        "regola": "In una tabella con chiave primaria composta, ogni colonna non chiave deve dipendere da tutta la chiave, non da una sola parte.",
        "perche": "Un dato che dipende da una parte della chiave viene ripetuto in molte righe: si creano anomalie di inserimento, modifica e cancellazione (cambiare la città di un fornitore in tutte le sue forniture).",
        "correzione": "Spostare la colonna nella tabella identificata da quella parte della chiave.",
        "sbagliato": "forniture (id_fornitore, id_articolo, citta_fornitore, quantita)",
        "corretto": "forniture (id_fornitore, id_articolo, quantita)   e   fornitori (id_fornitore, citta)",
    },
    {
        "id": "R8", "titolo": "Terza forma normale: niente dipendenze transitive",
        "codici": ["W301"],
        "regola": "Ogni colonna non chiave deve dipendere direttamente dalla chiave primaria, non da un'altra colonna non chiave.",
        "perche": "Se un dato dipende da un'altra colonna (la ragione sociale dal cliente della fattura) viene copiato in ogni riga: con il tempo le copie diventano diverse tra loro.",
        "correzione": "Togliere la colonna e ricavarla con un join dalla tabella da cui dipende.",
        "sbagliato": "fatture (numero, id_cliente, ragione_sociale, importo)",
        "corretto": "fatture (numero, id_cliente, importo)   e   clienti (id_cliente, ragione_sociale)",
    },
]

REGOLA_DI = {codice: r for r in REGOLE for codice in r["codici"]}


def spiega(codice):
    """Testo della regola a cui appartiene un codice (per il terminale)."""
    r = REGOLA_DI.get(codice.upper())
    if not r:
        return f"Codice sconosciuto: {codice}"
    return "\n".join([
        f"{r['id']}. {r['titolo']}  (codici: {', '.join(r['codici'])})",
        "",
        f"Regola: {r['regola']}",
        f"Perché: {r['perche']}",
        f"Come correggere: {r['correzione']}",
        "",
        "Sbagliato:", "    " + r["sbagliato"].replace("\n", "\n    "),
        "Corretto:", "    " + r["corretto"].replace("\n", "\n    "),
    ])
