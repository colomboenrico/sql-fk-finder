"use strict";

// Pagina "Ascolta il database" (sqlfk/ascolto.py): legge il general log di MySQL, un file sul disco, mentre si usa il programma.
// Si dà un nome all'azione (il tasto premuto), si registra, e si vede quali query manda: tabelle, valori, JOIN, collegamenti.

const LETTERE_CRUD = { C: "inserisce", R: "legge", U: "modifica", D: "cancella" };
const USI_VALORE = { inserito: "inserito", modificato: "nuovo valore", condizione: "cercato (WHERE)" };
let azioneAperta = null;

/** Lettere CRUD come etichette colorate: C verde, R grigia, U arancione, D rossa. */
function lettereCrud(lettere) {
  if (/^(CREATE|READ|UPDATE|DELETE)$/.test(lettere)) lettere = lettere[0];
  return el("span", { class: "lettere-crud" }, [...(lettere || "")].map(l => el("b", { class: `crud-${l}`, title: LETTERE_CRUD[l] }, l)));
}

/** Ora del log senza data e decimali: 2026-10-26T13:28:26.255Z -> 13:28:26 (l'ora del log di MySQL, di solito UTC). */
function oraBreve(ora) {
  const m = String(ora || "").match(/(\d{1,2}:\d{2}:\d{2})/);
  return m ? m[1].padStart(8, "0") : String(ora || "");
}

function istruzioniMysql(file) {
  const sql = `SET GLOBAL log_output = 'FILE';\nSET GLOBAL general_log_file = '${file}';\nSET GLOBAL general_log = 'ON';`;
  const copia = el("button", { onclick: async () => {
    try { await navigator.clipboard.writeText(sql); avviso("Comandi copiati."); } catch { avviso("Selezionali e copiali a mano.", true); }
  } }, "Copia");
  return el("details", { class: "pannello" }, el("summary", {}, el("b", {}, "Come si attiva il registro delle query in MySQL")),
    el("p", {}, "MySQL può scrivere ogni query che riceve in un file di testo (general log). L'app legge solo quel file: non si collega " +
      "a MySQL e non usa la rete. Sul computer dove gira MySQL, da un utente con il permesso SUPER (per esempio root), esegui:"),
    el("pre", { class: "sql" }, sql), copia,
    el("p", {}, "Oppure, per averlo sempre, nel file my.cnf / my.ini sotto [mysqld]: ",
      el("code", {}, "general_log = 1"), " e ", el("code", {}, `general_log_file = ${file}`), " e riavvia MySQL."),
    el("p", {}, "Alla fine spegnilo, perché il file cresce a ogni query: ", el("code", {}, "SET GLOBAL general_log = 'OFF';")),
    el("p", { class: "tenue" }, "Funziona anche con MariaDB e con i log delle versioni vecchie. Il programma che studi deve usare questo " +
      "MySQL: se ha un suo database, attiva il log lì. Il dump dello stesso database, caricato nell'app, serve a confrontare " +
      "le query con lo schema (chiavi esterne dichiarate e trovate)."));
}

/** Campo per il percorso del log, con il pulsante per sceglierlo (nell'app il percorso si legge dal file scelto). */
function campoPercorso(valore, alFile) {
  const campo = el("input", { type: "text", size: 60, value: valore || "", placeholder: "/var/lib/mysql/query.log  oppure  C:\\ProgramData\\MySQL\\query.log",
    "aria-label": "Percorso del general log" });
  const scelta = el("input", { type: "file", hidden: true });
  scelta.addEventListener("change", () => {
    const f = scelta.files[0];
    if (!f) return;
    const percorso = window.sqlfkApp && window.sqlfkApp.percorso(f);
    if (percorso) campo.value = percorso;
    alFile && alFile(f, percorso);
  });
  return { campo, scelta, pulsante: el("button", { onclick: () => scelta.click() }, "Scegli il file...") };
}

function dettaglioAzione(A, ridisegna) {
  const R = A.riassunto;
  const nome = el("input", { type: "text", value: A.nome, size: 40, "aria-label": "Nome dell'azione" });
  const salvaNome = async () => {
    if (nome.value.trim() === A.nome) return;
    await api("/api/ascolto/rinomina", { indice: A.indice, nome: nome.value });
    ridisegna();
  };
  nome.addEventListener("change", salvaNome);
  const sql = A.query.filter(q => !q.tecnica);
  const tecniche = A.query.length - sql.length;
  const sequenza = el("ol", { class: "sequenza-query" }, A.query.map(q => el("li", { class: q.tecnica ? "tenue" : null },
    el("div", { class: "riga-query" }, el("span", { class: "tenue" }, `${oraBreve(q.ora)} conn. ${q.conn}`), " ",
      q.tabelle.map(([t, op]) => el("span", { class: "chip" }, `${t} `, lettereCrud(op)))),
    el("pre", { class: "sql" }, q.testo),
    q.valori.length ? el("div", { class: "tenue" }, q.valori.map((v, i) =>
      [i ? " · " : "", `${v.tabella}.${v.colonna} = `, el("b", {}, String(v.valore)), ` (${USI_VALORE[v.uso] || v.uso})`])) : null)));
  return el("div", { class: "pannello" },
    el("div", { class: "riga-comandi" }, el("b", {}, "Azione:"), nome,
      el("button", { onclick: async () => {
        if (!confirm(`Togliere l'azione «${A.nome}»?`)) return;
        await api("/api/ascolto/elimina", { indice: A.indice });
        azioneAperta = null;
        ridisegna();
      } }, "Togli l'azione")),
    el("p", {}, `${sql.length} query` + (tecniche ? ` (più ${tecniche} tecniche: transazioni, SET...)` : "") +
      (A.inizio ? `, dalle ${oraBreve(A.inizio)} alle ${oraBreve(A.fine)}` : "") + "."),
    Object.keys(R.crud).length ? el("div", { class: "riga-comandi" }, el("b", {}, "Tabelle:"),
      Object.entries(R.crud).map(([t, l]) => el("span", { class: "chip" }, `${t} `, lettereCrud(l)))) : null,
    R.join.length ? el("p", {}, el("b", {}, "JOIN: "), R.join.map(([t1, c1, t2, c2], i) => [i ? ", " : "", `${t1}.${c1} = ${t2}.${c2}`])) : null,
    R.flussi.length ? el("div", {}, el("b", {}, "Valori che passano da una tabella all'altra"),
      el("p", { class: "tenue" }, "Lo stesso valore usato in più tabelle nella stessa azione: indizio di un collegamento (chiave esterna)."),
      el("ul", {}, R.flussi.map(f => el("li", {}, el("b", {}, f.valore), ": ", f.posti.join(", "))))) : null,
    el("details", { open: sql.length <= 12 }, el("summary", {}, el("b", {}, "Le query in ordine")), sequenza));
}

Object.assign(VISTE, {
  async ascolto() {
    let S = await api("/api/ascolto");
    const percorsoLog = S.percorso || (navigator.platform.startsWith("Win") ? "C:/ProgramData/MySQL/query.log" : "/tmp/mysql_query.log");
    const intestazione = intestazioneRichiudibile("ascolto", "Ascolta il database",
      el("p", { class: "tenue" }, "Per capire cosa fa ogni tasto di un programma: mentre lo usi, l'app legge le query che il programma " +
        "manda a MySQL (dal file del general log, sullo stesso computer, senza collegarsi al database). Scrivi il nome dell'azione, " +
        "premi Inizia, fai l'azione nel programma, premi Fine: l'azione resta con le sue query, le tabelle che legge e scrive, i valori, " +
        "le JOIN e i collegamenti tra tabelle. Si può anche importare un log già registrato: le azioni si separano dalle pause."),
      istruzioniMysql(percorsoLog));

    // ---- file del log
    const P = campoPercorso(S.percorso || "");
    const dallInizio = el("input", { type: "checkbox" });
    const segui = async () => {
      try {
        S = await api("/api/ascolto/segui", { percorso: P.campo.value.trim(), dall_inizio: dallInizio.checked });
        avviso("Il file del log si legge.");
        disegnaStato();
      } catch (e) { avviso(e.message, true); }
    };
    P.campo.addEventListener("keydown", e => { if (e.key === "Enter") segui(); });
    const boxFile = el("div", { class: "pannello" }, el("h3", {}, "1. Il file del log"),
      el("div", { class: "riga-comandi" }, P.campo, P.pulsante, P.scelta, el("button", { class: "primario", onclick: segui }, "Leggi il file")),
      el("label", {}, dallInizio, " leggi anche le query già scritte (altrimenti solo quelle nuove, da adesso)"));

    // ---- registrazione
    const nomeAzione = el("input", { type: "text", size: 36, placeholder: "es. Salva ordine, Apri cliente, Stampa fattura",
      "aria-label": "Nome dell'azione" });
    const comandi = el("div", { class: "riga-comandi" });
    const statoRegistrazione = el("p", { class: "tenue" });
    const flusso = el("div", { class: "flusso-query" });
    const azioni = el("div");
    const riepilogo = el("div");

    async function comando(nome, dati = {}) {
      try {
        const r = await api(`/api/ascolto/${nome}`, dati);
        S = { ...S, ...r };
        if (nome === "fine" && r.azione !== undefined) {
          azioneAperta = r.azione;
          avviso(`Azione registrata: ${r.query} query.`);
          nomeAzione.value = "";
          disegnaAzioni();
        } else if (nome === "fine" && r.rumore !== undefined) {
          avviso(`${r.rumore} query tolte come rumore: d'ora in poi non si contano.`);
        }
        disegnaStato();
      } catch (e) { avviso(e.message, true); }
    }
    nomeAzione.addEventListener("keydown", e => { if (e.key === "Enter" && !S.in_corso) comando("inizia", { nome: nomeAzione.value }); });

    let chiaveComandi = null;
    function disegnaStato() {
      const R = S.in_corso;
      const chiave = JSON.stringify([!!S.percorso, R && R.nome, R && R.rumore, S.rumore]);
      if (chiave !== chiaveComandi) comandi.replaceChildren(
        R ? el("span", { class: "registra" }, R.rumore ? "Registro il rumore" : `Registro «${R.nome}»`) : nomeAzione,
        R ? el("button", { class: "primario", onclick: () => comando("fine") }, "Fine") :
          el("button", { class: "primario", disabled: !S.percorso, onclick: () => comando("inizia", { nome: nomeAzione.value }) }, "Inizia"),
        R ? el("button", { onclick: () => comando("annulla") }, "Annulla") :
          el("button", { disabled: !S.percorso, title: "Registra qualche secondo senza toccare il programma: le query che arrivano lo stesso " +
            "(timer, controllo delle notifiche) non si conteranno nelle azioni", onclick: () => comando("inizia", { rumore: true }) }, "Registra il rumore"),
        S.rumore ? el("button", { onclick: () => comando("dimentica_rumore"), title: "Torna a contare tutte le query" },
          `Dimentica il rumore (${S.rumore})`) : null);
      chiaveComandi = chiave;
      statoRegistrazione.textContent = !S.percorso ? "Prima scegli il file del log (punto 1)." :
        R ? `Dalle ${R.dalle}: ${R.query} query lette. Fai l'azione nel programma, poi premi Fine.` :
        `Leggo ${S.percorso}: ${S.lette} query finora.`;
      flusso.replaceChildren(...(S.ultime || []).slice().reverse().map(q => el("div",
        { class: q.rumore || q.tecnica ? "tenue" : null, title: q.rumore ? "rumore" : q.tecnica ? "query tecnica" : null },
        el("span", { class: "ora" }, oraBreve(q.ora)), " ", q.forma)));
      if (!(S.ultime || []).length) flusso.replaceChildren(el("p", { class: "tenue" }, "Le ultime query lette compariranno qui."));
    }

    async function disegnaAzioni() {
      S = await api("/api/ascolto");
      disegnaStato();
      if (!S.elenco.length) {
        azioni.replaceChildren(el("p", { class: "tenue" }, "Nessuna azione registrata."));
        riepilogo.replaceChildren();
        return;
      }
      if (azioneAperta === null || azioneAperta >= S.elenco.length) azioneAperta = S.elenco.length - 1;
      const dettaglio = el("div");
      const elenco = el("ul", { class: "elenco-azioni" }, S.elenco.map((a, i) => el("li", { class: i === azioneAperta ? "scelta" : null,
        onclick: () => { azioneAperta = i; disegnaAzioni(); } },
        el("b", {}, a.nome), el("span", { class: "tenue" }, ` ${a.query} query `),
        Object.entries(a.crud).map(([t, l]) => el("span", { class: "chip" }, `${t} `, lettereCrud(l))))));
      azioni.replaceChildren(el("div", { class: "riga-comandi" },
        el("a", { class: "pulsante", href: "/api/scarica/ascolto_excel", download: "azioni_del_programma.xlsx" }, "Scarica (Excel)"),
        el("a", { class: "pulsante", href: "/api/scarica/ascolto_md", download: "azioni_del_programma.md" }, "Scarica la specifica (Markdown)"),
        el("button", { onclick: async () => { if (confirm("Togliere tutte le azioni registrate?")) { await api("/api/ascolto/svuota", {}); disegnaAzioni(); } } },
          "Togli tutte")),
        el("div", { class: "azioni-affiancate" }, elenco, dettaglio));
      try {
        dettaglio.replaceChildren(dettaglioAzione(await api(`/api/ascolto/azione?indice=${azioneAperta}`), disegnaAzioni));
      } catch (e) { dettaglio.replaceChildren(el("p", { class: "errore" }, e.message)); }

      const M = await api("/api/ascolto/riepilogo");
      const classe = (c, v) => c !== "azione" && v ? "cella-crud" : null;
      riepilogo.replaceChildren(el("div", { class: "pannello" }, el("h3", {}, "Azioni e tabelle"),
        el("p", { class: "tenue" }, "Per ogni azione registrata, cosa fa su ogni tabella: C inserisce, R legge, U modifica, D cancella."),
        griglia({ colonne: ["azione", ...M.tabelle], righe: M.matrice }, { classiCella: classe })),
        el("div", { class: "pannello" }, el("h3", {}, "Collegamenti usati dal programma"),
          el("p", { class: "tenue" }, M.schema ? "Le colonne che il programma collega (JOIN, o lo stesso valore in due tabelle) confrontate " +
            "con le chiavi esterne del database caricato: quelle \"non trovata dall'analisi\" sono collegamenti nuovi da guardare."
            : "Le colonne che il programma collega (JOIN, o lo stesso valore in due tabelle). Carica il dump dello stesso database " +
            "per confrontarle con le chiavi esterne dichiarate e trovate."),
          M.collegamenti.length ? griglia({ colonne: ["da", "a", "nello schema", "prove"],
            righe: M.collegamenti.map(c => [c.da, c.a, c.schema, c.prove.join("; ")]) },
          { nascondi: M.schema ? [] : ["nello schema"],
            classiCella: (c, v) => c !== "nello schema" ? null : v === "dichiarata" ? "si" : v.startsWith("candidata") ? "alta" : v ? "avviso-g" : null })
            : el("p", {}, "Nessun collegamento tra tabelle nelle azioni registrate.")));
    }

    // ---- importazione di un log già registrato
    const I = campoPercorso("", (f, percorso) => { if (!percorso) fileScelto = f; });
    let fileScelto = null;
    const pausaSecondi = el("input", { type: "number", min: 0.5, step: 0.5, value: 2, style: "width: 5em", "aria-label": "Secondi di pausa" });
    const importa = async () => {
      try {
        const dati = { pausa: Number(pausaSecondi.value) || 2 };
        if (fileScelto && !I.campo.value.trim()) dati.testo = await fileScelto.text();
        else dati.percorso = I.campo.value.trim();
        const r = await conAttesa(() => api("/api/ascolto/importa", dati));
        avviso(`${r.azioni} azioni con ${r.query} query` + (r.rumore.length ? `; tolte come rumore: ${r.rumore.join(" · ")}` : "") + ".");
        azioneAperta = S.elenco ? S.elenco.length : 0;
        disegnaAzioni();
      } catch (e) { avviso(e.message, true); }
    };
    const boxImporta = el("details", { class: "pannello" }, el("summary", {}, el("b", {}, "Oppure importa un log già registrato")),
      el("p", { class: "tenue" }, "Se hai già registrato il log usando il programma, l'app lo divide in azioni: una nuova azione dopo ogni pausa " +
        "senza query. Le query che si ripetono a intervalli regolari (timer) e quelle tecniche si tolgono da sole. Poi dai un nome a ogni azione."),
      el("div", { class: "riga-comandi" }, I.campo, I.pulsante, I.scelta),
      el("div", { class: "riga-comandi" }, el("label", {}, "Nuova azione dopo ", pausaSecondi, " secondi di pausa"),
        el("button", { class: "primario", onclick: importa }, "Importa")));

    disegnaStato();
    disegnaAzioni();
    const ciclo = setInterval(async () => {
      if (!document.body.contains(flusso)) { clearInterval(ciclo); return; }
      if (!S.percorso) return;
      try {
        S = { ...S, ...(await api("/api/ascolto")) };
        disegnaStato();
      } catch { /* il server risponde al prossimo giro */ }
    }, 1000);

    return [intestazione, boxFile,
      el("div", { class: "pannello" }, el("h3", {}, "2. Registra un'azione"), comandi, statoRegistrazione,
        el("details", { open: true }, el("summary", {}, "Ultime query lette"), flusso)),
      boxImporta,
      el("h3", {}, "Azioni registrate"), azioni, riepilogo];
  },
});
