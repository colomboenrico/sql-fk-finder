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
let testoQuery = "";
let ricercaTogli = "";           // la ricerca della pagina Togli entità resta dopo aver tolto delle tabelle             // il testo dell'editor delle query resta quando si cambia pagina
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

const pausa = ms => new Promise(r => setTimeout(r, ms));

function formattaByte(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function formattaDurata(secondi) {
  if (secondi < 60) return `${Math.max(1, Math.round(secondi))} s`;
  if (secondi < 3600) return `${Math.round(secondi / 60)} min`;
  return `${Math.floor(secondi / 3600)} h ${Math.round((secondi % 3600) / 60)} min`;
}

/** Riquadro di attesa con un testo e, se serve, un pulsante (per esempio Interrompi). */
function mostraAttesa(testo, pulsante) {
  $("#attesa .riquadro-attesa").replaceChildren(...[el("div", {}, testo), pulsante || null].filter(Boolean));
  $("#attesa").hidden = false;
}

/** Segue un lavoro in background (lettura di file grandi, costruzione del database) con l'avanzamento. */
async function seguiLavoro(titolo) {
  const testo = el("div", { class: "tenue" }, "avvio...");
  const piena = el("div", { class: "barra-piena" });
  const ferma = el("button", { onclick: () => { ferma.disabled = true; api("/api/lavoro/ferma", {}); } }, "Interrompi");
  $("#attesa .riquadro-attesa").replaceChildren(el("div", {}, titolo), el("div", { class: "barra" }, piena), testo, ferma);
  $("#attesa").hidden = false;
  let lavoro = null;
  try {
    while (true) {
      lavoro = (await api("/api/lavoro")).lavoro;
      if (!lavoro) break;
      piena.style.width = `${lavoro.percentuale}%`;
      const parti = [];
      if (lavoro.unita === "passi" && lavoro.fase !== "inizio") parti.push(lavoro.fase);
      if (lavoro.totale) parti.push(lavoro.unita === "passi" ? `${lavoro.percentuale}% · ${lavoro.letti} di ${lavoro.totale}`
        : `${lavoro.percentuale}% · ${formattaByte(lavoro.letti)} di ${formattaByte(lavoro.totale)}`);
      if (lavoro.file) parti.push(lavoro.file);
      if (lavoro.fase === "analisi") parti.push("analisi della struttura...");
      if (lavoro.restano !== null && lavoro.fase !== "analisi") parti.push(`circa ${formattaDurata(lavoro.restano)} alla fine`);
      testo.textContent = parti.join(" · ") || "avvio...";
      if (lavoro.finito) break;
      await pausa(600);
    }
  } finally {
    $("#attesa").hidden = true;
  }
  if (lavoro && lavoro.errore) throw new Error(lavoro.errore);
  return lavoro;
}

/** Esegue un'operazione lunga mostrando "Analisi in corso" e gli eventuali errori. */
async function conAttesa(funzione) {
  mostraAttesa("Analisi in corso...");
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

/** Salvare il database senza le tabelle tolte in un nuovo file .sql (con il nome scelto): i file originali non cambiano. */
function salvaSenzaTolte() {
  const base = String(stato.origine || "database").split(/[\\/]/).pop().replace(/^cartella /, "").replace(/\.sql$/i, "") || "database";
  const nome = el("input", { type: "text", class: "largo", value: `${base}_senza_tolte.sql`, "aria-label": "Nome del nuovo file" });
  return el("div", { class: "pannello" },
    el("h3", { class: "titolo-file" }, "Salva il database senza le tabelle tolte"),
    el("p", { class: "tenue" }, "Un nuovo file .sql uguale a quelli letti (struttura, dati, indici, procedure) ma senza le tabelle tolte e senza le chiavi " +
      "esterne che puntano a loro. I file originali non vengono toccati: scegli un nome diverso." +
      (window.sqlfkApp ? " Nell'app si apre la finestra per scegliere anche la cartella." : "")),
    el("div", { class: "riga-comandi" }, nome,
      el("button", { class: "primario", disabled: !stato.rimosse.length, onclick: () => {
        let n = nome.value.trim() || `${base}_senza_tolte.sql`;
        if (!/\.sql$/i.test(n)) n += ".sql";
        el("a", { href: `/api/scarica/sql_senza_tolte?nome=${encodeURIComponent(n)}`, download: n }).click();
      } }, stato.rimosse.length ? `Salva senza le ${stato.rimosse.length} tabelle tolte` : "Togli prima delle tabelle")));
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

const LIMITE_BROWSER = 64 * 1024 * 1024;     // oltre, il file si legge dal disco (percorso), non dal browser

/** Fa leggere al server file o cartelle dal disco, in background (anche file da decine di GB). */
async function caricaDaServer(percorso, dati) {
  try {
    await api(percorso, dati);
    const lavoro = await seguiLavoro("Lettura dei file");
    await conAttesa(async () => {
      stato = await api("/api/stato");
      layoutER = { iniziale: {}, collegamenti: {} };
      const grandi = stato.file_ridotti && stato.file_ridotti.length;
      avviso(`Letti ${formattaByte(lavoro?.totale || stato.dimensione_file || 0)} in ${formattaDurata(lavoro?.secondi || 1)}` +
        (grandi ? ": dei file grandi è stata letta la struttura, i dati si usano nella pagina Query." : "."));
      aggiornaTutto("panoramica");
    });
  } catch (e) {
    avviso(e.message, true);
  }
}

async function leggiFile(lista, origine) {
  const file = [...lista].filter(f => f.name.toLowerCase().endsWith(".sql"));
  if (!file.length) { avviso("Nessun file .sql tra quelli scelti.", true); return; }
  // nell'app si passano i percorsi: il server legge i file dal disco, di qualsiasi dimensione
  const percorsi = window.sqlfkApp ? file.map(f => window.sqlfkApp.percorso(f)).filter(Boolean) : [];
  if (percorsi.length === file.length) {
    const relativo = file[0].webkitRelativePath;
    const cartella = relativo ? percorsi[0].slice(0, percorsi[0].length - relativo.length) + relativo.split("/")[0] : null;
    return caricaDaServer("/api/carica_percorsi", { percorsi, origine: cartella || (percorsi.length === 1 ? percorsi[0] : origine) });
  }
  const grandi = file.filter(f => f.size > LIMITE_BROWSER);
  if (grandi.length) {
    avviso(`${grandi.map(f => `${f.name} (${formattaByte(f.size)})`).join(", ")}: troppo grande per il caricamento dal browser. ` +
      "Scrivi il percorso del file o della cartella nel campo in alto e premi Apri, oppure usa l'app (avvia_app).", true);
    return;
  }
  await conAttesa(async () => {
    const contenuti = await Promise.all(file.map(async f => ({ nome: f.name, testo: await f.text() })));
    stato = await api("/api/carica_file", { file: contenuti, origine });
    layoutER = { iniziale: {}, collegamenti: {} };
    avviso(`Caricati ${file.length} file .sql.`);
    aggiornaTutto("panoramica");
  });
}

/** Nel browser (senza percorsi su disco) le pagine File e File XML usano i file scelti; nell'app li legge il server. */
function ricordaFileScelti(lista) {
  const conPercorso = window.sqlfkApp && lista.length && window.sqlfkApp.percorso(lista[0]);
  fileLocaliCaricati = conPercorso || !lista.length ? null : [...lista];
  fileLocali = fileLocaliCaricati;
  usaLocali = !!fileLocali;
  fileAperto = xmlAperto = null;
}

$("#in-cartella").addEventListener("change", e => {
  const lista = e.target.files;
  ricordaFileScelti(lista);
  const cartella = lista.length ? (lista[0].webkitRelativePath || "").split("/")[0] : "";
  leggiFile(lista, cartella ? `cartella ${cartella}` : null);
  e.target.value = "";
});

$("#in-file").addEventListener("change", e => {
  ricordaFileScelti(e.target.files);
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
  progetto.lavagna = STATO_LAVAGNA.modello;
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
    layoutER = { ...l, iniziale: l.iniziale || {}, collegamenti: l.collegamenti || {} };
    modelloEditor = progetto.editor && progetto.editor.entita ? progetto.editor : Editor.nuovoModello();
    selezioneEditor = null; vistaEditor = null;
    STATO_LAVAGNA.modello = progetto.lavagna ? leggiLavagna(JSON.stringify({ formato: FORMATO_LAVAGNA, modello: progetto.lavagna })) : Editor.nuovoModello();
    STATO_LAVAGNA.selezione = STATO_LAVAGNA.vista = null;
    regoleCache = null;
    avviso(`Progetto ${file.name} aperto: ${stato.tabelle_totali} tabelle, ${stato.rimosse.length} tolte.`);
    aggiornaTutto("panoramica");
  });
});

$("#form-percorso").addEventListener("submit", async e => {
  e.preventDefault();
  const cartella = $("#percorso").value.trim();
  if (!cartella) return;
  ricordaFileScelti([]);
  await caricaDaServer("/api/carica_cartella", { cartella });
});

// ======================================================================= navigazione

document.querySelectorAll("#menu button[data-vista]").forEach(b => b.addEventListener("click", () => mostra(b.dataset.vista)));

// barra a schede in stile Word: ogni scheda è una funzionalità con i suoi gruppi di pulsanti
const ICONE = {
  cartella: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6",
  apri: "M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 7v10a2 2 0 0 0 2 2h12l3-8H7l-3 8",
  salva: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
  panoramica: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  problemi: "M12 3l9 16H3zM12 10v4M12 17v.5",
  guida: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17v.5",
  tabella: "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14",
  chiave: "M14 10a4 4 0 1 0-1.2 2.8L20 20M17 17l2-2M15 15l2-2",
  collegamento: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  clingo: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  verifica: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6",
  qualita: "M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6zM9 12l2 2 4-4",
  regole: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10M9 8h5",
  altri: "M5 12h.5M12 12h.5M19 12h.5",
  gruppi: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  togli: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8",
  reverse: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5M8 11h6M11 8v6",
  crud: "M4 6h16M4 12h16M4 18h10M18 16l2 2 3-4",
  interfaccia: "M3 4h18v12H3zM8 20h8M12 16v4",
  cartellafile: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM14 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM15.5 14.5l2 2",
  xml: "M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16",
  schemi: "M3 4h7v6H3zM14 14h7v6h-7zM14 4h7v6h-7zM10 7h4M17.5 10v4",
  modello: "M3 4h8v16H3zM13 4h8v7h-8zM13 13h8v7h-8zM5 8h4M15 8h4",
  editor: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  lavagna: "M3 4h8v16H3zM13 4h8v16h-8zM15 9h4M15 13h3",
  dati: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  peso: "M5 20V10M10 20V4M15 20v-7M20 20v-4M3 20h19",
  query: "M4 5h16v14H4zM7 10l3 2-3 2M12 15h5",
  codice: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  ontologia: "M12 5a2 2 0 1 0 0-.1M5 18a2 2 0 1 0 0-.1M19 18a2 2 0 1 0 0-.1M11 7l-5 9M13 7l5 9M7 18h10",
  esporta: "M12 4v11M7 10l5 5 5-5M5 20h14",
  impostazioni: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.5-1.6.3-2-3-1-1 2h-2l-1-2-3 1 .3 2L5.3 8.3 3.3 8l-1 3 2 1v1.5l-2 1 1 3 2-.3 1.5 1.6-.3 2 3 1 1-2h2l1 2 3-1-.3-2 1.6-1.5 2 .3 1-3-2-1z",
};
document.querySelectorAll("[data-icona]").forEach(b => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icona");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONE[b.dataset.icona] || ICONE.altri);
  svg.append(path);
  b.prepend(svg);
});
let schedaNastro = "home";
function mostraScheda(id) {
  schedaNastro = id;
  document.querySelectorAll(".scheda-nastro").forEach(b => {
    b.classList.toggle("attiva", b.dataset.scheda === id);
    b.setAttribute("aria-selected", b.dataset.scheda === id ? "true" : "false");
  });
  document.querySelectorAll(".pannello-nastro").forEach(p => { p.hidden = p.dataset.scheda !== id; });
}
// barra richiudibile (come "Comprimi barra multifunzione" di Word): restano solo le schede; cliccandone una i pulsanti
// scendono sopra la pagina e si richiudono scegliendo un comando, cliccando fuori o con Esc
let nastroCompresso = false;
try { nastroCompresso = localStorage.getItem("sqlfk-nastro-compresso") === "1"; } catch { /* senza memoria del browser */ }
const nastroAperto = aperto => document.body.classList.toggle("nastro-aperto", aperto && nastroCompresso);
function comprimiNastro(compresso) {
  nastroCompresso = compresso;
  try { localStorage.setItem("sqlfk-nastro-compresso", compresso ? "1" : "0"); } catch { /* niente */ }
  document.body.classList.toggle("nastro-compresso", compresso);
  nastroAperto(false);
  const pulsante = $("#comprimi-nastro");
  pulsante.textContent = compresso ? "Mostra pulsanti ▾" : "Nascondi pulsanti ▴";
  pulsante.title = compresso ? "Mostra sempre i pulsanti (Ctrl+F1)" : "Nascondi i pulsanti e lascia solo le schede (Ctrl+F1)";
  pulsante.setAttribute("aria-expanded", compresso ? "false" : "true");
}
document.querySelectorAll(".scheda-nastro").forEach(b => {
  b.addEventListener("click", () => {
    const giaAperta = document.body.classList.contains("nastro-aperto") && schedaNastro === b.dataset.scheda;
    mostraScheda(b.dataset.scheda);
    nastroAperto(!giaAperta);
  });
  b.addEventListener("dblclick", () => comprimiNastro(!nastroCompresso));      // doppio clic su una scheda, come in Word
});
$("#comprimi-nastro").addEventListener("click", () => comprimiNastro(!nastroCompresso));
$("#menu").addEventListener("click", e => { if (e.target.closest("button[data-vista]")) nastroAperto(false); });
$("#menu").addEventListener("change", () => nastroAperto(false));            // file scelto con Carica
document.addEventListener("click", e => { if (!e.target.closest(".testata")) nastroAperto(false); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") nastroAperto(false);
  if (e.key === "F1" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); comprimiNastro(!nastroCompresso); }
});
mostraScheda("home");
comprimiNastro(nastroCompresso);

function aggiornaMenu() {
  $("#salva-progetto").disabled = !stato.caricato;
  document.querySelectorAll("#menu button[data-vista]").forEach(b => {
    b.classList.toggle("attiva", b.dataset.vista === vistaAttuale);
    b.disabled = b.hasAttribute("data-serve-dati") && !stato.caricato;
  });
  // la scheda della barra segue la pagina aperta (se la pagina non è già nella scheda visibile)
  const nellaScheda = $(`.pannello-nastro[data-scheda="${schedaNastro}"] button[data-vista="${vistaAttuale}"]`);
  const pulsante = $(`#menu button[data-vista="${vistaAttuale}"]:not([data-doppio])`);
  if (!nellaScheda && pulsante) mostraScheda(pulsante.closest(".pannello-nastro").dataset.scheda);
}

function aggiornaRiepilogo() {
  $("#origine").textContent = stato.caricato ? stato.origine : "";
  const iconaProblemi = $("#voce-problemi .icona");          // l'icona della barra resta
  if (!stato.caricato) { $("#voce-problemi").replaceChildren(iconaProblemi, "Problemi"); $("#riepilogo").textContent = "Nessun file caricato."; return; }
  const n = (valore, testo) => [el("b", {}, valore), ` ${testo}`];
  const p = stato.problemi;
  $("#voce-problemi").replaceChildren(iconaProblemi, el("span", {}, "Problemi",
    p.errore ? el("span", { class: "contatore", title: "errori" }, p.errore) : null,
    p.avviso ? el("span", { class: "contatore giallo", title: "avvisi" }, p.avviso) : null));
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

const STATI_RELAZIONE = {
  confermata: ["confermata", "#2e7d32", "prevista dall'analisi e confermata dal programma"],
  dichiarata: ["dichiarata", "#1f4e79", "già chiave esterna nel database"],
  mancata: ["mancata", "#c62828", "il programma la usa ma l'analisi non l'aveva prevista"],
  debole: ["indizio debole", "#8a94a3", "solo un nome simile: da verificare"],
};

/** Risultati della verifica con l'interfaccia: sintesi, mappa, racconto, dettagli e rapporto da scaricare. */
function mostraAnalisiInterfaccia(V, dove) {
  const S = V.spiegazione, M = V.mappa;
  const cornice = el("div", { class: "er-cornice", style: "height: 520px" });
  let diagramma = null;
  const tabelle = M.classi.map(c => ({
    nome: c.tabella, titolo: c.classe ? `${c.classe}  ·  ${c.tabella}` : `${c.tabella} (solo nel database)`,
    gruppo: c.schermate[0] || "database", pk_indovinata: false,
    colonne: (c.attributi.length ? c.attributi : c.pk.map(p => ({ nome: p, colonna: p }))).map(a => ({
      nome: a.colonna !== "-" ? a.colonna : `(${a.nome})`, tipo: a.colonna !== "-" && a.nome !== a.colonna ? a.nome : "",
      pk: c.pk.includes(a.colonna), fk: M.relazioni.some(r => r.da === c.tabella && r.colonna === a.colonna), unique: false, not_null: false })),
  }));
  const collegamenti = M.relazioni.map(r => ({
    da: r.da, colonne_da: r.colonna ? [r.colonna] : [], a: r.a, colonne_a: r.verso, tipo: r.stato,
    relazione: r.come === "elenco nella scheda" && !r.colonna ? "N:M" : "1:N", obbligatoria: false,
    descrizione: `${STATI_RELAZIONE[r.stato][0]}: ${STATI_RELAZIONE[r.stato][2]} (visto in ${r.schermata})` }));
  setTimeout(() => {
    diagramma = DiagrammaER.crea(cornice, { tabelle, collegamenti }, { tipi: true });
  }, 0);

  const etichetta = stato => el("span", { class: "stato-rel", style: `background:${STATI_RELAZIONE[stato][1]}` }, STATI_RELAZIONE[stato][0]);
  const racconto = el("div", {}, S.schermate.map(sch => el("div", { class: "schermata" },
    el("h4", {}, sch.nome),
    el("ul", {}, sch.frasi.map(f => el("li", {}, etichetta(f.stato), " ", f.testo, f.sql ? el("pre", {}, f.sql) : null))))),
    S.non_viste.length ? el("div", { class: "schermata" }, el("h4", {}, "Previste ma non mostrate dal programma"),
      el("p", { class: "tenue" }, "Le due tabelle si vedono nel programma, ma nessuna schermata mostra il collegamento: forse non esiste, o si vede in una schermata non letta."),
      el("ul", {}, S.non_viste.map(t => el("li", {}, t)))) : null);

  function rapportoHtml() {
    const svg = diagramma ? diagramma.esporta() : "";
    const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const tab = d => `<table><tr>${d.colonne.map(c => `<th>${esc(c)}</th>`).join("")}</tr>` +
      d.righe.map(r => `<tr>${r.map(v => `<td>${esc(v ?? "")}</td>`).join("")}</tr>`).join("") + "</table>";
    const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Rapporto: come comunicano le parti del programma</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:32px;color:#1d2330;max-width:1200px}
h1{font-size:24px}h2{margin-top:32px;border-bottom:1px solid #dde1e7;padding-bottom:4px}li{margin:6px 0;line-height:1.5}
.s{display:inline-block;color:#fff;border-radius:8px;padding:0 7px;font-size:12px;font-weight:600}pre{background:#f5f6f8;padding:8px;border-radius:6px}
table{border-collapse:collapse;font-size:12px;margin:8px 0}td,th{border:1px solid #dde1e7;padding:3px 6px;text-align:left}th{background:#f5f6f8}
.mappa svg{max-width:100%;height:auto;border:1px solid #dde1e7}</style></head><body>
<h1>Come comunicano le parti del programma</h1><p>${esc(S.sintesi)}</p>
<h2>Mappa</h2><p>${Object.values(STATI_RELAZIONE).map(([n, c, d]) => `<span class="s" style="background:${c}">${n}</span> ${esc(d)}`).join(" &nbsp; ")}</p>
<div class="mappa">${svg}</div>
<h2>Schermata per schermata</h2>${S.schermate.map(sch => `<h3>${esc(sch.nome)}</h3><ul>${sch.frasi.map(f =>
  `<li><span class="s" style="background:${STATI_RELAZIONE[f.stato][1]}">${STATI_RELAZIONE[f.stato][0]}</span> ${esc(f.testo)}${f.sql ? `<pre>${esc(f.sql)}</pre>` : ""}</li>`).join("")}</ul>`).join("")}
${S.non_viste.length ? `<h3>Previste ma non mostrate dal programma</h3><ul>${S.non_viste.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
<h2>Precisione e richiamo</h2>${tab(V.numeri)}<h2>Classi</h2>${tab(V.classi)}<h2>Relazioni</h2>${tab(V.relazioni)}
<h2>Previsioni</h2>${tab(V.previsioni)}<h2>Attributi</h2>${tab(V.attributi)}
<p style="color:#5f6b7a;font-size:12px">Creato da SQL FK Finder il ${new Date().toLocaleString("it-IT")}.</p></body></html>`;
    return html;
  }

  function rapportoTesto() {
    const righe = d => d.righe.map(r => "  " + d.colonne.map((c, i) => `${c}: ${r[i] ?? ""}`).join(" | "));
    return [
      "COME COMUNICANO LE PARTI DEL PROGRAMMA", `(SQL FK Finder, ${new Date().toLocaleString("it-IT")})`, "",
      S.sintesi, "",
      ...S.schermate.flatMap(sch => [`== ${sch.nome}`, ...sch.frasi.flatMap(f => [`- [${STATI_RELAZIONE[f.stato][0]}] ${f.testo}`,
        ...(f.sql ? [`    ${f.sql}`] : [])]), ""]),
      ...(S.non_viste.length ? ["== Previste ma non mostrate dal programma", ...S.non_viste.map(t => `- ${t}`), ""] : []),
      "== Precisione e richiamo", ...righe(V.numeri), "",
      "== Classi e tabelle", ...righe(V.classi), "",
    ].join("\n") + "\n";
  }

  function rapporto() {
    scaricaBlob(new Blob([rapportoHtml()], { type: "text/html;charset=utf-8" }), "rapporto_programma.html");
  }

  const esito = (colonna, valore) => colonna !== "esito" ? null :
    String(valore).startsWith("mancata") || valore === "non vista nell'interfaccia" ? "errore-g" :
    String(valore).startsWith("confermata") || String(valore).startsWith("prevista") || String(valore).startsWith("N:M") ? "ok-g" : null;
  dove.replaceChildren(
    el("div", { class: "sintesi" }, S.sintesi),
    el("div", { class: "riga-comandi" },
      el("button", { class: "primario", onclick: rapporto }, "Scarica il rapporto (HTML)"),
      el("a", { class: "pulsante", href: "/api/scarica/interfaccia" }, "Scarica i dettagli in Excel")),
    el("h3", {}, "Mappa del programma"),
    el("div", { class: "legenda" }, Object.keys(STATI_RELAZIONE).map(k => el("span", {}, etichetta(k), " ", STATI_RELAZIONE[k][2])),
      el("span", {}, "Ogni riquadro è un'entità del programma con la sua tabella; le righe sono gli attributi con la colonna collegata.")),
    cornice,
    el("h3", {}, "Come comunicano le parti, schermata per schermata"),
    racconto,
    el("h3", {}, "Dettagli"),
    griglia(V.numeri, { titolo: "Precisione e richiamo" }),
    griglia(V.relazioni, { titolo: "Relazioni mostrate dal programma", classiCella: esito }),
    griglia(V.previsioni, { titolo: "Chiavi esterne previste: cosa dice il programma", classiCella: esito }),
    griglia(V.classi, { titolo: "Classi e tabelle" }),
    griglia(V.attributi, { titolo: "Attributi e colonne" }));
  return { html: rapportoHtml, testo: rapportoTesto, pronto: () => !!diagramma };
}

/** Il risultato del controllo dell'app, voce per voce. */
function risultatoControllo(r) {
  const colori = { ok: "#2e7d32", errore: "#c62828", info: "#5f6b7a" };
  return el("div", {},
    el("div", { class: r.errori ? "messaggio errore" : "messaggio" }, r.errori ? `${r.errori} problemi trovati.` : "Tutto a posto."),
    el("ul", { class: "controlli" }, r.controlli.map(c => el("li", {},
      el("span", { class: "stato-rel", style: `background:${colori[c.esito] || colori.info}` }, c.esito === "ok" ? "OK" : c.esito.toUpperCase()),
      " ", el("b", {}, c.voce), `: ${c.dettaglio}`))),
    r.file ? el("p", { class: "tenue" }, `Salvato in ${r.file} `,
      el("button", { onclick: () => window.sqlfkApp.apriCartella(r.file.replace(/[\\/][^\\/]+$/, "")) }, "Apri la cartella")) : null);
}

if (window.sqlfkApp && window.sqlfkApp.alControllo) {
  // al primo avvio l'app si controlla da sola e dice com'è andata
  window.sqlfkApp.alControllo(r => {
    avviso(r.errori ? `Controllo dell'app: ${r.errori} problemi. Dettagli in Impostazioni, Controllo dell'app.`
      : "Controllo dell'app al primo avvio: tutto a posto, e nessuna connessione di rete.", !!r.errori);
  });
}

/** Pagina Query quando i dati sono tanti: il database su disco va costruito (una volta sola). */
function paginaDatabaseDaCostruire(info) {
  const velocita = ["mysql", "mariadb", "tsql"].includes(info.dialetto) ? 15e6 : 35e6;      // byte al secondo, circa
  const stima = info.dimensione / velocita;
  const spazio = info.dimensione * 1.2;
  const poco = info.libero < spazio;
  async function costruisci() {
    try {
      if (!info.in_costruzione) await api("/api/query/costruisci", {});
      await seguiLavoro("Costruzione del database delle query");
      avviso("Database pronto.");
    } catch (e) {
      avviso(e.message, true);
    }
    mostra("query");
  }
  if (info.in_costruzione) setTimeout(costruisci, 0);
  return [
    el("h2", {}, "Query sui dati"),
    el("div", { class: "pannello" },
      el("p", {}, `I file contengono ${formattaByte(info.dimensione)} di dati: per interrogarli si costruisce un database SQLite su disco, ` +
        "leggendo i file a blocchi (non serve tutta quella memoria)."),
      el("p", {}, `Si fa una volta sola: le volte dopo, con gli stessi file, si riapre subito. Tempo stimato: circa ${formattaDurata(stima)}. ` +
        `Spazio su disco: circa ${formattaByte(spazio)} in ${info.cartella_cache} (liberi ${formattaByte(info.libero)}).`),
      poco ? el("div", { class: "messaggio errore" },
        "Lo spazio libero non basta: libera spazio, oppure avvia l'app con la variabile SQLFK_CACHE impostata a una cartella su un altro disco.") : null,
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", disabled: poco, onclick: costruisci }, info.in_costruzione ? "Costruzione in corso..." : "Costruisci il database")),
      el("p", { class: "tenue" }, "Puoi interrompere la costruzione in qualsiasi momento e riprenderla più tardi (ricomincia da capo).")),
  ];
}

/** Il dizionario dei dati (HTML da salvare): sintesi, filo logico e la scheda di ogni tabella. */
function dizionarioDati(D, origine) {
  const esc = t => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const ancora = t => "t-" + t.replace(/[^A-Za-z0-9_]/g, "_");
  const nomeTab = t => `<a href="#${ancora(t)}">${esc(t)}</a>`;
  const conLink = testo => esc(testo).replace(/«([^»]+)»/g, (m, t) => D.tabelle[t] ? `«${nomeTab(t)}»` : m);
  const schede = Object.values(D.tabelle).sort((a, b) => (a.area || "").localeCompare(b.area || "") || a.tabella.localeCompare(b.tabella));
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Dizionario dei dati</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:32px auto;max-width:1100px;color:#1d2330;line-height:1.5;padding:0 16px}
h1{font-size:26px}h2{margin-top:36px;border-bottom:2px solid #1f4e79;padding-bottom:4px}h3{margin:26px 0 4px}
.cat{display:inline-block;background:#e7eef6;color:#1f4e79;border-radius:8px;padding:0 8px;font-size:12px;font-weight:600}
table{border-collapse:collapse;font-size:13px;margin:8px 0}td,th{border:1px solid #dde1e7;padding:3px 8px;text-align:left}th{background:#f5f6f8}
.tenue{color:#5f6b7a}ol li{margin:4px 0}.scheda{border-left:3px solid #dde1e7;padding-left:14px}</style></head><body>
<h1>Dizionario dei dati</h1><p class="tenue">${esc(origine || "")} · creato da SQL FK Finder il ${new Date().toLocaleString("it-IT")}</p>
<p>${conLink(D.sintesi)}</p>
<h2>Il filo logico</h2>${D.filo.map(a => `<h3>Area ${esc(a.area)}</h3><p class="tenue">${conLink(a.introduzione)}</p><ol>${a.passi.map(p =>
  `<li>${nomeTab(p.tabella)} <span class="cat">${esc(p.categoria)}</span> ${conLink(p.frase)}</li>`).join("")}</ol>`).join("")}
<h2>Le tabelle</h2>${schede.map(t => `<div class="scheda" id="${ancora(t.tabella)}"><h3>${esc(t.tabella)} <span class="cat">${esc(t.categoria)}</span></h3>
<p class="tenue">${esc(t.nome)} · area ${esc(t.area || "-")} · gruppo ${esc(t.gruppo)}</p><p>${conLink(t.descrizione)}</p>
${t.padri.length ? `<p><b>Dipende da:</b> ${t.padri.map(p => `${nomeTab(p.tabella)} (${esc(p.colonne.join(", "))})`).join(", ")}</p>` : ""}
${t.figli.length ? `<p><b>Usata da:</b> ${t.figli.map(f => `${nomeTab(f.tabella)} (${esc(f.colonne.join(", "))})`).join(", ")}</p>` : ""}
<table><tr><th>colonna</th><th>tipo</th><th>ruolo</th><th>significato probabile</th></tr>${t.colonne.map(c =>
  `<tr><td>${esc(c.colonna)}</td><td>${esc(c.tipo)}</td><td>${esc(c.ruolo)}</td><td>${esc(c.significato)}</td></tr>`).join("")}</table></div>`).join("")}
</body></html>`;
}

// ======================================================================= reverse engineering (condiviso)

let cacheReverse = null;
/** Descrizioni e diagramma per il reverse engineering, richiesti una volta sola per lo stesso stato dell'analisi. */
async function datiReverse() {
  const chiave = JSON.stringify([stato.origine, stato.tabelle_analizzate, stato.fk_candidate, stato.rimosse, stato.impostazioni]);
  if (!cacheReverse || cacheReverse.chiave !== chiave) {
    const [D, diag] = await Promise.all([api("/api/reverse"), api("/api/diagramma?tipo=collegamenti")]);
    cacheReverse = { chiave, D, diag, tabelleDiag: Object.fromEntries(diag.tabelle.map(t => [t.nome, t])) };
  }
  return cacheReverse;
}

const etichettaCategoria = c => el("span", { class: `cat cat-${c}` }, c);

/** Le frasi con «tabella» diventano collegamenti che aprono la tabella. */
function conLinkReverse(R, testo, apri) {
  return String(testo).split(/(«[^»]+»)/).map(parte => {
    const t = parte.startsWith("«") ? parte.slice(1, -1) : null;
    return t && R.D.tabelle[t] ? el("a", { href: "#", onclick: e => { e.preventDefault(); apri(t); } }, `«${t}»`) : parte;
  });
}

/** Il filo logico: area per area, l'ordine in cui conviene leggere le tabelle. */
function filoReverse(R, apri) {
  const { D } = R;
  return el("div", {},
    el("div", { class: "sintesi" }, conLinkReverse(R, D.sintesi, apri)),
    el("h3", {}, "Il filo logico del database"),
    el("p", { class: "tenue" }, "Area per area, nell'ordine in cui conviene leggerle: prima le tabelle da cui dipendono le altre " +
      "(anagrafiche, codifiche), poi movimenti, dettagli e tabelle ponte. Clicca una tabella per la sua scheda."),
    D.filo.map(a => el("div", { class: "pannello filo-area" },
      el("h4", {}, `Area ${a.area}`), el("p", { class: "tenue" }, conLinkReverse(R, a.introduzione, apri)),
      el("ol", {}, a.passi.map(p => el("li", {},
        el("a", { href: "#", onclick: e => { e.preventDefault(); apri(p.tabella); } }, el("b", {}, p.tabella)), " ",
        etichettaCategoria(p.categoria), " ", conLinkReverse(R, p.frase, apri)))))));
}

/** Diagramma di alcune tabelle con solo le colonne che spiegano i collegamenti (chiave primaria e colonne collegate).
    centrali: le tabelle in evidenza; vicine: si aggiungono anche le tabelle collegate a quelle centrali (attenuate). */
function diagrammaTabelle(R, centrali, { vicine = true, selezionata = null, onClic = null, altezza = 380 } = {}) {
  const { diag, tabelleDiag } = R;
  const centro = new Set(centrali.filter(n => tabelleDiag[n]));
  const nomi = new Set(centro);
  const collegamenti = diag.collegamenti.filter(l => {
    const tocca = centro.has(l.da) || centro.has(l.a);
    if (tocca && vicine) { nomi.add(l.da); nomi.add(l.a); }
    return tocca;
  }).filter(l => nomi.has(l.da) && nomi.has(l.a));
  const usate = new Set(collegamenti.flatMap(l => [...l.colonne_da.map(c => `${l.da}.${c}`), ...l.colonne_a.map(c => `${l.a}.${c}`)]));
  const tabelle = [...nomi].map(n => {
    const T0 = tabelleDiag[n];
    const colonne = T0.colonne.filter(c => c.pk || usate.has(`${n}.${c.nome}`));
    const tolte = T0.colonne.length - colonne.length;
    return { ...T0, gruppo: n === selezionata ? "selezionata" : centro.has(n) ? "in evidenza" : T0.gruppo,
             colonne: tolte ? [...colonne, { nome: `… altre ${tolte} colonne`, tipo: "", pk: false, fk: false, unique: false, not_null: false }] : colonne };
  });
  const cornice = el("div", { class: "er-cornice", style: `height: ${altezza}px` });
  if (!tabelle.length) return el("p", { class: "tenue" }, "Nessuna di queste tabelle è nell'analisi.");
  const attenuate = new Set([...nomi].filter(n => !centro.has(n)));
  setTimeout(() => DiagrammaER.crea(cornice, { tabelle, collegamenti }, { tipi: true, selezionata, attenuate,
    onClic: n => { if (n && onClic) onClic(n); } }), 0);
  return cornice;
}

/** La scheda di una tabella: cosa rappresenta, da chi dipende, chi la usa, mini-diagramma e significato delle colonne. */
function schedaReverse(R, t, apri, { altezza = 380 } = {}) {
  const T = R.D.tabelle[t];
  if (!T) return el("p", { class: "tenue" }, `La tabella ${t} non è nell'analisi (forse è stata tolta).`);
  const lista = (voci, titolo) => voci.length ? el("p", {}, el("b", {}, titolo), " ",
    voci.map((v, i) => [i ? ", " : "", el("a", { href: "#", onclick: e => { e.preventDefault(); apri(v.tabella); } }, v.tabella),
      ` (${v.colonne.join(", ")})`])) : null;
  return el("div", {},
    el("h3", {}, t, " ", etichettaCategoria(T.categoria), T.centrale ? el("span", { class: "tenue" }, " tabella centrale") : null),
    el("p", { class: "tenue" }, `${T.nome} · area ${T.area || "-"} · gruppo ${T.gruppo}`),
    el("div", { class: "sintesi" }, conLinkReverse(R, T.descrizione, apri)),
    lista(T.padri, "Dipende da:"), lista(T.figli, "È usata da:"),
    el("p", { class: "tenue" }, "Sopra le tabelle da cui dipende, sotto quelle che la usano (clicca una tabella per aprirla)."),
    diagrammaTabelle(R, [t], { selezionata: t, onClic: n => { if (n !== t) apri(n); }, altezza }),
    griglia({ colonne: ["colonna", "tipo", "ruolo", "significato probabile"], righe: T.colonne.map(c => [c.colonna, c.tipo, c.ruolo, c.significato]) },
      { titolo: "Colonne" }));
}

/** L'editor del database (tela, pannello dell'entità scelta, avvisi, SQL) su uno stato {modello, selezione, vista}:
    lo usano la pagina Editor del database e la lavagna della pagina Disegno affiancato. */
function creaEditor(S) {
  const M = () => S.modello;
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

  // Collega: si clicca la tabella che riceve la chiave esterna (lato molti), poi quella a cui punta
  let collega = null;                       // null = spento; {} = aspetta la prima tabella; {primo} = aspetta la seconda
  const statoCollega = el("span", { class: "stato-collega" });
  const pulsanteCollega = el("button", { title: "Collega due tabelle: clicca prima quella che riceve la chiave esterna (lato molti), poi quella a cui punta" }, "Collega due tabelle");
  function aggiornaCollega() {
    pulsanteCollega.classList.toggle("primario", !!collega);
    pulsanteCollega.textContent = collega ? "Annulla il collegamento" : "Collega due tabelle";
    statoCollega.textContent = !collega ? "" : collega.primo
      ? `${Editor.entitaDi(M(), collega.primo)?.nome}: ora clicca la tabella a cui punta (lato uno).`
      : "Clicca la tabella che riceve la chiave esterna (lato molti).";
  }
  pulsanteCollega.addEventListener("click", () => { collega = collega ? null : {}; aggiornaCollega(); });
  function cliccaPerCollegare(nome) {
    const e = nome ? M().entita.find(x => x.nome === nome) : null;
    if (!e) { avviso("Clicca un'entità (non una tabella ponte).", true); return; }
    if (!collega.primo) { collega.primo = e.id; aggiornaCollega(); return; }
    const r = Editor.aggiungiRelazione(M(), { da: collega.primo, a: e.id, tipo: "1:N", obbligatoria: false });
    collega = null;
    aggiornaCollega();
    S.selezione = r.id;                       // si apre il riquadro della relazione: nome, cardinalità
    ridisegna();
    avviso("Relazione creata: dagli un nome e scegli la cardinalità nel riquadro.");
  }

  function ridisegna() {
    if (diagramma) { S.vista = diagramma.vista(); salvaPosizioni(diagramma.posizioni()); }
    const schema = Editor.schemaLogico(M());
    const scelto = S.selezione && (Editor.entitaDi(M(), S.selezione)?.nome || M().relazioni.find(r => r.id === S.selezione)?.nome);
    if (schema.tabelle.length) {
      diagramma = DiagrammaER.crea(cornice, schema, {
        tipi: true, posizioni: posizioniModello(), vista: S.vista, selezionata: scelto,
        rombi: true, relazioneScelta: S.selezione,
        onSposta: (nome, x, y) => { const el_ = elementoDaNome(nome); if (el_) { el_.x = x; el_.y = y; } },
        onClic: nome => {
          if (collega) return cliccaPerCollegare(nome);
          S.selezione = nome ? elementoDaNome(nome)?.id || null : null;
          ridisegna();
        },
        onClicRelazione: id => { S.selezione = id; ridisegna(); pannello.scrollIntoView({ behavior: "smooth", block: "nearest" }); },
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
    if (S.selezione && Editor.entitaDi(M(), S.selezione)) da.value = S.selezione;
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
        S.selezione = r.tipo === "N:M" ? r.id : da.value;
        ridisegna();
      } }, "Crea relazione"),
    ];
  }

  function disegnaPannello() {
    const e = S.selezione && Editor.entitaDi(M(), S.selezione);
    const r = !e && S.selezione && M().relazioni.find(x => x.id === S.selezione);
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
          el("button", { class: "pericolo", onclick: () => { Editor.eliminaEntita(M(), e.id); S.selezione = null; ridisegna(); } }, "Elimina entità")),
        relazioni.length ? el("h3", {}, "Relazioni") : null,
        relazioni.map(x => el("div", { class: "riga-comandi" },
          el("a", { href: "#", onclick: ev => { ev.preventDefault(); S.selezione = x.id; ridisegna(); } },
            x.tipo === "N:M" ? `${x.nome}: N:M` : `${Editor.entitaDi(M(), x.da).nome} → ${Editor.entitaDi(M(), x.a).nome}` +
            `${x.verbo ? ` «${x.verbo}»` : ""} (${x.tipo}${x.obbligatoria ? ", obbligatoria" : ""})`),
          el("button", { onclick: () => { M().relazioni = M().relazioni.filter(y => y !== x); ridisegna(); } }, "Elimina"))),
        el("hr"));
    } else if (r && r.tipo !== "N:M") {
      const figlia = Editor.entitaDi(M(), r.da), padre = Editor.entitaDi(M(), r.a);
      const verbo = el("input", { type: "text", class: "largo", value: r.verbo || "", placeholder: "per esempio: emette, appartiene a, contiene",
                                  "aria-label": "Nome della relazione" });
      verbo.addEventListener("change", () => { r.verbo = verbo.value.trim(); ridisegna(); });
      const tipo = el("select", { "aria-label": "Cardinalità" },
        el("option", { value: "1:N", selected: r.tipo === "1:N" }, `1:N  molti ${figlia.nome} per un ${padre.nome}`),
        el("option", { value: "1:1", selected: r.tipo === "1:1" }, "1:1  uno per uno"));
      tipo.addEventListener("change", () => {
        r.tipo = tipo.value;
        figlia.attributi.forEach(a => { if (r.colonne_da.includes(a.nome)) a.uq = r.tipo === "1:1"; });
        ridisegna();
      });
      const obbl = el("input", { type: "checkbox", checked: r.obbligatoria });
      obbl.addEventListener("change", () => {
        r.obbligatoria = obbl.checked;
        figlia.attributi.forEach(a => { if (r.colonne_da.includes(a.nome) && !a.pk) a.nn = obbl.checked; });
        ridisegna();
      });
      contenuto.push(
        el("h3", {}, `Relazione ${figlia.nome} → ${padre.nome}`),
        el("p", { class: "tenue" }, `Come nello schema E-R: il nome compare nel rombo a metà del collegamento. ` +
          `Chiave esterna: ${figlia.nome}(${r.colonne_da.join(", ")}) → ${padre.nome}(${r.colonne_a.join(", ")}).`),
        el("label", { class: "campo" }, "Nome della relazione", verbo),
        el("label", { class: "campo" }, "Cardinalità", tipo), el("br"),
        el("label", {}, obbl, " obbligatoria (la chiave esterna è NOT NULL)"), el("br"), el("br"),
        el("div", { class: "riga-comandi" },
          el("button", { onclick: () => { S.selezione = r.da; ridisegna(); } }, `Apri ${figlia.nome}`),
          el("button", { onclick: () => { S.selezione = r.a; ridisegna(); } }, `Apri ${padre.nome}`),
          el("button", { class: "pericolo", onclick: () => { M().relazioni = M().relazioni.filter(y => y !== r); S.selezione = null; ridisegna(); } }, "Elimina relazione")),
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
          el("button", { class: "pericolo", onclick: () => { M().relazioni = M().relazioni.filter(y => y !== r); S.selezione = null; ridisegna(); } }, "Elimina relazione")),
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
    S.selezione = e.id;
    nomeNuova.value = "";
    S.vista = null;                         // la vista si adatta per mostrare tutto
    if (diagramma) salvaPosizioni(diagramma.posizioni());
    diagramma = null;
    ridisegna();
  }
  nomeNuova.addEventListener("keydown", ev => { if (ev.key === "Enter") nuovaEntita(); });

  async function importa() {
    if (M().entita.length && !confirm("L'editor contiene già un database: sostituirlo con quello caricato?")) return;
    const dati = await api(`/api/diagramma?tipo=${tipoImport.value}`);
    S.modello = Editor.daDiagramma(dati, layoutER[tipoImport.value] || {});
    S.selezione = null; S.vista = null; diagramma = null;
    ridisegna();
    avviso(`Importate ${S.modello.entita.length} entità e ${S.modello.relazioni.length} relazioni.`);
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


  function azzera() {
    S.modello = Editor.nuovoModello(); S.selezione = null; S.vista = null; diagramma = null;
    ridisegna();
  }
  /** Il modello è stato sostituito (file riaperto, tabelle copiate): si ridisegna adattando la vista. */
  function ricarica() {
    S.selezione = null; S.vista = null; diagramma = null;
    ridisegna();
  }
  return { cornice, pannello, avvisiBox, anteprima, nomeNuova, tipoImport, ridisegna, nuovaEntita, importa, analizza, regole, dialetto,
           pulsanteCollega, statoCollega,
           azzera, ricarica, posizioniModello, get diagramma() { return diagramma; } };
}

// lo stato dell'editor della pagina Editor del database: le variabili globali (si salvano nel progetto)
const STATO_EDITOR = {
  get modello() { return modelloEditor; }, set modello(m) { modelloEditor = m; },
  get selezione() { return selezioneEditor; }, set selezione(v) { selezioneEditor = v; },
  get vista() { return vistaEditor; }, set vista(v) { vistaEditor = v; },
};

const VISTE = {
  async reverse() {
    const R = await datiReverse();
    const { D } = R;
    const destra = el("div");
    const elenco = el("div", { class: "reverse-elenco" });
    const cercaE = el("input", { type: "search", placeholder: "tabella / entità", "aria-label": "Cerca una tabella o un'entità" });
    const cercaA = el("input", { type: "search", placeholder: "attributo / colonna", "aria-label": "Cerca un attributo" });
    const contatore = el("p", { class: "tenue" });
    let entitaTrovate = new Set();

    const filo = () => destra.replaceChildren(filoReverse(R, apri));

    function apri(t) {
      if (!D.tabelle[t]) return;
      destra.replaceChildren(el("div", {},
        el("div", { class: "riga-comandi" }, el("button", { onclick: filo }, "Torna al filo logico")),
        schedaReverse(R, t, apri)));
      elenco.querySelectorAll("a.scelta").forEach(a => a.classList.remove("scelta"));
      const voce = elenco.querySelector(`a[data-tabella="${CSS.escape(t)}"]`);
      if (voce) voce.classList.add("scelta");
    }

    function disegnaElenco() {
      const e = cercaE.value.trim().toLowerCase(), a = cercaA.value.trim().toLowerCase();
      const passa = T => (!e || T.tabella.toLowerCase().includes(e) || entitaTrovate.has(T.tabella)) &&
        (!a || T.colonne.some(c => c.colonna.toLowerCase().includes(a)));
      let quante = 0;
      elenco.replaceChildren(...D.filo.map(area => {
        const voci = area.passi.filter(p => passa(D.tabelle[p.tabella]));
        quante += voci.length;
        return voci.length ? el("div", {}, el("div", { class: "reverse-area" }, `${area.area} (${voci.length})`),
          voci.map(p => el("a", { href: "#", "data-tabella": p.tabella, title: D.tabelle[p.tabella].sintesi,
            onclick: ev => { ev.preventDefault(); apri(p.tabella); } }, etichettaCategoria(p.categoria), " ", p.tabella))) : null;
      }).filter(Boolean));
      contatore.textContent = e || a ? `${quante} tabelle su ${Object.keys(D.tabelle).length}` : "";
    }
    let attesa = null;
    const cerca = () => { clearTimeout(attesa); attesa = setTimeout(async () => {
      const e = cercaE.value.trim();
      entitaTrovate = new Set(e.length >= 3 ? (await api(`/api/cerca_entita?parola=${encodeURIComponent(e)}`).catch(() => ({ tabelle: [] }))).tabelle : []);
      disegnaElenco();
    }, 200); };
    cercaE.addEventListener("input", cerca);
    cercaA.addEventListener("input", cerca);
    disegnaElenco();
    filo();
    return [
      el("h2", {}, "Reverse engineering"),
      el("p", { class: "tenue" }, "Cosa rappresenta probabilmente ogni tabella e come si legge il database, ricavato da nomi, chiavi, " +
        "collegamenti (dichiarati e trovati ad affidabilità alta) e colonne tipiche (date, importi, quantità, stato...). Sono ipotesi da confermare. " +
        "Le stesse schede si possono affiancare ai file nelle pagine File della cartella e File XML."),
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: () => scaricaBlob(new Blob([dizionarioDati(D, stato.origine)], { type: "text/html;charset=utf-8" }),
          "dizionario_dei_dati.html") }, "Scarica il dizionario dei dati (HTML)")),
      el("div", { class: "reverse-griglia" },
        el("div", { class: "pannello reverse-laterale" }, el("h3", {}, "Tabelle"), cercaE, cercaA, contatore, elenco),
        destra),
    ];
  },

  async asp() {
    const medie = el("input", { type: "checkbox" });
    const conInterfaccia = el("input", { type: "checkbox", checked: true });
    const risultati = el("div");
    const pagine = (await api("/api/interfaccia")).pagine.length;
    async function risolvi() {
      const X = await conAttesa(() => api(`/api/asp?medie=${medie.checked ? 1 : 0}&interfaccia=${conInterfaccia.checked ? 1 : 0}`));
      if (!X) return;
      const righe = d => d.righe.map(x => Object.fromEntries(d.colonne.map((n, i) => [n, x[i]])));
      risultati.replaceChildren(el("div", {},
        el("div", { class: "riquadri" }, righe(X.riepilogo).map(x => el("div", { class: "riquadro" },
          el("div", { class: "valore" }, String(x.valore)), el("div", { class: "voce" }, x.voce)))),
        X.con_interfaccia ? el("div", { class: "messaggio" }, `Usate anche le ${X.schermate} schermate lette del programma: ` +
          "le relazioni confermate dall'interfaccia valgono di più e quelle che solo l'interfaccia mostra sono tra le candidate.") : null,
        el("div", { class: "riga-comandi" },
          el("a", { class: "pulsante primario", href: "/api/scarica/asp_sql" }, "Scarica le chiavi scelte (.sql)"),
          el("a", { class: "pulsante", href: "/api/scarica/asp_lp", title: "Regole e fatti, da usare anche con clingo da terminale" }, "Scarica il programma ASP (.lp)")),
        griglia(X.scelte, { titolo: "Chiavi esterne scelte da clingo", nascondi: ["sql"] }),
        griglia(X.scartate, { titolo: "Candidate scartate, con il motivo" }),
        X.differenze.righe.length ? griglia(X.differenze, { titolo: "Differenze con la scelta automatica (dichiarate + la migliore ad affidabilità alta per colonna)" }) :
          el("div", { class: "messaggio" }, "Nessuna differenza con la scelta automatica."),
        el("details", { class: "pannello" }, el("summary", {}, "Le regole usate da clingo (sqlfk/regole_fk.lp)"), el("pre", {}, X.programma))));
    }
    return [
      el("h2", {}, "Scelta delle chiavi con clingo"),
      el("p", { class: "tenue" }, "clingo è un risolutore di Answer Set Programming: le candidate trovate dall'analisi (e quelle confermate " +
        "dall'interfaccia del programma) diventano fatti, e le regole chiedono l'insieme di chiavi esterne più coerente: le chiavi dichiarate " +
        "restano, le stesse colonne puntano a una sola tabella, due tabelle non si puntano a vicenda, si preferiscono le affidabilità alte e le " +
        "relazioni confermate dal programma, si scartano tipi incompatibili, relazioni ridondanti e collegamenti di direzione incerta tra tabelle " +
        "con la stessa chiave. Tutto in locale: clingo è una libreria dentro l'app."),
      el("div", { class: "pannello" },
        el("div", { class: "riga-comandi" },
          el("label", {}, medie, " anche le candidate ad affidabilità media"),
          el("label", { title: pagine ? "" : "nessuna schermata letta" }, conInterfaccia,
            ` usa le schermate lette del programma (${pagine})`),
          el("button", { class: "primario", onclick: risolvi }, "Risolvi con clingo"))),
      risultati,
    ];
  },

  async interfaccia() {
    const statoBox = el("div", { class: "messaggio" }, "Nessuna schermata letta.");
    const pagineBox = el("div");
    const risultati = el("div");
    const elencoFinestre = el("div", { class: "elenco-finestre" }, el("span", { class: "tenue" }, "cerco le finestre aperte..."));
    const massimo = el("input", { type: "number", min: "5", max: "2000", value: "150", style: "width: 90px", "aria-label": "Schede al massimo" });
    let scelta = null, disponibile = true;

    async function caricaFinestre() {
      const r = await api("/api/finestre");
      disponibile = r.disponibile;
      if (!r.disponibile) {
        elencoFinestre.replaceChildren(el("div", { class: "messaggio" }, r.messaggio));
        return;
      }
      elencoFinestre.replaceChildren(...(r.finestre.length ? r.finestre.map(f => el("button", {
        class: scelta === f.id ? "primario" : null, title: `${f.programma} (processo ${f.pid})`,
        onclick: () => { scelta = f.id; caricaFinestre(); } }, el("b", {}, f.programma || "programma"), ` · ${f.titolo}`))
        : [el("span", { class: "tenue" }, "Nessuna finestra aperta: apri il programma e premi Aggiorna.")]));
    }

    async function comando(nome, dati = {}) {
      if (!scelta) return avviso("Scegli prima la finestra del programma.", true);
      try {
        const r = await api(`/api/finestre/${nome}`, { id: scelta, ...dati });
        if (r.letta !== undefined) avviso(`Letta la schermata "${r.letta}": ${r.moduli} moduli, ${r.tabelle} tabelle.`);
        aggiorna();
      } catch (e) { avviso(e.message, true); }
    }

    async function aggiorna() {
      const r = await api("/api/interfaccia");
      const st = r.stato || {};
      statoBox.textContent = `${r.pagine.length} schermate lette` + (st.in_corso ? " · lettura di tutte le schede in corso" : "") +
        (st.registra ? " · registrazione attiva: naviga nel programma" : "") + (st.messaggio ? ` · ${st.messaggio}` : "");
      const conta = {};
      r.pagine.forEach(p => { conta[p.schema] = (conta[p.schema] || 0) + 1; });
      pagineBox.replaceChildren(r.pagine.length ? griglia({ colonne: ["schermata", "letture", "elenchi", "moduli", "schede"],
        righe: Object.keys(conta).sort().map(k => { const p = r.pagine.find(x => x.schema === k);
          return [decodeURIComponent(k).replace(/^\//, "").replace(/\//g, " > "), conta[k], p.tabelle, p.moduli, p.schede]; }) },
        { titolo: "Schermate lette" }) : "");
    }
    const ciclo = setInterval(async () => {
      if (!document.body.contains(statoBox)) { clearInterval(ciclo); return; }
      try { await aggiorna(); } catch { /* si riprova */ }
    }, 2000);

    async function analizza() {
      const V = await conAttesa(() => api("/api/interfaccia/analisi"));
      if (!V) return null;
      return mostraAnalisiInterfaccia(V, risultati);
    }

    // un clic: legge tutte le schede, analizza e salva i rapporti in Documenti/SQL FK Finder/rapporti
    async function tuttoDaSolo() {
      if (!scelta) return avviso("Scegli prima la finestra del programma.", true);
      const finestra = [...elencoFinestre.querySelectorAll("button")].find(b => b.classList.contains("primario"));
      const programma = finestra ? finestra.querySelector("b").textContent.replace(/\.exe$/i, "") : "programma";
      mostraAttesa("Lettura di tutte le schermate del programma...", el("button", { onclick: () => api("/api/finestre/ferma", {}) }, "Ferma"));
      try {
        await api("/api/finestre/leggi_tutto", { id: scelta, massimo: Number(massimo.value) || 150 });
        for (let i = 0; i < 1800; i++) {                 // al massimo mezz'ora
          await pausa(1000);
          const st = (await api("/api/interfaccia")).stato || {};
          $("#attesa .riquadro-attesa div").textContent = `Lettura delle schermate: ${st.messaggio || "in corso"}`;
          if (!st.in_corso) break;
        }
      } catch (e) {
        $("#attesa").hidden = true;
        return avviso(e.message, true);
      }
      $("#attesa").hidden = true;
      await aggiorna();
      const rapporto = await analizza();
      if (!rapporto) return;
      for (let i = 0; i < 20 && !rapporto.pronto(); i++) await pausa(250);   // la mappa si disegna subito dopo
      const nome = `${programma} ${new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".")}`;
      const excel = new Uint8Array(await (await fetch("/api/scarica/interfaccia")).arrayBuffer());
      const file = { "rapporto.html": rapporto.html(), "rapporto.txt": rapporto.testo(), "dettagli.xlsx": excel };
      if (window.sqlfkApp && window.sqlfkApp.salvaRapporto) {
        const cartella = await window.sqlfkApp.salvaRapporto(nome, file);
        risultati.prepend(el("div", { class: "messaggio" }, `Rapporti salvati in ${cartella} (rapporto.html, rapporto.txt, dettagli.xlsx). `,
          el("button", { onclick: () => window.sqlfkApp.apriCartella(cartella) }, "Apri la cartella")));
        avviso("Verifica finita: rapporti salvati.");
      } else {
        scaricaBlob(new Blob([file["rapporto.html"]], { type: "text/html;charset=utf-8" }), "rapporto_programma.html");
        scaricaBlob(new Blob([file["rapporto.txt"]], { type: "text/plain;charset=utf-8" }), "rapporto_programma.txt");
      }
    }

    setTimeout(() => { caricaFinestre().catch(e => avviso(e.message, true)); aggiorna().catch(() => {}); }, 0);
    return [
      el("h2", {}, "Verifica con l'interfaccia del programma"),
      el("p", { class: "tenue" }, "L'app legge le finestre del programma che usa questo database, come un lettore di schermo: etichette, " +
        "campi, menu a tendina con le voci, griglie, schede. Ne ricava le entità (classi) con i loro attributi, le collega a tabelle e " +
        "colonne, e mostra come comunicano le parti del programma, controllando le chiavi esterne previste. Tutto sul computer, senza rete: " +
        "non preme pulsanti, non usa i comandi dei menu e non scrive nei campi."),
      el("div", { class: "pannello" },
        el("h3", {}, "1. Scegli la finestra del programma"),
        el("div", { class: "riga-comandi" }, el("button", { onclick: () => caricaFinestre().catch(e => avviso(e.message, true)) }, "Aggiorna l'elenco")),
        elencoFinestre),
      el("div", { class: "pannello" },
        el("h3", {}, "2. Leggi le schermate"),
        el("p", { class: "tenue" }, "Fai tutto da solo legge tutte le schede, analizza e salva rapporto HTML, rapporto di testo ed Excel in " +
          "Documenti/SQL FK Finder/rapporti. Leggi tutte le schede passa da solo tra le schede (tab) e le voci degli alberi di navigazione. " +
          "Per le schermate che si aprono con un pulsante o un menu usa Registra e aprile tu: ogni schermata che vedi viene letta, " +
          "anche le finestre secondarie dello stesso programma."),
        el("div", { class: "riga-comandi" },
          el("button", { class: "primario", onclick: tuttoDaSolo, title: "Legge tutte le schede, analizza e salva i rapporti da solo" }, "Fai tutto da solo"),
          el("button", { onclick: () => comando("leggi") }, "Leggi questa schermata"),
          el("button", { onclick: () => comando("leggi_tutto", { massimo: Number(massimo.value) || 150 }) }, "Leggi tutte le schede"),
          el("label", {}, "al massimo ", massimo),
          el("button", { onclick: () => comando("registra") }, "Registra mentre navigo"),
          el("button", { onclick: () => comando("ferma") }, "Ferma"),
          el("button", { onclick: async () => {
            if (!confirm("Dimenticare le schermate lette?")) return;
            await api("/api/interfaccia/svuota", {});
            risultati.replaceChildren();
            aggiorna();
          } }, "Dimentica le schermate lette")),
        statoBox, pagineBox),
      el("div", { class: "pannello" },
        el("h3", {}, "3. Come comunicano le parti del programma"),
        el("p", { class: "tenue" }, "Se il database delle query è pronto (pagina Query sui dati) si confrontano anche i valori mostrati con i dati: " +
          "i collegamenti diventano più sicuri."),
        el("div", { class: "riga-comandi" }, el("button", { class: "primario", onclick: analizza }, "Analizza le schermate lette")),
        risultati),
    ];
  },

  async query() {
    const info = await api("/api/query/tabelle");
    if (info.da_costruire) return paginaDatabaseDaCostruire(info);
    const editor = el("textarea", { class: "editor-query", spellcheck: "false", "aria-label": "Query SQL",
      placeholder: "SELECT * FROM tabella LIMIT 100;\n\nCtrl+Invio (Cmd+Invio sul Mac) per eseguire. Se selezioni una parte, viene eseguita solo quella." });
    editor.value = testoQuery;
    editor.addEventListener("input", () => { testoQuery = editor.value; });
    const risultati = el("div");
    const filtroTabelle = el("input", { type: "search", placeholder: "tabella / entità", "aria-label": "Cerca una tabella o un'entità" });
    const filtroAttributo = el("input", { type: "search", placeholder: "attributo / colonna", "aria-label": "Cerca un attributo" });
    let entitaTrovate = new Set();
    const elenco = el("div", { class: "query-tabelle" });
    const conteggioRicerca = el("p", { class: "tenue" });
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
      // restano solo le tabelle con quel nome (anche al plurale) e, se c'è, con quell'attributo
      const f = filtroTabelle.value.trim().toLowerCase(), a = filtroAttributo.value.trim().toLowerCase();
      const colonneTrovate = t => a ? t.colonne.filter(c => c.toLowerCase().includes(a)) : [];
      const scelte = info.tabelle.filter(t => (!f || t.tabella.toLowerCase().includes(f) || entitaTrovate.has(t.tabella)) &&
                                              (!a || colonneTrovate(t).length));
      conteggioRicerca.textContent = f || a ? `${scelte.length} tabelle su ${info.tabelle.length}` +
        (a ? `, con una colonna che contiene "${a}" (in giallo)` : "") : "";
      elenco.replaceChildren(...scelte.map(t => {
        const trovate = new Set(colonneTrovate(t));
        return el("details", { open: trovate.size ? "" : null },
          el("summary", { title: "Clicca il nome per vedere le prime righe" },
            el("a", { href: "#", onclick: e => {
              e.preventDefault();
              editor.value = testoQuery = `SELECT * FROM "${t.tabella.replace(/"/g, '""')}" LIMIT 100;`;
              esegui();
            } }, t.tabella),
            el("span", { class: "tenue" }, ` ${t.righe.toLocaleString("it-IT")}`)),
          el("div", { class: "query-colonne" }, t.colonne.map(c => el("a", { href: "#", class: trovate.has(c) ? "trovata" : null,
            title: "Inserisci nella query", onclick: e => {
            e.preventDefault();
            const inizio = editor.selectionStart, fine = editor.selectionEnd;
            editor.setRangeText(/^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c}"`, inizio, fine, "end");
            testoQuery = editor.value;
            editor.focus();
          } }, c))));
      }));
    }
    let attesa = null;
    const filtra = () => {
      clearTimeout(attesa);
      attesa = setTimeout(async () => {
        const e = filtroTabelle.value.trim();
        entitaTrovate = new Set(e.length >= 3 ? (await api(`/api/cerca_entita?parola=${encodeURIComponent(e)}`).catch(() => ({ tabelle: [] }))).tabelle : []);
        disegnaTabelle();
      }, 200);
    };
    filtroTabelle.addEventListener("input", filtra);
    filtroAttributo.addEventListener("input", filtra);

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
            el("span", { class: "tenue" }, (r.altre ? `prime ${r.totale} righe, ce ne sono altre` : `${r.totale} righe`) + ` · ${r.secondi} s`),
            el("button", { onclick: () => scaricaBlob(new Blob([csvRisultato(r)], { type: "text/csv;charset=utf-8" }), nome) },
              r.altre ? "Scarica CSV (righe mostrate)" : "Scarica CSV"),
            r.altre && esito.risultati.length === 1 ? el("a", { class: "pulsante", href: `/api/query/csv?sql=${encodeURIComponent(r.istruzione)}`,
              title: "Tutte le righe del risultato, anche milioni: il file si scarica man mano" }, "Scarica CSV completo") : null),
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
      mostraAttesa("Query in corso...", el("button", { onclick: () => api("/api/query/interrompi", {}) }, "Interrompi"));
      let esito = null;
      try {
        esito = await api("/api/query", { sql: testo, conferma });
      } catch (e) {
        avviso(e.message, true);
      } finally {
        $("#attesa").hidden = true;
      }
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
      if (nuove.lavoro) {                         // database su disco: si ricostruisce in background
        try { await seguiLavoro("Costruzione del database delle query"); } catch (e) { avviso(e.message, true); }
        ultimiRisultati = null;
        return mostra("query");
      }
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
        `Database SQLite ${info.su_disco ? "su disco" : "in memoria"} costruito dai file: ${info.tabelle.length} tabelle, ${conDati} con dati, ` +
        `${totaleRighe.toLocaleString("it-IT")} righe (dagli INSERT e dai COPY dei file). Scrivi le query in SQLite o in ${info.dialetto}: ` +
        "se serve vengono tradotte. INSERT, UPDATE, DELETE e DROP chiedono conferma e cambiano solo questa copia, non i file. " +
        `Si vedono le prime ${info.max_righe} righe di ogni risultato; il CSV completo le contiene tutte.`),
      info.su_disco ? el("div", { class: "messaggio" },
        `Il database è un file su disco (${formattaByte(info.dimensione_db || 0)}): ${info.su_disco}. ` +
        "Con gli stessi file si riapre subito anche dopo aver chiuso l'app. ",
        el("button", { onclick: async () => {
          if (!confirm("Cancellare i database delle query salvati su disco? Si ricostruiscono dai file quando servono.")) return;
          const r = await conAttesa(() => api("/api/query/svuota_cache", {}));
          if (r) { avviso(`Liberati ${formattaByte(r.liberati)}.`); ultimiRisultati = null; mostra("query"); }
        } }, "Cancella i database su disco")) : null,
      totaleRighe === 0 ? el("div", { class: "messaggio" },
        "I file non contengono dati (INSERT o COPY): le tabelle sono vuote. Puoi comunque inserire righe con INSERT INTO ... VALUES ...") : null,
      info.problemi.length ? griglia({ colonne: ["file", "riga", "problema", "istruzione"],
        righe: info.problemi.map(p => [p.file, p.riga, p.problema, p.istruzione]) },
        { titolo: `Istruzioni di dati non caricate (${info.n_problemi > info.problemi.length ? `${info.n_problemi}, mostrate le prime ${info.problemi.length}` : info.problemi.length})` }) : null,
      el("div", { class: "query-griglia" },
        el("div", { class: "pannello query-laterale" }, el("h3", {}, "Tabelle"), filtroTabelle, filtroAttributo, conteggioRicerca,
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
    const E = creaEditor(STATO_EDITOR);
    const M = () => modelloEditor;
    setTimeout(E.ridisegna, 0);
    return [
      el("datalist", { id: "tipi-sql" }, Editor.TIPI.map(t => el("option", { value: t }))),
      el("h2", {}, "Editor del database"),
      el("p", { class: "tenue" }, "Disegna le entità con i loro attributi e collegale con relazioni 1:N, 1:1 o N:M: l'editor applica le regole del passaggio al modello logico (chiave esterna dal lato N, UNIQUE per 1:1, tabella ponte per N:M) e scrive le CREATE TABLE. Con Analizza questo schema tutte le altre pagine (Problemi, Regole, Ontologia, Modello relazionale, esportazioni) lavorano sul database disegnato. Tutto si salva nel file di progetto."),
      el("div", { class: "riga-comandi" },
        E.nomeNuova, el("button", { class: "primario", onclick: E.nuovaEntita }, "Nuova entità"), E.pulsanteCollega,
        el("button", { onclick: () => { if (!M().entita.length || confirm("Cancellare il database dell'editor e ripartire da zero?")) E.azzera(); } }, "Nuovo database"),
        stato.caricato ? [el("button", { onclick: () => conAttesa(E.importa) }, "Importa il database caricato"), E.tipoImport] : null,
        el("button", { onclick: () => E.diagramma && E.diagramma.adatta() }, "Adatta alla finestra"),
        el("button", { onclick: () => conAttesa(E.analizza) }, "Analizza questo schema"),
        el("button", { onclick: () => scaricaBlob(new Blob([Editor.sql(M(), E.regole(), E.dialetto())], { type: "application/sql" }), "database.sql") }, "Scarica SQL"),
        el("button", { onclick: () => E.diagramma && conAttesa(async () => scaricaBlob(await E.diagramma.png(), "database.png")) }, "Scarica PNG")),
      E.statoCollega, E.avvisiBox,
      el("div", { class: "editor-griglia" }, E.cornice, E.pannello),
      el("h3", {}, "Codice SQL generato"),
      E.anteprima,
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
      stato.file_ridotti && stato.file_ridotti.length ? el("div", { class: "messaggio" },
        `File grandi (${formattaByte(stato.dimensione_file)} in tutto): di ${stato.file_ridotti.join(", ")} è stata letta solo la struttura ` +
        "(CREATE TABLE, ALTER TABLE...), saltando i dati. I numeri di riga restano quelli del file. I dati si interrogano nella pagina ",
        el("a", { href: "#", onclick: e => { e.preventDefault(); mostra("query"); } }, "Query sui dati"), ".") : null,
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
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: () => { raggruppaER = "gruppo"; filtroER = ""; mostraSchema("collegamenti", "er"); } },
          "Vedi i gruppi nel diagramma"),
        el("button", { onclick: () => { raggruppaER = "area"; filtroER = ""; mostraSchema("collegamenti", "er"); } }, "Vedi le aree nel diagramma"),
        el("span", { class: "tenue" }, "ogni gruppo (o area) in un riquadro separato, in ordine di nome")),
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
    const parola = el("input", { type: "search", class: "largo", value: ricercaTogli,
      placeholder: "nome di una tabella (anche completo, es. piatto_ingredienti) o di un'entità (es. piatto)", "aria-label": "Tabella o entità da togliere" });
    const trovate = el("div");
    const cerca = async () => {
      ricercaTogli = parola.value;
      const q = parola.value.trim();
      if (!q) { trovate.replaceChildren(el("p", { class: "tenue" }, "Scrivi il nome di una tabella o di un'entità: le tabelle trovate compaiono qui, senza spunta.")); return; }
      const r = await api(`/api/cerca_entita?parola=${encodeURIComponent(q)}`);
      if (parola.value.trim() !== q) return;                 // nel frattempo è stato scritto altro
      const entita = r.tabelle.filter(t => !r.uguali.includes(t) && !r.contengono.includes(t));
      const gruppi = [["Con lo stesso nome", r.uguali], [`Che contengono «${q}» nel nome`, r.contengono], ["Della stessa entità", entita]]
        .filter(([, t]) => t.length);
      if (!gruppi.length) {
        trovate.replaceChildren(el("div", { class: "messaggio" }, "Nessuna tabella trovata (per le entità servono almeno 3 lettere)."));
        return;
      }
      const spunte = [];
      const togli = el("button", { class: "pericolo", disabled: true }, "Togli selezionate");
      const aggiorna = () => {
        const n = spunte.filter(x => x.checked).length;
        togli.disabled = !n;
        togli.textContent = n ? `Togli ${n} ${n === 1 ? "tabella" : "tabelle"}` : "Togli selezionate";
      };
      togli.addEventListener("click", async () => {
        const scelte = spunte.filter(x => x.checked).map(x => x.value);
        if (!scelte.length) return;
        await conAttesa(async () => {
          const esito = await api("/api/togli", { tabelle: scelte });
          await dopoModifica(`Tolte ${esito.tolte} tabelle.`);
        });
      });
      const spunta = t => { const c = el("input", { type: "checkbox", value: t, onchange: aggiorna }); spunte.push(c); return el("label", {}, c, t); };
      const tutte = valore => { spunte.forEach(x => { x.checked = valore; }); aggiorna(); };
      const totale = gruppi.reduce((n, [, t]) => n + t.length, 0);
      trovate.replaceChildren(
        el("p", {}, `${totale} tabelle trovate per `, el("b", {}, q), ". Spunta quelle da togliere."),
        el("div", { class: "elenco-spunte" }, gruppi.map(([titolo, t]) => [el("div", { class: "reverse-area" }, `${titolo} (${t.length})`), t.map(spunta)])),
        el("div", { class: "riga-comandi" },
          el("button", { onclick: () => tutte(true) }, "Seleziona tutte"),
          el("button", { onclick: () => tutte(false) }, "Deseleziona tutte"),
          togli));
    };
    let attesaRicerca = null;
    parola.addEventListener("input", () => { clearTimeout(attesaRicerca); attesaRicerca = setTimeout(cerca, 250); });
    parola.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(attesaRicerca); cerca(); } });
    setTimeout(cerca, 0);

    const spunteTolte = stato.rimosse.map(t => el("input", { type: "checkbox", value: t }));
    return [
      el("h2", {}, "Togli entità dall'analisi"),
      el("p", { class: "tenue" }, "Scrivi il nome di una tabella, anche completo (piatto_ingredienti), o di un'entità (piatto: trova piatti, piatto_ingredienti, tbl_piatti...): le tabelle compaiono mentre scrivi, senza spunta, e scegli tu quali togliere. Appena le togli l'analisi si aggiorna da sola, senza salvare: le tabelle tolte spariscono dai risultati e dagli schemi grafici. I file non vengono modificati."),
      pulsantiSchemi(),
      el("div", { class: "pannello" },
        el("div", { class: "riga-comandi" }, parola, el("button", { class: "primario", onclick: cerca }, "Cerca")),
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
      salvaSenzaTolte(),
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
    const esitoControllo = el("div");
    const pannelloControllo = el("div", { class: "pannello" },
      el("h3", {}, "Controllo dell'app"),
      el("p", { class: "tenue" }, "Controlla che Python, librerie, analisi, query e lettura delle finestre funzionino, e che l'app non vada in rete " +
        "(internet bloccato, nessuna connessione aperta). Usa una copia degli esempi: il lavoro aperto non cambia. Si fa da solo al primo avvio."),
      el("div", { class: "riga-comandi" }, el("button", { class: "primario", onclick: async () => {
        const r = await conAttesa(() => window.sqlfkApp && window.sqlfkApp.controlla ? window.sqlfkApp.controlla()
          : api("/api/autoverifica").then(d => ({ controlli: d.controlli, errori: d.controlli.filter(c => c.esito === "errore").length })));
        if (r) esitoControllo.replaceChildren(risultatoControllo(r));
      } }, "Controlla l'app")),
      esitoControllo);
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
      pannelloControllo,
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
let raggruppaER = "";
let lineeSoloFocusER = false;  // linee visibili solo per la tabella sotto il mouse          // disposizione del diagramma: "" (per collegamenti), "gruppo" o "area"
let cercaER = { entita: "", attributo: "", collegate: false };   // ricerca che filtra il diagramma
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
  const sceltaDisposizione = el("select", { "aria-label": "Disposizione", title: "Come disporre le tabelle" },
    el("option", { value: "" }, "disposte per collegamenti"), el("option", { value: "gruppo" }, "raccolte per gruppi"),
    el("option", { value: "area" }, "raccolte per aree"));
  sceltaDisposizione.value = raggruppaER;
  const cercaEntita = el("input", { type: "search", placeholder: "tabella / entità", "aria-label": "Cerca una tabella o un'entità",
    title: "Restano solo le tabelle con questo nome (anche al plurale o con i sinonimi)", value: cercaER.entita });
  const cercaAttributo = el("input", { type: "search", placeholder: "attributo / colonna", "aria-label": "Cerca un attributo",
    title: "Restano solo le tabelle che hanno una colonna con questo nome; le colonne trovate sono in giallo", value: cercaER.attributo });
  const conCollegate = el("input", { type: "checkbox", checked: cercaER.collegate });
  const soloFocus = el("input", { type: "checkbox", checked: lineeSoloFocusER });
  const conTipi = el("input", { type: "checkbox", checked: true });
  const medie = el("input", { type: "checkbox", checked: erMedie && quale === "collegamenti", title: "Aggiunge le FK trovate ad affidabilità media (passa a FK dichiarate e trovate)" });
  let diagramma = null;

  // ricerca: per entità (nome della tabella, plurali e sinonimi) e per attributo (nome di una colonna)
  let entitaTrovate = new Set(), ultimaEntita = null;
  async function aggiornaEntita() {
    const e = cercaEntita.value.trim();
    if (e === ultimaEntita) return;
    ultimaEntita = e;
    entitaTrovate = new Set(e.length >= 3 ? (await api(`/api/cerca_entita?parola=${encodeURIComponent(e)}`).catch(() => ({ tabelle: [] }))).tabelle : []);
  }
  const normale = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");

  function disegna() {
    let tabelle = dati.tabelle, collegamenti = dati.collegamenti;
    let attenuate = null, trovateInfo = "";
    const e = normale(cercaEntita.value), a = normale(cercaAttributo.value);
    if (sceltaGruppo.value) {
      // l'area o il gruppo scelto più le tabelle direttamente collegate
      const [genere, valore] = [sceltaGruppo.value.slice(0, 1), sceltaGruppo.value.slice(2)];
      const nomi = new Set(tabelle.filter(t => (genere === "a" ? t.area : t.gruppo) === valore).map(t => t.nome));
      collegamenti.forEach(l => { if (nomi.has(l.da) || nomi.has(l.a)) { nomi.add(l.da); nomi.add(l.a); } });
      tabelle = tabelle.filter(t => nomi.has(t.nome));
      collegamenti = collegamenti.filter(l => nomi.has(l.da) && nomi.has(l.a));
    }
    if (e || a) {
      // restano solo le tabelle cercate (con le collegate, se richiesto, più chiare); le altre spariscono
      const trovate = new Set(tabelle.filter(t =>
        (!e || normale(t.nome).includes(e) || entitaTrovate.has(t.nome)) &&
        (!a || t.colonne.some(c => normale(c.nome).includes(a)))).map(t => t.nome));
      const nomi = new Set(trovate);
      if (conCollegate.checked) collegamenti.forEach(l => {
        if (trovate.has(l.da)) nomi.add(l.a);
        if (trovate.has(l.a)) nomi.add(l.da);
      });
      attenuate = new Set([...nomi].filter(n => !trovate.has(n)));
      const colonneTrovate = a ? tabelle.filter(t => trovate.has(t.nome)).reduce((n, t) => n + t.colonne.filter(c => normale(c.nome).includes(a)).length, 0) : 0;
      trovateInfo = `trovate ${trovate.size} tabelle su ${tabelle.length}` + (a ? `, ${colonneTrovate} colonne in giallo` : "") +
        (attenuate.size ? ` (più ${attenuate.size} collegate, più chiare)` : "");
      tabelle = tabelle.filter(t => nomi.has(t.nome));
      collegamenti = collegamenti.filter(l => nomi.has(l.da) && nomi.has(l.a));
      if (!trovate.size) {
        cornice.replaceChildren(el("div", { class: "messaggio" },
          `Nessuna tabella ${e ? `con il nome "${cercaEntita.value.trim()}"` : ""}${e && a ? " e " : ""}${a ? `con un attributo "${cercaAttributo.value.trim()}"` : ""}.`));
        info.textContent = "";
        diagramma = null;
        return;
      }
    }
    if (collegamenti.length > 3000) {
      cornice.replaceChildren(el("div", { class: "messaggio" },
        `${collegamenti.length} collegamenti sono troppi per un diagramma leggibile: scegli un gruppo o togli qualche entità.`));
      diagramma = null;
      return;
    }
    // le posizioni spostate a mano valgono per la vista completa, con la sua disposizione
    const chiave = quale + (raggruppaER ? `:${raggruppaER}` : "");
    layoutER[chiave] ||= {};
    const filtrato = !!(e || a);
    diagramma = DiagrammaER.crea(cornice, { tabelle, collegamenti }, {
      tipi: conTipi.checked,
      coloraPer: raggruppaER || coloraER,
      raggruppa: raggruppaER || null,
      lineeSoloFocus: soloFocus.checked,
      colonne: cercaAttributo.value.trim(),
      attenuate,
      posizioni: filtrato ? {} : layoutER[chiave],
      onSposta: (nome, x, y) => { if (!filtrato) layoutER[chiave][nome] = [x, y]; },
    });
    info.textContent = trovateInfo || (`${diagramma.numeri.tabelle} tabelle, ${diagramma.numeri.collegamenti} collegamenti` +
      (raggruppaER ? `, ${diagramma.numeri.gruppi} ${raggruppaER === "area" ? "aree" : "gruppi"}` : ""));
  }

  sceltaGruppo.addEventListener("change", () => { filtroER = sceltaGruppo.value; disegna(); });
  sceltaColore.addEventListener("change", () => { coloraER = sceltaColore.value; disegna(); });
  conTipi.addEventListener("change", disegna);
  medie.addEventListener("change", () => { erMedie = medie.checked; mostraSchema(medie.checked ? "collegamenti" : quale, "er"); });
  sceltaDisposizione.addEventListener("change", () => { raggruppaER = sceltaDisposizione.value; disegna(); });
  soloFocus.addEventListener("change", () => { lineeSoloFocusER = soloFocus.checked; disegna(); });
  let attesaRicerca = null;
  const cerca = () => {
    clearTimeout(attesaRicerca);
    attesaRicerca = setTimeout(async () => {
      cercaER = { entita: cercaEntita.value, attributo: cercaAttributo.value, collegate: conCollegate.checked };
      await aggiornaEntita();
      disegna();
    }, 250);
  };
  cercaEntita.addEventListener("input", cerca);
  cercaAttributo.addEventListener("input", cerca);
  conCollegate.addEventListener("change", cerca);
  const scarica = () => {
    if (!diagramma) return;
    const url = URL.createObjectURL(new Blob([diagramma.esporta()], { type: "image/svg+xml" }));
    el("a", { href: url, download: nomeImmagine().replace(/\.png$/, ".svg") }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const scheda = (q, testo) => el("button", { class: q === quale ? "primario" : null, onclick: () => mostraSchema(q, "er") }, testo);
  // PNG di quello che si vede (il risultato della ricerca, del gruppo o dell'area), con un nome che lo ricorda
  const nomeImmagine = () => {
    const parti = ["diagramma", sceltaGruppo.value.slice(2), cercaEntita.value.trim(), cercaAttributo.value.trim()].filter(Boolean);
    return (parti.length > 1 ? parti.join("_") : `diagramma_${quale}`).replace(/[^\w.-]+/g, "_") + ".png";
  };
  const scaricaPng = () => diagramma && conAttesa(async () => {
    const pochi = diagramma.numeri.tabelle <= 30;              // poche tabelle: immagine più nitida
    const nome = nomeImmagine();
    scaricaBlob(await diagramma.png(pochi ? 3 : 2), nome);
    avviso(`Scaricata ${nome}: ${diagramma.numeri.tabelle} tabelle, ${diagramma.numeri.collegamenti} collegamenti.`);
  });
  setTimeout(async () => { await aggiornaEntita(); disegna(); }, 0);
  return [
    el("h2", {}, "Diagramma delle tabelle"),
    el("div", { class: "riga-comandi" },
      scheda("iniziale", "Solo FK dichiarate"),
      scheda("collegamenti", "FK dichiarate e trovate"),
      el("label", {}, medie, "anche affidabilità media"),
      el("button", { onclick: () => mostraSchema(quale, "grafo") }, "Vista a grafo")),
    el("div", { class: "riga-comandi ricerca-er" },
      el("b", {}, "Cerca:"), cercaEntita, cercaAttributo, el("label", {}, conCollegate, "anche le collegate"),
      el("button", { onclick: () => { cercaEntita.value = ""; cercaAttributo.value = ""; cerca(); } }, "Mostra tutte"),
      el("button", { class: "primario", title: "Un'immagine PNG con le tabelle e i collegamenti che vedi (il risultato della ricerca o del gruppo scelto)",
        onclick: scaricaPng }, "Scarica il risultato (PNG)")),
    el("div", { class: "riga-comandi" },
      sceltaDisposizione, sceltaGruppo, sceltaColore,
      el("label", {}, conTipi, "mostra i tipi"),
      el("label", { title: "Le linee si vedono solo passando il mouse su una tabella" }, soloFocus, "linee solo della tabella sotto il mouse"),
      el("button", { onclick: () => diagramma && diagramma.zoom(1.25), title: "Ingrandisci" }, "+"),
      el("button", { onclick: () => diagramma && diagramma.zoom(0.8), title: "Rimpicciolisci" }, "-"),
      el("button", { onclick: () => diagramma && diagramma.adatta() }, "Adatta alla finestra"),
      el("button", { title: "Dimentica gli spostamenti fatti a mano", onclick: () => { layoutER[quale + (raggruppaER ? `:${raggruppaER}` : "")] = {}; disegna(); } }, "Disposizione automatica"),
      el("button", { onclick: scarica }, "Scarica SVG"),
      el("button", { onclick: scaricaPng }, "Scarica PNG"),
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
