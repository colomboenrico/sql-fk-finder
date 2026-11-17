"use strict";

// Pagina "Backend": il backend C++ costruito dal database, quello disegnato nell'editor o quello caricato. Una classe per
// tabella con getter e setter, un repository per tabella (inserisci, aggiorna, elimina, trova, tutti), le query salvate con
// "Chiedi un dato" (query.hpp) e il programma di prova. Si rigenera ogni volta che si apre: è sempre quello di adesso.

const STATO_BACKEND = { origine: null, file: "modelli.hpp" };

/** Le tabelle del disegno dell'editor nel formato del generatore: {nome, colonne: [{nome, tipo, notnull, pk}]}. */
function tabelleEditorPerBackend() {
  return Editor.schemaLogico(modelloEditor).tabelle.map(t => {
    let k = 0;
    return { nome: t.nome, colonne: t.colonne.map(c => ({ nome: c.nome, tipo: c.tipo || "", notnull: !!c.not_null, pk: c.pk ? ++k : 0 })) };
  });
}

/** Aggiunge al backend una query creata con "Chiedi un dato" (la stessa query non si aggiunge due volte). */
function aggiungiQueryBackend(info) {
  const chiave = q => `${q.sql}|${q.operatore}`;
  if (queryBackend.some(q => chiave(q) === chiave(info))) return avviso("Questa query è già nel backend.");
  queryBackend.push(info);
  avviso(`Query aggiunta al backend (${queryBackend.length}): la trovi in Diagrammi → Backend, nel file query.hpp.`);
}

Object.assign(VISTE, {
  async backend() {
    const entita = modelloEditor.entita.length;
    // finché non la sceglie l'utente, l'origine segue il disegno: l'editor se ha delle entità, se no il database caricato
    if (!STATO_BACKEND.sceltaUtente) STATO_BACKEND.origine = entita ? "editor" : stato.caricato ? "caricato" : "editor";
    const origine = el("select", { "aria-label": "Da quale database" },
      el("option", { value: "editor", selected: STATO_BACKEND.origine === "editor" }, `dal disegno dell'editor (${entita} entità)`),
      stato.caricato ? el("option", { value: "caricato", selected: STATO_BACKEND.origine === "caricato" },
        `dal database caricato (${stato.tabelle_analizzate} tabelle)`) : null);
    origine.addEventListener("change", () => { STATO_BACKEND.origine = origine.value; STATO_BACKEND.sceltaUtente = true; mostra("backend"); });
    const riepilogo = el("div");
    const sceltaFile = el("div", { class: "riga-comandi schede-file" });
    const codice = el("pre", { class: "codice-cpp codice-backend" });
    const compilazione = el("div");
    const elencoQuery = el("div");
    let file = {};

    const mostraFile = () => {
      if (!file[STATO_BACKEND.file]) STATO_BACKEND.file = Object.keys(file)[0];
      metti(sceltaFile, Object.keys(file).map(n => el("button", { class: n === STATO_BACKEND.file ? "primario" : null,
        onclick: () => { STATO_BACKEND.file = n; mostraFile(); } }, n)),
        el("button", { onclick: async () => { try { await navigator.clipboard.writeText(file[STATO_BACKEND.file]); avviso("File copiato."); } catch { avviso("Selezionalo e copialo a mano.", true); } } }, "Copia il file"));
      codice.textContent = file[STATO_BACKEND.file] || "";
    };
    const disegnaQuery = () => metti(elencoQuery, queryBackend.length
      ? el("ol", { class: "query-backend" }, queryBackend.map((q, i) => el("li", {},
          el("span", {}, q.spiegazione), " ",
          el("button", { title: "Togli dal backend", onclick: () => { queryBackend.splice(i, 1); genera(); } }, "Togli"))))
      : el("p", { class: "tenue" }, "Nessuna query salvata. Creale in Editor del database → Prova il database → Chiedi un dato e premi «Aggiungi al backend»."));

    async function genera() {
      disegnaQuery();
      try {
        if (STATO_BACKEND.origine === "editor" && !modelloEditor.entita.length) {
          metti(riepilogo, el("div", { class: "messaggio" }, "Il disegno dell'editor è vuoto: disegna o importa delle tabelle in Editor del database" +
            (stato.caricato ? ", oppure scegli «dal database caricato»." : ".")));
          file = {}; mostraFile(); return;
        }
        const G = await conAttesa(() => api("/api/backend/genera", { origine: STATO_BACKEND.origine, query: queryBackend,
          tabelle: STATO_BACKEND.origine === "editor" ? tabelleEditorPerBackend() : undefined }));
        file = G.file;
        metti(riepilogo, el("div", { class: "riquadri-backend" },
          [[G.tabelle, "classi con getter e setter"], [G.tabelle, "repository (inserisci, aggiorna, elimina, trova, tutti)"],
           [G.query, "query salvate (query.hpp)"], [G.righe_codice.toLocaleString("it-IT"), "righe di codice"]]
            .map(([n, t]) => el("div", { class: "pannello riquadro-numero" }, el("div", { class: "valore" }, n), el("div", { class: "tenue" }, t)))),
          el("p", { class: "tenue" }, `Cartella: ${G.cartella}`));
        mostraFile();
      } catch (e) { metti(riepilogo, el("div", { class: "messaggio" }, e.message)); }
    }
    async function compila() {
      try {
        metti(compilazione, el("p", { class: "tenue" }, "Compilazione..."));
        const C = await api("/api/backend/compila", {});
        metti(compilazione, el("p", { class: C.ok ? "si" : "errore" }, C.ok ? "Compilato: il backend è corretto." : "La compilazione non è riuscita."),
          C.comando ? el("p", { class: "tenue" }, C.comando) : null, C.uscita ? el("pre", {}, C.uscita) : null);
      } catch (e) { metti(compilazione, el("pre", { class: "errore" }, e.message)); }
    }
    setTimeout(genera, 0);
    return [
      intestazioneRichiudibile("backend", "Backend",
        el("p", { class: "tenue" }, "Il backend in C++ costruito dal database: una classe per tabella con getter e setter (modelli.hpp), un repository " +
          "per tabella con inserisci, aggiorna, elimina, trova e tutti su SQLite (repository.hpp), le query salvate con «Chiedi un dato», una " +
          "funzione per query (query.hpp), e un programma di prova (main.cpp). Si ricostruisce ogni volta che apri la pagina, quindi segue le " +
          "modifiche al disegno. Si compila su Mac, Linux e Windows (senza librerie in più: SQLite di Windows 10 e 11)."),
        el("div", { class: "riga-comandi" }, el("b", {}, "Costruito"), origine,
          el("button", { class: "primario", onclick: genera }, "Ricostruisci"),
          el("button", { onclick: compila }, "Compila"),
          el("a", { class: "pulsante", href: "/api/scarica/backend", download: "backend.zip" }, "Scarica il backend (.zip)"),
          el("button", { onclick: () => mostra("editor") }, "Vai all'editor"))),
      riepilogo, compilazione,
      el("details", { class: "pannello", open: true }, el("summary", {}, el("b", {}, `Query salvate (${queryBackend.length})`)), elencoQuery),
      sceltaFile, codice,
    ];
  },
});
