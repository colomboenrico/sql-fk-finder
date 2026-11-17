"use strict";

// Pagina "Assistente": una chat sul database caricato. Con un modello di linguaggio locale (file .gguf letto da
// llama-cpp-python dentro l'app) capisce domande libere e usa gli strumenti dell'app (query in sola lettura, scheda di
// una tabella, percorso tra tabelle, suggerimenti); senza modello risponde alle domande frequenti con le regole.
// Niente rete: il modello è un file sul computer (sqlfk/assistente.py).

const STATO_ASSISTENTE = { messaggi: [], senzaModello: false, inCorso: null, progetto: null };
try { STATO_ASSISTENTE.progetto = localStorage.getItem("sqlfk-progetto") || ""; } catch { STATO_ASSISTENTE.progetto = ""; }

/** Testo della risposta con i blocchi ```sql come codice e il **grassetto**. */
function testoRisposta(testo) {
  const parti = String(testo || "").split(/```(?:\w+)?\n?([\s\S]*?)```/g);
  return parti.map((p, i) => i % 2 ? el("pre", { class: "sql" }, p.trim()) :
    p.split(/\n{2,}/).filter(x => x.trim()).map(par => el("p", {}, par.split(/(\*\*[^*]+\*\*)/g).map(x =>
      x.startsWith("**") ? el("b", {}, x.slice(2, -2)) : x.split("\n").map((r, k) => [k ? el("br") : null, r])))));
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
      metti(chat, S.messaggi.length ? S.messaggi.map(m => el("div", { class: `messaggio-chat ${m.ruolo}` },
        el("div", { class: "chi" }, m.ruolo === "utente" ? "Tu" : `Assistente${m.modo === "regole" ? " (senza modello)" : ""}`,
          m.secondi ? el("span", { class: "tenue" }, ` · ${m.secondi} s`) : null),
        m.ruolo === "utente" ? el("p", {}, m.testo) : testoRisposta(m.testo || (m.finito ? "" : "…")),
        (m.passi || []).map(passoAssistente),
        m.errore ? el("p", { class: "errore" }, m.errore) : null))
        : el("div", { class: "tenue chat-vuota" },
            el("p", {}, "Chiedi qualcosa sul database o sul progetto. Per esempio:"),
            ["Come procedo con il progetto? Il database è fatto bene?", "Cosa non va nel database?",
             "Il gestionale deve mandare gli ordini al sito appena si creano: qual è il modo migliore?",
             "Un programma di report deve solo leggere i dati: come lo collego?",
             "Quali sono le tabelle più importanti e perché?"].map(e =>
              el("button", { class: "esempio-domanda", onclick: () => { domanda.value = e; manda(); } }, e))));
      chat.scrollTop = chat.scrollHeight;
    }

    async function manda() {
      const testo = domanda.value.trim();
      if (!testo || S.inCorso) return;
      const origine = richiestaOrigine();
      if (origine.origine === "editor" && !modelloEditor.entita.length)
        return avviso("Il disegno dell'editor è vuoto: disegna o importa delle entità, oppure carica un database.", true);
      if (origine.origine === "editor") origine.relazioni = frasiRelazioniEditor().filter(Boolean);
      domanda.value = "";
      const storia = S.messaggi.filter(m => m.finito || m.ruolo === "utente").map(m => ({ ruolo: m.ruolo, testo: m.testo }));
      S.messaggi.push({ ruolo: "utente", testo });
      const risposta = { ruolo: "assistente", testo: "", passi: [], finito: false };
      S.messaggi.push(risposta);
      disegnaChat();
      try {
        const R = await api("/api/assistente/chiedi", { ...origine, domanda: testo, storia, senza_modello: S.senzaModello, progetto: S.progetto });
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
        el("div", { class: "riga-comandi" }, el("b", {}, "Parla di"), sceltaOrigine("assistente"))),
      el("div", { class: "assistente-griglia" },
        el("div", { class: "pannello assistente-chat" }, chat,
          el("div", { class: "chat-scrivi" }, domanda, el("div", { class: "riga-comandi" }, invia, ferma,
            el("button", { onclick: () => { if (!S.inCorso) { S.messaggi = []; disegnaChat(); } } }, "Nuova conversazione")))),
        lato),
    ];
  },
});
