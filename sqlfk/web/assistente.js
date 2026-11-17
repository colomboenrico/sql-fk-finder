"use strict";

// Pagina "Assistente": una chat sul database caricato. Con un modello di linguaggio locale (file .gguf letto da
// llama-cpp-python dentro l'app) capisce domande libere e usa gli strumenti dell'app (query in sola lettura, scheda di
// una tabella, percorso tra tabelle, suggerimenti); senza modello risponde alle domande frequenti con le regole.
// Niente rete: il modello è un file sul computer (sqlfk/assistente.py).

const STATO_ASSISTENTE = { conversazioni: { database: [], programmazione: [] }, modo: "database", senzaModello: false, inCorso: null, progetto: null };
try { STATO_ASSISTENTE.progetto = localStorage.getItem("sqlfk-progetto") || ""; } catch { STATO_ASSISTENTE.progetto = ""; }

const ESTENSIONI = { python: "py", py: "py", cpp: "cpp", "c++": "cpp", c: "c", sql: "sql", js: "js", javascript: "js", java: "java",
  cs: "cs", csharp: "cs", html: "html", css: "css", json: "json", sh: "sh", bash: "sh", bat: "bat", http: "txt" };
const ESEGUIBILI = { python: "python", py: "python", cpp: "cpp", "c++": "cpp" };

/** Un blocco di codice della risposta: Copia, Salva e, per Python e C++, Esegui (in locale, accanto al database di prova). */
function bloccoCodice(lingua, codice) {
  const lg = (lingua || "").toLowerCase();
  const esito = el("div");
  const ingresso = el("textarea", { rows: 2, class: "ingresso-programma", placeholder: "ingresso del programma (facoltativo: quello che leggerebbe da tastiera)",
    hidden: true, "aria-label": "Ingresso del programma" });
  const esegui = async () => {
    metti(esito, el("p", { class: "tenue" }, lg.startsWith("c") ? "Compilo ed eseguo..." : "Eseguo..."));
    try {
      const R = await api("/api/programmazione/esegui", { ...richiestaOrigine(), linguaggio: ESEGUIBILI[lg], codice, ingresso: ingresso.value });
      metti(esito, el("div", { class: `uscita-programma ${R.ok ? "" : "uscita-errore"}` },
        el("div", { class: "tenue piccolo" }, R.fase === "compilazione" ? "Errori di compilazione" :
          `${R.ok ? "Finito" : "Finito con errore"}${R.codice_uscita != null ? ` (codice ${R.codice_uscita})` : ""}${R.secondi != null ? ` in ${R.secondi} s` : ""}`),
        el("pre", {}, R.uscita),
        !R.ok ? el("button", { class: "piccolo", onclick: () => window.dispatchEvent(new CustomEvent("sqlfk-chiedi",
          { detail: `Questo codice dà questo errore:\n\n\`\`\`${lg}\n${codice}\n\`\`\`\n\nErrore:\n${R.uscita.slice(-2500)}` })) }, "Chiedi di correggerlo") : null));
    } catch (e) { metti(esito, el("p", { class: "errore" }, e.message)); }
  };
  const salva = () => {
    const a = el("a", { href: URL.createObjectURL(new Blob([codice], { type: "text/plain" })), download: `programma.${ESTENSIONI[lg] || "txt"}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return el("div", { class: "blocco-codice" },
    el("div", { class: "barra-codice" }, el("span", { class: "tenue piccolo" }, lg || "codice"),
      el("button", { class: "piccolo", onclick: async () => { try { await navigator.clipboard.writeText(codice); avviso("Codice copiato."); } catch { avviso("Copia non riuscita.", true); } } }, "Copia"),
      el("button", { class: "piccolo", onclick: salva }, "Salva"),
      ESEGUIBILI[lg] ? [el("button", { class: "piccolo primario", onclick: esegui }, "Esegui"),
        el("button", { class: "piccolo", title: "Scrivi l'ingresso del programma", onclick: () => { ingresso.hidden = !ingresso.hidden; } }, "Ingresso")] : null),
    el("pre", { class: "sql" }, codice),
    ingresso, esito);
}

/** Testo della risposta: blocchi ``` come codice (con i pulsanti), il **grassetto**, i titoli ###. */
function testoRisposta(testo) {
  const parti = String(testo || "").split(/```([\w+#-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g);
  const fuori = [];
  for (let i = 0; i < parti.length; i += 3) {
    fuori.push(parti[i].replace(/^(#{1,4}\s+.*)$/gm, "\n\n$1\n\n").split(/\n{2,}/).filter(x => x.trim()).map(par => {
      const titolo = par.match(/^#{1,4}\s+(.*)$/);
      if (titolo) return el("h4", {}, titolo[1].replace(/\*\*/g, ""));
      return el("p", {}, par.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g).map(x =>
        x.startsWith("**") ? el("b", {}, x.slice(2, -2)) : x.startsWith("`") && x.length > 2 ? el("code", {}, x.slice(1, -1)) :
          x.split("\n").map((r, k) => [k ? el("br") : null, r])));
    }));
    if (i + 2 < parti.length) fuori.push(bloccoCodice(parti[i + 1], parti[i + 2].replace(/\n$/, "")));
  }
  return fuori;
}

function passoAssistente(p) {
  const nomi = { sql: "Query sui dati", tabella: "Scheda della tabella", percorso: "Percorso tra le tabelle", suggerimenti: "Suggerimenti" };
  const richiesta = p.richiesta?.query || Object.entries(p.richiesta || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  return el("details", { class: `passo-assistente ${p.ok ? "" : "passo-errore"}` },
    el("summary", {}, `${p.ok ? "✓" : "✗"} ${nomi[p.strumento] || p.strumento}`, richiesta ? el("span", { class: "tenue" }, ` · ${String(richiesta).slice(0, 90)}`) : null),
    p.sql ? el("pre", { class: "sql" }, p.sql) : null,
    p.testo && !(p.colonne && p.colonne.length) ? el("pre", { class: "testo-passo" }, p.testo) : null,
    p.colonne && p.colonne.length ? griglia({ colonne: p.colonne, righe: p.righe || [] }) : null);
}

Object.assign(VISTE, {
  async assistente() {
    const S = STATO_ASSISTENTE;
    const chat = el("div", { class: "chat-messaggi" });
    const domanda = el("textarea", { rows: 2, placeholder: "Chiedi qualcosa sul database o sul progetto (es. come collego il gestionale al sito? come arrivo da clienti a prodotti?)",
      "aria-label": "Domanda per l'assistente" });
    const invia = el("button", { class: "primario" }, "Invia");
    const ferma = el("button", { hidden: true }, "Ferma");
    const lato = el("div", { class: "pannello assistente-lato" });

    function disegnaChat() {
      const messaggi = S.conversazioni[S.modo];
      metti(chat, messaggi.length ? messaggi.map(m => el("div", { class: `messaggio-chat ${m.ruolo}` },
        el("div", { class: "chi" }, m.ruolo === "utente" ? "Tu" : `Assistente${m.modo === "regole" ? " (senza modello)" : m.modo?.startsWith("regole") ? " (risposta con le regole)" : ""}`,
          m.secondi ? el("span", { class: "tenue" }, ` · ${m.secondi} s`) : null),
        m.ruolo === "utente" ? el("p", {}, m.testo) : testoRisposta(m.testo || (m.finito ? "" : "…")),
        (m.passi || []).map(passoAssistente),
        m.errore ? el("p", { class: "errore" }, m.errore) : null))
        : el("div", { class: "tenue chat-vuota" },
            el("p", {}, S.modo === "programmazione" ? "Chiedi il codice che ti serve, o incolla un errore. Per esempio:" :
              "Chiedi qualcosa sul database o sul progetto. Per esempio:"),
            (S.modo === "programmazione" ? ["Scrivi un programma Python che stampa le righe di una tabella con i dati collegati",
              "Scrivi in C++ un programma che usa il backend per inserire una riga e rileggerla",
              "Scrivi una funzione Python che esporta una tabella in CSV",
              "Questo codice mi dà errore: for i in range(10) print(i)"] :
             ["Come procedo con il progetto? Il database è fatto bene?", "Cosa non va nel database?",
              "Il gestionale deve mandare gli ordini al sito appena si creano: qual è il modo migliore?",
              "Un programma di report deve solo leggere i dati: come lo collego?",
              "Quali sono le tabelle più importanti e perché?"]).map(e =>
              el("button", { class: "esempio-domanda", onclick: () => { domanda.value = e; manda(); } }, e))));
      chat.scrollTop = chat.scrollHeight;
    }

    async function manda() {
      const testo = domanda.value.trim();
      if (!testo || S.inCorso) return;
      const origine = richiestaOrigine();
      if (origine.origine === "editor" && !modelloEditor.entita.length && S.modo !== "programmazione")
        return avviso("Il disegno dell'editor è vuoto: disegna o importa delle entità, oppure carica un database.", true);
      if (origine.origine === "editor") origine.relazioni = frasiRelazioniEditor().filter(Boolean);
      domanda.value = "";
      const messaggi = S.conversazioni[S.modo];
      const storia = messaggi.filter(m => m.finito || m.ruolo === "utente").map(m => ({ ruolo: m.ruolo, testo: m.testo }));
      messaggi.push({ ruolo: "utente", testo });
      const risposta = { ruolo: "assistente", testo: "", passi: [], finito: false };
      messaggi.push(risposta);
      disegnaChat();
      try {
        const R = await api("/api/assistente/chiedi", { ...origine, modo: S.modo, domanda: testo, storia, senza_modello: S.senzaModello, progetto: S.progetto });
        S.inCorso = R.id; risposta.modo = R.modo;
        invia.disabled = true; ferma.hidden = false;
        while (true) {
          await pausa(350);
          const D = await api(`/api/assistente/risposta?id=${R.id}`);
          Object.assign(risposta, { testo: D.testo, passi: D.passi, errore: D.errore, modo: D.modo, secondi: D.secondi, finito: D.finito });
          if (document.body.contains(chat)) disegnaChat();
          if (D.finito) break;
        }
      } catch (e) {
        Object.assign(risposta, { errore: e.message, finito: true });
        if (document.body.contains(chat)) disegnaChat();
      } finally {
        S.inCorso = null; invia.disabled = false; ferma.hidden = true;
      }
    }
    invia.addEventListener("click", manda);
    if (S.ascoltoChiedi) window.removeEventListener("sqlfk-chiedi", S.ascoltoChiedi);
    S.ascoltoChiedi = e => { if (document.body.contains(chat)) { domanda.value = e.detail; manda(); } };
    window.addEventListener("sqlfk-chiedi", S.ascoltoChiedi);
    ferma.addEventListener("click", () => S.inCorso && api("/api/assistente/ferma", { id: S.inCorso }));
    domanda.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); manda(); } });

    async function disegnaLato() {
      let M;
      try { M = await api("/api/assistente/stato"); } catch (e) { metti(lato, el("p", { class: "errore" }, e.message)); return; }
      const percorso = el("input", { type: "text", placeholder: "percorso di un file .gguf", "aria-label": "File del modello" });
      const scelta = el("input", { type: "file", accept: ".gguf", hidden: true });
      scelta.addEventListener("change", () => {
        const f = scelta.files[0];
        const p = f && window.sqlfkApp ? window.sqlfkApp.percorso(f) : "";
        if (p) percorso.value = p; else avviso("Nel browser il percorso del file non si legge: scrivilo nel campo.", true);
      });
      const carica = async p => {
        try { await api("/api/assistente/carica", { percorso: p }); avviso("Caricamento del modello..."); attendi(); } catch (e) { avviso(e.message, true); }
      };
      const attendi = async () => {
        for (let i = 0; i < 600; i++) {
          await pausa(1000);
          const X = await api("/api/assistente/stato");
          if (!X.caricando) { avviso(X.errore ? `Modello non caricato: ${X.errore}` : "Modello caricato: l'assistente ora usa il modello.", !!X.errore); break; }
        }
        if (document.body.contains(lato)) disegnaLato();
      };
      const senza = el("input", { type: "checkbox", checked: S.senzaModello });
      senza.addEventListener("change", () => { S.senzaModello = senza.checked; });
      const ram = M.ram_gb;
      // un modello sul computer e nessuno caricato: lo si carica da solo (una volta per sessione), il più grande che ci sta
      if (!S.autoCaricato && M.libreria && !M.caricato && !M.caricando && !M.errore && M.modelli.length) {
        S.autoCaricato = true;
        const adatti = M.modelli.filter(m => !ram || m.gb * 1.5 <= ram * 0.7).sort((a, b) => b.gb - a.gb);
        const scelto = adatti[0] || M.modelli.slice().sort((a, b) => a.gb - b.gb)[0];
        carica(scelto.percorso);
        M.caricando = true;              // il pannello dice "Caricamento in corso" finché il modello non è pronto
      } else if (M.caricando) {
        attendi();                       // caricamento partito prima (per esempio prima di cambiare modo): si aspetta qui
      }
      const progettoTesto = el("textarea", { rows: 4, placeholder: "A cosa serve il database, chi lo usa, con quali programmi deve comunicare " +
        "(es. un gestionale ordini che manda gli ordini al sito e-commerce; i report li fa Power BI)", "aria-label": "Descrizione del progetto" });
      progettoTesto.value = S.progetto;
      progettoTesto.addEventListener("input", () => {
        S.progetto = progettoTesto.value;
        try { localStorage.setItem("sqlfk-progetto", S.progetto); } catch {}
      });
      metti(lato,
        el("h3", {}, "Il modello"),
        M.caricato ? el("p", { class: "si" }, "Caricato: ", el("b", {}, M.caricato.split(/[\\/]/).pop()))
          : M.caricando ? el("p", { class: "tenue" }, "Caricamento in corso...")
          : el("p", { class: "tenue" }, M.libreria ? "Nessun modello caricato: l'assistente risponde con le regole." :
              "La libreria llama-cpp-python non c'è: l'assistente risponde con le regole. Gli eseguibili per Windows la includono."),
        M.errore ? el("p", { class: "errore" }, M.errore) : null,
        el("p", { class: "tenue piccolo" }, `${M.sistema} · ${ram ?? "?"} GB di RAM · ${M.processori} processori` + (M.libreria ? ` · llama-cpp-python ${M.libreria}` : "")),
        M.modelli.length ? [el("b", {}, "Modelli sul computer"), el("ul", { class: "modelli" }, M.modelli.map(m => el("li", {},
          `${m.nome} (${m.gb} GB) `, el("button", { disabled: !M.libreria || M.caricando || M.caricato === m.percorso, onclick: () => carica(m.percorso) },
            M.caricato === m.percorso ? "in uso" : "Carica"))))] : null,
        el("div", { class: "riga-comandi" }, percorso, el("button", { onclick: () => scelta.click() }, "Scegli..."), scelta,
          el("button", { disabled: !M.libreria, onclick: () => carica(percorso.value.trim()) }, "Carica")),
        M.caricato ? el("button", { onclick: async () => { await api("/api/assistente/libera", {}); disegnaLato(); } }, "Libera la memoria") : null,
        el("label", {}, senza, " rispondi senza modello (regole)"),
        el("h3", {}, "Il progetto"),
        progettoTesto,
        el("h3", {}, "Quale modello"),
        el("p", { class: "tenue piccolo" }, "Un file .gguf di un modello per il codice: si scarica una volta su un computer con internet e si copia in ",
          el("code", {}, M.cartelle[0]), " (o si sceglie con «Scegli...»). Poi tutto gira sul computer, senza rete."),
        el("ul", { class: "modelli" }, M.consigliati.map(m => el("li", {},
          el("b", {}, m.nome), ` · ${m.gb} GB, ~${m.ram} GB di RAM`,
          ram ? el("span", { class: m.ram <= ram * 0.6 ? "si" : m.ram <= ram * 0.85 ? "avviso-g" : "errore" },
            m.ram <= ram * 0.6 ? " · adatto" : m.ram <= ram * 0.85 ? " · al limite" : " · troppo grande") : null,
          el("div", { class: "tenue piccolo" }, `${m.per} · file ${m.file}`)))),
        el("p", { class: "tenue piccolo" }, "Con 32 GB: il 7B risponde in pochi secondi anche senza scheda grafica, il 14B ragiona meglio ma è più lento. " +
          "Il modello non vede i file: l'app gli passa le tabelle che c'entrano con la domanda ed esegue lei le query (in sola lettura), " +
          "così le risposte si basano sui dati veri e si vede sempre cosa ha fatto."));
    }

    disegnaChat();
    disegnaLato();
    return [
      intestazioneRichiudibile("assistente", "Assistente",
        el("p", { class: "tenue" }, "Un esperto di database e di progettazione con cui parlare del database che costruisci nell'editor o di quello caricato: spiega tabelle e collegamenti, trova come arrivare da " +
          "un dato a un altro, scrive ed esegue query, dice cosa migliorare. Gira tutto sul computer: il modello di linguaggio è un file locale " +
          "e non c'è nessuna connessione. Nella risposta si vedono i passi: le query eseguite e le righe trovate."),
        el("div", { class: "riga-comandi" },
          el("div", { class: "scelta-modo", role: "tablist" }, [["database", "Database e progetto"], ["programmazione", "Programmazione"]].map(([m, n]) =>
            el("button", { class: S.modo === m ? "primario" : "", role: "tab", "aria-selected": String(S.modo === m),
              onclick: () => { if (S.inCorso) return; S.modo = m; mostra("assistente"); } }, n))),
          el("b", {}, "Database"), sceltaOrigine("assistente"))),
      el("div", { class: "assistente-griglia" },
        el("div", { class: "pannello assistente-chat" }, chat,
          el("div", { class: "chat-scrivi" }, domanda, el("div", { class: "riga-comandi" }, invia, ferma,
            el("button", { onclick: () => { if (!S.inCorso) { S.conversazioni[S.modo] = []; disegnaChat(); } } }, "Nuova conversazione")))),
        lato),
    ];
  },
});
