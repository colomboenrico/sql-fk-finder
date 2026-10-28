"use strict";

// Due pagine per capire una tabella alla volta:
// - "Collegamenti passo passo": si cerca una tabella e con Avanti si vede un collegamento alla volta (con chi, con quali
//   colonne, che relazione, righe di esempio), poi si può passare alla tabella collegata e continuare;
// - "Esempi dei dati": come è popolata una tabella, colonna per colonna (nome: Mirco, Giulia...) e qualche riga intera.

const STATO_PASSI = { tabella: null, passo: 0, storia: [] };
let tabellaEsempi = null;
let esempiCache = {};

const quanti = (n, uno, molti) => `${n} ${n === 1 ? uno : molti}`;

/** Campo per cercare una tabella tra tante: mostra le tabelle che contengono il testo, Invio sceglie la prima. */
function cercaTabella(nomi, alScelto, { iniziale = "", segnaposto = "cerca una tabella (es. ordini, cliente...)" } = {}) {
  const campo = el("input", { type: "search", size: 36, value: iniziale, placeholder: segnaposto, "aria-label": "Cerca una tabella" });
  const proposte = el("div", { class: "proposte-tabelle" });
  const ordinati = [...nomi].sort((a, b) => a.localeCompare(b, "it"));
  const trovate = () => {
    const testo = campo.value.trim().toLowerCase();
    if (!testo) return [];
    const esatte = ordinati.filter(n => n.toLowerCase() === testo);
    const inizio = ordinati.filter(n => n.toLowerCase().startsWith(testo) && !esatte.includes(n));
    const dentro = ordinati.filter(n => n.toLowerCase().includes(testo) && !n.toLowerCase().startsWith(testo));
    return [...esatte, ...inizio, ...dentro];
  };
  const disegna = () => {
    const T = trovate();
    proposte.replaceChildren(...(campo.value.trim() ? [
      ...T.slice(0, 40).map(n => el("a", { href: "#", class: "chip", onclick: e => { e.preventDefault(); campo.value = n; proposte.replaceChildren(); alScelto(n); } }, n)),
      T.length > 40 ? el("span", { class: "tenue" }, ` e altre ${T.length - 40}: scrivi di più`) : null,
      !T.length ? el("span", { class: "tenue" }, "Nessuna tabella con questo nome.") : null] : []));
  };
  campo.addEventListener("input", disegna);
  campo.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const T = trovate();
    if (T.length) { campo.value = T[0]; proposte.replaceChildren(); alScelto(T[0]); }
  });
  return el("div", { class: "cerca-tabella" }, campo, proposte);
}

/** I collegamenti di una tabella: prima quelli verso le tabelle da cui dipende (padri), poi quelli delle tabelle che la usano. */
function collegamentiDi(R, t) {
  const padri = R.diag.collegamenti.filter(l => l.da === t && l.a !== t);
  const figli = R.diag.collegamenti.filter(l => l.a === t && l.da !== t);
  const se = R.diag.collegamenti.filter(l => l.a === t && l.da === t);
  const ordina = (lista, altra) => lista.sort((x, y) => x[altra].localeCompare(y[altra], "it"));
  return [...ordina(padri, "a").map(l => ({ ...l, verso: "padre", altra: l.a })),
          ...ordina(figli, "da").map(l => ({ ...l, verso: "figlio", altra: l.da })),
          ...se.map(l => ({ ...l, verso: "se", altra: t }))];
}

const nomeTipo = tipo => tipo === "dichiarata" ? "chiave esterna dichiarata" : `chiave trovata dall'analisi (affidabilità ${tipo})`;

function frasePasso(l, t) {
  const coppie = l.colonne_da.map((c, i) => `${l.da}.${c} → ${l.a}.${l.colonne_a[i]}`).join(", ");
  const quante = l.relazione === "1:1" ? "al massimo una riga" : "molte righe";
  if (l.verso === "se") {
    return [el("p", {}, `«${t}» punta a se stessa: ogni riga può avere una riga «madre» nella stessa tabella (una gerarchia, `,
      "per esempio categorie e sottocategorie)."), el("p", { class: "sql-linea" }, coppie)];
  }
  if (l.verso === "padre") {
    return [el("p", {}, "Ogni riga di ", el("b", {}, t), " punta a una riga di ", el("b", {}, l.a), ` tramite ${l.colonne_da.join(", ")}. `,
      `Una riga di ${l.a} può essere usata da ${quante} di ${t}.`,
      l.obbligatoria ? " Il collegamento è obbligatorio (la colonna non può essere vuota)." : " Il collegamento è facoltativo (la colonna può essere vuota)."),
      el("p", { class: "sql-linea" }, coppie)];
  }
  return [el("p", {}, "Le righe di ", el("b", {}, l.da), " puntano a ", el("b", {}, t), ` tramite ${l.colonne_da.join(", ")}: `,
    `per ogni riga di ${t} ci possono essere ${quante} di ${l.da}.`), el("p", { class: "sql-linea" }, coppie)];
}

/** Righe di esempio di un collegamento, lette dal database delle query (se c'è). */
function esempiPasso(l, conDati) {
  const box = el("div", { class: "esempi-passo" });
  if (!conDati) {
    box.append(el("p", { class: "tenue" }, "Con un dump che contiene i dati (INSERT) qui si vedono righe di esempio del collegamento."));
    return box;
  }
  box.append(el("p", { class: "tenue" }, "Lettura degli esempi..."));
  const q = new URLSearchParams({ da: l.da, a: l.a, colonne_da: JSON.stringify(l.colonne_da), colonne_a: JSON.stringify(l.colonne_a) });
  api(`/api/esempi/collegamento?${q}`).then(E => {
    if (!E.esempi.length) {
      box.replaceChildren(el("p", { class: "tenue" }, E.provate ? `Nessuna delle ${E.provate} righe di ${l.da} provate trova la riga di ${l.a}: ` +
        "il collegamento è dubbio, o i dati sono parziali." : `Nei dati non ci sono righe di ${l.da} con ${l.colonne_da.join(", ")} pieno.`));
      return;
    }
    const percentuale = E.provate ? Math.round(100 * E.trovate / E.provate) : 0;
    box.replaceChildren(el("b", {}, "Esempi dai dati"),
      el("p", { class: percentuale >= 95 ? "tenue" : "avviso-g" }, `Su ${E.provate.toLocaleString("it-IT")} righe di ${l.da} con il valore, ` +
        `${E.trovate.toLocaleString("it-IT")} trovano la riga di ${l.a} (${percentuale}%).`),
      griglia({ colonne: E.colonne, righe: E.esempi }));
  }).catch(e => box.replaceChildren(el("p", { class: "tenue" }, e.message)));
  return box;
}

Object.assign(VISTE, {
  async passopasso() {
    const R = await datiReverse();
    const nomi = Object.keys(R.D.tabelle);
    const info = await api("/api/query/tabelle").catch(() => ({ da_costruire: true, tabelle: [] }));
    const conDati = !info.da_costruire && info.tabelle.some(t => t.righe > 0);
    const S = STATO_PASSI;
    if (S.tabella && !R.D.tabelle[S.tabella]) Object.assign(S, { tabella: null, passo: 0, storia: [] });

    const apri = (t, { nuova = true } = {}) => {
      if (nuova && S.tabella && S.tabella !== t) S.storia.push({ tabella: S.tabella, passo: S.passo });
      S.tabella = t;
      S.passo = 0;
      mostra("passopasso");
    };
    const intestazione = intestazioneRichiudibile("passopasso", "Collegamenti passo passo",
      el("p", { class: "tenue" }, "Cerca una tabella e premi Avanti: vedi un collegamento alla volta, con quale tabella, con quali colonne, " +
        "che relazione è e, se ci sono i dati, righe di esempio. Da ogni collegamento puoi passare alla tabella collegata e continuare: " +
        "il percorso fatto resta in alto. Con la tastiera: frecce sinistra e destra."),
      el("div", { class: "riga-comandi" }, el("b", {}, "Tabella:"),
        cercaTabella(nomi, t => { Object.assign(S, { storia: [] }); apri(t, { nuova: false }); }, { iniziale: S.tabella || "" })));
    if (!S.tabella) {
      return [intestazione, el("div", { class: "pannello" }, el("p", {}, "Scrivi il nome (anche una parte) di una tabella e sceglila."),
        el("p", { class: "tenue" }, "Per cominciare, le tabelle con più collegamenti:"),
        el("div", { class: "riga-comandi" }, nomi.map(n => [n, collegamentiDi(R, n).length]).sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([n, k]) => el("a", { href: "#", class: "chip", onclick: e => { e.preventDefault(); apri(n, { nuova: false }); } }, `${n} (${k})`))))];
    }

    const t = S.tabella;
    const T = R.D.tabelle[t];
    const passi = collegamentiDi(R, t);
    S.passo = Math.max(0, Math.min(S.passo, passi.length));
    const vai = k => { S.passo = k; mostra("passopasso"); };

    // percorso fatto: tabella dopo tabella
    const percorso = el("div", { class: "percorso-passi" },
      S.storia.map((h, i) => [el("a", { href: "#", onclick: e => {
        e.preventDefault(); S.storia = S.storia.slice(0, i); S.tabella = h.tabella; S.passo = h.passo; mostra("passopasso");
      } }, h.tabella), " › "]), el("b", {}, t));

    const comandi = el("div", { class: "riga-comandi comandi-passi" },
      el("button", { disabled: S.passo === 0, onclick: () => vai(S.passo - 1) }, "◀ Indietro"),
      el("span", { class: "contatore-passi" }, S.passo === 0 ? `Panoramica · ${quanti(passi.length, "collegamento", "collegamenti")}` : `Collegamento ${S.passo} di ${passi.length}`),
      el("button", { class: "primario", disabled: S.passo >= passi.length, onclick: () => vai(S.passo + 1) }, "Avanti ▶"),
      S.storia.length ? el("button", { onclick: () => { const h = S.storia.pop(); S.tabella = h.tabella; S.passo = h.passo; mostra("passopasso"); } },
        `Torna a ${S.storia[S.storia.length - 1].tabella}`) : null);

    let corpo;
    if (S.passo === 0) {
      const padri = passi.filter(l => l.verso === "padre"), figli = passi.filter(l => l.verso === "figlio");
      corpo = el("div", { class: "pannello" },
        el("h3", {}, t, " ", etichettaCategoria(T.categoria)),
        el("p", {}, T.descrizione),
        el("p", {}, passi.length ? `${quanti(passi.length, "collegamento", "collegamenti")}: dipende da ${quanti(padri.length, "tabella", "tabelle")}, ` +
          `è usata da ${quanti(figli.length, "tabella", "tabelle")}. Premi Avanti per vederli uno alla volta.`
          : "Nessun collegamento: la tabella è isolata (nessuna chiave esterna dichiarata o trovata)."),
        passi.length ? el("ol", { class: "elenco-passi" }, passi.map((l, i) => el("li", {},
          el("a", { href: "#", onclick: e => { e.preventDefault(); vai(i + 1); } },
            l.verso === "padre" ? `→ ${l.a}` : l.verso === "figlio" ? `← ${l.da}` : "↺ se stessa"),
          el("span", { class: "tenue" }, ` ${l.colonne_da.join(", ")} · ${l.relazione || ""} · ${l.tipo === "dichiarata" ? "dichiarata" : "trovata"}`)))) : null,
        diagrammaTabelle(R, [t], { selezionata: t, onClic: n => { if (n !== t) apri(n); }, altezza: 360 }));
    } else {
      const l = passi[S.passo - 1];
      const x = l.altra;
      const colonneUsate = new Set(l.verso === "padre" ? l.colonne_da : l.colonne_a);
      const significati = T.colonne.filter(c => colonneUsate.has(c.colonna));
      corpo = el("div", { class: "pannello" },
        el("h3", {}, l.verso === "padre" ? `${t} → ${x}` : l.verso === "figlio" ? `${x} → ${t}` : `${t} → ${t}`,
          " ", el("span", { class: l.tipo === "dichiarata" ? "chip dichiarata" : "chip" }, nomeTipo(l.tipo)),
          l.relazione ? el("span", { class: "chip" }, l.relazione) : null),
        frasePasso(l, t),
        significati.length ? el("p", { class: "tenue" }, significati.map(c => `${t}.${c.colonna}: ${c.significato || c.tipo}`).join(" · ")) : null,
        R.D.tabelle[x] && x !== t ? el("p", { class: "tenue" }, el("b", {}, `${x}: `), R.D.tabelle[x].descrizione) : null,
        el("div", { class: "passo-affiancato" },
          diagrammaTabelle(R, x === t ? [t] : [t, x], { vicine: false, selezionata: t, altezza: 320 }),
          esempiPasso(l, conDati)),
        x !== t ? el("div", { class: "riga-comandi" }, el("button", { onclick: () => apri(x) }, `Continua da ${x} ▶▶`),
          el("span", { class: "tenue" }, `vedi i collegamenti di ${x}; poi torni con il percorso in alto`)) : null);
    }
    const tasti = e => {
      if (!document.body.contains(comandi)) { document.removeEventListener("keydown", tasti); return; }
      if (e.target.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" && S.passo < passi.length) vai(S.passo + 1);
      if (e.key === "ArrowLeft" && S.passo > 0) vai(S.passo - 1);
    };
    document.addEventListener("keydown", tasti);
    return [intestazione, percorso, comandi, corpo];
  },

  async esempi() {
    const info = await api("/api/query/tabelle");
    const R = await datiReverse();
    const nomi = Object.keys(R.D.tabelle);
    const intestazione = intestazioneRichiudibile("esempi", "Esempi dei dati",
      el("p", { class: "tenue" }, "Come è popolata una tabella: per ogni colonna i valori che contiene davvero, i più frequenti " +
        "(per esempio nome: Mirco, Giulia, Luca), quante righe la riempiono e cosa significa probabilmente; sotto, alcune righe intere " +
        "lette come schede. I valori vengono dagli INSERT e COPY dei file (le prime 2000 righe di ogni tabella)."),
      el("div", { class: "riga-comandi" }, el("b", {}, "Tabella:"),
        cercaTabella(nomi, t => { tabellaEsempi = t; mostra("esempi"); }, { iniziale: tabellaEsempi || "" })));
    if (info.da_costruire) return [intestazione, paginaDatabaseDaCostruire(info)];
    const popolate = info.tabelle.filter(t => t.righe > 0);
    if (!popolate.length) return [intestazione, el("div", { class: "messaggio" },
      "Nei file non ci sono dati (INSERT o COPY): gli esempi servono un dump con i dati.")];
    if (!tabellaEsempi || !R.D.tabelle[tabellaEsempi]) {
      return [intestazione, el("div", { class: "pannello" }, el("p", {}, "Scegli una tabella. Le tabelle con più righe:"),
        el("div", { class: "riga-comandi" }, [...popolate].sort((a, b) => b.righe - a.righe).slice(0, 20).map(t =>
          el("a", { href: "#", class: "chip", onclick: e => { e.preventDefault(); tabellaEsempi = t.tabella; mostra("esempi"); } },
            `${t.tabella} (${t.righe.toLocaleString("it-IT")})`))))];
    }
    const chiave = `${stato.origine}|${tabellaEsempi}`;
    let E;
    try {
      E = esempiCache[chiave] || (esempiCache[chiave] = await api(`/api/esempi?tabella=${encodeURIComponent(tabellaEsempi)}`));
    } catch (e) {
      return [intestazione, el("div", { class: "messaggio" }, e.message)];
    }
    const T = R.D.tabelle[E.tabella] || R.D.tabelle[tabellaEsempi];
    const significato = Object.fromEntries((T?.colonne || []).map(c => [c.colonna, c.significato]));
    if (!E.righe) return [intestazione, el("div", { class: "pannello" }, el("h3", {}, E.tabella),
      el("p", {}, "La tabella è vuota nei file: nessun INSERT o COPY. Forse non è usata, o i suoi dati non sono nel dump.")),
      ];
    const percento = n => `${Math.round(100 * n / E.campione)}%`;
    const righe = E.colonne.map(c => el("tr", {},
      el("td", {}, el("b", {}, c.colonna), c.ruolo ? el("span", { class: "chip" }, c.ruolo) : null),
      el("td", { class: "tenue" }, c.tipo || ""),
      el("td", { class: "tenue" }, c.verso ? `→ ${c.verso}` : significato[c.colonna] || ""),
      el("td", {}, c.esempi.length ? c.esempi.map(([v, n]) => el("span", { class: "valore-esempio", title: `${n} righe` },
        v, n > 1 ? el("small", {}, ` ×${n}`) : null)) : el("span", { class: "tenue" }, "sempre vuota")),
      el("td", { class: "tenue numero" }, `${percento(c.pieni)} piene · ${c.diversi.toLocaleString("it-IT")} valori diversi`)));
    return [intestazione,
      el("div", { class: "pannello" },
        el("h3", {}, E.tabella, T ? [" ", etichettaCategoria(T.categoria)] : null),
        T ? el("p", {}, T.descrizione) : null,
        el("p", { class: "tenue" }, `${E.righe.toLocaleString("it-IT")} righe` +
          (E.campione < E.righe ? `: gli esempi vengono dalle prime ${E.campione.toLocaleString("it-IT")}.` : ".")),
        el("div", { class: "riga-comandi" },
          el("button", { onclick: () => { STATO_PASSI.tabella = E.tabella; STATO_PASSI.passo = 0; STATO_PASSI.storia = []; mostra("passopasso"); } },
            "Collegamenti passo passo"),
          el("button", { onclick: () => { Object.assign(DATI, { tabella: E.tabella, da: 0, cerca: "", dove: null, vista: "dati" }); DATI.storia = []; mostra("datitabelle"); } },
            "Tutte le righe"))),
      el("div", { class: "griglia" }, el("div", { class: "griglia-scorri" }, el("table", { class: "tabella-esempi" },
        el("thead", {}, el("tr", {}, ["colonna", "tipo", "significato", "valori più frequenti", "riempimento"].map(x => el("th", {}, x)))),
        el("tbody", {}, righe)))),
      el("h3", {}, "Righe di esempio"),
      el("div", { class: "schede-esempio" }, E.schede.map(r => el("div", { class: "pannello scheda-esempio" },
        E.etichetta && r[E.etichetta] ? el("h4", {}, String(r[E.etichetta])) : null,
        el("dl", {}, Object.entries(r).map(([k, v]) => [el("dt", {}, k),
          el("dd", { class: v === null || v === "" ? "tenue" : null }, v === null ? "(vuoto)" : String(v))])))))];
  },
});
