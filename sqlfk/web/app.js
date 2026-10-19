"use strict";

// ======================================================================= utilità

const $ = (selettore, dentro = document) => dentro.querySelector(selettore);
const vista = $("#vista");
let stato = { caricato: false };
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
  for (const f of figli.flat()) {
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

$("#form-percorso").addEventListener("submit", async e => {
  e.preventDefault();
  const cartella = $("#percorso").value.trim();
  if (!cartella) return;
  await conAttesa(async () => {
    stato = await api("/api/carica_cartella", { cartella });
    avviso("Cartella caricata.");
    aggiornaTutto("panoramica");
  });
});

// ======================================================================= navigazione

document.querySelectorAll("#menu button").forEach(b => b.addEventListener("click", () => mostra(b.dataset.vista)));

function aggiornaMenu() {
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
  $("#voce-problemi").replaceChildren("Problemi",
    p.errore ? el("span", { class: "contatore", title: "errori" }, p.errore) : null,
    p.avviso ? el("span", { class: "contatore giallo", title: "avvisi" }, p.avviso) : null);
  $("#riepilogo").replaceChildren(
    el("span", { class: p.errore ? "errore" : null }, ...n(p.errore, p.errore === 1 ? "errore" : "errori")), " · ",
    el("span", { class: p.avviso ? "avviso-g" : null }, ...n(p.avviso, p.avviso === 1 ? "avviso" : "avvisi")), " · ",
    ...n(stato.tabelle_analizzate, "tabelle analizzate"), stato.rimosse.length ? ` (${stato.rimosse.length} tolte)` : "", " · ",
    ...n(stato.gruppi, "gruppi"), " · ",
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

const VISTE = {
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
          el("div", { class: n === s.riga ? classe : null }, el("span", { class: "numero" }, n), testo))));
    }

    function disegna() {
      const righe = dati.problemi.righe.filter(r => spunte[r[col("gravità")]].checked && (!codice.value || r[col("codice")] === codice.value));
      elenco.replaceChildren(griglia({ colonne: dati.problemi.colonne, righe },
        { classiCella: classiStandard, alClic: mostraSorgente, nascondi: ["regola", "suggerimento"] }));
    }
    Object.values(spunte).forEach(s => s.addEventListener("change", disegna));
    codice.addEventListener("change", disegna);
    disegna();
    return [
      el("h2", {}, "Problemi dello schema"),
      el("p", { class: "tenue" }, "Come un compilatore: gli errori sono cose sbagliate da correggere (per esempio una tabella senza chiave primaria o una chiave esterna verso una tabella che non esiste); gli avvisi sono probabili difetti di progettazione (chiavi esterne mancanti, normalizzazione, relazioni ridondanti); le info sono osservazioni. Ricavati dalla sola struttura: gli avvisi vanno verificati."),
      tiles,
      el("div", { class: "riga-comandi" }, codice,
        el("a", { class: "pulsante", href: "/api/scarica/report", download: "diagnostica.txt" }, "Scarica il report (.txt)")),
      sorgente,
      elenco,
    ];
  },

  async panoramica() {
    if (!stato.caricato) {
      return el("div", { class: "pannello" },
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
    const dati = await api("/api/gruppi");
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

    return [
      el("h2", {}, "Gruppi di entità"),
      el("p", { class: "tenue" }, "Tabelle con nomi simili, raggruppate con un clustering gerarchico (per esempio ordini, ordini_righe, tbl_ordini). La soglia si cambia in Impostazioni."),
      griglia(soloGruppi, { titolo: "Gruppi con almeno 2 tabelle", alClic: scegli }),
      dettaglio,
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
        el("p", { class: "tenue" }, "Crea nella cartella il file Excel, i due file .sql (ALTER TABLE e CREATE TABLE con FK) e i due schemi grafici."),
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
  const cornice = el("div", { class: "er-cornice" });
  const info = el("span", { class: "tenue" });
  const sceltaGruppo = el("select", { "aria-label": "Gruppo" }, el("option", { value: "" }, "tutte le tabelle"),
    gruppi.map(g => el("option", { value: g }, `gruppo ${g}`)));
  const ricerca = el("input", { type: "text", placeholder: "cerca una tabella", "aria-label": "Cerca una tabella" });
  const conTipi = el("input", { type: "checkbox", checked: true });
  const medie = el("input", { type: "checkbox", checked: erMedie, disabled: quale !== "collegamenti" });
  let diagramma = null;

  function disegna() {
    let tabelle = dati.tabelle, collegamenti = dati.collegamenti;
    if (sceltaGruppo.value) {
      // il gruppo scelto più le tabelle direttamente collegate
      const nomi = new Set(tabelle.filter(t => t.gruppo === sceltaGruppo.value).map(t => t.nome));
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
    diagramma = DiagrammaER.crea(cornice, { tabelle, collegamenti }, { tipi: conTipi.checked });
    info.textContent = `${diagramma.numeri.tabelle} tabelle, ${diagramma.numeri.collegamenti} collegamenti`;
  }

  sceltaGruppo.addEventListener("change", disegna);
  conTipi.addEventListener("change", disegna);
  medie.addEventListener("change", () => { erMedie = medie.checked; mostraSchema(quale, "er"); });
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
      sceltaGruppo, ricerca,
      el("label", {}, conTipi, "mostra i tipi"),
      el("button", { onclick: () => diagramma && diagramma.zoom(1.25), title: "Ingrandisci" }, "+"),
      el("button", { onclick: () => diagramma && diagramma.zoom(0.8), title: "Rimpicciolisci" }, "-"),
      el("button", { onclick: () => diagramma && diagramma.adatta() }, "Adatta alla finestra"),
      el("button", { onclick: scarica }, "Scarica SVG"),
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
