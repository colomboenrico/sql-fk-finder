"use strict";

// Pagina "Popola e verifica": riempie il database di prova (creato dallo schema dell'editor) con dati finti ma credibili,
// rispettando tipi e chiavi, verifica che le chiavi esterne funzionino (orfani, rifiuto di un figlio senza padre,
// cancellazione di un padre usato) e permette le query di prova. Tutto in locale (sqlfk/popola.py).

const STATO_POPOLA = { scelte: null, righe: 20, conPadri: true, query: "" };

Object.assign(VISTE, {
  async popola() {
    const S = await api("/api/prova/struttura");
    const intestazione = intestazioneRichiudibile("popola", "Popola e verifica",
      el("p", { class: "tenue" }, "Riempi le tabelle con dati di prova credibili (nomi, città, email, codici, prezzi, date, posizioni) che rispettano " +
        "tipi, chiavi primarie, UNIQUE, NOT NULL e chiavi esterne: i valori delle chiavi esterne si prendono dalle righe che esistono nella tabella " +
        "collegata (le tabelle padre vuote si riempiono prima). Poi verifica i collegamenti e prova le query. Si lavora sul database di prova " +
        "creato dallo schema dell'editor: i file caricati non cambiano e non si usa la rete."),
      el("div", { class: "riga-comandi" },
        el("button", { class: S.esiste ? null : "primario", onclick: creaDaEditor }, S.esiste ? "Ricrea dal disegno dell'editor" : "Crea il database di prova dal disegno dell'editor"),
        el("button", { onclick: () => mostra("editor") }, "Vai all'editor"),
        S.esiste ? el("a", { class: "pulsante", href: "/api/scarica/prova_sqlite", download: "prova.sqlite" }, "Scarica prova.sqlite") : null));

    async function creaDaEditor() {
      if (!modelloEditor.entita.length) return avviso("Il disegno dell'editor è vuoto: disegna o importa delle tabelle.", true);
      if (S.esiste && S.tabelle.some(t => t.righe) && !confirm("Il database di prova ha già delle righe: ricrearlo dal disegno (le righe si perdono)?")) return;
      try {
        await conAttesa(() => api("/api/prova/crea", { sql: Editor.sql(modelloEditor, { on_delete: stato.impostazioni?.on_delete || "", on_update: stato.impostazioni?.on_update || "" },
          stato.impostazioni?.dialetto || "mysql"), dialetto: stato.impostazioni?.dialetto || "mysql", con_dati: false }));
        avviso("Database di prova creato dal disegno: ora popolalo.");
        mostra("popola");
      } catch (e) { avviso(e.message, true); }
    }
    if (!S.esiste) return [intestazione, el("div", { class: "messaggio" }, "Il database di prova non c'è ancora: crealo dal disegno dell'editor con il pulsante qui sopra.")];

    // ---- scelta delle tabelle
    const nomi = S.tabelle.map(t => t.nome);
    if (!STATO_POPOLA.scelte) STATO_POPOLA.scelte = new Set(nomi);
    STATO_POPOLA.scelte = new Set([...STATO_POPOLA.scelte].filter(n => nomi.includes(n)));
    const fkDi = Object.fromEntries(S.tabelle.map(t => [t.nome, t.fk.map(f => f.a)]));
    const spunte = el("div", { class: "scelta-import" }, S.tabelle.map(t => {
      const c = el("input", { type: "checkbox", checked: STATO_POPOLA.scelte.has(t.nome) });
      c.addEventListener("change", () => { if (c.checked) STATO_POPOLA.scelte.add(t.nome); else STATO_POPOLA.scelte.delete(t.nome); });
      return el("label", { title: fkDi[t.nome].length ? `punta a ${fkDi[t.nome].join(", ")}` : "non punta ad altre tabelle" }, c, ` ${t.nome} `,
        el("small", { class: "tenue" }, `(${t.righe})`));
    }));
    const righe = el("input", { type: "number", min: 1, max: 5000, value: STATO_POPOLA.righe, style: "width: 6em", "aria-label": "Righe per tabella" });
    righe.addEventListener("change", () => { STATO_POPOLA.righe = Number(righe.value) || 20; });
    const padri = el("input", { type: "checkbox", checked: STATO_POPOLA.conPadri });
    padri.addEventListener("change", () => { STATO_POPOLA.conPadri = padri.checked; });
    const esitoPopola = el("div");
    const esitoVerifica = el("div");

    async function popola() {
      const scelte = [...STATO_POPOLA.scelte];
      if (!scelte.length) return avviso("Spunta almeno una tabella.", true);
      try {
        const R = await conAttesa(() => api("/api/popola/popola", { tabelle: scelte, righe: STATO_POPOLA.righe, con_padri: STATO_POPOLA.conPadri }));
        metti(esitoPopola, el("div", { class: "pannello" }, el("h3", {}, "Righe inserite"),
          R.aggiunte.length ? el("p", { class: "tenue" }, `Riempite anche le tabelle a cui puntano le chiavi esterne: ${R.aggiunte.join(", ")}.`) : null,
          griglia({ colonne: ["tabella", "inserite", "scartate", "righe in tutto", "perché scartate"],
            righe: R.tabelle.map(t => [t.tabella + (t.padre ? " (padre)" : ""), t.inserite, t.scartate, t.totale,
              Object.entries(t.motivi).map(([m, n]) => `${m} (${n})`).join("; ")]) })));
        avviso(`Inserite ${R.tabelle.reduce((n, t) => n + t.inserite, 0)} righe.`);
        await verifica();
      } catch (e) { avviso(e.message, true); }
    }
    async function svuota() {
      const scelte = [...STATO_POPOLA.scelte];
      if (!scelte.length || !confirm(`Cancellare le righe di ${scelte.length} tabelle del database di prova?`)) return;
      try { await api("/api/popola/svuota", { tabelle: scelte }); avviso("Tabelle svuotate."); mostra("popola"); } catch (e) { avviso(e.message, true); }
    }
    async function verifica() {
      try {
        metti(esitoVerifica, el("p", { class: "tenue" }, "Verifica delle chiavi esterne..."));
        const V = await api("/api/popola/verifica", {});
        const segno = v => v === true ? "sì" : v === false ? "no" : "–";
        metti(esitoVerifica, el("div", { class: "pannello" }, el("h3", {}, "Verifica dei collegamenti"),
          el("p", {}, el("b", {}, V.sintesi)),
          el("p", { class: "tenue" }, "Per ogni chiave esterna: righe collegate e orfane; se il database rifiuta un figlio con un padre che non c'è; cosa " +
            "succede cancellando un padre usato. Le prove di inserimento e cancellazione si annullano subito: i dati restano come sono."),
          V.chiavi.length ? V.chiavi.map(k => el("div", { class: `consiglio consiglio-${k.esito === "ok" ? "ok" : k.esito === "problema" ? "errore" : "avviso"}` },
            el("div", { class: "riga-titolo-consiglio" },
              el("span", { class: k.esito === "ok" ? "si" : k.esito === "problema" ? "errore" : "avviso-g" }, k.esito === "ok" ? "funziona" : k.esito),
              el("b", {}, `${k.da}(${k.colonne_da.join(", ")}) → ${k.a}(${k.colonne_a.join(", ")})`),
              k.on_delete && k.on_delete !== "NO ACTION" ? el("span", { class: "chip" }, `ON DELETE ${k.on_delete}`) : null),
            el("p", {}, `${k.collegate} righe collegate, ${k.orfani} orfane, ${k.nulle} senza valore. ` +
              `Un figlio con un padre che non esiste è rifiutato: ${segno(k.rifiuta_orfano)}. ` +
              (k.cancellazione ? `Cancellare un padre usato: ${k.cancellazione}.` : "")),
            k.problemi.length ? el("p", { class: "errore" }, k.problemi.join("; ")) : null,
            k.esempi.length ? el("details", {}, el("summary", { class: "tenue" }, "Righe collegate di esempio"),
              griglia({ colonne: k.colonne_esempi, righe: k.esempi })) : null))
            : el("p", { class: "tenue" }, "Nel database di prova non ci sono chiavi esterne: collega le entità nell'editor e ricrealo.")));
      } catch (e) { metti(esitoVerifica, el("pre", { class: "errore" }, e.message)); }
    }

    // ---- query di prova
    const testo = el("textarea", { class: "editor-sql", rows: 5, spellcheck: "false", "aria-label": "Query di prova" });
    testo.value = STATO_POPOLA.query || (S.tabelle[0] ? `SELECT * FROM ${S.tabelle[0].nome} LIMIT 20;` : "");
    const risultato = el("div");
    const eseguiQuery = async () => {
      STATO_POPOLA.query = testo.value;
      try {
        const R = await api("/api/prova/query", { sql: testo.value });
        metti(risultato, R.colonne.length ? griglia({ colonne: R.colonne, righe: R.righe }) : el("p", {}, `Fatto: ${R.modificate} righe cambiate.`));
      } catch (e) { metti(risultato, el("pre", { class: "errore" }, e.message)); }
    };
    testo.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); eseguiQuery(); } });
    // query pronte: una JOIN per ogni chiave esterna, e il conteggio dei figli per padre
    const pronte = S.tabelle.flatMap(t => t.fk.map(f => {
      const on = f.colonne_da.map((c, i) => `c.${c} = p.${f.colonne_a[i]}`).join(" AND ");
      return [[`${t.nome} con ${f.a}`, `SELECT c.*, p.*\nFROM ${t.nome} c\nJOIN ${f.a} p ON ${on}\nLIMIT 20;`],
              [`quanti ${t.nome} per ${f.a}`, `SELECT p.*, COUNT(c.${f.colonne_da[0]}) AS quanti_${t.nome}\nFROM ${f.a} p\nLEFT JOIN ${t.nome} c ON ${on}\n` +
                `GROUP BY ${f.colonne_a.map(x => "p." + x).join(", ")}\nORDER BY quanti_${t.nome} DESC\nLIMIT 20;`]];
    })).flat().slice(0, 12);
    const esempi = el("div", { class: "riga-comandi" }, el("span", { class: "tenue" }, "Query pronte:"),
      pronte.map(([nome, sql]) => el("button", { onclick: () => { testo.value = sql; eseguiQuery(); } }, nome)));

    setTimeout(verifica, 0);
    return [intestazione,
      el("div", { class: "pannello" }, el("h3", {}, "1. Popola le tabelle"),
        el("div", { class: "riga-comandi" },
          el("button", { onclick: () => { STATO_POPOLA.scelte = new Set(nomi); mostra("popola"); } }, "Tutte"),
          el("button", { onclick: () => { STATO_POPOLA.scelte = new Set(); mostra("popola"); } }, "Nessuna")),
        spunte,
        el("div", { class: "riga-comandi" }, el("label", {}, righe, " righe per tabella"),
          el("label", {}, padri, " riempi anche le tabelle a cui puntano (se sono vuote)"),
          el("button", { class: "primario", onclick: popola }, "Popola"),
          el("button", { onclick: svuota }, "Svuota le scelte"),
          el("button", { onclick: verifica }, "Verifica i collegamenti"))),
      esitoPopola,
      esitoVerifica,
      el("div", { class: "pannello" }, el("h3", {}, "2. Query di prova"),
        el("p", { class: "tenue" }, "SQL (SQLite) sul database di prova: SELECT per guardare i dati, anche INSERT, UPDATE e DELETE per provare i vincoli " +
          "(le chiavi esterne sono attive). Ctrl+Invio (Cmd+Invio) per eseguire."),
        pronte.length ? esempi : null,
        el("div", { class: "colonne-prova" }, S.tabelle.map(t => el("div", {}, el("b", {}, t.nome), ": ",
          t.colonne.map((c, i) => [i ? ", " : "", el("a", { href: "#", onclick: ev => { ev.preventDefault(); testo.setRangeText(`${t.nome}.${c.nome}`, testo.selectionStart, testo.selectionEnd, "end"); testo.focus(); } }, c.nome)])))),
        testo,
        el("div", { class: "riga-comandi" }, el("button", { class: "primario", onclick: eseguiQuery }, "Esegui")),
        risultato),
    ];
  },
});
