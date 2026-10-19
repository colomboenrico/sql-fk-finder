"use strict";

// ======================================================================= utilità

const $ = (selettore, dentro = document) => dentro.querySelector(selettore);
const vista = $("#vista");
let stato = { caricato: false };
let filtroRegola = "";
// editor: il database disegnato (entità, attributi, relazioni), l'elemento selezionato e la vista della tela
let modelloEditor = Editor.nuovoModello();
let selezioneEditor = null;
let vistaEditor = null;
// disposizione del diagramma: tabella -> [x, y], per le due viste; si salva nel file di progetto
let layoutER = { iniziale: {}, collegamenti: {} };
let testoQuery = "";             // il testo dell'editor delle query resta quando si cambia pagina
let ultimiRisultati = null;
let regoleCache = null;

async function regole() {
  if (!regoleCache || stato.caricato) regoleCache = (await api("/api/regole")).regole;
  return regoleCache;
}

/** Riquadro con una regola di progettazione: cosa dice, perché, come correggere, esempi. */
function schedaRegola(r, conPulsante) {
  const c = r.conteggi || { errore: 0, avviso: 0, info: 0 };
  const totale = c.errore + c.avviso + c.info;
  return el("div", { class: "pannello regola" },
    el("h3", {}, `${r.id}. ${r.titolo}`),
    el("p", { class: "tenue" }, `Codici: ${r.codici.join(", ")}`,
      stato.caricato ? [" · ", el("span", { class: c.errore ? "errore" : null }, `${c.errore} errori`), ", ",
        el("span", { class: c.avviso ? "avviso-g" : null }, `${c.avviso} avvisi`), `, ${c.info} info`] : null),
    el("p", {}, el("b", {}, "Regola. "), r.regola),
    el("p", {}, el("b", {}, "Perché. "), r.perche),
    el("p", {}, el("b", {}, "Come correggere. "), r.correzione),
    el("div", { class: "esempi" },
      el("div", {}, el("span", { class: "etichetta errore" }, "Sbagliato"), el("pre", {}, r.sbagliato)),
      el("div", {}, el("span", { class: "etichetta" }, "Corretto"), el("pre", {}, r.corretto))),
    conPulsante && stato.caricato && totale ? el("button", { onclick: () => { filtroRegola = r.id; mostra("problemi"); } },
      `Vedi i ${totale} problemi di questa regola`) : null);
}
let vistaAttuale = "panoramica";

/** Crea un elemento: el("button", {class: "x", onclick: f}, "testo", altroElemento) */
function el(tag, attributi = {}, ...figli) {
  const nodo = document.createElement(tag);
  for (const [k, v] of Object.entries(attributi)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) nodo.addEventListener(k.slice(2), v);
    else if (k === "class") nodo.className = v;
    else if (v === true) nodo.setAttribute(k, "");
    else nodo.setAttribute(k, v);
  }
  for (const f of figli.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    nodo.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return nodo;
}

async function api(percorso, dati) {
  const opzioni = dati === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dati),
  };
  const risposta = await fetch(percorso, opzioni);
  const json = await risposta.json().catch(() => ({}));
  if (!risposta.ok) throw new Error(json.errore || `Errore ${risposta.status}`);
  return json;
}

/** Esegue un'operazione lunga mostrando "Analisi in corso" e gli eventuali errori. */
async function conAttesa(funzione) {
  $("#attesa").hidden = false;
  try {
    return await funzione();
  } catch (e) {
    avviso(e.message, true);
    return null;
  } finally {
    $("#attesa").hidden = true;
  }
}

function avviso(testo, errore = false) {
  const nodo = el("div", { class: "avviso" + (errore ? " errore" : "") }, testo);
  $("#avvisi").append(nodo);
  setTimeout(() => nodo.remove(), errore ? 8000 : 4000);
}

/** I due pulsanti per aprire gli schemi grafici, aggiornati con le tabelle tolte. */
function pulsantiSchemi() {
  return el("div", { class: "riga-comandi" },
    el("span", { class: "tenue" }, "Vedi il risultato:"),
    el("button", { onclick: () => mostraSchema("iniziale") }, "Schema iniziale"),
    el("button", { onclick: () => mostraSchema("collegamenti") }, "Collegamenti trovati"));
}

function scaricaBlob(blob, nome) {
  const url = URL.createObjectURL(blob);
  el("a", { href: url, download: nome }).click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Disegna il diagramma fuori dallo schermo e lo salva in PNG (senza dover aprire la pagina degli schemi). */
async function diagrammaInPng(dati, nome, posizioni) {
  const scatola = el("div", { style: "position: fixed; left: -20000px; top: 0; width: 1600px; height: 1000px" });
  document.body.append(scatola);
  try {
    const d = DiagrammaER.crea(scatola, dati, { tipi: true, posizioni });
    scaricaBlob(await d.png(), nome);
  } finally {
    scatola.remove();
  }
}

function formatta(valore) {
  if (valore === true) return "sì";
  if (valore === false) return "no";
  if (valore === null || valore === undefined) return "";
  return String(valore);
}

// ======================================================================= tabella dati

/**
 * Tabella con filtro, ordinamento (clic sull'intestazione) e pagine da 200 righe.
 * dati: {colonne: [...], righe: [[...]]}
 * opzioni: {titolo, alClic(riga), classiCella(colonna, valore), nascondi: [colonne]}
 */
function griglia(dati, opzioni = {}) {
  const colonne = dati.colonne.map((nome, i) => ({ nome, i })).filter(c => !(opzioni.nascondi || []).includes(c.nome));
  let filtro = "", ordine = null, verso = 1, pagina = 0;
  const PER_PAGINA = 200;

  const campo = el("input", { type: "text", placeholder: "Filtra...", "aria-label": "Filtra righe" });
  const conteggio = el("span", { class: "conteggio" });
  const corpo = el("tbody");
  const testa = el("tr");
  const paginazione = el("div", { class: "paginazione" });

  function righeVisibili() {
    let righe = dati.righe;
    if (filtro) {
      const f = filtro.toLowerCase();
      righe = righe.filter(r => r.some(v => formatta(v).toLowerCase().includes(f)));
    }
    if (ordine !== null) {
      righe = [...righe].sort((a, b) => {
        const x = a[ordine], y = b[ordine];
        if (typeof x === "number" && typeof y === "number") return (x - y) * verso;
        return formatta(x).localeCompare(formatta(y), "it", { numeric: true }) * verso;
      });
    }
    return righe;
  }

  function disegna() {
    const righe = righeVisibili();
    const pagine = Math.max(1, Math.ceil(righe.length / PER_PAGINA));
    pagina = Math.min(pagina, pagine - 1);
    testa.replaceChildren(...colonne.map(c => el("th", {
      onclick: () => { verso = ordine === c.i ? -verso : 1; ordine = c.i; disegna(); },
    }, c.nome, ordine === c.i ? el("span", { class: "verso" }, verso > 0 ? " (crescente)" : " (decrescente)") : "")));
    corpo.replaceChildren(...righe.slice(pagina * PER_PAGINA, (pagina + 1) * PER_PAGINA).map(r => {
      const tr = el("tr", { class: opzioni.alClic ? "cliccabile" : null },
        colonne.map(c => el("td", { class: opzioni.classiCella ? opzioni.classiCella(c.nome, r[c.i]) : null }, formatta(r[c.i]))));
      if (opzioni.alClic) tr.addEventListener("click", () => {
        corpo.querySelectorAll("tr.scelta").forEach(x => x.classList.remove("scelta"));
        tr.classList.add("scelta");
        opzioni.alClic(Object.fromEntries(dati.colonne.map((n, i) => [n, r[i]])));
      });
      return tr;
    }));
    conteggio.textContent = `${righe.length} righe` + (righe.length !== dati.righe.length ? ` su ${dati.righe.length}` : "");
    paginazione.replaceChildren(...(pagine > 1 ? [
      el("button", { onclick: () => { pagina--; disegna(); }, disabled: pagina === 0 }, "Precedente"),
      el("span", { class: "tenue" }, `pagina ${pagina + 1} di ${pagine}`),
      el("button", { onclick: () => { pagina++; disegna(); }, disabled: pagina >= pagine - 1 }, "Successiva"),
    ] : []));
  }

  campo.addEventListener("input", () => { filtro = campo.value.trim(); pagina = 0; disegna(); });
  disegna();
  const nodo = el("div", { class: "griglia" },
    el("div", { class: "griglia-testa" }, opzioni.titolo ? el("b", {}, opzioni.titolo) : null, campo, conteggio),
    el("div", { class: "griglia-scorri" }, el("table", {}, el("thead", {}, testa), corpo)),
    paginazione);
  nodo.righeFiltrate = righeVisibili;
  return nodo;
}

/** Colori per affidabilità, tipi e sì/no. */
function classiStandard(colonna, valore) {
  if (colonna === "affidabilità") return valore;
  if (colonna === "gravità") return { errore: "errore", avviso: "avviso-g", info: "info-g" }[valore];
  if (valore === true) return "si";
  if (valore === false && (colonna === "tipi ok" || colonna === "stesso tipo" || colonna === "tipi coerenti")) return "no";
  if (colonna === "sql") return "sql";
  return null;
}

// ======================================================================= caricamento dei file

async function leggiFile(lista, origine) {
  const file = [...lista].filter(f => f.name.toLowerCase().endsWith(".sql"));
  if (!file.length) { avviso("Nessun file .sql tra quelli scelti.", true); return; }
  await conAttesa(async () => {
    const contenuti = await Promise.all(file.map(async f => ({ nome: f.name, testo: await f.text() })));
    stato = await api("/api/carica_file", { file: contenuti, origine });
    layoutER = { iniziale: {}, collegamenti: {} };
    avviso(`Caricati ${file.length} file .sql.`);
    aggiornaTutto("panoramica");
  });
}

$("#in-cartella").addEventListener("change", e => {
  const lista = e.target.files;
  const cartella = lista.length ? (lista[0].webkitRelativePath || "").split("/")[0] : "";
  leggiFile(lista, cartella ? `cartella ${cartella}` : null);
  e.target.value = "";
});

$("#in-file").addEventListener("change", e => {
  leggiFile(e.target.files, `${e.target.files.length} file`);
  e.target.value = "";
});

function nomeProgetto() {
  const base = String(stato.origine || "progetto").split(/[\\/]/).pop().replace(/^cartella /, "");
  return (base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "progetto") + ".sqlfk";
}

$("#salva-progetto").addEventListener("click", () => conAttesa(async () => {
  const progetto = await api("/api/progetto");
  progetto.layout = layoutER;
  progetto.editor = modelloEditor;
  scaricaBlob(new Blob([JSON.stringify(progetto, null, 1)], { type: "application/json" }), nomeProgetto());
  avviso("Progetto salvato: riaprilo con Apri progetto per continuare il lavoro.");
}));

$("#in-progetto").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  await conAttesa(async () => {
    let progetto;
    try { progetto = JSON.parse(await file.text()); } catch { throw new Error("Il file non è un progetto valido."); }
    stato = await api("/api/progetto", progetto);
    const l = progetto.layout || {};
    layoutER = { iniziale: l.iniziale || {}, collegamenti: l.collegamenti || {} };
    modelloEditor = progetto.editor && progetto.editor.entita ? progetto.editor : Editor.nuovoModello();
    selezioneEditor = null; vistaEditor = null;
    regoleCache = null;
    avviso(`Progetto ${file.name} aperto: ${stato.tabelle_totali} tabelle, ${stato.rimosse.length} tolte.`);
    aggiornaTutto("panoramica");
  });
});

$("#form-percorso").addEventListener("submit", async e => {
  e.preventDefault();
  const cartella = $("#percorso").value.trim();
  if (!cartella) return;
  await conAttesa(async () => {
    stato = await api("/api/carica_cartella", { cartella });
    layoutER = { iniziale: {}, collegamenti: {} };
    avviso("Cartella caricata.");
    aggiornaTutto("panoramica");
  });
});

// ======================================================================= navigazione

document.querySelectorAll("#menu button").forEach(b => b.addEventListener("click", () => mostra(b.dataset.vista)));

function aggiornaMenu() {
  $("#salva-progetto").disabled = !stato.caricato;
  document.querySelectorAll("#menu button").forEach(b => {
    b.classList.toggle("attiva", b.dataset.vista === vistaAttuale);
    b.disabled = b.hasAttribute("data-serve-dati") && !stato.caricato;
  });
}

function aggiornaRiepilogo() {
  $("#origine").textContent = stato.caricato ? stato.origine : "";
  if (!stato.caricato) { $("#riepilogo").textContent = "Nessun file caricato."; $("#voce-problemi").textContent = "Problemi"; return; }
  const n = (valore, testo) => [el("b", {}, valore), ` ${testo}`];
  const p = stato.problemi;
  $("#voce-problemi").replaceChildren(...["Problemi",
    p.errore ? el("span", { class: "contatore", title: "errori" }, p.errore) : null,
    p.avviso ? el("span", { class: "contatore giallo", title: "avvisi" }, p.avviso) : null].filter(Boolean));
  $("#riepilogo").replaceChildren(
    el("span", { class: p.errore ? "errore" : null }, ...n(p.errore, p.errore === 1 ? "errore" : "errori")), " · ",
    el("span", { class: p.avviso ? "avviso-g" : null }, ...n(p.avviso, p.avviso === 1 ? "avviso" : "avvisi")), " · ",
    ...n(stato.tabelle_analizzate, "tabelle analizzate"), stato.rimosse.length ? ` (${stato.rimosse.length} tolte)` : "", " · ",
    ...n(stato.aree, "aree"), " · ", ...n(stato.gruppi, "gruppi"), " · ",
    ...n(stato.pk_composte, "con chiave primaria composta"), " · ",
    ...n(stato.fk_dichiarate, "FK dichiarate"), " · ",
    ...n(stato.fk_candidate, "FK candidate"), ` (${stato.fk_alta} alta)`, " · ",
    ...n(stato.isolate, "isolate"),
  );
}

async function aggiornaTutto(prossima) {
  stato = await api("/api/stato");
  aggiornaRiepilogo();
  await mostra(prossima || vistaAttuale);
}

/** Dopo aver tolto o rimesso tabelle: aggiorna il riepilogo e ridisegna la vista corrente. */
async function dopoModifica(messaggio) {
  if (messaggio) avviso(messaggio);
  await aggiornaTutto();
}

async function mostra(nome) {
  vistaAttuale = nome;
  aggiornaMenu();
  const funzione = VISTE[nome];
  if (!stato.caricato && $(`#menu button[data-vista="${nome}"]`).hasAttribute("data-serve-dati")) {
    return mostra("panoramica");
  }
  try {
    const contenuto = await funzione();
    vista.replaceChildren(...[contenuto].flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
  } catch (e) {
    vista.replaceChildren(el("div", { class: "messaggio" }, e.message));
  }
}

// ======================================================================= viste

/** Risultati di una query come CSV (separatore ; per Excel in italiano). */
function csvRisultato(r) {
  const campo = v => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return "\ufeff" + [r.colonne, ...r.righe].map(riga => riga.map(campo).join(";")).join("\r\n");
}

function storicoQuery() {
  try { return JSON.parse(localStorage.getItem("sqlfk-storico-query") || "[]"); } catch { return []; }
}

function ricordaQuery(testo) {
  try {
    const elenco = [testo, ...storicoQuery().filter(t => t !== testo)].slice(0, 30);
    localStorage.setItem("sqlfk-storico-query", JSON.stringify(elenco));
  } catch { /* storico non disponibile: non importa */ }
}

const VISTE = {
  async query() {
    const info = await api("/api/query/tabelle");
    const editor = el("textarea", { class: "editor-query", spellcheck: "false", "aria-label": "Query SQL",
      placeholder: "SELECT * FROM tabella LIMIT 100;\n\nCtrl+Invio (Cmd+Invio sul Mac) per eseguire. Se selezioni una parte, viene eseguita solo quella." });
    editor.value = testoQuery;
    editor.addEventListener("input", () => { testoQuery = editor.value; });
    const risultati = el("div");
    const filtroTabelle = el("input", { type: "text", placeholder: "cerca una tabella", "aria-label": "Cerca una tabella" });
    const elenco = el("div", { class: "query-tabelle" });
    const storico = el("select", { "aria-label": "Query recenti" });

    function aggiornaStorico() {
      storico.replaceChildren(el("option", { value: "" }, "query recenti..."),
        storicoQuery().map(t => el("option", { value: t }, t.replace(/\s+/g, " ").slice(0, 90))));
    }
    storico.addEventListener("change", () => {
      if (storico.value) { editor.value = testoQuery = storico.value; editor.focus(); }
      storico.value = "";
    });

    function disegnaTabelle() {
      const f = filtroTabelle.value.toLowerCase();
      elenco.replaceChildren(...info.tabelle.filter(t => t.tabella.toLowerCase().includes(f)).map(t =>
        el("details", {},
          el("summary", { title: "Clicca il nome per vedere le prime righe" },
            el("a", { href: "#", onclick: e => {
              e.preventDefault();
              editor.value = testoQuery = `SELECT * FROM "${t.tabella.replace(/"/g, '""')}" LIMIT 100;`;
              esegui();
            } }, t.tabella),
            el("span", { class: "tenue" }, ` ${t.righe}`)),
          el("div", { class: "query-colonne" }, t.colonne.map(c => el("a", { href: "#", title: "Inserisci nella query", onclick: e => {
            e.preventDefault();
            const inizio = editor.selectionStart, fine = editor.selectionEnd;
            editor.setRangeText(/^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c}"`, inizio, fine, "end");
            testoQuery = editor.value;
            editor.focus();
          } }, c))))));
    }
    filtroTabelle.addEventListener("input", disegnaTabelle);

    function mostraRisultati(esito, testo) {
      if (esito.serve_conferma) {
        risultati.replaceChildren(el("div", { class: "pannello conferma" },
          el("h3", {}, "Queste istruzioni modificano i dati"),
          el("p", {}, "Cambiano solo la copia in memoria, non i file .sql. Si annullano con \"Ricarica i dati dai file\"."),
          esito.modifiche.map(m => el("pre", {}, m)),
          el("div", { class: "riga-comandi" },
            el("button", { class: "pericolo", onclick: () => esegui(testo, true) }, "Esegui comunque"),
            el("button", { onclick: () => risultati.replaceChildren() }, "Annulla"))));
        return;
      }
      ultimiRisultati = esito;
      risultati.replaceChildren(...esito.risultati.map((r, i) => {
        const titolo = esito.risultati.length > 1 ? el("pre", { class: "query-istruzione" }, r.istruzione) : null;
        const tradotta = r.tradotta ? el("p", { class: "tenue" }, "Eseguita come (SQLite): ", el("code", {}, r.tradotta)) : null;
        if (r.errore) return el("div", { class: "pannello" }, titolo, tradotta, el("div", { class: "errore" }, `Errore: ${r.errore}`));
        if (!r.colonne.length) {
          return el("div", { class: "pannello" }, titolo, tradotta,
            el("div", { class: "messaggio" }, `Eseguita: ${r.modificate} righe modificate (${r.secondi} s).`));
        }
        const nome = `risultato_${i + 1}.csv`;
        return el("div", {}, titolo, tradotta,
          el("div", { class: "riga-comandi" },
            el("span", { class: "tenue" }, `${r.totale} righe` + (r.totale > r.righe.length ? `, mostrate le prime ${r.righe.length}` : "") + ` · ${r.secondi} s`),
            el("button", { onclick: () => scaricaBlob(new Blob([csvRisultato(r)], { type: "text/csv;charset=utf-8" }), nome) }, "Scarica CSV")),
          griglia({ colonne: r.colonne, righe: r.righe }, { titolo: "Risultato" }));
      }));
      if (esito.risultati.some(r => r.modificate !== null && !r.errore)) aggiornaConteggi();
    }

    async function aggiornaConteggi() {
      const nuove = await api("/api/query/tabelle");
      info.tabelle = nuove.tabelle;
      disegnaTabelle();
    }

    async function esegui(testo, conferma = false) {
      if (typeof testo !== "string") {
        const scelto = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        testo = scelto.trim() ? scelto : editor.value;
      }
      if (!testo.trim()) return;
      ricordaQuery(testo.trim());
      aggiornaStorico();
      const esito = await conAttesa(() => api("/api/query", { sql: testo, conferma }));
      if (esito) mostraRisultati(esito, testo);
    }

    editor.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); esegui(); }
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); }
    });

    async function ricostruisci() {
      if (!confirm("Ricaricare i dati dai file .sql? Le modifiche fatte con le query vanno perse.")) return;
      const nuove = await conAttesa(() => api("/api/query/ricostruisci", {}));
      if (!nuove) return;
      info.tabelle = nuove.tabelle; info.problemi = nuove.problemi;
      disegnaTabelle();
      risultati.replaceChildren();
      avviso("Dati ricaricati dai file.");
    }

    aggiornaStorico();
    disegnaTabelle();
    if (ultimiRisultati) mostraRisultati(ultimiRisultati, "");
    const totaleRighe = info.tabelle.reduce((a, t) => a + t.righe, 0);
    const conDati = info.tabelle.filter(t => t.righe > 0).length;
    return [
      el("h2", {}, "Query sui dati"),
      el("p", { class: "tenue" },
        `Database SQLite in memoria costruito dai file: ${info.tabelle.length} tabelle, ${conDati} con dati, ${totaleRighe} righe ` +
        `(dagli INSERT e dai COPY dei file). Scrivi le query in SQLite o in ${info.dialetto}: se serve vengono tradotte. ` +
        "INSERT, UPDATE, DELETE e DROP chiedono conferma e cambiano solo questa copia, non i file."),
      totaleRighe === 0 ? el("div", { class: "messaggio" },
        "I file non contengono dati (INSERT o COPY): le tabelle sono vuote. Puoi comunque inserire righe con INSERT INTO ... VALUES ...") : null,
      info.problemi.length ? griglia({ colonne: ["file", "riga", "problema", "istruzione"],
        righe: info.problemi.map(p => [p.file, p.riga, p.problema, p.istruzione]) },
        { titolo: `Istruzioni di dati non caricate (${info.problemi.length})` }) : null,
      el("div", { class: "query-griglia" },
        el("div", { class: "pannello query-laterale" }, el("h3", {}, "Tabelle"), filtroTabelle,
          el("p", { class: "tenue" }, "Nome: prime 100 righe. Freccia: colonne (clic per inserirle)."), elenco),
        el("div", {},
          editor,
          el("div", { class: "riga-comandi" },
            el("button", { class: "primario", onclick: () => esegui() }, "Esegui"),
            el("button", { onclick: () => { editor.value = testoQuery = ""; editor.focus(); } }, "Svuota"),
            storico,
            el("button", { onclick: ricostruisci, title: "Annulla le modifiche fatte con le query" }, "Ricarica i dati dai file"),
            el("a", { class: "pulsante", href: "/api/scarica/database_sqlite", title: "Apribile con DBeaver o DB Browser for SQLite" }, "Scarica .sqlite"),
            el("a", { class: "pulsante", href: "/api/scarica/database_sql" }, "Scarica script SQL")),
          risultati)),
    ];
  },

  async editor() {
    const M = () => modelloEditor;
    const cornice = el("div", { class: "er-cornice" });
    const pannello = el("div", { class: "pannello editor-pannello" });
    const avvisiBox = el("div", { class: "editor-avvisi" });
    const anteprima = el("pre", { style: "max-height: 320px" });
    const nomeNuova = el("input", { type: "text", placeholder: "nome della nuova entità", "aria-label": "Nome della nuova entità" });
    const tipoImport = el("select", { "aria-label": "Chiavi esterne da importare" },
      el("option", { value: "iniziale" }, "solo FK dichiarate"), el("option", { value: "collegamenti" }, "FK dichiarate e trovate"));
    let diagramma = null;
    const regole = () => ({ on_delete: stato.impostazioni?.on_delete || "", on_update: stato.impostazioni?.on_update || "" });
    const dialetto = () => stato.impostazioni?.dialetto || "mysql";

    function posizioniModello() {
      const p = {};
      M().entita.forEach(e => { if (isFinite(e.x) && isFinite(e.y)) p[e.nome] = [e.x, e.y]; });
      M().relazioni.forEach(r => { if (r.tipo === "N:M" && isFinite(r.x) && isFinite(r.y)) p[r.nome] = [r.x, r.y]; });
      return p;
    }
    function elementoDaNome(nome) {
      return M().entita.find(e => e.nome === nome) || M().relazioni.find(r => r.tipo === "N:M" && r.nome === nome) || null;
    }
    function salvaPosizioni(pos) {
      M().entita.forEach(e => { if (pos[e.nome]) [e.x, e.y] = pos[e.nome]; });
      M().relazioni.forEach(r => { if (r.tipo === "N:M" && pos[r.nome]) [r.x, r.y] = pos[r.nome]; });
    }

    function ridisegna() {
      if (diagramma) { vistaEditor = diagramma.vista(); salvaPosizioni(diagramma.posizioni()); }
      const schema = Editor.schemaLogico(M());
      const scelto = selezioneEditor && (Editor.entitaDi(M(), selezioneEditor)?.nome || M().relazioni.find(r => r.id === selezioneEditor)?.nome);
      if (schema.tabelle.length) {
        diagramma = DiagrammaER.crea(cornice, schema, {
          tipi: true, posizioni: posizioniModello(), vista: vistaEditor, selezionata: scelto,
          onSposta: (nome, x, y) => { const el_ = elementoDaNome(nome); if (el_) { el_.x = x; el_.y = y; } },
          onClic: nome => { selezioneEditor = nome ? elementoDaNome(nome)?.id || null : null; ridisegna(); },
        });
        salvaPosizioni(diagramma.posizioni());
      } else {
        diagramma = null;
        cornice.replaceChildren(el("div", { class: "messaggio", style: "margin: 16px" },
          "Tela vuota: scrivi il nome di un'entità (per esempio Clienti) e premi Nuova entità, oppure importa il database caricato."));
      }
      avvisiBox.replaceChildren(...schema.avvisi.map(a => el("div", {}, `Avviso: ${a}`)));
      anteprima.textContent = Editor.sql(M(), regole(), dialetto());
      disegnaPannello();
    }

    function riga(attributo, eliminabile, alCambio) {
      const nome = el("input", { type: "text", value: attributo.nome, "aria-label": "Nome dell'attributo" });
      const tipo = el("input", { type: "text", value: attributo.tipo, list: "tipi-sql", "aria-label": "Tipo" });
      const spunta = (chiave, titolo) => {
        const c = el("input", { type: "checkbox", checked: !!attributo[chiave], title: titolo, "aria-label": titolo });
        c.addEventListener("change", () => { attributo[chiave] = c.checked; alCambio(); });
        return el("td", { class: "stretto" }, c);
      };
      nome.addEventListener("change", () => { attributo.nome = Editor.pulisciNome(nome.value); alCambio(); });
      tipo.addEventListener("change", () => { attributo.tipo = tipo.value.trim().toUpperCase() || "INT"; alCambio(); });
      return el("tr", {}, el("td", {}, nome), el("td", {}, tipo),
        "pk" in attributo ? spunta("pk", "chiave primaria") : el("td"), spunta("nn", "NOT NULL (obbligatorio)"),
        "uq" in attributo ? spunta("uq", "UNIQUE") : el("td"),
        el("td", { class: "stretto" }, eliminabile ? el("button", { title: "Elimina l'attributo", onclick: eliminabile }, "x") : null));
    }

    function formRelazione() {
      const opzioni = () => M().entita.map(e => el("option", { value: e.id }, e.nome));
      const da = el("select", { "aria-label": "Entità figlia" }, opzioni());
      const a = el("select", { "aria-label": "Entità padre" }, opzioni());
      if (M().entita.length > 1) a.selectedIndex = 1;
      if (selezioneEditor && Editor.entitaDi(M(), selezioneEditor)) da.value = selezioneEditor;
      const tipo = el("select", { "aria-label": "Cardinalità" },
        el("option", { value: "1:N" }, "1:N  molte righe della prima per una della seconda"),
        el("option", { value: "1:1" }, "1:1  una per una"),
        el("option", { value: "N:M" }, "N:M  molte per molte (tabella ponte)"));
      const obbl = el("input", { type: "checkbox", checked: true });
      const nomePonte = el("input", { type: "text", class: "largo", placeholder: "nome della tabella ponte (facoltativo)" });
      return [
        el("h3", {}, "Nuova relazione"),
        el("label", { class: "campo" }, "Prima entità (per 1:N: quella dal lato molti, che riceve la chiave esterna)", da),
        el("label", { class: "campo" }, "Seconda entità (per 1:N: quella dal lato uno)", a),
        el("label", { class: "campo" }, "Cardinalità", tipo),
        el("label", {}, obbl, " obbligatoria (la chiave esterna è NOT NULL)"), el("br"), el("br"),
        nomePonte, el("br"), el("br"),
        el("button", { class: "primario", onclick: () => {
          if (!da.value || !a.value) return avviso("Servono almeno due entità (o una per una relazione con se stessa).", true);
          if (tipo.value === "N:M" && da.value === a.value) return avviso("Una relazione N:M deve collegare due entità diverse.", true);
          const r = Editor.aggiungiRelazione(M(), { da: da.value, a: a.value, tipo: tipo.value, obbligatoria: obbl.checked, nome: nomePonte.value });
          if (r.tipo === "N:M") {                 // la tabella ponte sotto, a metà tra le due entità
            const e1 = Editor.entitaDi(M(), r.da), e2 = Editor.entitaDi(M(), r.a);
            if (isFinite(e1.x) && isFinite(e2.x)) { r.x = Math.round((e1.x + e2.x) / 2); r.y = Math.max(e1.y, e2.y) + 260; }
          }
          selezioneEditor = r.tipo === "N:M" ? r.id : da.value;
          ridisegna();
        } }, "Crea relazione"),
      ];
    }

    function disegnaPannello() {
      const e = selezioneEditor && Editor.entitaDi(M(), selezioneEditor);
      const r = !e && selezioneEditor && M().relazioni.find(x => x.id === selezioneEditor);
      const contenuto = [];
      const intestazione = el("tr", {}, ["nome", "tipo", "PK", "NN", "UQ", ""].map(x => el("th", {}, x)));
      if (e) {
        const nome = el("input", { type: "text", class: "largo", value: e.nome, "aria-label": "Nome dell'entità" });
        nome.addEventListener("change", () => { e.nome = Editor.pulisciNome(nome.value); ridisegna(); });
        const relazioni = M().relazioni.filter(x => x.da === e.id || x.a === e.id);
        contenuto.push(
          el("h3", {}, `Entità ${e.nome}`), el("label", { class: "campo" }, "Nome", nome),
          el("table", {}, el("thead", {}, intestazione), el("tbody", {}, e.attributi.map((at, i) =>
            riga(at, () => { e.attributi.splice(i, 1); ridisegna(); }, ridisegna)))),
          el("div", { class: "riga-comandi", style: "margin-top: 8px" },
            el("button", { onclick: () => { e.attributi.push({ nome: `attributo${e.attributi.length + 1}`, tipo: "VARCHAR(50)", pk: false, nn: false, uq: false }); ridisegna(); } }, "Aggiungi attributo"),
            el("button", { class: "pericolo", onclick: () => { Editor.eliminaEntita(M(), e.id); selezioneEditor = null; ridisegna(); } }, "Elimina entità")),
          relazioni.length ? el("h3", {}, "Relazioni") : null,
          relazioni.map(x => el("div", { class: "riga-comandi" },
            el("span", {}, x.tipo === "N:M" ? `${x.nome}: N:M` : `${Editor.entitaDi(M(), x.da).nome} → ${Editor.entitaDi(M(), x.a).nome} (${x.tipo}${x.obbligatoria ? ", obbligatoria" : ""})`),
            el("button", { onclick: () => { M().relazioni = M().relazioni.filter(y => y !== x); ridisegna(); } }, "Elimina"))),
          el("hr"));
      } else if (r) {
        const nome = el("input", { type: "text", class: "largo", value: r.nome, "aria-label": "Nome della tabella ponte" });
        nome.addEventListener("change", () => { r.nome = Editor.pulisciNome(nome.value); ridisegna(); });
        contenuto.push(
          el("h3", {}, `Relazione N:M ${r.nome}`),
          el("p", { class: "tenue" }, `Tra ${Editor.entitaDi(M(), r.da).nome} e ${Editor.entitaDi(M(), r.a).nome}: la tabella ponte ha come chiave primaria le chiavi delle due entità. Qui sotto gli attributi della relazione (per esempio la quantità).`),
          el("label", { class: "campo" }, "Nome della tabella ponte", nome),
          el("table", {}, el("thead", {}, el("tr", {}, ["nome", "tipo", "", "NN", "", ""].map(x => el("th", {}, x)))),
            el("tbody", {}, (r.attributi || []).map((at, i) => riga(at, () => { r.attributi.splice(i, 1); ridisegna(); }, ridisegna)))),
          el("div", { class: "riga-comandi", style: "margin-top: 8px" },
            el("button", { onclick: () => { (r.attributi ||= []).push({ nome: `attributo${r.attributi.length + 1}`, tipo: "INT", nn: false }); ridisegna(); } }, "Aggiungi attributo"),
            el("button", { class: "pericolo", onclick: () => { M().relazioni = M().relazioni.filter(y => y !== r); selezioneEditor = null; ridisegna(); } }, "Elimina relazione")),
          el("hr"));
      } else {
        contenuto.push(el("p", { class: "tenue" }, "Clicca un'entità sulla tela per modificarne nome e attributi; trascinala per spostarla."));
      }
      contenuto.push(M().entita.length ? formRelazione() : null);
      pannello.replaceChildren(...[contenuto].flat(Infinity).filter(Boolean));
    }

    function nuovaEntita() {
      const nome = nomeNuova.value.trim();
      if (!nome) return avviso("Scrivi il nome della nuova entità.", true);
      if (M().entita.some(e => e.nome.toLowerCase() === Editor.pulisciNome(nome).toLowerCase())) return avviso("Esiste già un'entità con questo nome.", true);
      const pos = diagramma ? diagramma.posizioni() : {};
      const xs = Object.values(pos).map(p => p[0]), ys = Object.values(pos).map(p => p[1]);
      // a destra dell'ultima, andando a capo ogni 4 entità
      const n = M().entita.length;
      const e = Editor.aggiungiEntita(M(), nome, xs.length ? 40 + (n % 4) * 360 : 40, ys.length ? 40 + Math.floor(n / 4) * 300 : 40);
      selezioneEditor = e.id;
      nomeNuova.value = "";
      vistaEditor = null;                         // la vista si adatta per mostrare tutto
      if (diagramma) salvaPosizioni(diagramma.posizioni());
      diagramma = null;
      ridisegna();
    }
    nomeNuova.addEventListener("keydown", ev => { if (ev.key === "Enter") nuovaEntita(); });

    async function importa() {
      if (M().entita.length && !confirm("L'editor contiene già un database: sostituirlo con quello caricato?")) return;
      const dati = await api(`/api/diagramma?tipo=${tipoImport.value}`);
      modelloEditor = Editor.daDiagramma(dati, layoutER[tipoImport.value] || {});
      selezioneEditor = null; vistaEditor = null; diagramma = null;
      ridisegna();
      avviso(`Importate ${modelloEditor.entita.length} entità e ${modelloEditor.relazioni.length} relazioni.`);
    }

    async function analizza() {
      if (!M().entita.length) return avviso("L'editor è vuoto.", true);
      if (diagramma) salvaPosizioni(diagramma.posizioni());
      stato = await api("/api/carica_file", { file: [{ nome: "editor.sql", testo: Editor.sql(M(), regole(), dialetto()) }], origine: "editor" });
      const pos = posizioniModello();
      layoutER = { iniziale: { ...pos }, collegamenti: { ...pos } };
      regoleCache = null;
      avviso("Schema analizzato: ora Problemi, Regole, Ontologia e Modello relazionale si riferiscono al database dell'editor.");
      await aggiornaTutto("problemi");
    }

    setTimeout(ridisegna, 0);
    return [
      el("datalist", { id: "tipi-sql" }, Editor.TIPI.map(t => el("option", { value: t }))),
      el("h2", {}, "Editor del database"),
      el("p", { class: "tenue" }, "Disegna le entità con i loro attributi e collegale con relazioni 1:N, 1:1 o N:M: l'editor applica le regole del passaggio al modello logico (chiave esterna dal lato N, UNIQUE per 1:1, tabella ponte per N:M) e scrive le CREATE TABLE. Con Analizza questo schema tutte le altre pagine (Problemi, Regole, Ontologia, Modello relazionale, esportazioni) lavorano sul database disegnato. Tutto si salva nel file di progetto."),
      el("div", { class: "riga-comandi" },
        nomeNuova, el("button", { class: "primario", onclick: nuovaEntita }, "Nuova entità"),
        el("button", { onclick: () => { if (!M().entita.length || confirm("Cancellare il database dell'editor e ripartire da zero?")) { modelloEditor = Editor.nuovoModello(); selezioneEditor = null; vistaEditor = null; diagramma = null; ridisegna(); } } }, "Nuovo database"),
        stato.caricato ? [el("button", { onclick: () => conAttesa(importa) }, "Importa il database caricato"), tipoImport] : null,
        el("button", { onclick: () => diagramma && diagramma.adatta() }, "Adatta alla finestra"),
        el("button", { onclick: () => conAttesa(analizza) }, "Analizza questo schema"),
        el("button", { onclick: () => scaricaBlob(new Blob([Editor.sql(M(), regole(), dialetto())], { type: "application/sql" }), "database.sql") }, "Scarica SQL"),
        el("button", { onclick: () => diagramma && conAttesa(async () => scaricaBlob(await diagramma.png(), "database.png")) }, "Scarica PNG")),
      avvisiBox,
      el("div", { class: "editor-griglia" }, cornice, pannello),
      el("h3", {}, "Codice SQL generato"),
      anteprima,
    ];
  },

  async regole() {
    const elenco = await regole();
    return [
      el("h2", {}, "Regole di progettazione"),
      el("p", { class: "tenue" }, "Le regole per costruire bene un database relazionale, dalla teoria della progettazione: integrità dell'entità e referenziale, cardinalità delle relazioni, normalizzazione. Ogni errore o avviso della pagina Problemi indica la regola che viola." +
        (stato.caricato ? "" : " Carica i file .sql per vedere quante volte ogni regola è violata.")),
      elenco.map(r => schedaRegola(r, true)),
    ];
  },

  async problemi() {
    const dati = await api("/api/diagnostica");
    const col = n => dati.problemi.colonne.indexOf(n);
    const conta = g => dati.problemi.righe.filter(r => r[col("gravità")] === g).length;
    const spunte = {};
    const riquadro = (g, testo, classe) => {
      spunte[g] = el("input", { type: "checkbox", checked: g !== "info" });
      return el("label", { class: `riquadro ${classe}` }, el("div", { class: "valore" }, conta(g)),
        el("div", { class: "voce" }, spunte[g], " ", testo));
    };
    const tiles = el("div", { class: "riquadri" },
      riquadro("errore", "errori", "errore-r"), riquadro("avviso", "avvisi", "avviso-r"), riquadro("info", "info", "info-r"));
    const elencoRegole = await regole();
    const regolaDi = Object.fromEntries(elencoRegole.flatMap(r => r.codici.map(c => [c, r])));
    const sceltaRegola = el("select", { "aria-label": "Regola" }, el("option", { value: "" }, "tutte le regole"),
      elencoRegole.map(r => el("option", { value: r.id, selected: r.id === filtroRegola }, `${r.id} ${r.titolo}`)));
    const codici = [...new Set(dati.problemi.righe.map(r => r[col("codice")]))].sort();
    const codice = el("select", { "aria-label": "Codice" }, el("option", { value: "" }, "tutti i codici"),
      codici.map(c => el("option", { value: c }, `${c} - ${dati.problemi.righe.find(r => r[col("codice")] === c)[col("regola")]}`)));
    const elenco = el("div");
    const sorgente = el("div", { class: "pannello" }, el("p", { class: "tenue" }, "Clicca un problema per vedere il suggerimento e il punto del file .sql in cui si trova."));

    async function mostraSorgente(riga) {
      if (!riga.file || riga.riga === null) {
        sorgente.replaceChildren(el("p", { class: "tenue" }, "Questo problema riguarda tutto lo schema, non una riga precisa."));
        return;
      }
      const s = await api(`/api/sorgente?file=${encodeURIComponent(riga.file)}&riga=${riga.riga}`);
      const classe = "evidenziata" + (riga["gravità"] === "errore" ? " e" : "");
      sorgente.replaceChildren(
        el("h3", {}, `${riga.file}:${riga.riga}`),
        el("p", {}, el("b", { class: classiStandard("gravità", riga["gravità"]) }, `${riga["gravità"]} ${riga.codice}`), `: ${riga.messaggio}`),
        riga.suggerimento ? el("p", { class: "tenue" }, `Suggerimento: ${riga.suggerimento}`) : null,
        el("div", { class: "sorgente" }, s.righe.map(([n, testo]) =>
          el("div", { class: n === s.riga ? classe : null }, el("span", { class: "numero" }, n), testo))),
        regolaDi[riga.codice] ? schedaRegola(regolaDi[riga.codice], false) : null);
    }

    function disegna() {
      const codiciRegola = sceltaRegola.value ? new Set(elencoRegole.find(r => r.id === sceltaRegola.value).codici) : null;
      filtroRegola = sceltaRegola.value;
      const righe = dati.problemi.righe.filter(r => spunte[r[col("gravità")]].checked
        && (!codice.value || r[col("codice")] === codice.value)
        && (!codiciRegola || codiciRegola.has(r[col("codice")])));
      elenco.replaceChildren(griglia({ colonne: dati.problemi.colonne, righe },
        { classiCella: classiStandard, alClic: mostraSorgente, nascondi: ["regola", "suggerimento"] }));
    }
    Object.values(spunte).forEach(s => s.addEventListener("change", disegna));
    codice.addEventListener("change", disegna);
    sceltaRegola.addEventListener("change", disegna);
    if (filtroRegola) Object.values(spunte).forEach(s => { s.checked = true; });
    disegna();
    return [
      el("h2", {}, "Problemi dello schema"),
      el("p", { class: "tenue" }, "Come un compilatore: gli errori sono cose sbagliate da correggere (per esempio una tabella senza chiave primaria o una chiave esterna verso una tabella che non esiste); gli avvisi sono probabili difetti di progettazione (chiavi esterne mancanti, normalizzazione, relazioni ridondanti); le info sono osservazioni. Ricavati dalla sola struttura: gli avvisi vanno verificati."),
      tiles,
      el("div", { class: "riga-comandi" }, sceltaRegola, codice,
        el("a", { class: "pulsante", href: "/api/scarica/report", download: "diagnostica.txt" }, "Scarica il report (.txt)")),
      sorgente,
      elenco,
    ];
  },

  async panoramica() {
    if (!stato.caricato) {
      return el("div", { class: "pannello" },
        el("img", { src: "logo.png", alt: "", width: 120, height: 120, style: "float: right; margin: 0 0 8px 16px" }),
        el("h2", {}, "Benvenuto"),
        el("p", {}, "Questa app legge i file .sql con i CREATE TABLE di un database e cerca i collegamenti tra le tabelle (le chiavi esterne mancanti)."),
        el("p", {}, "Per iniziare usa in alto ", el("b", {}, "Carica cartella"), " (tutti i file .sql di una cartella), ",
          el("b", {}, "Carica file .sql"), " (uno o più file), oppure scrivi il percorso di una cartella e premi ", el("b", {}, "Apri"), "."),
        el("p", { class: "tenue" }, "I file non vengono mai modificati: l'app li legge e basta."),
        stato.sqlglot === false ? el("div", { class: "messaggio" }, "sqlglot non è installato: viene usato solo il parser interno (pip install sqlglot).") : null);
    }
    const dati = await api("/api/panoramica");
    const riquadri = el("div", { class: "riquadri" }, dati.riepilogo.righe.map(([voce, valore]) =>
      el("div", { class: "riquadro" }, el("div", { class: "valore" }, valore), el("div", { class: "voce" }, voce))));
    return [
      el("h2", {}, "Il database com'è prima dell'analisi"),
      riquadri,
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: () => mostra("problemi") },
          `Vedi i problemi (${stato.problemi.errore} errori, ${stato.problemi.avviso} avvisi)`),
        el("button", { onclick: () => mostraSchema("iniziale") }, "Apri lo schema iniziale"),
        el("button", { onclick: () => mostra("gruppi") }, "Vedi i gruppi di entità")),
      dati.fk_dichiarate.righe.length
        ? griglia(dati.fk_dichiarate, { titolo: "Chiavi esterne già dichiarate" })
        : el("div", { class: "messaggio" }, "Nessuna chiave esterna dichiarata: nei file le tabelle non sono collegate tra loro."),
      dati.errori.length ? el("div", { class: "pannello" }, el("h3", {}, "Errori di lettura dei file"),
        dati.errori.map(e => el("pre", {}, `${e.file}:${e.riga}: ${e.problema}`))) : null,
      el("p", { class: "tenue" }, "File letti: ", stato.file.join(", ")),
    ];
  },

  async gruppi() {
    const [dati, aree] = await Promise.all([api("/api/gruppi"), api("/api/aree")]);
    const iN = dati.gruppi.colonne.indexOf("n_tabelle");
    const soloGruppi = { colonne: dati.gruppi.colonne, righe: dati.gruppi.righe.filter(r => r[iN] > 1) };
    const singole = { colonne: dati.gruppi.colonne, righe: dati.gruppi.righe.filter(r => r[iN] === 1) };
    const dettaglio = el("div", { class: "pannello" }, el("p", { class: "tenue" }, "Clicca un gruppo per vedere le sue tabelle e, se vuoi, toglierlo dall'analisi."));

    function scegli(riga) {
      const tabelle = riga.tabelle.split(", ");
      const tolte = new Set(stato.rimosse);
      dettaglio.replaceChildren(
        el("h3", {}, `Gruppo ${riga.gruppo}: ${tabelle.length} tabelle`),
        el("p", {}, tabelle.map((t, i) => [i ? ", " : "", tolte.has(t) ? el("s", { class: "tenue", title: "tolta" }, t) : t])),
        el("div", { class: "riga-comandi" },
          el("button", { class: "pericolo", onclick: async () => {
            await conAttesa(async () => {
              const r = await api("/api/togli_gruppo", { gruppo: riga.gruppo });
              await dopoModifica(`Tolte ${r.tolte} tabelle del gruppo ${riga.gruppo}.`);
            });
          } }, "Togli questo gruppo"),
          el("button", { onclick: async () => {
            await conAttesa(async () => {
              const r = await api("/api/rimetti", { tabelle: tabelle });
              await dopoModifica(`Rimesse ${r.rimesse} tabelle del gruppo ${riga.gruppo}.`);
            });
          } }, "Rimetti questo gruppo")),
        pulsantiSchemi());
    }

    const righeGruppi = Object.fromEntries(dati.gruppi.righe.map(r => [r[dati.gruppi.colonne.indexOf("gruppo")],
      Object.fromEntries(dati.gruppi.colonne.map((n, i) => [n, r[i]]))]));
    const albero = alberoAree(aree, g => {
      if (!righeGruppi[g]) return;
      scegli(righeGruppi[g]);
      dettaglio.scrollIntoView({ block: "center" });
    });

    return [
      el("h2", {}, "Aree, sottogruppi e categorie"),
      el("p", { class: "tenue" },
        "Due livelli. I sottogruppi sono le tabelle con nomi simili. Le aree sono sottogruppi molto collegati tra loro dalle chiavi esterne " +
        "(dichiarate e trovate ad affidabilità alta): si trovano con un rilevamento di comunità, che mette insieme i sottogruppi con molti " +
        "collegamenti tra loro e pochi con il resto. Le tabelle centrali, puntate da moltissime altre, nella divisione pesano poco, " +
        "altrimenti unirebbero tutto in un'unica area. La categoria di ogni tabella è ricavata dalla struttura ed è da verificare."),
      albero,
      dettaglio,
      griglia(aree.collegamenti_aree, { titolo: "Collegamenti tra aree" }),
      griglia(aree.collegamenti, { titolo: "Collegamenti tra sottogruppi (prima quelli tra aree diverse)" }),
      griglia(aree.tabelle, { titolo: "Categoria di ogni tabella",
        classiCella: (nome, valore) => nome === "categoria" ? `cat cat-${valore}` : null }),
      el("h2", {}, "Gruppi di entità per nome"),
      el("p", { class: "tenue" }, "Tabelle con nomi simili, raggruppate con un clustering gerarchico (per esempio ordini, ordini_righe, tbl_ordini). La soglia si cambia in Impostazioni."),
      griglia(soloGruppi, { titolo: "Gruppi con almeno 2 tabelle (clicca per il dettaglio sotto l'albero delle aree)", alClic: r => {
        scegli(r); dettaglio.scrollIntoView({ block: "center" }); } }),
      griglia(singole, { titolo: "Tabelle che non stanno in nessun gruppo", nascondi: ["gruppo", "n_tabelle"] }),
    ];
  },

  async schemi() {
    return contenutoSchema(ultimoSchema);
  },

  async togli() {
    const parola = el("input", { type: "text", placeholder: "es. piatto", "aria-label": "Entità da togliere" });
    const trovate = el("div");
    const cerca = async () => {
      const r = await api(`/api/cerca_entita?parola=${encodeURIComponent(parola.value)}`);
      if (!r.tabelle.length) {
        trovate.replaceChildren(el("div", { class: "messaggio" }, "Nessuna tabella trovata (servono almeno 3 lettere)."));
        return;
      }
      const spunte = r.tabelle.map(t => el("input", { type: "checkbox", value: t, checked: true }));
      trovate.replaceChildren(
        el("p", {}, `${r.tabelle.length} tabelle trovate per `, el("b", {}, parola.value), ". Togli la spunta a quelle da tenere."),
        el("div", { class: "elenco-spunte" }, spunte.map(s => el("label", {}, s, s.value))),
        el("button", { class: "pericolo", onclick: async () => {
          const scelte = spunte.filter(s => s.checked).map(s => s.value);
          if (!scelte.length) return avviso("Nessuna tabella selezionata.", true);
          await conAttesa(async () => {
            const esito = await api("/api/togli", { tabelle: scelte });
            await dopoModifica(`Tolte ${esito.tolte} tabelle.`);
          });
        } }, "Togli selezionate"));
    };
    parola.addEventListener("keydown", e => { if (e.key === "Enter") cerca(); });

    const spunteTolte = stato.rimosse.map(t => el("input", { type: "checkbox", value: t }));
    return [
      el("h2", {}, "Togli entità dall'analisi"),
      el("p", { class: "tenue" }, "Scrivi un'entità (per esempio piatto): vengono trovate tutte le sue tabelle (piatti, piatto_ingredienti, tbl_piatti...). Appena le togli l'analisi si aggiorna da sola, senza salvare: le tabelle tolte spariscono dai risultati e dagli schemi grafici. I file non vengono modificati."),
      pulsantiSchemi(),
      el("div", { class: "pannello" },
        el("div", { class: "riga-comandi" }, parola, el("button", { class: "primario", onclick: cerca }, "Cerca tabelle")),
        trovate),
      el("div", { class: "pannello" },
        el("h3", {}, `Tabelle tolte (${stato.rimosse.length})`),
        stato.rimosse.length
          ? [el("div", { class: "elenco-spunte" }, spunteTolte.map(s => el("label", {}, s, s.value))),
             el("div", { class: "riga-comandi" },
               el("button", { onclick: async () => {
                 const scelte = spunteTolte.filter(s => s.checked).map(s => s.value);
                 if (!scelte.length) return avviso("Nessuna tabella selezionata.", true);
                 await conAttesa(async () => { const r = await api("/api/rimetti", { tabelle: scelte }); await dopoModifica(`Rimesse ${r.rimesse} tabelle.`); });
               } }, "Rimetti selezionate"),
               el("button", { onclick: async () => {
                 await conAttesa(async () => { const r = await api("/api/rimetti", { tutte: true }); await dopoModifica(`Rimesse ${r.rimesse} tabelle.`); });
               } }, "Rimetti tutte"))]
          : el("p", { class: "tenue" }, "Nessuna tabella tolta.")),
    ];
  },

  async tabelle() {
    const dati = await api("/api/tabelle");
    return [
      el("h2", {}, "Tabelle analizzate"),
      el("p", { class: "tenue" }, "Chiave primaria dichiarata nei file oppure indovinata (id, id_tabella, tabella_id). n colonne PK maggiore di 1 = chiave primaria composta."),
      griglia(dati.tabelle, { classiCella: classiStandard }),
    ];
  },

  async pk() {
    const dati = await api("/api/pk_composte");
    if (!dati.tabelle.length) return [el("h2", {}, "PK composte"), el("div", { class: "messaggio" }, "Nessuna tabella con chiave primaria composta.")];
    const scelta = el("select", { "aria-label": "Tabella" }, el("option", { value: "" }, "(tutte)"), dati.tabelle.map(t => el("option", { value: t }, t)));
    const contenuto = el("div");
    const iTab = dati.dettaglio.colonne.indexOf("tabella");
    const disegna = () => {
      const t = scelta.value;
      const testo = t ? dati.testi[t] : dati.tabelle.map(x => dati.testi[x]).join("\n");
      const righe = t ? dati.dettaglio.righe.filter(r => r[iTab] === t) : dati.dettaglio.righe;
      contenuto.replaceChildren(el("pre", {}, testo.trim()),
        griglia({ colonne: dati.dettaglio.colonne, righe }, { classiCella: classiStandard }));
    };
    scelta.addEventListener("change", disegna);
    disegna();
    return [
      el("h2", {}, "Tabelle con chiave primaria composta"),
      el("p", { class: "tenue" }, "Ogni colonna della chiave viene analizzata da sola: prima una tabella con il nome del campo (codice -> codici) dove il campo è presente ed eventualmente chiave primaria, poi le tabelle in cui il campo è chiave primaria, infine quelle che hanno solo lo stesso campo."),
      el("div", { class: "riga-comandi" }, el("label", {}, "Tabella ", scelta)),
      contenuto,
    ];
  },

  async fk() {
    const dati = await api("/api/fk");
    const col = n => dati.fk.colonne.indexOf(n);
    const aff = el("select", { "aria-label": "Affidabilità" }, ["tutte", "alta", "media"].map(v => el("option", { value: v }, v)));
    const tipi = el("input", { type: "checkbox" });
    const nuove = el("input", { type: "checkbox" });
    const nome = el("input", { type: "text", placeholder: "tabella di partenza o di arrivo" });
    const contenuto = el("div");
    let corrente = null;
    const disegna = () => {
      const f = nome.value.trim().toLowerCase();
      const righe = dati.fk.righe.filter(r =>
        (aff.value === "tutte" || r[col("affidabilità")] === aff.value) &&
        (!tipi.checked || r[col("tipi ok")]) &&
        (!nuove.checked || !r[col("già dichiarata")]) &&
        (!f || String(r[col("tabella")]).toLowerCase().includes(f) || String(r[col("→ tabella")]).toLowerCase().includes(f)));
      corrente = griglia({ colonne: dati.fk.colonne, righe }, { classiCella: classiStandard });
      contenuto.replaceChildren(corrente);
    };
    [aff, tipi, nuove].forEach(c => c.addEventListener("change", disegna));
    nome.addEventListener("input", disegna);
    disegna();
    const copia = async () => {
      const sql = corrente.righeFiltrate().map(r => r[col("sql")]).join("\n");
      await navigator.clipboard.writeText(sql);
      avviso(`Copiate ${corrente.righeFiltrate().length} istruzioni SQL.`);
    };
    return [
      el("h2", {}, "Chiavi esterne candidate"),
      el("p", { class: "tenue" }, "alta: stesso nome della chiave primaria di un'altra tabella, oppure tutte le colonne di una chiave primaria composta. media: il nome rimanda a una tabella (id_articolo -> articoli). Sono proposte da verificare sui dati prima di eseguire gli ALTER TABLE."),
      el("div", { class: "riga-comandi" },
        el("label", {}, "Affidabilità ", aff),
        el("label", {}, tipi, "solo tipi compatibili"),
        el("label", {}, nuove, "nascondi quelle già dichiarate"),
        nome,
        el("button", { onclick: copia }, "Copia SQL delle righe mostrate")),
      contenuto,
    ];
  },

  async qualita() {
    const dati = await api("/api/qualita");
    const riquadri = el("div", { class: "riquadri" }, dati.riepilogo.righe.map(([voce, valore]) =>
      el("div", { class: "riquadro" }, el("div", { class: "valore" }, valore), el("div", { class: "voce" }, voce))));
    const regola = r => r || "nessuna clausola";
    const sezione = (titolo, spiegazione, tabella, vuoto) => [
      el("h3", {}, titolo),
      el("p", { class: "tenue" }, spiegazione),
      tabella.righe.length ? griglia(tabella) : el("div", { class: "messaggio" }, vuoto),
    ];
    return [
      el("h2", {}, "Qualità dello schema"),
      el("p", { class: "tenue" }, "Controlli di buona progettazione ricavati dalla sola struttura (CREATE TABLE): sono avvisi da verificare, perché senza i dati non si possono dimostrare. Si basano sui collegamenti ad affidabilità alta con tipi compatibili e sulle chiavi esterne già dichiarate."),
      riquadri,
      el("div", { class: "pannello" },
        el("h3", {}, "Integrità referenziale: regole delle chiavi esterne"),
        el("p", {}, "Negli script ALTER TABLE e CREATE TABLE ogni chiave esterna ha ",
          el("b", {}, `ON DELETE ${regola(dati.regole.on_delete)}`), " e ", el("b", {}, `ON UPDATE ${regola(dati.regole.on_update)}`), "."),
        el("p", { class: "tenue" }, "RESTRICT: non si può cancellare o cambiare il padre se ha dei figli. CASCADE: la cancellazione o la modifica del padre si propaga ai figli. SET NULL: nei figli la chiave esterna diventa NULL (non si può usare su colonne NOT NULL). Si cambiano in Impostazioni."),
        el("button", { onclick: () => mostra("impostazioni") }, "Cambia le regole")),
      sezione("Integrità dell'entità: tabelle senza chiave primaria",
        "Ogni tabella deve avere una chiave primaria, con valori sempre presenti e diversi tra loro.",
        dati.senza_pk, "Tutte le tabelle hanno una chiave primaria dichiarata."),
      sezione("Relazioni N:M (tabelle ponte)",
        "Tabelle la cui chiave primaria è composta da chiavi esterne verso tabelle diverse: realizzano una relazione molti a molti. Le altre colonne sono attributi della relazione.",
        dati.ponti, "Nessuna tabella ponte trovata."),
      sezione("Normalizzazione",
        "1NF: ogni campo deve contenere un solo valore (niente campi composti o colonne numerate ripetute). 2NF: con una chiave composta, ogni colonna deve dipendere da tutta la chiave. 3NF: una colonna non deve dipendere da un'altra colonna non chiave (qui: un dato copiato da una tabella collegata).",
        dati.normalizzazione, "Nessun avviso di normalizzazione."),
      sezione("Relazioni ridondanti",
        "Collegamenti diretti che ripetono un percorso già esistente tramite altre tabelle: di solito vanno tolti (nel CREATE TABLE sono commentati).",
        dati.ridondanti, "Nessuna relazione ridondante trovata."),
    ];
  },

  async altri() {
    const dati = await api("/api/altri");
    return [
      el("h2", {}, "Altri risultati"),
      griglia(dati.stesso_nome, { titolo: "Colonne con lo stesso nome in più tabelle", classiCella: classiStandard }),
      griglia(dati.simili, { titolo: "Colonne con nomi simili", classiCella: classiStandard }),
      griglia(dati.sospette, { titolo: "Colonne che sembrano chiavi ma senza tabella corrispondente" }),
      griglia(dati.isolate, { titolo: "Tabelle isolate (nessun collegamento trovato)" }),
    ];
  },

  async modello() {
    let tipo = "collegamenti";
    const medie = el("input", { type: "checkbox", title: "Aggiunge le FK trovate ad affidabilità media (passa a FK dichiarate e trovate)" });
    const filtro = el("input", { type: "text", placeholder: "filtra le tabelle", "aria-label": "Filtra le tabelle" });
    const formato = el("select", { "aria-label": "Formato dell'anteprima" },
      [["testo", "Testo (.txt)"], ["md", "Markdown (.md)"], ["mermaid", "Mermaid (.mmd)"], ["plantuml", "PlantUML (.puml)"],
       ["dot", "Graphviz (.dot)"], ["dbml", "DBML (.dbml)"], ["json", "JSON"]].map(([v, t]) => el("option", { value: v }, t)));
    const schema = el("div", { class: "pannello schema-logico" });
    const anteprima = el("pre", { style: "max-height: 360px" });
    const info = el("span", { class: "tenue" });
    const schede = el("span", { class: "riga-comandi", style: "margin: 0" });
    let dati = null;
    const parametri = () => `tipo=${tipo}&medie=${medie.checked ? 1 : 0}`;

    function disegnaSchema() {
      const f = filtro.value.trim().toLowerCase();
      const tabelle = dati.tabelle.filter(t => !f || t.nome.toLowerCase().includes(f));
      schema.replaceChildren(...tabelle.map(t => el("div", {},
        el("span", { class: "nome-tabella" }, t.nome), " (",
        t.colonne.map((c, i) => [i ? ", " : "",
          el("span", { class: [c.pk ? "pk" : "", c.fk ? "fk" : ""].join(" ").trim() || null, title: c.tipo }, c.nome),
          c.fk ? el("span", { class: "verso" }, ` → ${c.verso.join(", ")}`) : null]),
        ")", t.pk_indovinata ? el("span", { class: "verso" }, "  chiave primaria non dichiarata") : null)));
      info.textContent = `${tabelle.length} tabelle, ${dati.collegamenti.length} collegamenti`;
    }
    async function carica() {
      dati = await api(`/api/diagramma?${parametri()}`);
      schede.replaceChildren(
        el("button", { class: tipo === "iniziale" ? "primario" : null, onclick: () => { tipo = "iniziale"; medie.checked = false; conAttesa(carica); } }, "Solo FK dichiarate"),
        el("button", { class: tipo === "collegamenti" ? "primario" : null, onclick: () => { tipo = "collegamenti"; conAttesa(carica); } }, "FK dichiarate e trovate"));
      disegnaSchema();
      await aggiornaAnteprima();
    }
    async function aggiornaAnteprima() {
      const r = await api(`/api/modello?${parametri()}&formato=${formato.value}&anteprima=1`);
      anteprima.textContent = r.testo;
    }
    filtro.addEventListener("input", disegnaSchema);
    medie.addEventListener("change", () => {
      if (medie.checked) tipo = "collegamenti";       // le FK medie ci sono solo tra quelle trovate
      conAttesa(carica);
    });
    formato.addEventListener("change", () => conAttesa(aggiornaAnteprima));
    setTimeout(() => conAttesa(carica), 0);

    const scaricaFormato = (f, est) => el("button", { onclick: () =>
      el("a", { href: `/api/modello?${parametri()}&formato=${f}`, download: `modello_relazionale.${est}` }).click() }, est.toUpperCase());
    return [
      el("h2", {}, "Modello relazionale"),
      el("p", { class: "tenue" }, "Lo schema logico del database: una riga per tabella con i suoi attributi; la chiave primaria è sottolineata, le chiavi esterne sono in corsivo con la tabella a cui puntano (passa il mouse su un attributo per vederne il tipo). Si può esportare come immagine o in formati da usare con altri strumenti."),
      el("div", { class: "riga-comandi" }, schede, el("label", {}, medie, "anche affidabilità media"), filtro, info),
      el("div", { class: "pannello" },
        el("h3", {}, "Esporta"),
        el("div", { class: "riga-comandi" },
          el("span", { class: "tenue" }, "Immagine del diagramma:"),
          el("button", { class: "primario", onclick: () => conAttesa(() => diagrammaInPng(dati, "modello_relazionale.png", layoutER[tipo])) }, "PNG"),
          el("button", { onclick: () => {
            const scatola = el("div", { style: "position: fixed; left: -20000px; top: 0; width: 1600px; height: 1000px" });
            document.body.append(scatola);
            try {
              const d = DiagrammaER.crea(scatola, dati, { tipi: true, posizioni: layoutER[tipo] });
              scaricaBlob(new Blob([d.esporta()], { type: "image/svg+xml" }), "modello_relazionale.svg");
            } finally { scatola.remove(); }
          } }, "SVG")),
        el("div", { class: "riga-comandi" },
          el("span", { class: "tenue" }, "Testo e altri strumenti:"),
          [["testo", "txt"], ["md", "md"], ["mermaid", "mmd"], ["plantuml", "puml"], ["dot", "dot"], ["dbml", "dbml"], ["json", "json"]]
            .map(([f, est]) => scaricaFormato(f, est))),
        el("p", { class: "tenue" }, "Mermaid: lo disegnano GitHub, Notion e mermaid.live. PlantUML: plantuml.com. Graphviz: dot -Tpng modello_relazionale.dot -o modello.png. DBML: dbdiagram.io.")),
      schema,
      el("div", { class: "riga-comandi" }, el("b", {}, "Anteprima"), formato),
      anteprima,
    ];
  },

  async ontologia() {
    const base = el("input", { type: "text", style: "width: 340px", "aria-label": "IRI di base" });
    const lingua = el("select", { "aria-label": "Lingua dei nomi" },
      [["auto", "lingua: automatica"], ["italiano", "nomi in italiano (ha...)"], ["inglese", "nomi in inglese (has...)"]]
        .map(([v, t]) => el("option", { value: v }, t)));
    const risultato = el("div");
    const parametri = () => `base=${encodeURIComponent(base.value)}&lingua=${lingua.value}`;
    async function genera() {
      const d = await api(`/api/ontologia?${parametri()}`);
      if (!base.value) base.value = d.base;
      const riquadri = [["classi", "classi (una per tabella)"], ["proprieta_dato", "proprietà di dato (colonne)"],
        ["proprieta_oggetto", "proprietà d'oggetto (chiavi esterne)"], ["proposte", "collegamenti proposti, da verificare"],
        ["relazioni_nm", "relazioni N:M"]];
      risultato.replaceChildren(
        el("div", { class: "riquadri" }, riquadri.map(([k, t]) =>
          el("div", { class: "riquadro" }, el("div", { class: "valore" }, d[k]), el("div", { class: "voce" }, t)))),
        el("p", { class: "tenue" }, `Nomi in ${d.lingua}.`),
        el("div", { class: "riga-comandi" },
          el("a", { class: "pulsante primario", href: `/api/scarica/ontologia?${parametri()}`, download: "ontologia.ttl" }, "Scarica ontologia (.ttl)"),
          el("a", { class: "pulsante", href: `/api/scarica/r2rml?${parametri()}`, download: "mapping_r2rml.ttl" }, "Scarica mapping R2RML (.ttl)")),
        griglia({ colonne: ["tabella", "classe"], righe: d.tabelle.map(x => [x.tabella, x.classe]) }, { titolo: "Tabelle e classi" }),
        d.ponti.length ? griglia({ colonne: ["tabella ponte", "proprietà N:M"], righe: d.ponti.map(x => [x.tabella, x.proprieta]) },
          { titolo: "Tabelle ponte diventate relazioni N:M" }) : null,
        el("h3", {}, "Anteprima dell'ontologia"),
        el("pre", { style: "max-height: 420px" }, d.anteprima));
    }
    lingua.addEventListener("change", () => conAttesa(genera));
    setTimeout(() => conAttesa(genera), 0);
    return [
      el("h2", {}, "Ontologia"),
      el("p", { class: "tenue" }, "Genera un'ontologia OWL (formato Turtle, apribile in Protégé) dalla struttura del database: ogni tabella diventa una classe, ogni colonna una proprietà di dato, ogni chiave esterna una proprietà d'oggetto; la chiave primaria diventa owl:hasKey, NOT NULL una cardinalità minima, le tabelle ponte senza attributi una relazione N:M. Il mapping R2RML dice come trasformare i dati del database in RDF (con Ontop, RMLMapper e simili). Usa le chiavi esterne dichiarate e quelle trovate ad affidabilità alta, che nell'ontologia sono annotate come da verificare; le relazioni ridondanti e le tabelle tolte sono escluse."),
      el("div", { class: "riga-comandi" },
        el("label", {}, "IRI di base ", base), lingua,
        el("button", { onclick: () => conAttesa(genera) }, "Aggiorna")),
      risultato,
    ];
  },

  async salva() {
    const cartella = el("input", { type: "text", placeholder: "percorso di una cartella", style: "width: 360px" });
    const esito = el("div");
    const anteprima = el("div");
    return [
      el("h2", {}, "Salva i risultati"),
      el("div", { class: "pannello" },
        el("h3", {}, "Scarica"),
        el("p", { class: "tenue" }, "Il file Excel ha un foglio per ogni analisi. Gli ALTER TABLE aggiungono le chiavi esterne proposte a un database esistente; i CREATE TABLE sono quelli dei tuoi file con le chiavi esterne già scritte dentro (attive quelle ad affidabilità alta, le altre commentate con -- e il motivo)."),
        el("div", { class: "riga-comandi" },
          el("a", { class: "pulsante primario", href: "/api/scarica/excel", download: "possibili_collegamenti.xlsx" }, "Scarica Excel"),
          el("a", { class: "pulsante", href: "/api/scarica/sql", download: "fk_candidate.sql" }, "Scarica ALTER TABLE (.sql)"),
          el("a", { class: "pulsante", href: "/api/scarica/create", download: "create_table_con_fk.sql" }, "Scarica CREATE TABLE con FK (.sql)"),
          el("button", { onclick: async () => {
            const testo = await (await fetch("/api/scarica/create")).text();
            const righe = testo.split("\n");
            anteprima.replaceChildren(
              righe.length > 400 ? el("p", { class: "tenue" }, `Prime 400 righe su ${righe.length}: il file completo si scarica con il pulsante.`) : null,
              el("pre", {}, righe.slice(0, 400).join("\n")));
          } }, "Anteprima CREATE TABLE")),
        anteprima),
      el("div", { class: "pannello" },
        el("h3", {}, "Salva tutto in una cartella"),
        el("p", { class: "tenue" }, "Crea nella cartella il file Excel, i due file .sql (ALTER TABLE e CREATE TABLE con FK), l'ontologia e il mapping R2RML, il report della diagnostica e i due schemi grafici."),
        el("div", { class: "riga-comandi" }, cartella, el("button", { onclick: async () => {
          await conAttesa(async () => {
            const r = await api("/api/salva_cartella", { cartella: cartella.value });
            esito.replaceChildren(el("div", { class: "messaggio" }, "Salvati:", el("pre", {}, r.salvati.join("\n"))));
          });
        } }, "Salva")),
        esito),
    ];
  },

  async impostazioni() {
    const imp = stato.impostazioni;
    const dialetto = el("select", {}, ["mysql", "tsql", "oracle", "postgres", "sqlite"].map(d => el("option", { value: d, selected: d === imp.dialetto }, d)));
    const sSimili = el("input", { type: "number", min: "0.1", max: "1", step: "0.05", value: imp.soglia_simili });
    const sGruppi = el("input", { type: "number", min: "0.1", max: "1", step: "0.05", value: imp.soglia_gruppi });
    const generiche = el("textarea", {}, imp.generiche.join(", "));
    const parole = el("textarea", {}, imp.parole_non_entita.join(", "));
    const sinonimi = el("textarea", { placeholder: "comune = citta = paese\ncliente = customer" }, (imp.sinonimi || []).join("\n"));
    const regole = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION", "SET DEFAULT", ""];
    const sceltaRegola = valore => el("select", {}, regole.map(r => el("option", { value: r, selected: r === valore }, r || "nessuna clausola")));
    const onDelete = sceltaRegola(imp.on_delete);
    const onUpdate = sceltaRegola(imp.on_update);
    const elenco = t => t.value.split(",").map(x => x.trim()).filter(Boolean);
    return [
      el("h2", {}, "Impostazioni"),
      el("div", { class: "pannello" },
        el("div", { class: "riquadri" },
          el("label", { class: "campo" }, "Dialetto SQL", dialetto),
          el("label", { class: "campo" }, "Soglia nomi simili (0-1)", sSimili),
          el("label", { class: "campo" }, "Soglia gruppi di entità (0-1)", sGruppi),
          el("label", { class: "campo" }, "Regola ON DELETE delle chiavi esterne", onDelete),
          el("label", { class: "campo" }, "Regola ON UPDATE delle chiavi esterne", onUpdate)),
        el("label", { class: "campo" }, "Colonne generiche, da non usare per i collegamenti (separate da virgola)", generiche),
        el("br"),
        el("label", { class: "campo" }, "Parole tecniche nei nomi delle tabelle, che non indicano un'entità", parole),
        el("br"),
        el("label", { class: "campo" }, "Sinonimi: un gruppo per riga, parole separate da = (per esempio comune = citta). " +
          "Le parole dello stesso gruppo indicano la stessa entità per i collegamenti, i gruppi e Togli entità. " +
          "Plurali (italiano e inglese) e accenti sono già riconosciuti da soli.", sinonimi),
        el("br"),
        el("button", { class: "primario", onclick: async () => {
          await conAttesa(async () => {
            stato = await api("/api/impostazioni", {
              dialetto: dialetto.value, soglia_simili: Number(sSimili.value), soglia_gruppi: Number(sGruppi.value),
              generiche: elenco(generiche), parole_non_entita: elenco(parole),
              on_delete: onDelete.value, on_update: onUpdate.value,
              sinonimi: sinonimi.value.split("\n").map(x => x.trim()).filter(x => x.includes("=")),
            });
            avviso(stato.caricato ? "Impostazioni applicate: analisi rifatta." : "Impostazioni salvate.");
            aggiornaRiepilogo();
          });
        } }, "Applica")),
      el("p", { class: "tenue" }, stato.sqlglot ? "Lettura SQL: sqlglot e parser interno." : "sqlglot non installato: viene usato solo il parser interno."),
    ];
  },
};

// ======================================================================= schemi grafici

/** Albero area -> sottogruppo -> tabelle con la loro categoria. */
function alberoAree(aree, alClicSottogruppo) {
  const righe = d => d.righe.map(r => Object.fromEntries(d.colonne.map((n, i) => [n, r[i]])));
  const elencoAree = righe(aree.aree), sottogruppi = righe(aree.sottogruppi);
  const info = Object.fromEntries(righe(aree.tabelle).map(t => [t.tabella, t]));
  const aperte = elencoAree.length <= 12;
  const legenda = el("div", { class: "legenda" }, Object.entries(aree.categorie).map(([c, testo]) =>
    el("span", { title: testo }, el("span", { class: `cat cat-${c}` }, c))),
    el("span", {}, el("b", {}, "*"), " tabella centrale"));
  return el("div", { class: "pannello" },
    el("h3", {}, `${elencoAree.length} aree, ${sottogruppi.length} sottogruppi` +
      (aree.centrali.length ? ` · tabelle centrali: ${aree.centrali.join(", ")}` : "")),
    legenda,
    elencoAree.map(a => el("details", { class: "area", open: aperte ? "" : null },
      el("summary", {}, el("b", {}, `Area ${a.area}`),
        el("span", { class: "tenue" }, ` · ${a.n_sottogruppi} sottogruppi, ${a.n_tabelle} tabelle` +
          (a["collegata a"] !== "-" ? ` · collegata a: ${a["collegata a"]}` : ""))),
      el("div", { class: "riga-comandi" },
        el("button", { onclick: () => { filtroER = `a:${a.area}`; mostraSchema("collegamenti", "er"); } }, "Diagramma dell'area")),
      sottogruppi.filter(g => g.area === a.area).map(g => el("div", { class: "sottogruppo" },
        el("a", { href: "#", title: "Dettagli e Togli/Rimetti", onclick: e => { e.preventDefault(); alClicSottogruppo(g.sottogruppo); } },
          g.sottogruppo),
        ": ",
        g.tabelle.split(", ").filter(t => info[t]).map((t, i) => [i ? ", " : "", t,
          info[t].centrale ? el("b", { title: "tabella centrale" }, "*") : null, " ",
          el("span", { class: `cat cat-${info[t].categoria}`, title: info[t]["perché"] }, info[t].categoria)]))))));
}

let filtroER = "";             // "a:area" o "g:gruppo" scelto nel diagramma
let coloraER = "gruppo";       // colore delle tabelle: per gruppo o per area
let ultimoSchema = "iniziale";
let vistaSchema = "er";
let erMedie = false;

function mostraSchema(quale, modo) {
  ultimoSchema = quale;
  if (modo) vistaSchema = modo;
  mostra("schemi");
}

async function contenutoSchema(quale) {
  return vistaSchema === "er" ? contenutoER(quale) : contenutoGrafo(quale);
}

/** Diagramma ER in stile DBeaver: tabelle con le colonne e linee tra le colonne. */
async function contenutoER(quale) {
  const dati = await api(`/api/diagramma?tipo=${quale}&medie=${erMedie ? 1 : 0}`);
  const gruppi = [...new Set(dati.tabelle.map(t => t.gruppo))].sort();
  const areeER = [...new Set(dati.tabelle.map(t => t.area).filter(Boolean))].sort();
  const cornice = el("div", { class: "er-cornice" });
  const info = el("span", { class: "tenue" });
  const sceltaGruppo = el("select", { "aria-label": "Area o gruppo" }, el("option", { value: "" }, "tutte le tabelle"),
    areeER.length ? el("optgroup", { label: "Aree" }, areeER.map(a => el("option", { value: `a:${a}` }, `area ${a}`))) : null,
    el("optgroup", { label: "Gruppi" }, gruppi.map(g => el("option", { value: `g:${g}` }, `gruppo ${g}`))));
  if ([...sceltaGruppo.options].some(o => o.value === filtroER)) sceltaGruppo.value = filtroER;
  const sceltaColore = el("select", { "aria-label": "Colore delle tabelle" },
    el("option", { value: "gruppo" }, "colore per gruppo"), el("option", { value: "area" }, "colore per area"),
    el("option", { value: "categoria" }, "colore per categoria"));
  sceltaColore.value = coloraER;
  const ricerca = el("input", { type: "text", placeholder: "cerca una tabella", "aria-label": "Cerca una tabella" });
  const conTipi = el("input", { type: "checkbox", checked: true });
  const medie = el("input", { type: "checkbox", checked: erMedie && quale === "collegamenti", title: "Aggiunge le FK trovate ad affidabilità media (passa a FK dichiarate e trovate)" });
  let diagramma = null;

  function disegna() {
    let tabelle = dati.tabelle, collegamenti = dati.collegamenti;
    if (sceltaGruppo.value) {
      // l'area o il gruppo scelto più le tabelle direttamente collegate
      const [genere, valore] = [sceltaGruppo.value.slice(0, 1), sceltaGruppo.value.slice(2)];
      const nomi = new Set(tabelle.filter(t => (genere === "a" ? t.area : t.gruppo) === valore).map(t => t.nome));
      collegamenti.forEach(l => { if (nomi.has(l.da) || nomi.has(l.a)) { nomi.add(l.da); nomi.add(l.a); } });
      tabelle = tabelle.filter(t => nomi.has(t.nome));
      collegamenti = collegamenti.filter(l => nomi.has(l.da) && nomi.has(l.a));
    }
    if (collegamenti.length > 3000) {
      cornice.replaceChildren(el("div", { class: "messaggio" },
        `${collegamenti.length} collegamenti sono troppi per un diagramma leggibile: scegli un gruppo o togli qualche entità.`));
      diagramma = null;
      return;
    }
    diagramma = DiagrammaER.crea(cornice, { tabelle, collegamenti }, {
      tipi: conTipi.checked,
      coloraPer: coloraER,
      posizioni: layoutER[quale],
      onSposta: (nome, x, y) => { layoutER[quale][nome] = [x, y]; },
    });
    info.textContent = `${diagramma.numeri.tabelle} tabelle, ${diagramma.numeri.collegamenti} collegamenti`;
  }

  sceltaGruppo.addEventListener("change", () => { filtroER = sceltaGruppo.value; disegna(); });
  sceltaColore.addEventListener("change", () => { coloraER = sceltaColore.value; disegna(); });
  conTipi.addEventListener("change", disegna);
  medie.addEventListener("change", () => { erMedie = medie.checked; mostraSchema(medie.checked ? "collegamenti" : quale, "er"); });
  ricerca.addEventListener("keydown", e => {
    if (e.key === "Enter" && diagramma) {
      const n = diagramma.cerca(ricerca.value);
      if (!n) avviso(`Nessuna tabella contiene "${ricerca.value}".`, true);
    }
  });
  const scarica = () => {
    if (!diagramma) return;
    const url = URL.createObjectURL(new Blob([diagramma.esporta()], { type: "image/svg+xml" }));
    el("a", { href: url, download: `diagramma_${quale}.svg` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const scheda = (q, testo) => el("button", { class: q === quale ? "primario" : null, onclick: () => mostraSchema(q, "er") }, testo);
  setTimeout(disegna, 0);
  return [
    el("h2", {}, "Diagramma delle tabelle"),
    el("div", { class: "riga-comandi" },
      scheda("iniziale", "Solo FK dichiarate"),
      scheda("collegamenti", "FK dichiarate e trovate"),
      el("label", {}, medie, "anche affidabilità media"),
      el("button", { onclick: () => mostraSchema(quale, "grafo") }, "Vista a grafo")),
    el("div", { class: "riga-comandi" },
      sceltaGruppo, sceltaColore, ricerca,
      el("label", {}, conTipi, "mostra i tipi"),
      el("button", { onclick: () => diagramma && diagramma.zoom(1.25), title: "Ingrandisci" }, "+"),
      el("button", { onclick: () => diagramma && diagramma.zoom(0.8), title: "Rimpicciolisci" }, "-"),
      el("button", { onclick: () => diagramma && diagramma.adatta() }, "Adatta alla finestra"),
      el("button", { title: "Dimentica gli spostamenti fatti a mano", onclick: () => { layoutER[quale] = {}; disegna(); } }, "Disposizione automatica"),
      el("button", { onclick: scarica }, "Scarica SVG"),
      el("button", { onclick: () => diagramma && conAttesa(async () => scaricaBlob(await diagramma.png(), `diagramma_${quale}.png`)) }, "Scarica PNG"),
      info),
    el("div", { class: "legenda" },
      el("span", {}, el("b", {}, "PK"), " chiave primaria · ", el("b", {}, "FK"), " chiave esterna · ", el("b", {}, "UQ"), " unique"),
      el("span", {}, el("span", { class: "campione", style: "border-color:#1f4e79" }), "FK dichiarata"),
      quale === "collegamenti" ? el("span", {}, el("span", { class: "campione", style: "border-color:#2e7d32" }), "FK trovata (alta)") : null,
      quale === "collegamenti" && erMedie ? el("span", {}, el("span", { class: "campione tratteggio", style: "border-color:#c25e00" }), "FK trovata (media)") : null,
      el("span", {}, "1 / N: cardinalità · trascina le tabelle, rotellina per lo zoom, passa il mouse per evidenziare i collegamenti")),
    stato.rimosse.length ? el("div", { class: "messaggio" },
      `Le ${stato.rimosse.length} tabelle tolte non compaiono. Si rimettono da Togli entità.`) : null,
    cornice,
  ];
}

function contenutoGrafo(quale) {
  const url = `/api/schema_${quale}?t=${Date.now()}`;
  const scheda = (q, testo) => el("button", { class: q === quale ? "primario" : null, onclick: () => mostraSchema(q) }, testo);
  return [
    el("h2", {}, "Schemi grafici"),
    el("div", { class: "riga-comandi" },
      scheda("iniziale", "Schema iniziale (gruppi e FK dichiarate)"),
      scheda("collegamenti", "Collegamenti trovati (FK candidate)"),
      el("button", { onclick: () => mostraSchema(quale, "er") }, "Diagramma delle tabelle"),
      el("button", { onclick: () => window.open(url, "_blank") }, "Apri in una finestra a parte")),
    stato.rimosse.length ? el("div", { class: "messaggio" },
      `Le ${stato.rimosse.length} tabelle tolte non compaiono nello schema. Si rimettono da Togli entità.`) : null,
    el("p", { class: "tenue" }, quale === "iniziale"
      ? "Ogni casella è una tabella, colorata in base al suo gruppo; linee grigie tratteggiate = stesso gruppo, frecce blu = chiavi esterne dichiarate. Passa il mouse su una casella per vedere le colonne ([PK] = chiave primaria)."
      : "Frecce verdi = affidabilità alta, arancioni tratteggiate = media, caselle grigie = tabelle isolate. Si possono trascinare le caselle e fare zoom."),
    el("iframe", { class: "cornice-schema", src: url, title: "Schema grafico" }),
  ];
}

// ======================================================================= avvio

aggiornaTutto("panoramica").catch(e => avviso(e.message, true));
