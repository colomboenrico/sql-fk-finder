"use strict";

// Pagine "Peso delle tabelle" (tutte le tabelle, anche le più leggere e le vuote, con righe e spazio, da togliere
// dall'analisi) e "Dati delle tabelle" (struttura e righe di ogni tabella, seguendo i collegamenti riga per riga).
// I dati sono quelli degli INSERT e dei COPY dei file, nel database delle query: i file non si modificano mai.

let ordinePeso = "leggere", ricercaPeso = "", mostraTolte = true;
const DATI = { tabella: null, da: 0, cerca: "", dove: null, storia: [], vista: "dati" };   // vista: "dati" o "grafici"
const PER_PAGINA_DATI = 100;

/** Avviso (con il pulsante) quando il database delle query va costruito prima. */
function serveDatabase(motivo) {
  return el("div", { class: "pannello" },
    el("p", {}, motivo || "Il database delle query non è ancora stato costruito."),
    el("p", { class: "tenue" }, "Con i file grandi va costruito una volta sola nella pagina Query sui dati; poi qui si vedono righe e spazio."),
    el("button", { class: "primario", onclick: () => mostra("query") }, "Vai a Query sui dati"));
}

const formattaValore = v => v === null || v === undefined ? "NULL" : String(v);

/** Tabella HTML semplice di righe {colonne, righe}; alClic(riga come oggetto) se le righe si possono cliccare. */
function tabellaRighe(colonne, righe, alClic) {
  const corpo = el("tbody", {}, righe.map(r => {
    const tr = el("tr", { class: alClic ? "cliccabile" : null },
      r.map(v => el("td", { class: v === null ? "nullo" : null, title: formattaValore(v) }, formattaValore(v))));
    if (alClic) tr.addEventListener("click", () => {
      corpo.querySelectorAll("tr.scelta").forEach(x => x.classList.remove("scelta"));
      tr.classList.add("scelta");
      alClic(Object.fromEntries(colonne.map((c, i) => [c, r[i]])));
    });
    return tr;
  }));
  return el("div", { class: "griglia-scorri" }, el("table", { class: "tabella-dati" },
    el("thead", {}, el("tr", {}, colonne.map(c => el("th", {}, c)))), corpo));
}

/** Apre una tabella nella pagina Dati delle tabelle (con un filtro, per seguire un collegamento). */
function apriDati(tabella, dove = null, ricorda = true) {
  if (ricorda && DATI.tabella) DATI.storia.push({ tabella: DATI.tabella, da: DATI.da, cerca: DATI.cerca, dove: DATI.dove });
  Object.assign(DATI, { tabella, da: 0, cerca: "", dove });
  mostra("datitabelle");
}

Object.assign(VISTE, {
  async peso() {
    const P = await api("/api/peso_tabelle");
    const intestazione = [el("h2", {}, "Peso delle tabelle"),
      el("p", { class: "tenue" }, "Tutte le tabelle dei file, anche le più leggere e quelle vuote, con il numero di colonne, le righe e lo spazio " +
        "che occupano i loro dati (nel database delle query, costruito dagli INSERT e dai COPY). Le tabelle vuote o quasi spesso " +
        "non servono: si possono togliere dall'analisi (i file non vengono modificati) e rimettere quando vuoi.")];
    const conDati = P.con_dati;
    const massimo = Math.max(1, ...P.tabelle.map(t => t.righe ? t.byte || 0 : 0));
    const vuote = P.tabelle.filter(t => t.righe === 0);
    const totale = P.tabelle.reduce((n, t) => n + (t.righe ? t.byte || 0 : 0), 0);
    const cerca = el("input", { type: "search", value: ricercaPeso, placeholder: "cerca una tabella", "aria-label": "Cerca una tabella" });
    const ordine = el("select", { "aria-label": "Ordine" },
      [["leggere", "Dalle più leggere"], ["pesanti", "Dalle più pesanti"], ["righe", "Per numero di righe"], ["nome", "Per nome"]]
        .map(([v, t]) => el("option", { value: v, selected: v === ordinePeso }, t)));
    const tolte = el("input", { type: "checkbox", checked: mostraTolte });
    const corpo = el("tbody");
    const spunte = new Map();
    const togli = el("button", { class: "pericolo", disabled: true }, "Togli dall'analisi");
    const rimetti = el("button", { disabled: true }, "Rimetti nell'analisi");
    const conteggio = el("span", { class: "tenue" });

    function aggiornaPulsanti() {
      const scelte = [...spunte.entries()].filter(([, c]) => c.checked).map(([t]) => P.tabelle.find(x => x.tabella === t));
      const daTogliere = scelte.filter(t => !t.tolta).length, daRimettere = scelte.filter(t => t.tolta).length;
      togli.disabled = !daTogliere; togli.textContent = daTogliere ? `Togli dall'analisi (${daTogliere})` : "Togli dall'analisi";
      rimetti.disabled = !daRimettere; rimetti.textContent = daRimettere ? `Rimetti nell'analisi (${daRimettere})` : "Rimetti nell'analisi";
    }
    function disegna() {
      ricercaPeso = cerca.value; ordinePeso = ordine.value; mostraTolte = tolte.checked;
      const q = cerca.value.trim().toLowerCase();
      const peso = t => t.byte ?? -1;
      const righe = P.tabelle.filter(t => (!q || t.tabella.toLowerCase().includes(q)) && (tolte.checked || !t.tolta))
        .sort({ leggere: (a, b) => (a.righe ?? -1) - (b.righe ?? -1) || peso(a) - peso(b) || a.tabella.localeCompare(b.tabella),
                pesanti: (a, b) => peso(b) - peso(a) || (b.righe ?? -1) - (a.righe ?? -1),
                righe: (a, b) => (b.righe ?? -1) - (a.righe ?? -1),
                nome: (a, b) => a.tabella.localeCompare(b.tabella) }[ordine.value]);
      corpo.replaceChildren(...righe.map(t => {
        if (!spunte.has(t.tabella)) spunte.set(t.tabella, el("input", { type: "checkbox", "aria-label": `Scegli ${t.tabella}`, onchange: aggiornaPulsanti }));
        return el("tr", { class: t.tolta ? "tolta" : null },
          el("td", { class: "stretto" }, spunte.get(t.tabella)),
          el("td", {}, conDati && !t.tolta ? el("a", { href: "#", title: "Guarda i dati della tabella",
            onclick: e => { e.preventDefault(); DATI.storia = []; apriDati(t.tabella, null, false); } }, t.tabella) : t.tabella),
          el("td", { class: "numero" }, t.colonne),
          el("td", { class: "numero" }, t.righe === null ? "-" : t.righe.toLocaleString("it-IT")),
          el("td", { class: "numero" }, t.righe === 0 ? el("span", { class: "tenue" }, "vuota") : t.byte === null ? "-" : formattaByte(t.byte)),
          el("td", { class: "barra-peso" }, t.righe && t.byte ? el("div", { style: `width: ${Math.max(1, 100 * t.byte / massimo).toFixed(1)}%` }) : null),
          el("td", {}, t.tolta ? el("span", { class: "avviso-g" }, "tolta") : ""));
      }));
      conteggio.textContent = `${righe.length} tabelle su ${P.tabelle.length}`;
      aggiornaPulsanti();
    }
    const scegli = filtro => { P.tabelle.forEach(t => { if (spunte.has(t.tabella)) spunte.get(t.tabella).checked = filtro(t); }); aggiornaPulsanti(); };
    togli.addEventListener("click", () => conAttesa(async () => {
      const scelte = [...spunte.entries()].filter(([t, c]) => c.checked && !P.tabelle.find(x => x.tabella === t).tolta).map(([t]) => t);
      const r = await api("/api/togli", { tabelle: scelte });
      await dopoModifica(`Tolte ${r.tolte} tabelle dall'analisi.`);
    }));
    rimetti.addEventListener("click", () => conAttesa(async () => {
      const scelte = [...spunte.entries()].filter(([t, c]) => c.checked && P.tabelle.find(x => x.tabella === t).tolta).map(([t]) => t);
      const r = await api("/api/rimetti", { tabelle: scelte });
      await dopoModifica(`Rimesse ${r.rimesse} tabelle.`);
    }));
    let attesa = null;
    cerca.addEventListener("input", () => { clearTimeout(attesa); attesa = setTimeout(disegna, 150); });
    ordine.addEventListener("change", disegna);
    tolte.addEventListener("change", disegna);
    // tutte le spunte esistono da subito (anche per le righe nascoste dalla ricerca)
    P.tabelle.forEach(t => spunte.set(t.tabella, el("input", { type: "checkbox", "aria-label": `Scegli ${t.tabella}`, onchange: aggiornaPulsanti })));
    disegna();
    return [...intestazione,
      conDati ? el("div", { class: "pannello" },
        el("p", {}, el("b", {}, `${P.tabelle.length} tabelle`), `: ${vuote.length} vuote, ${formattaByte(totale)} di dati in tutto` +
          (P.tabelle.some(t => t.tolta) ? `, ${P.tabelle.filter(t => t.tolta).length} tolte dall'analisi.` : "."))) : serveDatabase(P.motivo),
      el("div", { class: "riga-comandi" }, cerca, ordine, el("label", {}, tolte, "mostra anche le tolte"), conteggio),
      el("div", { class: "riga-comandi" },
        el("button", { onclick: () => scegli(t => t.righe === 0 && !t.tolta), disabled: !vuote.length }, `Scegli le vuote (${vuote.length})`),
        el("button", { onclick: () => scegli(() => false) }, "Nessuna"), togli, rimetti),
      el("div", { class: "griglia-scorri" }, el("table", { class: "tabella-peso" },
        el("thead", {}, el("tr", {}, ["", "tabella", "colonne", "righe", "spazio", "", ""].map((x, i) => el("th", { class: i >= 2 && i <= 4 ? "numero" : null }, x)))), corpo)),
      P.tabelle.some(t => t.tolta) ? salvaSenzaTolte() : null,
    ];
  },

  async datitabelle() {
    const P = await api("/api/peso_tabelle");
    const intestazione = [intestazioneRichiudibile("datitabelle", "Dati delle tabelle",
      el("p", { class: "tenue" }, "Le tabelle popolate dai file della cartella: per ognuna la struttura (colonne, tipi, chiavi, a cosa è collegata), " +
        "i dati e i grafici. Clicca una riga per vedere le righe collegate: quelle a cui punta (per esempio il cliente di un ordine) e quelle " +
        "che puntano a lei (le righe dell'ordine), e seguile da una tabella all'altra."))];
    if (!P.con_dati) return [...intestazione, serveDatabase(P.motivo)];
    const analizzate = P.tabelle.filter(t => !t.tolta && t.righe !== null);
    const vuote = el("input", { type: "checkbox" });
    const cerca = el("input", { type: "search", placeholder: "cerca una tabella", "aria-label": "Cerca una tabella" });
    const elenco = el("div", { class: "reverse-elenco" });
    const destra = el("div");
    function disegnaElenco() {
      const q = cerca.value.trim().toLowerCase();
      const voci = analizzate.filter(t => (vuote.checked || t.righe > 0) && (!q || t.tabella.toLowerCase().includes(q)))
        .sort((a, b) => (b.righe > 0) - (a.righe > 0) || a.tabella.localeCompare(b.tabella));
      elenco.replaceChildren(...voci.map(t => el("a", { href: "#", class: t.tabella === DATI.tabella ? "scelta" : null,
        onclick: e => { e.preventDefault(); DATI.storia = []; apriDati(t.tabella, null, false); } },
        t.tabella, el("span", { class: "tenue" }, ` ${t.righe.toLocaleString("it-IT")}`))));
      if (!voci.length) elenco.append(el("p", { class: "tenue" }, "Nessuna tabella."));
    }
    cerca.addEventListener("input", disegnaElenco);
    vuote.addEventListener("change", disegnaElenco);
    disegnaElenco();
    if (!DATI.tabella || !analizzate.some(t => t.tabella === DATI.tabella)) {
      const prima = analizzate.find(t => t.righe > 0);
      Object.assign(DATI, { tabella: prima ? prima.tabella : null, da: 0, cerca: "", dove: null, storia: [] });
      disegnaElenco();
    }
    if (DATI.tabella) await disegnaTabella(destra);
    else destra.append(el("div", { class: "pannello" }, el("p", {}, "Nei file non ci sono dati (INSERT o COPY).")));
    return [...intestazione,
      el("div", { class: "reverse-griglia" },
        el("div", { class: "pannello reverse-laterale" }, el("h3", {}, "Tabelle"), cerca, el("label", {}, vuote, " anche le vuote"), elenco),
        destra)];
  },
});

/** Struttura, righe e collegamenti della tabella in DATI. */
/** I due pulsanti Dati / Grafici della tabella aperta. */
function sceltaVistaDati() {
  return el("div", { class: "riga-comandi" }, ...[["dati", "Dati"], ["grafici", "Grafici"]].map(([v, t]) =>
    el("button", { class: DATI.vista === v ? "primario" : null, onclick: () => { DATI.vista = v; mostra("datitabelle"); } }, t)));
}

const numeroBreve = v => {
  if (v === null || v === undefined) return "-";
  const a = Math.abs(v);
  return a >= 1e6 ? `${(v / 1e6).toLocaleString("it-IT", { maximumFractionDigits: 1 })} mln`
    : a >= 1e4 ? Math.round(v).toLocaleString("it-IT")
    : Number.isInteger(v) ? v.toLocaleString("it-IT") : v.toLocaleString("it-IT", { maximumFractionDigits: 2 });
};

/** Barre verticali (istogramma dei numeri o andamento delle date): una sola serie, barre sottili con 2px di stacco,
    angoli arrotondati solo in cima, valore al passaggio del mouse. */
function grafoColonne(barre, descrivi, sinistra, destra) {
  const L = 320, H = 120, basso = H - 18;
  const massimo = Math.max(1, ...barre.map(b => b[1]));
  const passo = L / Math.max(1, barre.length), largo = Math.max(1, passo - 2);
  const svg = svgNodo("svg", { viewBox: `0 0 ${L} ${H}`, class: "grafico-colonne", role: "img" });
  svg.append(svgNodo("line", { x1: 0, x2: L, y1: basso + 0.5, y2: basso + 0.5, class: "asse" }));
  barre.forEach(([etichetta, n], i) => {
    const h = n ? Math.max(2, (basso - 16) * n / massimo) : 0;   // in cima resta lo spazio per "max"
    const x = i * passo + 1, y = basso - h, r = Math.min(4, largo / 2, h);
    const gruppo = svgNodo("g", { class: "barra" });
    gruppo.append(svgNodo("rect", { x: i * passo, y: 0, width: passo, height: basso, fill: "transparent" }));   // area di passaggio del mouse
    if (h) gruppo.append(svgNodo("path", { d: `M${x},${basso} V${y + r} Q${x},${y} ${x + r},${y} H${x + largo - r} Q${x + largo},${y} ${x + largo},${y + r} V${basso} Z` }));
    const titolo = svgNodo("title"); titolo.textContent = descrivi(etichetta, n, i);
    gruppo.append(titolo);
    svg.append(gruppo);
  });
  const testo = (x, ancora, t) => { const n = svgNodo("text", { x, y: H - 4, "text-anchor": ancora, class: "etichetta-asse" }); n.textContent = t; return n; };
  svg.append(testo(0, "start", sinistra), testo(L, "end", destra));
  const cima = svgNodo("text", { x: 0, y: 9, class: "etichetta-asse" }); cima.textContent = `max ${numeroBreve(massimo)}`;
  svg.append(cima);
  return svg;
}
const svgNodo = (tag, attributi = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attributi)) n.setAttribute(k, v);
  return n;
};

/** Valori più frequenti come barre orizzontali; cliccando un valore si vedono le righe che lo hanno. */
function grafoValori(C, tabella) {
  const massimo = Math.max(1, ...C.barre.map(b => b[1]));
  return el("div", { class: "valori-frequenti" },
    C.barre.map(([v, n]) => el("a", { href: "#", class: "valore", title: `${v}: ${n.toLocaleString("it-IT")} righe (clicca per vederle)`,
      onclick: e => { e.preventDefault(); DATI.vista = "dati"; apriDati(tabella, { [C.colonna]: /^-?\d+(\.\d+)?$/.test(v) && C.genere !== "date" && /INT|DEC|NUM|FLOAT|DOUBLE|REAL/i.test(C.tipo) ? Number(v) : v }); } },
      el("span", { class: "nome-valore" }, v === "" ? "(vuoto)" : v),
      el("span", { class: "traccia" }, el("span", { class: "riempita", style: `width: ${(100 * n / massimo).toFixed(1)}%` })),
      el("span", { class: "conto" }, numeroBreve(n)))),
    C.altri ? el("div", { class: "valore altri" }, el("span", { class: "nome-valore" }, `altri ${numeroBreve(C.diversi - C.barre.length)} valori`),
      el("span", {}), el("span", { class: "conto" }, numeroBreve(C.altri))) : null);
}

/** La scheda di una colonna: pieni e vuoti, poi il grafico adatto al tipo. */
function schedaColonna(C, righe, tabella) {
  const pieni = righe ? 100 * C.pieni / righe : 0;
  const S = C.statistiche;
  let grafico = null, nota = "";
  if (C.genere === "chiave") nota = "Valori tutti diversi: identifica ogni riga.";
  else if (C.genere === "vuota") nota = "Sempre vuota (NULL) nei dati caricati.";
  else if (C.genere === "valori") grafico = grafoValori(C, tabella);
  else if (C.genere === "numeri") {
    nota = `da ${numeroBreve(S.minimo)} a ${numeroBreve(S.massimo)}, media ${numeroBreve(S.media)}`;
    grafico = grafoColonne(C.barre, (da, n) => `da ${numeroBreve(da)} a ${numeroBreve(da + S.larghezza)}: ${n.toLocaleString("it-IT")} righe`,
      numeroBreve(S.minimo), numeroBreve(S.massimo));
  } else if (C.genere === "date") {
    nota = `dal ${S.primo} al ${S.ultimo}, per ${S.per}`;
    grafico = grafoColonne(C.barre, (d, n) => `${d}: ${n.toLocaleString("it-IT")} righe`, C.barre[0]?.[0] || "", C.barre[C.barre.length - 1]?.[0] || "");
  }
  return el("div", { class: "pannello scheda-colonna" },
    el("div", { class: "testa-colonna" }, el("b", {}, C.colonna), " ", el("span", { class: "tenue" }, C.tipo),
      C.ruolo ? el("span", { class: "cat" }, C.ruolo) : null),
    C.verso ? el("div", { class: "tenue" }, `collegata a ${C.verso}`) : null,
    el("div", { class: "pieni-vuoti", title: `${C.pieni.toLocaleString("it-IT")} pieni, ${C.vuoti.toLocaleString("it-IT")} vuoti` },
      el("span", { class: "pieni", style: `width: ${pieni.toFixed(1)}%` })),
    el("div", { class: "tenue piccolo" }, `${pieni.toFixed(pieni % 1 ? 1 : 0)}% pieni · ${numeroBreve(C.vuoti)} vuoti · ${numeroBreve(C.diversi)} valori diversi`),
    nota ? el("div", { class: "piccolo" }, nota) : null,
    grafico);
}

/** Vista Grafici: i dati di ogni colonna della tabella, graficamente. */
async function disegnaGrafici(box) {
  box.replaceChildren(el("p", { class: "tenue" }, "Calcolo dei grafici..."));
  let G;
  try { G = await api(`/api/dati/grafici?tabella=${encodeURIComponent(DATI.tabella)}`); }
  catch (e) { box.replaceChildren(el("p", { class: "errore" }, e.message)); return; }
  const completezza = G.righe && G.colonne.length ? 100 * G.colonne.reduce((n, c) => n + c.pieni, 0) / (G.righe * G.colonne.length) : 0;
  const vuote = G.colonne.filter(c => c.genere === "vuota").length;
  box.replaceChildren(el("div", {},
    el("h3", {}, G.tabella, el("span", { class: "tenue" }, `  ${G.righe.toLocaleString("it-IT")} righe · ${G.colonne.length} colonne`)),
    sceltaVistaDati(),
    el("p", { class: "tenue" }, `Completezza dei dati: ${completezza.toFixed(0)}% delle celle è piena` + (vuote ? `; ${vuote} colonne sempre vuote` : "") +
      ". Passa il mouse sulle barre per i valori; clicca un valore frequente per vedere le righe che lo hanno."),
    G.righe ? el("div", { class: "griglia-grafici" }, G.colonne.map(C => schedaColonna(C, G.righe, G.tabella)))
      : el("p", {}, "La tabella non ha righe nei dati caricati.")));
}

async function disegnaTabella(box) {
  if (DATI.vista === "grafici") return disegnaGrafici(box);
  const parametri = new URLSearchParams({ tabella: DATI.tabella, da: DATI.da, quanti: PER_PAGINA_DATI, cerca: DATI.cerca,
                                          dove: DATI.dove ? JSON.stringify(DATI.dove) : "" });
  let T;
  try { T = await api(`/api/dati/righe?${parametri}`); }
  catch (e) { box.replaceChildren(el("p", { class: "errore" }, e.message)); return; }
  const nomi = T.colonne.map(c => c.nome);
  const collegateBox = el("div");
  const cerca = el("input", { type: "search", value: DATI.cerca, placeholder: "cerca un valore in tutte le colonne", "aria-label": "Cerca nei dati" });
  cerca.addEventListener("keydown", e => { if (e.key === "Enter") { DATI.cerca = cerca.value.trim(); DATI.da = 0; mostra("datitabelle"); } });
  const pagine = Math.max(1, Math.ceil(T.totale / PER_PAGINA_DATI)), pagina = Math.floor(T.da / PER_PAGINA_DATI);
  const vai = da => { DATI.da = da; mostra("datitabelle"); };

  async function mostraCollegate(riga) {
    collegateBox.replaceChildren(el("p", { class: "tenue" }, "Ricerca delle righe collegate..."));
    const C = await api(`/api/dati/collegate?${new URLSearchParams({ tabella: T.tabella, riga: JSON.stringify(riga) })}`);
    const condizione = d => Object.entries(d).map(([k, v]) => `${k} = ${formattaValore(v)}`).join(" e ");
    const blocco = (X, freccia) => el("div", { class: "pannello collegata" },
      el("div", { class: "riga-comandi" },
        el("b", {}, `${freccia} ${X.tabella}`),
        el("span", { class: "tenue" }, `${X.totale} ${X.totale === 1 ? "riga" : "righe"} con ${condizione(X.dove)}` +
          (X.tipo === "dichiarata" ? "" : " (collegamento trovato, non dichiarato)")),
        X.totale ? el("button", { onclick: () => apriDati(X.tabella, X.dove) }, X.totale > X.righe.length ? `Apri tutte (${X.totale})` : "Apri") : null),
      X.totale ? tabellaRighe(X.colonne, X.righe) : el("p", { class: "errore" }, "Nessuna riga: il valore non esiste nella tabella collegata (orfano)."));
    collegateBox.replaceChildren(el("div", { class: "pannello" },
      el("h3", {}, "Righe collegate"),
      !C.padri.length && !C.figlie.length ? el("p", { class: "tenue" }, "Questa tabella non ha collegamenti con le altre.") : null,
      C.padri.length ? [el("h4", {}, "A cosa punta questa riga"), C.padri.map(X => blocco(X, "→"))] : null,
      C.figlie.length ? [el("h4", {}, "Chi punta a questa riga"), C.figlie.map(X => blocco(X, "←"))] : null));
    collegateBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const struttura = el("details", { class: "pannello", open: true },
    el("summary", {}, `Struttura: ${T.colonne.length} colonne`),
    tabellaRighe(["colonna", "tipo", "chiave", "obbligatoria", "collegata a"],
      T.colonne.map(c => [c.nome, c.tipo, c.pk ? "PK" : c.verso.length ? "FK" : "", c.not_null || c.pk ? "sì" : "", c.verso.join(", ")])));
  box.replaceChildren(el("div", {},
    DATI.storia.length ? el("div", { class: "riga-comandi" },
      el("button", { onclick: () => { Object.assign(DATI, DATI.storia.pop()); mostra("datitabelle"); } }, "Indietro"),
      el("span", { class: "tenue" }, [...DATI.storia.map(s => s.tabella), T.tabella].join(" → "))) : null,
    el("h3", {}, T.tabella, el("span", { class: "tenue" }, `  ${T.totale.toLocaleString("it-IT")} righe` + (DATI.dove || DATI.cerca ? " trovate" : ""))),
    sceltaVistaDati(),
    DATI.dove ? el("div", { class: "chips" }, el("span", { class: "tenue" }, "Filtro:"),
      el("a", { href: "#", class: "chip", title: "Togli il filtro", onclick: e => { e.preventDefault(); DATI.dove = null; DATI.da = 0; mostra("datitabelle"); } },
        Object.entries(DATI.dove).map(([k, v]) => `${k} = ${formattaValore(v)}`).join(", "), "  ×")) : null,
    struttura,
    el("div", { class: "riga-comandi" }, cerca,
      el("button", { onclick: () => vai(Math.max(0, T.da - PER_PAGINA_DATI)), disabled: pagina === 0 }, "Precedente"),
      el("span", { class: "tenue" }, `pagina ${pagina + 1} di ${pagine}`),
      el("button", { onclick: () => vai(T.da + PER_PAGINA_DATI), disabled: pagina >= pagine - 1 }, "Successiva"),
      el("span", { class: "tenue" }, "clicca una riga per le righe collegate")),
    T.righe.length ? tabellaRighe(nomi, T.righe, mostraCollegate) : el("p", { class: "tenue" }, "Nessuna riga."),
    collegateBox));
}
