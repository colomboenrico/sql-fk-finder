"use strict";

// Pagine delle estensioni (sqlfk/estensioni.py): chiavi esterne verificate sui dati con il profilo delle colonne,
// viste e procedure (matrice CRUD), codice generato (modelli SQLAlchemy e script di normalizzazione).

const ESITI = {
  "confirmed": ["confermata", "si"], "orphans": ["pochi orfani", "avviso-g"], "doubtful": ["dubbia", "avviso-g"],
  "probably wrong": ["probabilmente sbagliata", "no"], "no data": ["senza dati", "info-g"],
};
const CLASSI_PROFILO = {
  NO_DATA: ["tabella vuota", () => "La tabella non ha righe nei dati caricati: forse non è usata (verificalo prima di toglierla)."],
  DEPRECATION_CANDIDATE: ["sempre vuota", () => "Sempre NULL: candidata a essere tolta."],
  SPARSE: ["quasi vuota", () => "Quasi sempre NULL: si può spostare in una tabella 1:1 facoltativa."],
  CONSTANT: ["costante", () => "Sempre lo stesso valore: un DEFAULT, oppure si può togliere."],
  NATURAL_KEY_CANDIDATE: ["possibile chiave naturale", () => "Valori tutti diversi e mai NULL: possibile chiave naturale (vincolo UNIQUE)."],
  ENUM_CANDIDATE: ["possibile ENUM", d => `Solo ${d} valori diversi: possibile ENUM, vincolo CHECK o tabella di codifica (clicca per vederli).`],
};
const TIPI_OGGETTO = { VIEW: "vista", PROCEDURE: "procedura", FUNCTION: "funzione", TRIGGER: "trigger" };
const OPERAZIONI = { CREATE: "inserisce", READ: "legge", UPDATE: "modifica", DELETE: "cancella" };

/** Cambia i nomi delle colonne e i valori di una tabella {colonne, righe}: nomi {vecchio: nuovo}, valori {colonna: f(valore, riga)}. */
function traduciTabella(dati, nomi, valori = {}) {
  const indici = Object.fromEntries(dati.colonne.map((c, i) => [c, i]));
  const tenute = Object.keys(nomi).filter(c => c in indici);
  return {
    colonne: tenute.map(c => nomi[c]),
    righe: dati.righe.map(r => tenute.map(c => valori[c] ? valori[c](r[indici[c]], r, indici) : r[indici[c]])),
  };
}

/** Riquadro con i valori più frequenti di una colonna. */
async function mostraValori(dove, tabella, colonna) {
  dove.replaceChildren(el("p", { class: "tenue" }, "Lettura dei valori..."));
  try {
    const V = await api(`/api/valori?tabella=${encodeURIComponent(tabella)}&colonna=${encodeURIComponent(colonna)}`);
    dove.replaceChildren(el("div", { class: "pannello" },
      el("h3", {}, `Valori di ${V.tabella}.${V.colonna}`),
      el("p", { class: "tenue" }, "I valori più frequenti: se sono codici, annota cosa vuol dire ognuno (per il dizionario dei dati) " +
        "e valuta una tabella di codifica o un vincolo CHECK."),
      griglia({ colonne: ["valore", "righe"], righe: V.valori.map(([v, n]) => [v === null ? "(NULL)" : v, n]) }),
      V.altri ? el("p", { class: "tenue" }, "Ci sono altri valori oltre a questi 50.") : null));
  } catch (e) {
    dove.replaceChildren(el("p", { class: "errore" }, e.message));
  }
}

Object.assign(VISTE, {
  async dativerifica() {
    const intestazione = [el("h2", {}, "Chiavi verificate sui dati"),
      el("p", { class: "tenue" }, "Le chiavi esterne dichiarate e quelle trovate si controllano sui dati degli INSERT e dei COPY: " +
        "per ogni collegamento A.x → B.y si conta quanti valori di A.x esistono davvero in B.y e quanti no (orfani). " +
        "Si cercano anche i collegamenti che i nomi non rivelano (valori contenuti nella chiave di un'altra tabella) e si fa il " +
        "profilo di ogni colonna (righe, NULL, valori diversi). Tutto in sola lettura sul database delle query.")];
    const info = await api("/api/query/tabelle");
    if (info.da_costruire) {
      return [...intestazione, el("div", { class: "pannello" },
        el("p", {}, `I file contengono ${formattaByte(info.dimensione)} di dati: prima va costruito il database delle query (una volta sola).`),
        el("button", { class: "primario", onclick: () => mostra("query") }, "Vai a Query sui dati per costruirlo"))];
    }
    const conDati = info.tabelle.some(t => t.righe > 0);
    const medie = el("input", { type: "checkbox", checked: true });
    const risultati = el("div");
    async function avvia() {
      try {
        await api("/api/verifica_dati", { medie: medie.checked });
        await seguiLavoro("Verifica con i dati");
        avviso("Verifica finita.");
      } catch (e) {
        avviso(e.message, true);
      }
      mostra("dativerifica");
    }
    const V = await api("/api/verifica_dati");
    if (V.pronta) medie.checked = V.medie;
    const comandi = el("div", { class: "riga-comandi" },
      el("button", { class: "primario", onclick: avvia, disabled: !conDati }, V.pronta ? "Rifai la verifica" : "Verifica con i dati"),
      el("label", {}, medie, "anche le candidate ad affidabilità media"),
      V.pronta ? el("a", { class: "pulsante", href: "/api/scarica/verifica_dati", download: "verifica_con_i_dati.xlsx" }, "Scarica (Excel)") : null);
    if (!conDati) return [...intestazione, comandi, el("div", { class: "messaggio" },
      "Nei file non ci sono dati (INSERT o COPY): la verifica serve un dump con i dati.")];
    if (!V.pronta) return [...intestazione, comandi, el("p", { class: "tenue" },
      "Sui dump grandi può richiedere qualche minuto: si vede l'avanzamento e si può interrompere.")];

    // ---- riepilogo
    const conta = (dati, colonna, valore) => { const i = dati.colonne.indexOf(colonna); return dati.righe.filter(r => r[i] === valore).length; };
    const esiti = Object.fromEntries(Object.keys(ESITI).map(k => [k, conta(V.chiavi, "verdict", k)]));
    const forti = conta(V.valori, "strength", "strong");
    const classi = Object.fromEntries(Object.keys(CLASSI_PROFILO).map(k => [k, conta(V.profilo, "classification", k)]));
    const iT = V.profilo.colonne.indexOf("table"), iC = V.profilo.colonne.indexOf("classification");
    const vuote = [...new Set(V.profilo.righe.filter(r => r[iC] === "NO_DATA").map(r => r[iT]))];
    const riepilogo = el("div", { class: "pannello" },
      V.superata ? el("div", { class: "messaggio" }, "L'analisi è cambiata dopo la verifica (tabelle tolte o impostazioni): rifai la verifica.") : null,
      el("p", {}, el("b", {}, `${V.chiavi.righe.length} collegamenti controllati: `),
        Object.entries(esiti).filter(([, n]) => n).map(([k, n], i) => [i ? ", " : "", el("span", { class: ESITI[k][1] }, `${n} ${ESITI[k][0]}`)])),
      el("p", {}, el("b", {}, `${V.valori.righe.length} collegamenti trovati dai valori`), ` (${forti} forti) che i nomi delle colonne non rivelano.`),
      el("p", {}, el("b", {}, "Profilo: "), `${vuote.length} tabelle vuote, ${classi.DEPRECATION_CANDIDATE} colonne sempre vuote, ` +
        `${classi.SPARSE} quasi vuote, ${classi.CONSTANT} costanti, ${classi.ENUM_CANDIDATE} possibili ENUM, ` +
        `${classi.NATURAL_KEY_CANDIDATE} possibili chiavi naturali.`),
      el("p", { class: "tenue" }, `Verifica fatta in ${V.secondi} s.`));

    // ---- chiavi esterne
    const chiavi = traduciTabella(V.chiavi, {
      table: "tabella", column: "colonna", "→ table": "→ tabella", "→ column": "→ colonna", source: "origine", values: "valori",
      orphans: "orfani", "distinct values": "valori diversi", "orphan values": "valori diversi orfani", "match %": "% trovati",
      verdict: "esito", "orphan examples": "esempi di orfani",
    }, {
      source: v => v === "declared" ? "dichiarata" : v.replace("candidate", "candidata"),
      verdict: v => (ESITI[v] || [v])[0],
    });
    const classeEsito = (c, v) => c === "esito" ? (Object.values(ESITI).find(([n]) => n === v) || [])[1] : null;

    // ---- collegamenti dai valori
    const deboli = el("input", { type: "checkbox" });
    const boxValori = el("div");
    const disegnaValori = () => {
      const T = traduciTabella(V.valori, {
        table: "tabella", column: "colonna", "→ table": "→ tabella", "→ column": "→ colonna", type: "tipo",
        "distinct values": "valori diversi", "parent values": "valori nella chiave", "coverage %": "% della chiave usata",
        "same name root": "nome simile", strength: "forza",
      }, { strength: v => v === "strong" ? "forte" : "debole", type: v => v === "integer" ? "intero" : "testo" });
      if (!deboli.checked) T.righe = T.righe.filter(r => r[T.colonne.indexOf("forza")] === "forte");
      boxValori.replaceChildren(T.righe.length ? griglia(T, { classiCella: classiStandard })
        : el("p", { class: "tenue" }, deboli.checked ? "Nessun collegamento trovato dai valori." : "Nessun collegamento forte: guarda anche i deboli."));
    };
    deboli.addEventListener("change", disegnaValori);
    disegnaValori();

    // ---- profilo
    const filtro = el("select", { "aria-label": "Classificazione" },
      el("option", { value: "suggerimenti" }, "Solo le colonne con un suggerimento"),
      el("option", { value: "tutte" }, "Tutte le colonne"),
      Object.entries(CLASSI_PROFILO).map(([k, [n]]) => el("option", { value: k }, n)));
    const boxProfilo = el("div"), boxValoriColonna = el("div");
    const disegnaProfilo = () => {
      const iD = V.profilo.colonne.indexOf("distinct");
      const T = traduciTabella(V.profilo, {
        table: "tabella", column: "colonna", "declared type": "tipo", rows: "righe", nulls: "NULL", "null %": "% NULL",
        distinct: "valori diversi", "distinct %": "% diversi", classification: "classificazione", suggestion: "suggerimento",
      }, {
        classification: v => v ? CLASSI_PROFILO[v][0] : "",
        suggestion: (v, r) => r[iC] ? CLASSI_PROFILO[r[iC]][1](r[iD]) : "",
      });
      const iClasse = T.colonne.indexOf("classificazione");
      const scelta = filtro.value;
      if (scelta === "suggerimenti") T.righe = T.righe.filter(r => r[iClasse]);
      else if (scelta !== "tutte") T.righe = T.righe.filter(r => r[iClasse] === CLASSI_PROFILO[scelta][0]);
      boxProfilo.replaceChildren(griglia(T, { alClic: r => mostraValori(boxValoriColonna, r.tabella, r.colonna) }));
    };
    filtro.addEventListener("change", disegnaProfilo);
    disegnaProfilo();

    risultati.append(
      el("h3", {}, "Chiavi esterne controllate sui dati"),
      el("p", { class: "tenue" }, "Confermata: tutti i valori esistono nella tabella collegata. Pochi orfani: almeno il 95%. " +
        "Dubbia: almeno la metà. Probabilmente sbagliata: meno della metà. Le chiavi composte si controllano su tutte le colonne insieme."),
      griglia(chiavi, { classiCella: classeEsito }),
      el("h3", {}, "Collegamenti trovati dai valori"),
      el("p", { class: "tenue" }, "Colonne i cui valori sono tutti nella chiave primaria (o in una colonna UNIQUE) di un'altra tabella, " +
        "anche se i nomi non si somigliano. Forte: almeno 10 valori diversi che non sono una semplice sequenza 1, 2, 3...; " +
        "debole: potrebbe essere un caso. Da confermare."),
      el("div", { class: "riga-comandi" }, el("label", {}, deboli, "mostra anche i collegamenti deboli")),
      boxValori,
      el("h3", {}, "Profilo delle colonne"),
      vuote.length ? el("p", {}, el("b", {}, `Tabelle vuote (${vuote.length}): `), vuote.join(", ")) : null,
      el("div", { class: "riga-comandi" }, filtro, el("span", { class: "tenue" }, "Clicca una colonna per vederne i valori più frequenti.")),
      boxProfilo, boxValoriColonna);
    return [...intestazione, comandi, riepilogo, risultati];
  },

  async crud() {
    const C = await api("/api/crud");
    const intestazione = [el("h2", {}, "Viste e procedure"),
      el("p", { class: "tenue" }, "Le viste, le procedure, le funzioni e i trigger dei file .sql: quali tabelle leggono, inseriscono, " +
        "modificano o cancellano (matrice CRUD). L'SQL si analizza con l'albero sintattico di sqlglot; il codice procedurale che " +
        "sqlglot non capisce si legge con espressioni regolari (colonna metodo).")];
    if (!C.righe.righe.length) return [...intestazione, el("div", { class: "pannello" },
      el("p", {}, "Nei file non ci sono viste, procedure, funzioni o trigger (CREATE VIEW, PROCEDURE, FUNCTION, TRIGGER) che usano tabelle."))];
    const iT = C.righe.colonne.indexOf("table");
    const tabelle = new Set(C.righe.righe.map(r => r[iT]));
    const scritte = new Set(C.righe.righe.filter(r => r[C.righe.colonne.indexOf("operation")] !== "READ").map(r => r[iT]));
    const sorgente = el("div");
    const matrice = traduciTabella(C.matrice, { "object type": "tipo", object: "oggetto", table: "tabella",
      C: "C inserisce", R: "R legge", U: "U modifica", D: "D cancella" }, { "object type": v => TIPI_OGGETTO[v] || v });
    const dettaglio = traduciTabella(C.righe, { object: "oggetto", "object type": "tipo", table: "tabella", operation: "operazione",
      statement: "istruzione", "in schema": "nello schema", method: "metodo", file: "file", line: "riga" }, {
      "object type": v => TIPI_OGGETTO[v] || v, operation: v => OPERAZIONI[v] || v,
      method: v => v === "ast" ? "albero sintattico" : "espressione regolare",
    });
    async function apriSorgente(r) {
      try {
        const S = await api(`/api/sorgente?file=${encodeURIComponent(r.file)}&riga=${r.riga}`);
        sorgente.replaceChildren(el("div", { class: "pannello" }, el("h3", {}, `${r.oggetto} (${S.file}, riga ${S.riga})`),
          el("div", { class: "sorgente" }, S.righe.map(([n, t]) => el("div", { class: n === S.riga ? "evidenziata" : null }, el("span", { class: "numero" }, n), t)))));
      } catch (e) { avviso(e.message, true); }
    }
    return [...intestazione,
      el("div", { class: "riga-comandi" }, el("a", { class: "pulsante", href: "/api/scarica/crud", download: "matrice_crud.xlsx" }, "Scarica (Excel)")),
      el("div", { class: "pannello" }, el("p", {}, `${C.oggetti} oggetti usano ${tabelle.size} tabelle; ${scritte.size} tabelle vengono modificate ` +
        "(inserite, aggiornate o cancellate) da almeno un oggetto.")),
      griglia(matrice, { titolo: "Matrice CRUD" }),
      griglia(dettaglio, { titolo: "Dettaglio", classiCella: classiStandard, alClic: apriSorgente }),
      sorgente];
  },

  async codice() {
    let scheda = "modelli";
    const dialetto = el("select", { "aria-label": "Dialetto dello script" },
      [["mysql", "MySQL / MariaDB"], ["postgres", "PostgreSQL"], ["tsql", "SQL Server"], ["oracle", "Oracle"], ["sqlite", "SQLite"]]
        .map(([v, t]) => el("option", { value: v, selected: v === (stato.impostazioni.dialetto === "postgresql" ? "postgres" : stato.impostazioni.dialetto) }, t)));
    const schede = el("div", { class: "riga-comandi" });
    const contenuto = el("div");
    async function disegna() {
      schede.replaceChildren(...[["modelli", "Modelli SQLAlchemy (Python)"], ["normalizzazione", "Script di normalizzazione (SQL)"]]
        .map(([k, t]) => el("button", { class: k === scheda ? "primario" : null, onclick: () => { scheda = k; disegna(); } }, t)));
      const query = scheda === "normalizzazione" ? `?dialetto=${dialetto.value}` : "";
      const { testo } = await api(`/api/codice/${scheda}${query}`);
      const copia = el("button", { onclick: async () => {
        try { await navigator.clipboard.writeText(testo); avviso("Copiato."); } catch { avviso("Non è stato possibile copiare.", true); }
      } }, "Copia");
      contenuto.replaceChildren(
        scheda === "modelli"
          ? el("p", { class: "tenue" }, "Le classi SQLAlchemy di tutto il database, per ricrearlo o usarlo da Python. Le chiavi esterne dichiarate e quelle " +
            "trovate ad affidabilità alta diventano ForeignKey con una relationship(); quelle trovate sono segnate con un commento. " +
            "Le tabelle senza chiave primaria diventano Table.")
          : el("p", { class: "tenue" }, "Una bozza di script per correggere i problemi di normalizzazione della pagina Qualità schema: campi composti, " +
            "gruppi ripetuti e colonne con più valori (1NF), dipendenze parziali (2NF) e transitive (3NF). È da rivedere: i DROP COLUMN " +
            "sono commentati e va provato su una copia del database."),
        el("div", { class: "riga-comandi" },
          scheda === "normalizzazione" ? el("label", {}, "Dialetto ", dialetto) : null,
          el("a", { class: "pulsante primario", href: `/api/scarica/${scheda}${query}`, download: scheda === "modelli" ? "modelli_sqlalchemy.py" : "normalizzazione.sql" }, scheda === "modelli" ? "Scarica modelli_sqlalchemy.py" : "Scarica normalizzazione.sql"),
          copia),
        el("pre", { class: "codice-generato" }, testo));
    }
    dialetto.addEventListener("change", disegna);
    await disegna();
    return [el("h2", {}, "Codice generato"), schede, contenuto];
  },
});
