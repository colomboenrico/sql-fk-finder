"use strict";

// Pagina "Come si usa": il percorso consigliato e, scheda per scheda della barra in alto, cosa fa ogni pulsante.
// L'elenco si costruisce dalla barra stessa, così resta sempre uguale ai pulsanti veri.

const COSA_FA = {
  panoramica: "Il database com'è nei file: tabelle, colonne, chiavi primarie e chiavi esterne già dichiarate, tabelle collegate e isolate.",
  problemi: "Errori e avvisi come un compilatore, con file e riga, il pezzo di file e la regola di progettazione violata.",
  guida: "Questa pagina.",
  tabelle: "Tutte le tabelle analizzate con la chiave primaria (dichiarata o indovinata).",
  pk: "Le chiavi primarie su più colonne, analizzate colonna per colonna e collegate alle tabelle giuste.",
  fk: "Le chiavi esterne mancanti proposte, con l'affidabilità (alta, media), i tipi e lo script SQL.",
  asp: "Il risolutore logico clingo sceglie l'insieme di chiavi esterne più coerente e spiega ogni scarto.",
  dativerifica: "Ogni chiave esterna controllata sui dati (orfani), i collegamenti trovati dai valori e il profilo delle colonne.",
  qualita: "Tabelle senza chiave, tipo delle relazioni, normalizzazione (1NF, 2NF, 3NF), relazioni ridondanti.",
  regole: "Le regole per progettare bene un database, con esempi sbagliati e corretti.",
  altri: "Colonne con lo stesso nome o nomi simili, tabelle isolate e gli altri risultati dell'analisi.",
  gruppi: "Le tabelle divise in gruppi (per nome) e aree (per collegamenti), con le categorie e i collegamenti tra gruppi.",
  togli: "Cerca tabelle per nome o entità e toglile dall'analisi (i file non cambiano); si rimettono quando vuoi.",
  reverse: "Cosa rappresenta probabilmente ogni tabella, il significato delle colonne, il filo logico per leggere il database e il dizionario dei dati.",
  crud: "Viste, procedure, funzioni e trigger: quali tabelle leggono, inseriscono, modificano o cancellano.",
  interfaccia: "Legge le finestre del programma Windows che usa il database e controlla se le chiavi previste corrispondono.",
  ascolto: "Mentre usi il programma legge le query che manda a MySQL (dal general log): per ogni tasto tabelle, valori, JOIN e collegamenti.",
  file: "Tutti i file della cartella: cerca per nome o contenuto, leggili, affiancali agli schemi del reverse engineering.",
  xml: "I file XML come albero, con il riepilogo e le tabelle e colonne del database che vi compaiono.",
  schemi: "Il diagramma delle tabelle (raccolto per gruppi o aree, con ricerca) e i grafi interattivi.",
  modello: "Lo schema logico esportabile in testo, Mermaid, PlantUML, Graphviz, DBML, JSON.",
  editor: "Disegna un database da zero o parti da quello caricato: entità, attributi, relazioni e SQL.",
  er: "Lo schema E-R concettuale ricostruito dal database: entità, relazioni con il rombo e un nome proposto, N:M, gerarchie ISA, attributi multivalore.",
  lavagna: "Il diagramma del database accanto a una lavagna bianca: copia le tabelle, migliora il disegno, scaricalo e riaprilo.",
  datitabelle: "Struttura, righe e grafici dei dati di ogni tabella popolata; clicca una riga per le righe collegate e seguile.",
  peso: "Tutte le tabelle, anche le vuote, con righe e spazio: togli quelle che non servono.",
  query: "Interroga i dati degli INSERT e dei COPY con SQL (anche modifiche, con conferma), anche per dump enormi.",
  codice: "I modelli SQLAlchemy (Python) e una bozza di script di normalizzazione.",
  ontologia: "L'ontologia OWL e il mapping R2RML generati dallo schema.",
  salva: "Excel, script SQL, CREATE TABLE con le chiavi, diagnostica e schemi in una cartella.",
  impostazioni: "Dialetto SQL, soglie, colonne generiche, sinonimi, ON DELETE / ON UPDATE e il controllo dell'app.",
};

const PASSI = [
  ["Carica i file", "Nella scheda Home premi Carica cartella (o Carica file .sql, o scrivi il percorso e premi Apri). I file grandi si leggono a blocchi, anche da decine di GB."],
  ["Guarda il database", "Panoramica e Problemi dicono com'è fatto e cosa non va; Reverse engineering spiega cosa rappresenta ogni tabella."],
  ["Concentrati sulla parte che serve", "Togli entità o Peso delle tabelle (scheda Analisi e Dati) tolgono dall'analisi le tabelle che non interessano, per esempio le vuote."],
  ["Trova e conferma le chiavi", "FK candidate propone i collegamenti mancanti; Verificate sui dati li controlla sui dati; Scelta con clingo sceglie i migliori."],
  ["Guarda e disegna", "Schemi grafici per il diagramma; Disegno affiancato per copiare le tabelle su una lavagna e migliorare il disegno."],
  ["Salva", "Salva progetto (Home) per riprendere il lavoro; Salva risultati e Codice generato (Esporta) per i file da consegnare."],
];

Object.assign(VISTE, {
  async guida() {
    const vai = vista => () => mostra(vista);
    const schede = [...document.querySelectorAll(".scheda-nastro")].map(s => {
      const pannello = $(`.pannello-nastro[data-scheda="${s.dataset.scheda}"]`);
      const gruppi = [...pannello.querySelectorAll(".gruppo-nastro")].map(g => {
        const voci = [...g.querySelectorAll("button[data-vista]")].map(b => {
          const serve = b.hasAttribute("data-serve-dati") && !stato.caricato;
          return el("div", { class: "voce-guida" },
            el("button", { onclick: vai(b.dataset.vista), disabled: serve, title: serve ? "Carica prima i file .sql" : `Apri ${b.textContent.trim()}` },
              b.querySelector(".icona") ? b.querySelector(".icona").cloneNode(true) : null, b.dataset.vista === "problemi" ? "Problemi" : b.textContent.trim()),
            el("span", {}, COSA_FA[b.dataset.vista] || ""));
        });
        const carica = g.querySelector("#in-cartella") ? el("p", {},
          el("b", {}, "Carica cartella"), " legge tutti i file .sql di una cartella; ", el("b", {}, "Carica file .sql"), " uno o più file; ",
          "oppure scrivi il percorso di una cartella o di un file e premi ", el("b", {}, "Apri"), " (il modo migliore per i file molto grandi).")
          : g.querySelector("#in-progetto") ? el("p", {},
          el("b", {}, "Apri progetto"), " e ", el("b", {}, "Salva progetto"), " riaprono e salvano tutto il lavoro in un file .sqlfk: file letti, " +
          "impostazioni, tabelle tolte, disposizione del diagramma, editor e lavagna.") : null;
        return el("div", { class: "gruppo-guida" }, el("h4", {}, g.querySelector(".nome-gruppo").textContent), carica, voci);
      });
      return el("div", { class: "pannello" },
        el("div", { class: "riga-comandi" }, el("h3", { class: "titolo-file" }, `Scheda ${s.textContent}`),
          el("button", { onclick: () => mostraScheda(s.dataset.scheda) }, "Mostra la scheda")),
        gruppi);
    });
    return [
      el("h2", {}, "Come si usa"),
      el("p", { class: "tenue" }, "In alto ci sono le schede, una per funzionalità (come in Word): cliccane una per vederne i pulsanti, divisi in gruppi. " +
        "I pulsanti grigi si attivano dopo aver caricato i file .sql. Sotto le schede c'è il riepilogo del database caricato. " +
        "L'app lavora solo sul tuo computer: non usa la rete e non modifica mai i file."),
      el("div", { class: "pannello" }, el("h3", { class: "titolo-file" }, "Il percorso consigliato"),
        el("ol", { class: "passi-guida" }, PASSI.map(([titolo, testo]) => el("li", {}, el("b", {}, titolo), ". ", testo)))),
      schede,
      el("div", { class: "pannello" }, el("h3", { class: "titolo-file" }, "Consigli"),
        el("ul", {},
          el("li", {}, "I risultati sono ipotesi da confermare: affidabilità alta, chiavi verificate sui dati e scelta con clingo aiutano a decidere."),
          el("li", {}, "Gli script SQL proposti non vengono mai eseguiti sul tuo database: controllali ed eseguili tu."),
          el("li", {}, "Con i dump molto grandi i dati per Query, Dati e Peso delle tabelle si costruiscono una volta sola (pagina Query sui dati); le volte dopo si riaprono subito."),
          el("li", {}, "La guida completa, con come funziona ogni analisi, è nella cartella docs del progetto."))),
    ];
  },
});
