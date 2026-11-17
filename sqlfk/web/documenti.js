"use strict";

// Due pagine sul database che si sta costruendo (il disegno dell'editor) o su quello caricato:
// - "Documentazione": cosa rappresenta ogni tabella, il significato delle colonne, come sono collegate (con i nomi e le
//   cardinalità delle relazioni disegnate), il filo logico; da scaricare in HTML o Markdown;
// - "Suggerimenti": cosa migliorare, perché e come (con l'SQL e, nel disegno dell'editor, Applica). Tutto con regole
//   locali (sqlfk/consigli.py e sqlfk/descrizione.py): niente rete, niente servizi esterni.

const STATO_DOCUMENTI = { origine: null, gravita: "tutte", cerca: "" };

/** Da quale database: il disegno dell'editor (se c'è) o quello caricato. */
function sceltaOrigine(pagina) {
  const entita = modelloEditor.entita.length;
  if (!STATO_DOCUMENTI.sceltaUtente || (STATO_DOCUMENTI.origine === "caricato" && !stato.caricato)) {
    STATO_DOCUMENTI.origine = entita ? "editor" : stato.caricato ? "caricato" : "editor";
  }
  const s = el("select", { "aria-label": "Quale database" },
    el("option", { value: "editor", selected: STATO_DOCUMENTI.origine === "editor" }, `il database che stai costruendo nell'editor (${entita} entità)`),
    stato.caricato ? el("option", { value: "caricato", selected: STATO_DOCUMENTI.origine === "caricato" },
      `il database caricato (${stato.tabelle_analizzate} tabelle)`) : null);
  s.addEventListener("change", () => { STATO_DOCUMENTI.origine = s.value; STATO_DOCUMENTI.sceltaUtente = true; mostra(pagina); });
  return s;
}

function richiestaOrigine(E = null) {
  return STATO_DOCUMENTI.origine === "caricato" ? { origine: "caricato" }
    : { origine: "editor", sql: Editor.sql(modelloEditor, { on_delete: stato.impostazioni?.on_delete || "", on_update: stato.impostazioni?.on_update || "" },
        stato.impostazioni?.dialetto || "mysql"), dialetto: stato.impostazioni?.dialetto || "mysql" };
}

/** Le relazioni disegnate nell'editor dette a parole, con il nome (il verbo del rombo) e le cardinalità (min,max). */
function frasiRelazioniEditor() {
  const M = modelloEditor;
  return M.relazioni.map(r => {
    const A = Editor.entitaDi(M, r.da), B = Editor.entitaDi(M, r.a);
    if (!A || !B) return null;
    const verbo = r.verbo ? `«${r.verbo}»` : "è collegata a";
    if (r.tipo === "N:M") {
      return `${A.nome} (0,N) ${verbo} (0,N) ${B.nome}: ogni ${A.nome} può avere molti ${B.nome} e ogni ${B.nome} molti ${A.nome} ` +
        `(tabella ponte ${r.nome}${(r.attributi || []).length ? `, con ${r.attributi.map(a => a.nome).join(", ")}` : ""}).`;
    }
    const cf = r.obbligatoria ? "(1,1)" : "(0,1)", cp = r.tipo === "1:1" ? "(0,1)" : "(0,N)";
    return `${A.nome} ${cf} ${verbo} ${cp} ${B.nome}: ogni ${A.nome} ha ${r.obbligatoria ? "esattamente un" : "al massimo un"} ${B.nome}; ` +
      `un ${B.nome} può avere ${r.tipo === "1:1" ? "al massimo un" : "molti"} ${A.nome}. Chiave esterna: ${A.nome}(${r.colonne_da.join(", ")}) → ` +
      `${B.nome}(${r.colonne_a.join(", ")}).`;
  }).filter(Boolean);
}

function frasiRelazioniCaricato(D) {
  const frasi = [];
  for (const t of Object.values(D.tabelle)) {
    for (const p of t.padri) frasi.push(`${t.tabella} → ${p.tabella} (${p.colonne.join(", ")}, ${p.relazione || "1:N"}, ${p.tipo === "dichiarata" ? "dichiarata" : "trovata"})`);
  }
  return frasi;
}

function markdownDocumentazione(D, relazioni, titolo) {
  const righe = [`# ${titolo}`, "", `_Creata da SQL FK Finder il ${new Date().toLocaleString("it-IT")}_`, "", D.sintesi, "", "## Relazioni", "",
    ...(relazioni.length ? relazioni.map(f => `- ${f}`) : ["Nessuna relazione."]), "", "## Il filo logico", ""];
  for (const a of D.filo) {
    righe.push(`### Area ${a.area}`, "", a.introduzione, "", ...a.passi.map((p, i) => `${i + 1}. **${p.tabella}** (${p.categoria}): ${p.frase}`), "");
  }
  righe.push("## Le tabelle", "");
  for (const t of Object.values(D.tabelle).sort((a, b) => a.tabella.localeCompare(b.tabella, "it"))) {
    righe.push(`### ${t.tabella}`, "", `_${t.categoria}_ · ${t.descrizione}`, "");
    if (t.padri.length) righe.push(`Dipende da: ${t.padri.map(p => `${p.tabella} (${p.colonne.join(", ")})`).join(", ")}`, "");
    if (t.figli.length) righe.push(`Usata da: ${t.figli.map(f => `${f.tabella} (${f.colonne.join(", ")})`).join(", ")}`, "");
    righe.push("| colonna | tipo | ruolo | significato |", "|---|---|---|---|",
      ...t.colonne.map(c => `| ${c.colonna} | ${c.tipo || ""} | ${c.ruolo || ""} | ${c.significato || ""} |`), "");
  }
  return righe.join("\n");
}

Object.assign(VISTE, {
  async documentazione() {
    const corpo = el("div", {}, el("p", { class: "tenue" }, "Scrittura della documentazione..."));
    const titolo = STATO_DOCUMENTI.origine === "caricato" ? "Documentazione del database caricato" : "Documentazione del database";
    let D = null, relazioni = [];
    const scarica = formato => {
      if (!D) return;
      if (formato === "md") scaricaBlob(new Blob([markdownDocumentazione(D, relazioni, titolo)], { type: "text/markdown" }), "documentazione_database.md");
      else scaricaBlob(new Blob([dizionarioDati(D, D.origine)], { type: "text/html" }), "documentazione_database.html");
    };
    const intestazione = intestazioneRichiudibile("documentazione", "Documentazione",
      el("p", { class: "tenue" }, "La documentazione del database scritta dall'app: cosa rappresenta probabilmente ogni tabella, il significato delle " +
        "colonne, come sono collegate (con i nomi e le cardinalità delle relazioni che hai disegnato) e l'ordine in cui leggerle. Si aggiorna " +
        "ogni volta che apri la pagina. Le descrizioni sono ipotesi ricavate da nomi, chiavi e collegamenti, fatte sul computer senza rete."),
      el("div", { class: "riga-comandi" }, el("b", {}, "Di"), sceltaOrigine("documentazione"),
        el("button", { class: "primario", onclick: () => scarica("html") }, "Scarica (HTML)"),
        el("button", { onclick: () => scarica("md") }, "Scarica (Markdown)"),
        el("button", { onclick: () => mostra("suggerimenti") }, "Suggerimenti")));
    (async () => {
      try {
        if (STATO_DOCUMENTI.origine === "editor" && !modelloEditor.entita.length) {
          metti(corpo, el("div", { class: "messaggio" }, "Il disegno dell'editor è vuoto: disegna o importa delle tabelle in Editor del database."));
          return;
        }
        D = await api("/api/documentazione", richiestaOrigine());
        relazioni = STATO_DOCUMENTI.origine === "editor" ? frasiRelazioniEditor() : frasiRelazioniCaricato(D);
        const schede = Object.values(D.tabelle).sort((a, b) => a.tabella.localeCompare(b.tabella, "it"));
        const ancora = t => "doc-" + t.replace(/[^\w]/g, "_");
        metti(corpo,
          el("div", { class: "pannello" }, el("h3", {}, "In breve"), el("p", {}, D.sintesi),
            el("p", { class: "tenue" }, `${schede.length} tabelle · ${relazioni.length} relazioni · ${D.origine}`),
            el("div", { class: "indice-doc" }, schede.map(t => el("a", { href: "#", class: "chip", onclick: e => { e.preventDefault(); document.getElementById(ancora(t.tabella))?.scrollIntoView({ behavior: "smooth" }); } }, t.tabella)))),
          el("div", { class: "pannello" }, el("h3", {}, "Le relazioni"),
            relazioni.length ? el("ul", {}, relazioni.map(f => el("li", {}, f))) : el("p", { class: "tenue" }, "Nessuna relazione: collega le entità nell'editor.")),
          el("div", { class: "pannello" }, el("h3", {}, "Il filo logico"),
            D.filo.map(a => el("div", {}, el("h4", {}, `Area ${a.area}`), el("p", { class: "tenue" }, a.introduzione),
              el("ol", {}, a.passi.map(p => el("li", {}, el("b", {}, p.tabella), " ", etichettaCategoria(p.categoria), " ", p.frase)))))),
          schede.map(t => el("div", { class: "pannello scheda-doc", id: ancora(t.tabella) },
            el("h3", {}, t.tabella, " ", etichettaCategoria(t.categoria)),
            el("p", {}, t.descrizione),
            t.padri.length ? el("p", {}, el("b", {}, "Dipende da: "), t.padri.map(p => `${p.tabella} (${p.colonne.join(", ")})`).join(", ")) : null,
            t.figli.length ? el("p", {}, el("b", {}, "Usata da: "), t.figli.map(f => `${f.tabella} (${f.colonne.join(", ")})`).join(", ")) : null,
            griglia({ colonne: ["colonna", "tipo", "ruolo", "significato"], righe: t.colonne.map(c => [c.colonna, c.tipo, c.ruolo, c.significato]) }))));
      } catch (e) { metti(corpo, el("div", { class: "messaggio" }, e.message)); }
    })();
    return [intestazione, corpo];
  },

  async suggerimenti() {
    const corpo = el("div", {}, el("p", { class: "tenue" }, "Controllo del database..."));
    const delEditor = STATO_DOCUMENTI.origine !== "caricato";
    const intestazione = intestazioneRichiudibile("suggerimenti", "Suggerimenti",
      el("p", { class: "tenue" }, "L'app legge il database e ti dice cosa migliorare, perché e come: chiavi mancanti, tipi poco adatti (importi in " +
        "virgola mobile, date nel testo), dati ripetuti, vincoli da aggiungere, nomi da sistemare. Ogni consiglio ha la sua ragione e, quando " +
        "serve, l'SQL; sul database dell'editor alcuni si applicano con un clic. Tutto si calcola sul computer, con regole, senza rete."),
      el("div", { class: "riga-comandi" }, el("b", {}, "Controlla"), sceltaOrigine("suggerimenti"),
        el("button", { class: "primario", onclick: () => mostra("suggerimenti") }, "Ricontrolla"),
        el("button", { onclick: () => mostra("documentazione") }, "Documentazione")));
    const applica = c => {
      const e = modelloEditor.entita.find(x => x.nome.toLowerCase() === c.tabella.toLowerCase());
      const a = e && e.attributi.find(x => x.nome.toLowerCase() === c.colonna.toLowerCase());
      if (!a) return avviso("Non trovo la colonna nel disegno.", true);
      a[c.correzione.campo] = c.correzione.valore;
      avviso(`Applicato a ${e.nome}.${a.nome}.`);
      mostra("suggerimenti");
    };
    (async () => {
      try {
        if (delEditor && !modelloEditor.entita.length) {
          metti(corpo, el("div", { class: "messaggio" }, "Il disegno dell'editor è vuoto: disegna o importa delle tabelle in Editor del database."));
          return;
        }
        const R = await api("/api/suggerimenti", richiestaOrigine());
        const nomi = { errore: ["errori", "errore"], avviso: ["avvisi", "avviso-g"], info: ["consigli", "info-g"] };
        const elenco = el("div");
        const cerca = el("input", { type: "search", value: STATO_DOCUMENTI.cerca, placeholder: "cerca una tabella o una parola", "aria-label": "Cerca nei suggerimenti" });
        const filtri = el("div", { class: "riga-comandi" });
        const disegna = () => {
          const f = STATO_DOCUMENTI.cerca.trim().toLowerCase();
          const scelti = R.suggerimenti.filter(c => (STATO_DOCUMENTI.gravita === "tutte" || c.gravità === STATO_DOCUMENTI.gravita)
            && (!f || [c.titolo, c.perché, c.tabella, c.colonna].join(" ").toLowerCase().includes(f)));
          metti(filtri, [["tutte", `Tutti (${R.suggerimenti.length})`], ...Object.entries(nomi).map(([k, [n]]) => [k, `${n[0].toUpperCase() + n.slice(1)} (${R.conta[k] || 0})`])]
            .map(([k, n]) => el("button", { class: STATO_DOCUMENTI.gravita === k ? "primario" : null, onclick: () => { STATO_DOCUMENTI.gravita = k; disegna(); } }, n)), cerca);
          metti(elenco, scelti.length ? scelti.map(c => el("div", { class: `pannello consiglio consiglio-${c.gravità}` },
            el("div", { class: "riga-titolo-consiglio" }, el("span", { class: nomi[c.gravità]?.[1] }, c.gravità), " ", el("b", {}, c.titolo),
              c.tabella ? el("span", { class: "chip" }, c.colonna ? `${c.tabella}.${c.colonna}` : c.tabella) : null),
            el("p", {}, c.perché),
            c.come ? (/^(ALTER|CREATE)/i.test(c.come) ? el("pre", { class: "sql" }, c.come) : el("p", { class: "tenue" }, "Come: ", c.come)) : null,
            c.regola ? el("p", { class: "tenue piccolo" }, `Regola: ${c.regola}`) : null,
            el("div", { class: "riga-comandi" },
              /^(ALTER|CREATE)/i.test(c.come) ? el("button", { onclick: async () => { try { await navigator.clipboard.writeText(c.come); avviso("SQL copiato."); } catch { avviso("Selezionalo e copialo a mano.", true); } } }, "Copia l'SQL") : null,
              delEditor && c.correzione ? el("button", { class: "primario", onclick: () => applica(c) }, "Applica nell'editor") : null,
              delEditor && c.tabella ? el("button", { onclick: () => {
                const e = modelloEditor.entita.find(x => x.nome.toLowerCase() === c.tabella.toLowerCase());
                if (e) { STATO_EDITOR.selezione = e.id; STATO_EDITOR.multipla = []; }
                mostra("editor");
              } }, "Apri nell'editor") : null)))
            : el("p", { class: "tenue" }, "Nessun suggerimento con questi filtri."));
        };
        cerca.addEventListener("input", () => { STATO_DOCUMENTI.cerca = cerca.value; disegna(); });
        const colore = R.punteggio >= 85 ? "si" : R.punteggio >= 60 ? "avviso-g" : "errore";
        const rapporto = () => scaricaBlob(new Blob([[`# Suggerimenti sul database`, "", `Punteggio: ${R.punteggio}/100`, "", R.sintesi, "",
          ...R.suggerimenti.map(c => `- **${c.gravità}** ${c.titolo}${c.tabella ? ` (${c.tabella}${c.colonna ? "." + c.colonna : ""})` : ""}: ${c.perché}${c.come ? `\n  - Come: \`${c.come}\`` : ""}`)].join("\n")],
          { type: "text/markdown" }), "suggerimenti_database.md");
        metti(corpo,
          el("div", { class: "pannello voto" },
            el("div", { class: `punteggio ${colore}` }, String(R.punteggio), el("small", {}, "/100")),
            el("div", {}, el("p", {}, R.sintesi), el("p", { class: "tenue" }, R.origine),
              el("button", { onclick: rapporto }, "Scarica i suggerimenti (Markdown)"))),
          filtri, elenco);
        disegna();
      } catch (e) { metti(corpo, el("div", { class: "messaggio" }, e.message)); }
    })();
    return [intestazione, corpo];
  },
});
