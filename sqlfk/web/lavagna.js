"use strict";

// Pagina "Disegno affiancato": a sinistra il diagramma del database caricato, a destra una lavagna bianca
// (lo stesso editor della pagina Editor del database) dove copiare le tabelle e migliorare il disegno.
// Il disegno si scarica in un file .json e si riapre per continuare; si salva anche nel file di progetto.

const FORMATO_LAVAGNA = "sqlfk-lavagna";
const STATO_LAVAGNA = { modello: Editor.nuovoModello(), selezione: null, vista: null };
const sceltePerLavagna = new Set();          // tabelle del database selezionate da copiare
let ricercaLavagna = { entita: "", attributo: "", collegate: false };

/** Il disegno della lavagna come file da salvare. */
function fileLavagna() {
  return JSON.stringify({ formato: FORMATO_LAVAGNA, versione: 1, salvato: new Date().toISOString(),
                          origine: stato.origine || null, modello: STATO_LAVAGNA.modello }, null, 1);
}

/** Legge un disegno salvato (o un progetto .sqlfk, di cui prende la lavagna). */
function leggiLavagna(testo) {
  let dati;
  try { dati = JSON.parse(testo); } catch { throw new Error("Il file non è un disegno valido."); }
  const modello = dati.formato === FORMATO_LAVAGNA ? dati.modello : dati.lavagna || null;
  if (!modello || !Array.isArray(modello.entita) || !Array.isArray(modello.relazioni)) {
    throw new Error("Il file non contiene un disegno della lavagna.");
  }
  // il contatore degli id deve stare oltre quelli usati, per le entità aggiunte dopo
  const usati = [...modello.entita, ...modello.relazioni].map(x => Number(String(x.id).replace(/^n/, ""))).filter(isFinite);
  modello.prossimo = Math.max(modello.prossimo || 1, ...usati.map(n => n + 1), 1);
  return modello;
}

Object.assign(VISTE, {
  async lavagna() {
    const E = creaEditor(STATO_LAVAGNA);
    const M = () => STATO_LAVAGNA.modello;
    const apri = el("input", { type: "file", accept: ".json,.sqlfk", hidden: true });
    apri.addEventListener("change", async ev => {
      const f = ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      try {
        const modello = leggiLavagna(await f.text());
        if (M().entita.length && !confirm("La lavagna contiene già un disegno: sostituirlo con quello del file?")) return;
        STATO_LAVAGNA.modello = modello;
        E.ricarica();
        avviso(`Disegno ${f.name} aperto: ${modello.entita.length} entità.`);
      } catch (e) {
        avviso(e.message, true);
      }
    });
    const salva = () => {
      if (E.diagramma) E.ridisegna();            // le posizioni trascinate entrano nel modello
      const nome = (stato.caricato ? nomeProgetto().replace(/\.sqlfk$/, "") + "_" : "") + "lavagna.json";
      scaricaBlob(new Blob([fileLavagna()], { type: "application/json" }), nome);
      avviso("Disegno salvato: riaprilo con Apri un disegno per continuare.");
    };
    const lavagna = el("div", { class: "pannello lavagna-lato" },
      el("div", { class: "riga-comandi" }, el("h3", { class: "titolo-file" }, "Lavagna"),
        el("span", { class: "tenue" }, "clicca un'entità per modificarla, trascinala per spostarla")),
      el("div", { class: "riga-comandi" },
        E.nomeNuova, el("button", { class: "primario", onclick: E.nuovaEntita }, "Nuova entità"), E.pulsanteCollega,
        el("button", { onclick: () => E.diagramma && E.diagramma.adatta() }, "Adatta"),
        el("button", { onclick: () => { if (!M().entita.length || confirm("Cancellare il disegno della lavagna?")) E.azzera(); } }, "Svuota")),
      el("div", { class: "riga-comandi" },
        el("button", { class: "primario", onclick: salva }, "Scarica il disegno"),
        el("label", { class: "pulsante" }, "Apri un disegno", apri),
        el("button", { onclick: () => scaricaBlob(new Blob([Editor.sql(M(), E.regole(), E.dialetto())], { type: "application/sql" }), "lavagna.sql") }, "Scarica SQL"),
        el("button", { onclick: () => E.diagramma && conAttesa(async () => scaricaBlob(await E.diagramma.png(), "lavagna.png")) }, "Scarica PNG"),
        el("button", { title: "Copia il disegno nella pagina Editor del database (per analizzarlo come un database caricato)", onclick: () => {
          if (!M().entita.length) return avviso("La lavagna è vuota.", true);
          if (modelloEditor.entita.length && !confirm("L'Editor del database contiene già un disegno: sostituirlo con quello della lavagna?")) return;
          E.ridisegna();
          modelloEditor = JSON.parse(JSON.stringify(M()));
          selezioneEditor = null; vistaEditor = null;
          avviso("Disegno copiato nell'Editor del database.");
        } }, "Porta nell'Editor")),
      E.statoCollega, E.avvisiBox, E.cornice);

    const sinistra = el("div", { class: "pannello lavagna-lato" });
    const dettagli = el("div", { class: "lavagna-dettagli" },
      el("div", { class: "pannello" }, el("h3", {}, "Entità scelta nella lavagna"), E.pannello),
      el("details", { class: "pannello" }, el("summary", {}, "Codice SQL della lavagna"), E.anteprima));
    setTimeout(E.ridisegna, 0);
    if (stato.caricato) await disegnaSinistra(sinistra, E);
    else sinistra.append(el("h3", {}, "Database caricato"),
      el("p", { class: "tenue" }, "Carica i file .sql in alto per vedere qui il diagramma del database e copiarne le tabelle. " +
        "La lavagna si può usare anche da sola, o riaprendo un disegno salvato."));
    return [
      el("datalist", { id: "tipi-sql" }, Editor.TIPI.map(t => el("option", { value: t }))),
      intestazioneRichiudibile("lavagna", "Disegno affiancato",
        el("p", { class: "tenue" }, "A sinistra il diagramma del database caricato, a destra una lavagna bianca. Clicca le tabelle a sinistra per " +
          "sceglierle e copiale nella lavagna con le loro colonne e i collegamenti; poi spostale, rinominale, aggiungi o togli attributi, " +
          "entità e relazioni. Scarica il disegno per riaprirlo e continuarlo più tardi (si salva anche con Salva progetto).")),
      el("div", { class: "lavagna-griglia" }, sinistra, lavagna),
      dettagli,
    ];
  },
});

/** Il diagramma del database caricato con la ricerca e la scelta delle tabelle da copiare. */
async function disegnaSinistra(box, E) {
  const dati = await api("/api/diagramma?tipo=collegamenti");
  const esistenti = new Set(dati.tabelle.map(t => t.nome));
  [...sceltePerLavagna].forEach(t => { if (!esistenti.has(t)) sceltePerLavagna.delete(t); });
  const cornice = el("div", { class: "er-cornice" });
  const cercaE = el("input", { type: "search", value: ricercaLavagna.entita, placeholder: "tabella / entità", "aria-label": "Cerca una tabella" });
  const cercaA = el("input", { type: "search", value: ricercaLavagna.attributo, placeholder: "attributo", "aria-label": "Cerca un attributo" });
  const collegate = el("input", { type: "checkbox", checked: ricercaLavagna.collegate });
  const conCollegate = el("input", { type: "checkbox" });
  const conteggio = el("span", { class: "tenue" });
  const copia = el("button", { class: "primario" }, "Copia nella lavagna");
  // posizioni e vista del diagramma completo (con una ricerca il diagramma si ridispone solo per quella volta)
  let diagramma = null, posizioni = {}, vista = null, visibili = [], trovateEntita = new Set(), filtrato = false;

  const vicine = nomi => {
    const tutte = new Set(nomi);
    dati.collegamenti.forEach(l => { if (nomi.has(l.da)) tutte.add(l.a); if (nomi.has(l.a)) tutte.add(l.da); });
    return tutte;
  };
  function disegna() {
    if (diagramma && !filtrato) { posizioni = { ...posizioni, ...diagramma.posizioni() }; vista = diagramma.vista(); }
    const e = cercaE.value.trim().toLowerCase(), a = cercaA.value.trim().toLowerCase();
    ricercaLavagna = { entita: cercaE.value, attributo: cercaA.value, collegate: collegate.checked };
    let nomi = new Set(dati.tabelle.filter(t => (!e || t.nome.toLowerCase().includes(e) || trovateEntita.has(t.nome))
      && (!a || t.colonne.some(c => c.nome.toLowerCase().includes(a)))).map(t => t.nome));
    if ((e || a) && collegate.checked) nomi = vicine(nomi);
    visibili = dati.tabelle.filter(t => nomi.has(t.nome));
    const tabelle = visibili.map(t => sceltePerLavagna.has(t.nome) ? { ...t, gruppo: "scelta per la lavagna" } : t);
    filtrato = !!(e || a);
    if (!tabelle.length) { diagramma = null; cornice.replaceChildren(el("div", { class: "messaggio", style: "margin: 16px" }, "Nessuna tabella con questa ricerca.")); }
    else {
      diagramma = DiagrammaER.crea(cornice, { tabelle, collegamenti: dati.collegamenti }, {
        tipi: true, colonne: a || null, posizioni: filtrato ? {} : posizioni, vista: filtrato ? null : vista,
        onClic: nome => {
          if (!nome) return;
          sceltePerLavagna.has(nome) ? sceltePerLavagna.delete(nome) : sceltePerLavagna.add(nome);
          disegna();
        },
        onSposta: (nome, x, y) => { if (!filtrato) posizioni[nome] = [x, y]; },
      });
    }
    const n = sceltePerLavagna.size;
    copia.textContent = n ? `Copia nella lavagna (${n})` : "Copia nella lavagna";
    copia.disabled = !n;
    conteggio.textContent = `${visibili.length} tabelle su ${dati.tabelle.length}` + (n ? ` · ${n} scelte` : "");
  }
  let attesa = null;
  const cerca = () => { clearTimeout(attesa); attesa = setTimeout(async () => {
    const e = cercaE.value.trim();
    trovateEntita = new Set();
    if (e) {
      const r = await api(`/api/cerca_entita?parola=${encodeURIComponent(e)}`).catch(() => ({ tabelle: [], uguali: [], contengono: [] }));
      trovateEntita = new Set([...r.tabelle, ...(r.uguali || []), ...(r.contengono || [])]);
    }
    disegna();
  }, 250); };
  cercaE.addEventListener("input", cerca);
  cercaA.addEventListener("input", cerca);
  collegate.addEventListener("change", disegna);
  copia.addEventListener("click", () => {
    const dove = diagramma ? { ...posizioni, ...diagramma.posizioni() } : posizioni;
    let nomi = new Set(sceltePerLavagna);
    if (conCollegate.checked) nomi = vicine(nomi);
    E.ridisegna();                                  // le posizioni trascinate nella lavagna restano
    const r = Editor.copiaTabelle(STATO_LAVAGNA.modello, dati, [...nomi], dove);
    sceltePerLavagna.clear();
    E.ricarica();
    disegna();
    avviso(`Copiate ${r.copiate.length} tabelle e ${r.relazioni} collegamenti nella lavagna.` +
      (r.saltate.length ? ` Già presenti (non copiate): ${r.saltate.join(", ")}.` : ""));
  });
  box.append(
    el("div", { class: "riga-comandi" }, el("h3", { class: "titolo-file" }, "Database caricato"),
      el("span", { class: "tenue" }, "clicca le tabelle da copiare")),
    el("div", { class: "riga-comandi" }, cercaE, cercaA, el("label", {}, collegate, "anche le collegate")),
    el("div", { class: "riga-comandi" }, copia,
      el("label", {}, conCollegate, "con le tabelle collegate"),
      el("button", { onclick: () => { visibili.forEach(t => sceltePerLavagna.add(t.nome)); disegna(); } }, "Scegli le visibili"),
      el("button", { onclick: () => { sceltePerLavagna.clear(); disegna(); } }, "Nessuna"),
      conteggio),
    cornice);
  if (ricercaLavagna.entita) cerca();
  else setTimeout(disegna, 0);
}
