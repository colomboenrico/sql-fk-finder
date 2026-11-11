"use strict";

// Nell'editor del database: il database di prova (SQLite, dallo schema disegnato) da popolare con un modulo, da interrogare
// con le query, dove cercare come si arriva da un dato a un altro, e il backend C++ generato (getter, setter e repository
// con inserisci, aggiorna, elimina, trova, tutti) da compilare e provare (sqlfk/prova.py).

const STATO_PROVA = { scheda: "dati", tabella: null, query: "", cppFile: "modelli.hpp", cppTabella: null, cppOperazione: "tutti",
                      dove: "caricato", da: 0, cerca: "" };
const OPERAZIONI_CPP = {
  tutti: "tutti(): tutte le righe", trova: "trova(chiave): una riga", inserisci: "inserisci(riga): INSERT con i setter",
  aggiorna: "aggiorna(riga): trova, cambia con i setter, UPDATE", elimina: "elimina(chiave): DELETE",
};

/** replaceChildren senza i null, false e undefined delle parti condizionali (che diventerebbero testo "null"). */
function metti(nodo, ...figli) {
  nodo.replaceChildren(...figli.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
}

function sezioneProva(E) {
  const corpo = el("div");
  const info = el("p", { class: "tenue" });
  const conDati = el("input", { type: "checkbox", checked: true });
  const limite = el("input", { type: "number", min: 0, step: 1000, value: 10000, style: "width: 7em",
    title: "Righe copiate al massimo da ogni tabella importata (0 = tutte): con un database enorme il database di prova resta piccolo", "aria-label": "Righe per tabella" });
  let S = { esiste: false, tabelle: [] };

  async function aggiorna() {
    S = await api("/api/prova/struttura");
    info.textContent = S.esiste ? `Database di prova: ${S.tabelle.length} tabelle, ${S.tabelle.reduce((n, t) => n + t.righe, 0)} righe.`
      : "Il database di prova non c'è ancora: crealo dallo schema dell'editor.";
    if (S.esiste && (!STATO_PROVA.tabella || !S.tabelle.some(t => t.nome === STATO_PROVA.tabella))) STATO_PROVA.tabella = S.tabelle[0]?.nome || null;
    disegna();
  }

  async function crea() {
    if (!modelloEditor.entita.length) return avviso("L'editor è vuoto: disegna o importa delle tabelle.", true);
    if (S.esiste && S.tabelle.some(t => t.righe) && !confirm("Il database di prova ha già delle righe: ricrearlo dallo schema (le righe inserite si perdono)?")) return;
    try {
      await conAttesa(() => api("/api/prova/crea", { sql: Editor.sql(modelloEditor, E.regole(), E.dialetto()), dialetto: E.dialetto(),
        con_dati: conDati.checked, limite: Number(limite.value) || 0, mappa: Editor.mappaDati(modelloEditor) }));
      avviso("Database di prova creato.");
      await aggiorna();
    } catch (e) { avviso(e.message, true); }
  }

  const tabellaDi = nome => S.tabelle.find(t => t.nome === nome);
  const sceltaTabella = (valore, alCambio, etichetta = "Tabella") => {
    const s = el("select", { "aria-label": etichetta }, S.tabelle.map(t => el("option", { value: t.nome, selected: t.nome === valore }, `${t.nome} (${t.righe})`)));
    s.addEventListener("change", () => alCambio(s.value));
    return s;
  };
  const marca = c => [c.pk ? "PK" : "", c.notnull && !c.pk ? "NN" : ""].filter(Boolean).join(" ");

  // ---------------------------------------------------------------- scheda Dati: popolare le tabelle con un modulo
  function schedaDati() {
    const t = tabellaDi(STATO_PROVA.tabella);
    if (!t) return el("p", { class: "tenue" }, "Nessuna tabella.");
    const campi = Object.fromEntries(t.colonne.map(c => [c.nome, el("input", { type: "text", placeholder: c.tipo || "", "aria-label": c.nome })]));
    let scelta = null;
    const stato_ = el("span", { class: "tenue" }, "Clicca una riga per modificarla o eliminarla.");
    const contenuto = el("div");
    const chiaveDi = riga => Object.fromEntries((t.chiave.length ? t.chiave : t.colonne.map(c => c.nome)).map(k => [k, riga[k]]));
    const valori = () => Object.fromEntries(Object.entries(campi).map(([k, i]) => [k, i.value]));
    const cerca = el("input", { type: "search", value: STATO_PROVA.cerca, placeholder: "cerca in tutte le colonne", "aria-label": "Cerca nelle righe" });
    let attesa = null;
    cerca.addEventListener("input", () => { clearTimeout(attesa); attesa = setTimeout(() => { STATO_PROVA.cerca = cerca.value; STATO_PROVA.da = 0; ricarica(); }, 300); });
    async function ricarica() {
      const passo = 200;
      const R = await api(`/api/prova/righe?tabella=${encodeURIComponent(t.nome)}&da=${STATO_PROVA.da}&quanti=${passo}&cerca=${encodeURIComponent(STATO_PROVA.cerca)}`);
      const vai = d => { STATO_PROVA.da = Math.max(0, d); ricarica(); };
      metti(contenuto, 
        el("div", { class: "riga-comandi" }, cerca,
          el("span", { class: "tenue" }, R.totale ? `righe ${R.da + 1}–${R.da + R.righe.length} di ${R.totale.toLocaleString("it-IT")}` : "nessuna riga"),
          el("button", { disabled: R.da === 0, onclick: () => vai(R.da - passo) }, "◀ Precedenti"),
          el("button", { disabled: R.da + R.righe.length >= R.totale, onclick: () => vai(R.da + passo) }, "Successive ▶")),
        griglia({ colonne: R.colonne, righe: R.righe }, { alClic: riga => {
          scelta = riga;
          for (const [k, i] of Object.entries(campi)) i.value = riga[k] === null || riga[k] === undefined ? "" : riga[k];
          stato_.textContent = `Riga scelta: ${Object.entries(chiaveDi(riga)).map(([k, v]) => `${k} = ${v}`).join(", ")}`;
        } }));
    }
    const azione = async (nome) => {
      try {
        if (nome !== "inserisci" && !scelta) return avviso("Prima clicca la riga nella tabella.", true);
        const r = await api("/api/prova/riga", { azione: nome, tabella: t.nome, valori: nome === "elimina" ? {} : valori(),
          chiave: nome === "inserisci" ? null : chiaveDi(scelta) });
        avviso(r.fatto);
        if (nome !== "modifica") { scelta = null; Object.values(campi).forEach(i => { i.value = ""; }); stato_.textContent = ""; }
        await ricarica();
        S = await api("/api/prova/struttura");
      } catch (e) { avviso(e.message, true); }
    };
    ricarica();
    return el("div", {},
      el("div", { class: "riga-comandi" }, el("b", {}, "Tabella:"), sceltaTabella(t.nome, v => { STATO_PROVA.tabella = v; STATO_PROVA.da = 0; STATO_PROVA.cerca = ""; disegna(); })),
      el("div", { class: "modulo-riga" }, t.colonne.map(c => el("label", { class: "campo" },
        el("span", {}, c.nome, " ", el("small", { class: "tenue" }, [c.tipo, marca(c)].filter(Boolean).join(" · "))), campi[c.nome]))),
      el("p", { class: "tenue" }, "Lascia vuoto un campo per NULL (o, per una chiave intera AUTOINCREMENT, per farla scegliere al database). " +
        "Le chiavi esterne sono controllate: non si inserisce un ordine di un cliente che non esiste."),
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: () => azione("inserisci") }, "Inserisci"),
        el("button", { onclick: () => azione("modifica") }, "Modifica la riga scelta"),
        el("button", { class: "pericolo", onclick: () => azione("elimina") }, "Elimina la riga scelta"),
        el("button", { onclick: () => { scelta = null; Object.values(campi).forEach(i => { i.value = ""; }); stato_.textContent = ""; } }, "Svuota il modulo"),
        stato_),
      contenuto);
  }

  // ---------------------------------------------------------------- scheda Query
  function schedaQuery() {
    const testo = el("textarea", { class: "editor-sql", rows: 6, spellcheck: "false", "aria-label": "Query" });
    testo.value = STATO_PROVA.query || (S.tabelle[0] ? `SELECT * FROM ${S.tabelle[0].nome} LIMIT 50;` : "");
    const risultato = el("div");
    const esegui = async () => {
      STATO_PROVA.query = testo.value;
      try {
        const R = await api("/api/prova/query", { sql: testo.value });
        metti(risultato, 
          R.colonne.length ? griglia({ colonne: R.colonne, righe: R.righe }) : el("p", {}, `Fatto: ${R.modificate} righe cambiate.`),
          R.modificate && R.colonne.length ? el("p", { class: "tenue" }, `${R.modificate} righe cambiate.`) : null);
        if (R.modificate) S = await api("/api/prova/struttura");
      } catch (e) { metti(risultato, el("pre", { class: "errore" }, e.message)); }
    };
    testo.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); esegui(); } });
    return el("div", {},
      el("p", { class: "tenue" }, "Query SQL (SQLite) sul database di prova: SELECT, ma anche INSERT, UPDATE, DELETE. Ctrl+Invio (Cmd+Invio) per eseguire. " +
        "Clicca una colonna per inserirla."),
      el("div", { class: "colonne-prova" }, S.tabelle.map(t => el("div", {}, el("b", {}, t.nome), ": ",
        t.colonne.map((c, i) => [i ? ", " : "", el("a", { href: "#", onclick: ev => { ev.preventDefault(); testo.setRangeText(`${t.nome}.${c.nome}`, testo.selectionStart, testo.selectionEnd, "end"); testo.focus(); } }, c.nome)])))),
      testo,
      el("div", { class: "riga-comandi" }, el("button", { class: "primario", onclick: esegui }, "Esegui")),
      risultato);
  }

  // ---------------------------------------------------------------- scheda Da un dato a un altro
  function schedaPercorso() {
    const risultato = el("div");
    const pannelloScelte = el("div");
    let elenco = [];                                          // [{nome, colonne: [nomi]}] del database scelto
    const dove = el("select", { "aria-label": "Dove cercare" },
      stato.caricato ? el("option", { value: "caricato", selected: STATO_PROVA.dove === "caricato" }, "nel database caricato (tutte le tabelle, chiavi dichiarate e trovate)") : null,
      S.esiste ? el("option", { value: "prova", selected: STATO_PROVA.dove === "prova" || !stato.caricato }, "nel database di prova dell'editor") : null);
    const colonna = el("select", { "aria-label": "Colonna di partenza" });
    const valore = el("input", { type: "text", placeholder: "il valore (es. Mirco, 7, P02)", value: STATO_PROVA.percorsoValore || "", "aria-label": "Valore" });
    let da = STATO_PROVA.percorsoDa, a = STATO_PROVA.percorsoA;
    const campoTabella = (iniziale, alCambio, etichetta) => {
      const c = el("input", { type: "text", value: iniziale || "", list: "tabelle-percorso", placeholder: "nome della tabella", "aria-label": etichetta, size: 28 });
      c.addEventListener("change", () => alCambio(c.value.trim()));
      return c;
    };
    const riempi = () => {
      const t = elenco.find(x => x.nome === da);
      metti(colonna, ...(t ? t.colonne : []).map(c => el("option", { value: c, selected: c === STATO_PROVA.percorsoColonna }, c)));
    };
    async function carica() {
      STATO_PROVA.dove = dove.value;
      if (dove.value === "caricato") {
        const D = await api("/api/diagramma?tipo=collegamenti");
        elenco = D.tabelle.map(t => ({ nome: t.nome, colonne: t.colonne.map(c => c.nome) }));
      } else {
        elenco = S.tabelle.map(t => ({ nome: t.nome, colonne: t.colonne.map(c => c.nome) }));
      }
      if (!elenco.some(t => t.nome === da)) da = elenco[0]?.nome;
      if (!elenco.some(t => t.nome === a)) a = elenco[elenco.length - 1]?.nome;
      metti(pannelloScelte, 
        el("datalist", { id: "tabelle-percorso" }, elenco.map(t => el("option", { value: t.nome }))),
        el("div", { class: "riga-comandi" }, el("b", {}, "Da"), campoTabella(da, v => { da = v; STATO_PROVA.percorsoColonna = null; riempi(); }, "Tabella di partenza"),
          ".", colonna, "=", valore),
        el("div", { class: "riga-comandi" }, el("b", {}, "A"), campoTabella(a, v => { a = v; }, "Tabella di arrivo"),
          el("button", { class: "primario", onclick: trova }, "Trova il percorso"),
          el("span", { class: "tenue" }, `${elenco.length.toLocaleString("it-IT")} tabelle`)));
      riempi();
    }
    const trova = async () => {
      Object.assign(STATO_PROVA, { percorsoDa: da, percorsoA: a, percorsoColonna: colonna.value, percorsoValore: valore.value });
      try {
        metti(risultato, el("p", { class: "tenue" }, "Ricerca del percorso..."));
        const R = await api("/api/prova/percorso", { dove: dove.value, da_tabella: da, da_colonna: colonna.value, valore: valore.value, a_tabella: a });
        if (!R.trovato) { metti(risultato, el("div", { class: "messaggio" }, R.spiegazione)); return; }
        metti(risultato, 
          el("p", {}, el("b", {}, R.spiegazione), ` ${R.righe.length}${R.righe.length >= R.limite ? "+" : ""} righe di ${a} trovate.`),
          R.frasi.length ? el("ol", {}, R.frasi.map(f => el("li", {}, f))) : null,
          R.alternative?.length ? el("details", {}, el("summary", {}, `Altri percorsi possibili (${R.alternative.length})`),
            R.alternative.map(alt => el("ol", {}, alt.map(f => el("li", {}, f))))) : null,
          el("pre", { class: "sql" }, R.sql),
          dove.value === "prova" ? el("div", { class: "riga-comandi" }, el("button", { onclick: () => { STATO_PROVA.query = R.sql + ";"; STATO_PROVA.scheda = "query"; disegna(); } }, "Apri nella scheda Query")) : null,
          R.righe.length ? griglia({ colonne: R.colonne, righe: R.righe }) : el("p", { class: "tenue" }, "Il percorso c'è, ma con questo valore non si arriva a nessuna riga."));
      } catch (e) { metti(risultato, el("pre", { class: "errore" }, e.message)); }
    };
    valore.addEventListener("keydown", e => { if (e.key === "Enter") trova(); });
    dove.addEventListener("change", carica);
    carica().catch(e => metti(risultato, el("pre", { class: "errore" }, e.message)));
    return el("div", {},
      el("p", { class: "tenue" }, "Parti da un dato (per esempio clienti.nome = Mirco) e scegli dove vuoi arrivare (per esempio prodotti): l'app cerca la " +
        "catena più corta di chiavi esterne tra le due tabelle (e altre possibili), scrive la query con le JOIN e la esegue. Nel database caricato " +
        "si usano tutte le tabelle e anche le chiavi trovate dall'analisi, con gli indici che servono: funziona anche con database enormi."),
      el("div", { class: "riga-comandi" }, el("b", {}, "Cerca"), dove),
      pannelloScelte, risultato);
  }

  // ---------------------------------------------------------------- scheda Backend C++
  function schedaCpp() {
    const codice = el("pre", { class: "codice-cpp" });
    const sceltaFile = el("select", { "aria-label": "File" });
    const compilazione = el("div");
    let file = null;
    const mostraFile = () => { codice.textContent = file ? file[sceltaFile.value] || "" : "Premi Genera il codice."; };
    sceltaFile.addEventListener("change", () => { STATO_PROVA.cppFile = sceltaFile.value; mostraFile(); });
    const genera = async () => {
      try {
        const G = await conAttesa(() => api("/api/prova/genera", {}));
        file = G.file;
        metti(sceltaFile, ...Object.keys(file).map(n => el("option", { value: n, selected: n === STATO_PROVA.cppFile }, n)));
        mostraFile();
        metti(compilazione, el("p", { class: "tenue" }, `Codice generato per ${G.tabelle} tabelle in ${G.cartella}.`));
        return true;
      } catch (e) { avviso(e.message, true); return false; }
    };
    const compila = async () => {
      if (!file && !(await genera())) return;
      try {
        const C = await conAttesa(() => api("/api/prova/compila", {}));
        metti(compilazione, el("p", { class: C.ok ? "si" : "errore" }, C.ok ? "Compilato: il backend è pronto, provalo qui sotto." : "La compilazione non è riuscita."),
          C.comando ? el("p", { class: "tenue" }, C.comando) : null, C.uscita ? el("pre", {}, C.uscita) : null);
      } catch (e) { avviso(e.message, true); }
    };

    // prova delle operazioni
    const t = tabellaDi(STATO_PROVA.cppTabella) || S.tabelle[0];
    STATO_PROVA.cppTabella = t?.nome;
    const operazione = el("select", { "aria-label": "Operazione" }, Object.entries(OPERAZIONI_CPP).map(([k, v]) => el("option", { value: k, selected: k === STATO_PROVA.cppOperazione }, v)));
    const campi = Object.fromEntries((t?.colonne || []).map(c => [c.nome, el("input", { type: "text", placeholder: c.tipo || "", "aria-label": c.nome })]));
    const modulo = el("div", { class: "modulo-riga" });
    const spiega = el("p", { class: "tenue" });
    const aggiornaModulo = () => {
      STATO_PROVA.cppOperazione = operazione.value;
      const op = operazione.value, chiave = new Set(t?.chiave || []);
      metti(modulo, ...(t?.colonne || []).filter(c => op === "tutti" ? false : op === "trova" || op === "elimina" ? chiave.has(c.nome) : true)
        .map(c => el("label", { class: "campo" }, el("span", {}, c.nome, " ", el("small", { class: "tenue" }, [c.tipo, marca(c)].filter(Boolean).join(" · "))), campi[c.nome])));
      spiega.textContent = {
        tutti: "Chiama tutti() del repository: legge tutte le righe e le restituisce come oggetti (getter).",
        trova: "Chiama trova() con la chiave: una riga, o nessuna.",
        inserisci: "Crea l'oggetto, imposta i campi scritti con i setter e chiama inserisci() (INSERT). Una chiave intera vuota la sceglie il database.",
        aggiorna: "Chiama trova() con la chiave, cambia con i setter solo i campi scritti (\\N = NULL) e chiama aggiorna() (UPDATE).",
        elimina: "Chiama elimina() con la chiave (DELETE). Se altre righe la usano, la chiave esterna lo impedisce.",
      }[op];
    };
    operazione.addEventListener("change", aggiornaModulo);
    aggiornaModulo();
    const esito = el("div");
    const contenuto = el("div");
    const mostraContenuto = async () => {
      if (!t) return;
      const R = await api(`/api/prova/righe?tabella=${encodeURIComponent(t.nome)}`);
      metti(contenuto, el("h4", {}, `Contenuto di ${t.nome} (${R.totale} righe)`), griglia({ colonne: R.colonne, righe: R.righe }));
    };
    const esegui = async () => {
      try {
        const valori = Object.fromEntries(Object.entries(campi).map(([k, i]) => [k, i.value]));
        const R = await api("/api/prova/esegui", { operazione: operazione.value, tabella: t.nome, valori });
        metti(esito, el("pre", { class: "sql" }, R.comando),
          el("p", { class: R.ok ? "si" : "errore" }, R.ok ? R.messaggio : `Errore: ${R.messaggio}`),
          R.righe && R.righe.length ? griglia({ colonne: Object.keys(R.righe[0]), righe: R.righe.map(r => Object.values(r)) }) : null);
        await mostraContenuto();
      } catch (e) { avviso(e.message, true); }
    };
    mostraContenuto();
    return el("div", {},
      el("p", { class: "tenue" }, "Dal database di prova si genera un backend in C++: una classe per tabella con getter e setter (modelli.hpp), un " +
        "repository per tabella con inserisci, aggiorna, elimina, trova e tutti che usa SQLite (repository.hpp), e un programma di prova " +
        "(main.cpp). Si compila con il compilatore del computer (clang++ o g++) e qui sotto si provano le operazioni: il risultato e il " +
        "contenuto della tabella si vedono subito."),
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: genera }, "Genera il codice"),
        el("button", { onclick: compila }, "Compila"),
        el("a", { class: "pulsante", href: "/api/scarica/prova_cpp", download: "backend_cpp.zip" }, "Scarica il codice (.zip)"),
        el("span", { class: "tenue" }, "File:"), sceltaFile),
      compilazione,
      el("details", {}, el("summary", {}, "Il codice"), codice),
      el("h4", {}, "Prova il backend"),
      el("div", { class: "riga-comandi" }, el("b", {}, "Tabella:"),
        t ? sceltaTabella(t.nome, v => { STATO_PROVA.cppTabella = v; disegna(); }) : null, el("b", {}, "Operazione:"), operazione),
      spiega, modulo,
      el("div", { class: "riga-comandi" }, el("button", { class: "primario", onclick: esegui }, "Esegui con il backend C++")),
      esito, contenuto);
  }

  function disegna() {
    const schede = [["dati", "Dati"], ["query", "Query"], ["percorso", "Da un dato a un altro"], ["cpp", "Backend C++"]];
    if (!S.esiste && STATO_PROVA.scheda !== "percorso") STATO_PROVA.scheda = stato.caricato ? "percorso" : STATO_PROVA.scheda;
    metti(corpo, ...(!S.esiste && !stato.caricato ? [el("p", { class: "tenue" }, "Crea il database di prova per popolare le tabelle, fare le query e provare il backend C++.")] : [
      el("div", { class: "riga-comandi schede-prova" }, schede.map(([k, n]) =>
        el("button", { class: STATO_PROVA.scheda === k ? "primario" : null, disabled: !S.esiste && k !== "percorso",
          title: !S.esiste && k !== "percorso" ? "Prima crea il database di prova" : null, onclick: () => { STATO_PROVA.scheda = k; disegna(); } }, n))),
      { dati: schedaDati, query: schedaQuery, percorso: schedaPercorso, cpp: schedaCpp }[STATO_PROVA.scheda](),
    ]));
  }

  aggiorna().catch(e => info.textContent = e.message);
  return el("div", { class: "pannello sezione-prova" },
    el("h3", {}, "Prova il database"),
    el("p", { class: "tenue" }, "Un database SQLite di prova creato dallo schema dell'editor, separato dai file caricati: popolalo con il modulo, " +
      "fai le query, cerca come si arriva da un dato a un altro e prova il backend C++ generato. Quando cambi lo schema, ricrealo."),
    el("div", { class: "riga-comandi" },
      el("button", { class: "primario", onclick: crea }, "Crea il database di prova"),
      stato.caricato ? el("label", {}, conDati, "con i dati delle tabelle importate, al massimo", limite, "righe per tabella (0 = tutte)") : null,
      el("a", { class: "pulsante", href: "/api/scarica/prova_sqlite", download: "prova.sqlite" }, "Scarica prova.sqlite"),
      info),
    corpo);
}
