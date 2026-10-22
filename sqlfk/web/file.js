"use strict";

// Pagine "File della cartella" e "File XML": tutti i file della cartella caricata (anche nelle sottocartelle),
// da cercare per nome o per contenuto, leggere e affiancare agli schemi del reverse engineering.
// Tutto in sola lettura: dal disco tramite il server, oppure (nel browser) dai file scelti con "Carica cartella".

const CARTELLE_SALTATE = new Set([".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".ipynb_checkpoints"]);
const ESTENSIONI_XML = new Set([".xml", ".xsd", ".xsl", ".xslt", ".wsdl", ".config", ".xaml", ".resx", ".xmi", ".hbm", ".edmx",
  ".dbml", ".csproj", ".vbproj", ".plist", ".manifest", ".rdf", ".owl", ".svg", ".xhtml", ".pom"]);
const PAGINA_FILE = 512 * 1024;
const LIMITE_CERCA_LOCALE = 32 * 1024 * 1024;

let fileLocali = null;            // nel browser: i file della cartella scelta (oggetti File), senza percorso su disco
let fileLocaliCaricati = null;    // quelli scelti con "Carica cartella" in alto (per tornarci)
let usaLocali = false;
let fileAperto = null;            // il file aperto nella pagina File (resta quando si cambia pagina)
let rigaDaMostrare = null;
let xmlDaAprire = null;           // file da aprire entrando nella pagina File XML
let xmlAperto = null;
let ricercaNomeFile = "", ricercaTestoFile = "", tipoFile = "tutti";
const cartelleAperte = new Set([""]);
// schemi affiancati ai file: [{tipo: "scheda" | "schema" | "filo", tabella}], al massimo due
const affiancati = [];

/** replaceChildren che accetta anche liste e valori vuoti (come el). */
const riempi = (nodo, ...figli) => nodo.replaceChildren(...figli.flat(Infinity).filter(f => f !== null && f !== undefined && f !== false));
const estensioneDi = nome => (String(nome).match(/\.[^./\\]+$/) || [""])[0].toLowerCase();
const eFileXml = nome => ESTENSIONI_XML.has(estensioneDi(nome));

// ======================================================================= da dove vengono i file

function relativoLocale(f) {
  const r = f.webkitRelativePath || f.name;
  return r.includes("/") ? r.slice(r.indexOf("/") + 1) : r;
}

function elencoLocale() {
  const file = fileLocali
    .map(f => ({ f, percorso: relativoLocale(f) }))
    .filter(({ f, percorso }) => f.name !== ".DS_Store" && !percorso.split("/").slice(0, -1).some(d => CARTELLE_SALTATE.has(d)))
    .map(({ f, percorso }) => {
      const i = percorso.lastIndexOf("/");
      return { percorso, nome: f.name, cartella: i < 0 ? "" : percorso.slice(0, i), dimensione: f.size,
               estensione: estensioneDi(f.name).slice(1), xml: eFileXml(f.name) };
    })
    .sort((a, b) => a.percorso.localeCompare(b.percorso));
  const nome = (fileLocali[0] && fileLocali[0].webkitRelativePath || "").split("/")[0] || "file scelti";
  return { radice: nome, nome, file, troncato: false, caricata: fileLocali === fileLocaliCaricati, locale: true };
}

/** Codifica dai primi byte (come fa il server): BOM, UTF-16 senza BOM, altrimenti UTF-8 o Windows-1252. */
function codificaDi(byte) {
  if (byte[0] === 0xef && byte[1] === 0xbb && byte[2] === 0xbf) return ["utf-8", 3];
  if (byte[0] === 0xff && byte[1] === 0xfe) return ["utf-16le", 2];
  if (byte[0] === 0xfe && byte[1] === 0xff) return ["utf-16be", 2];
  if (byte.length >= 4 && byte[1] === 0 && byte[3] === 0 && byte[0] !== 0) return ["utf-16le", 0];
  if (byte.length >= 4 && byte[0] === 0 && byte[2] === 0 && byte[1] !== 0) return ["utf-16be", 0];
  try { new TextDecoder("utf-8", { fatal: true }).decode(byte.subarray(0, Math.max(0, byte.length - 3))); return ["utf-8", 0]; }
  catch { return ["windows-1252", 0]; }
}

async function leggiLocale(percorso, inizio = 0, quanti = PAGINA_FILE) {
  const f = fileLocali.find(x => relativoLocale(x) === percorso);
  if (!f) throw new Error(`File non trovato: ${percorso}`);
  const testa = new Uint8Array(await f.slice(0, 8192).arrayBuffer());
  const [codifica, bom] = codificaDi(testa);
  if (!codifica.startsWith("utf-16") && testa.includes(0)) {
    return { percorso, dimensione: f.size, binario: true, testo: "", inizio: 0, fine: 0, altro: false, codifica: null, tabelle: [] };
  }
  inizio = Math.max(inizio, bom);
  if (codifica.startsWith("utf-16")) inizio -= (inizio - bom) % 2;
  let byte = new Uint8Array(await f.slice(inizio, Math.min(f.size, inizio + quanti)).arrayBuffer());
  let fine = inizio + byte.length;
  if (fine < f.size) {
    let ultimo = byte.lastIndexOf(0x0a);
    if (codifica === "utf-16le" && ultimo % 2) ultimo = -1;
    if (codifica === "utf-16be") ultimo = ultimo > 0 && byte[ultimo - 1] === 0 && ultimo % 2 ? ultimo : -1;
    if (ultimo > 0) { byte = byte.subarray(0, ultimo + (codifica === "utf-16le" ? 2 : 1)); fine = inizio + byte.length; }
  }
  return { percorso, dimensione: f.size, binario: false, testo: new TextDecoder(codifica).decode(byte), inizio, fine,
           altro: fine < f.size, codifica, tabelle: [] };
}

const Sorgente = {
  locale: () => usaLocali && !!fileLocali,
  elenco() { return this.locale() ? Promise.resolve(elencoLocale()) : api("/api/file/elenco"); },
  leggi(percorso, inizio = 0) {
    return this.locale() ? leggiLocale(percorso, inizio)
      : api(`/api/file/leggi?percorso=${encodeURIComponent(percorso)}&inizio=${inizio}`);
  },
  async xml(percorso) {
    return this.locale() ? leggiLocale(percorso, 0, Infinity) : api(`/api/file/xml?percorso=${encodeURIComponent(percorso)}`);
  },
  async cerca(parola, nomi) {
    if (!this.locale()) return api(`/api/file/cerca?parola=${encodeURIComponent(parola)}&nomi=${encodeURIComponent(nomi || "")}`);
    const cerca = parola.toLowerCase(), risultati = [];
    let saltati = 0;
    for (const voce of elencoLocale().file) {
      if (nomi && !corrispondeNome(voce.nome, nomi)) continue;
      if (voce.dimensione > LIMITE_CERCA_LOCALE) { saltati++; continue; }
      const P = await leggiLocale(voce.percorso, 0, Infinity);
      if (P.binario || !P.testo.toLowerCase().includes(cerca)) continue;
      const righe = [];
      let volte = 0;
      P.testo.split(/\r?\n/).forEach((r, i) => {
        if (r.toLowerCase().includes(cerca)) { volte++; if (righe.length < 20) righe.push([i + 1, r.trim().slice(0, 300)]); }
      });
      risultati.push({ ...voce, volte, righe });
      if (risultati.length >= 300) break;
    }
    return { parola, risultati, saltati };
  },
};

/** Il nome corrisponde alla ricerca? Con * e ? è un modello (*.sql), altrimenti basta che lo contenga. */
function corrispondeNome(nome, cerca) {
  nome = nome.toLowerCase(); cerca = cerca.toLowerCase().trim();
  if (!cerca) return true;
  if (/[*?]/.test(cerca)) {
    const re = new RegExp("^" + cerca.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return re.test(nome);
  }
  return nome.includes(cerca);
}

/** Cartella scelta con il pulsante della pagina: nell'app il percorso va al server, nel browser si tengono i file. */
async function scegliCartellaFile(lista, pagina) {
  const file = [...lista];
  if (!file.length) return;
  const p = window.sqlfkApp ? window.sqlfkApp.percorso(file[0]) : "";
  try {
    if (p && file[0].webkitRelativePath) {
      const rel = file[0].webkitRelativePath;
      await api("/api/file/radice", { cartella: p.slice(0, p.length - rel.length) + rel.split("/")[0] });
      usaLocali = false;
    } else {
      fileLocali = file;
      usaLocali = true;
    }
  } catch (e) {
    avviso(e.message, true);
  }
  fileAperto = xmlAperto = null;
  mostra(pagina);
}

/** Intestazione comune alle due pagine: la cartella che si sta guardando e come cambiarla. */
function sceltaCartella(E, pagina) {
  const campo = el("input", { type: "text", placeholder: "percorso di un'altra cartella", "aria-label": "Percorso della cartella" });
  const scegli = el("input", { type: "file", webkitdirectory: true, multiple: true, hidden: true });
  scegli.addEventListener("change", e => { scegliCartellaFile(e.target.files, pagina); e.target.value = ""; });
  const apri = async ev => {
    ev.preventDefault();
    if (!campo.value.trim()) return;
    try { await api("/api/file/radice", { cartella: campo.value }); usaLocali = false; fileAperto = xmlAperto = null; mostra(pagina); }
    catch (e) { avviso(e.message, true); }
  };
  const torna = async () => {
    try { await api("/api/file/radice", { cartella: "" }); } catch { /* nel browser può non esserci */ }
    fileLocali = fileLocaliCaricati;
    usaLocali = !!fileLocali;
    fileAperto = xmlAperto = null;
    mostra(pagina);
  };
  return el("div", { class: "riga-comandi scelta-cartella" },
    E ? el("span", {}, el("b", {}, E.nome), el("span", { class: "tenue" }, ` · ${E.radice} · ${E.file.length} file` +
      (E.troncato ? " (elenco interrotto: troppi file)" : ""))) : null,
    el("form", { class: "percorso", onsubmit: apri }, campo, el("button", { class: "pulsante", type: "submit" }, "Apri")),
    el("label", { class: "pulsante" }, "Scegli un'altra cartella", scegli),
    E && !E.caricata && (stato.caricato || fileLocaliCaricati) ? el("button", { onclick: torna }, "Torna alla cartella caricata") : null);
}

async function elencoOMessaggio(pagina) {
  try {
    return { E: await Sorgente.elenco() };
  } catch (e) {
    return { errore: [el("div", { class: "pannello" },
      el("p", {}, e.message),
      el("p", { class: "tenue" }, "La pagina mostra i file della cartella caricata in alto. Puoi anche scegliere una cartella qui, " +
        "o scriverne il percorso: i file si leggono soltanto, senza modificarli.")),
    sceltaCartella(null, pagina)] };
  }
}

// ======================================================================= lettura di un file

/** Le tabelle definite in un testo SQL (CREATE TABLE), con la riga: quando il server non le conosce già. */
function tabelleNelTesto(testo) {
  const re = /create\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:[`"[]?[\w$]+[`"\]]?\.)*[`"[]?[\w$]+[`"\]]?)/gi;
  const trovate = [];
  let m;
  while ((m = re.exec(testo))) {
    const nome = m[1].split(".").pop().replace(/[`"[\]]/g, "");
    trovate.push({ tabella: nome, riga: testo.slice(0, m.index).split("\n").length });
  }
  return trovate;
}

/** Il visore di un file: righe numerate, pagine successive su richiesta, ricerca nel testo e salto a una riga. */
function visoreFile(primo, { altezza = "70vh" } = {}) {
  const corpo = el("div", { class: "visore", style: `max-height: ${altezza}` });
  let ultimo = primo, righe = 0, coda = "";
  let continua = false;          // l'ultima riga mostrata non è finita (righe lunghissime, senza a capo)
  const altro = el("button", { onclick: () => carica() }, "Carica il pezzo successivo");
  const info = el("span", { class: "tenue" });

  function aggiungi(P) {
    const testo = coda + P.testo;
    const pezzi = testo.split("\n");
    coda = P.altro ? pezzi.pop() : "";
    // una riga più lunga di un pezzo si mostra lo stesso: il seguito arriva con il pezzo dopo
    const parziale = P.altro && coda.length > 100000;
    if (parziale) { pezzi.push(coda); coda = ""; }
    const frammento = document.createDocumentFragment();
    pezzi.forEach((r, i) => {
      const seguito = i === 0 && continua;
      if (!seguito) righe++;
      frammento.append(el("div", { class: "riga-codice", "data-n": seguito ? null : righe }, el("span", { class: "num" }, seguito ? "" : righe),
        el("span", { class: "codice" }, r.replace(/\r$/, "") || " ")));
    });
    continua = parziale;
    corpo.append(frammento);
    ultimo = P;
    altro.hidden = !P.altro;
    info.textContent = P.altro ? `letti ${formattaByte(P.fine)} di ${formattaByte(P.dimensione)}` : "";
  }
  async function carica() {
    if (!ultimo.altro) return false;
    altro.disabled = true;
    try { aggiungi(await Sorgente.leggi(ultimo.percorso, ultimo.fine)); }
    catch (e) { avviso(e.message, true); return false; }
    finally { altro.disabled = false; }
    return true;
  }
  async function vaiA(n) {
    for (let i = 0; righe < n && ultimo.altro && i < 200; i++) if (!await carica()) break;
    const riga = corpo.querySelector(`[data-n="${n}"]`);
    if (!riga) return;
    corpo.querySelectorAll(".evidenziata").forEach(r => r.classList.remove("evidenziata"));
    riga.classList.add("evidenziata");
    corpo.scrollTop = riga.offsetTop - corpo.clientHeight / 3;
  }
  // ricerca nel testo già caricato
  const cerca = el("input", { type: "search", placeholder: "cerca in questo file", "aria-label": "Cerca nel file" });
  const conteggio = el("span", { class: "tenue" });
  let trovate = [], posizione = -1;
  function evidenzia() {
    const q = cerca.value.trim().toLowerCase();
    corpo.querySelectorAll(".trovata").forEach(r => r.classList.remove("trovata"));
    trovate = q ? [...corpo.querySelectorAll(".riga-codice")].filter(r => r.lastChild.textContent.toLowerCase().includes(q)) : [];
    trovate.forEach(r => r.classList.add("trovata"));
    posizione = -1;
    conteggio.textContent = q ? `${trovate.length} righe` + (ultimo.altro ? " (nel pezzo caricato)" : "") : "";
  }
  function successiva() {
    if (!trovate.length) return;
    posizione = (posizione + 1) % trovate.length;
    vaiA(Number(trovate[posizione].dataset.n));
    conteggio.textContent = `${posizione + 1} di ${trovate.length} righe`;
  }
  let attesa = null;
  cerca.addEventListener("input", () => { clearTimeout(attesa); attesa = setTimeout(evidenzia, 200); });
  cerca.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); successiva(); } });

  aggiungi(primo);
  const nodo = el("div", { class: "visore-file" },
    el("div", { class: "riga-comandi" }, cerca, el("button", { onclick: successiva }, "Successiva"), conteggio),
    corpo, el("div", { class: "riga-comandi" }, altro, info));
  return { nodo, vaiA };
}

// ======================================================================= schemi affiancati

/** I pannelli affiancati al file: scheda di reverse engineering, schema delle tabelle del file o filo logico.
    contesto.tabelle: le tabelle del file aperto (le prime proposte). */
function disegnaAffiancati(box, contesto) {
  box.replaceChildren(...affiancati.map((P, i) => pannelloAffiancato(P, i, box, contesto)));
  box.hidden = !affiancati.length;
}

function pannelloAffiancato(P, i, box, contesto) {
  const corpo = el("div", { class: "corpo-affiancato" });
  const nodo = el("div", { class: "pannello affiancato" });
  const ridisegna = () => disegnaAffiancati(box, contesto);
  const chiudi = el("button", { onclick: () => { affiancati.splice(i, 1); ridisegna(); } }, "Chiudi");
  if (!stato.caricato) {
    nodo.append(el("div", { class: "riga-comandi" }, el("b", {}, "Schema"), chiudi),
      el("p", { class: "tenue" }, "Carica i file .sql in alto per affiancare gli schemi del reverse engineering."));
    return nodo;
  }
  const tipo = el("select", { "aria-label": "Cosa affiancare" },
    [["scheda", "Scheda della tabella"], ["schema", "Schema delle tabelle del file"], ["filo", "Filo logico"]]
      .map(([v, t]) => el("option", { value: v, selected: P.tipo === v }, t)));
  tipo.addEventListener("change", () => { P.tipo = tipo.value; ridisegna(); });
  const testata = el("div", { class: "riga-comandi" }, tipo);
  nodo.append(testata, corpo);
  corpo.append(el("p", { class: "tenue" }, "Caricamento..."));
  datiReverse().then(R => {
    const apri = t => { P.tipo = "scheda"; P.tabella = t; ridisegna(); };
    const delFile = contesto.tabelle.filter(t => R.D.tabelle[t]);
    if (P.tipo === "scheda") {
      if (!R.D.tabelle[P.tabella]) P.tabella = delFile[0] || Object.keys(R.D.tabelle).sort()[0];
      const scelta = el("select", { "aria-label": "Tabella" },
        delFile.length ? el("optgroup", { label: contesto.titolo }, delFile.map(t => el("option", { value: t, selected: t === P.tabella }, t))) : null,
        el("optgroup", { label: "Tutte le tabelle" }, Object.keys(R.D.tabelle).sort()
          .map(t => el("option", { value: t, selected: t === P.tabella && !delFile.includes(t) }, t))));
      scelta.addEventListener("change", () => apri(scelta.value));
      testata.append(scelta);
      corpo.replaceChildren(schedaReverse(R, P.tabella, apri, { altezza: 320 }));
    } else if (P.tipo === "schema") {
      corpo.replaceChildren(delFile.length
        ? el("div", {}, el("p", { class: "tenue" }, `${contesto.titolo}: ${delFile.join(", ")}. Attenuate le tabelle collegate; clicca una tabella per la sua scheda.`),
          diagrammaTabelle(R, delFile, { onClic: apri, altezza: 520 }))
        : el("p", { class: "tenue" }, "In questo file non ci sono tabelle del database analizzato: scegli la scheda di una tabella o il filo logico."));
    } else {
      corpo.replaceChildren(filoReverse(R, apri));
    }
  }).catch(e => corpo.replaceChildren(el("p", { class: "errore" }, e.message)));
  testata.append(chiudi);
  return nodo;
}

function pulsanteAffianca(box, contesto) {
  return el("button", {
    title: "Mostra accanto al file la scheda di reverse engineering, lo schema delle sue tabelle o il filo logico (fino a due)",
    onclick: () => {
      if (affiancati.length >= 2) { avviso("Al massimo due schemi affiancati: chiudine uno."); return; }
      affiancati.push({ tipo: contesto.tabelle.length ? (affiancati.some(a => a.tipo === "scheda") ? "schema" : "scheda") : "filo", tabella: contesto.tabelle[0] || null });
      disegnaAffiancati(box, contesto);
    },
  }, "Affianca uno schema");
}

/** Apre la scheda di una tabella nel primo pannello affiancato (lo crea se non c'è). */
function apriNelPannello(box, contesto, tabella) {
  let P = affiancati.find(a => a.tipo === "scheda");
  if (!P) { P = { tipo: "scheda", tabella }; affiancati.length >= 2 ? (affiancati[0] = P) : affiancati.unshift(P); }
  P.tabella = tabella;
  disegnaAffiancati(box, contesto);
}

// ======================================================================= pagine

Object.assign(VISTE, {
  async file() {
    const { E, errore } = await elencoOMessaggio("file");
    const intestazione = [el("h2", {}, "File della cartella"),
      el("p", { class: "tenue" }, "Tutti i file della cartella, sottocartelle comprese: cercali per nome (ordini.sql, *.xml) o per contenuto, " +
        "aprili e affiancali agli schemi del reverse engineering. I file si leggono soltanto, non si modificano.")];
    if (errore) return [...intestazione, ...errore];

    const albero = el("div", { class: "file-albero" });
    const conteggio = el("p", { class: "tenue" });
    const cercaNome = el("input", { type: "search", value: ricercaNomeFile, placeholder: "nome del file, es. ordini.sql o *.xml", "aria-label": "Cerca per nome" });
    const cercaTesto = el("input", { type: "search", value: ricercaTestoFile, placeholder: "testo dentro i file (Invio)", "aria-label": "Cerca nel contenuto" });
    const tipo = el("select", { "aria-label": "Tipo di file" },
      [["tutti", "Tutti i file"], ["sql", "Solo .sql"], ["xml", "Solo XML"], ["altri", "Gli altri"]]
        .map(([v, t]) => el("option", { value: v, selected: v === tipoFile }, t)));
    const centro = el("div", { class: "file-centro" });
    const box = el("div", { class: "affiancati", hidden: true });
    let contesto = { tabelle: [], titolo: "Tabelle del file" };
    let visore = null;

    const passaTipo = f => tipoFile === "tutti" || (tipoFile === "sql" ? f.estensione === "sql" : tipoFile === "xml" ? f.xml : f.estensione !== "sql" && !f.xml);
    const voceFile = (f, conCartella) => el("a", { href: "#", class: "file-voce" + (fileAperto === f.percorso ? " scelta" : ""), "data-percorso": f.percorso,
      title: `${f.percorso} · ${formattaByte(f.dimensione)}`, onclick: ev => { ev.preventDefault(); apriFile(f.percorso); } },
      el("span", { class: `tipo-file tipo-${f.xml ? "xml" : f.estensione === "sql" ? "sql" : "altro"}` }, f.xml ? "xml" : f.estensione || "file"), " ", f.nome,
      conCartella && f.cartella ? el("span", { class: "tenue" }, ` ${f.cartella}/`) : null);

    function disegnaAlbero() {
      ricercaNomeFile = cercaNome.value; tipoFile = tipo.value;
      const q = cercaNome.value.trim();
      const file = E.file.filter(passaTipo);
      if (q) {
        const trovati = file.filter(f => corrispondeNome(f.nome, q) || (q.includes("/") && f.percorso.toLowerCase().includes(q.toLowerCase())));
        const esatti = trovati.filter(f => f.nome.toLowerCase() === q.toLowerCase());
        const altri = trovati.filter(f => !esatti.includes(f));
        conteggio.textContent = `${trovati.length} file su ${E.file.length}`;
        riempi(albero,
          esatti.length ? el("div", { class: "reverse-area" }, `Con lo stesso nome (${esatti.length})`) : null, esatti.map(f => voceFile(f, true)),
          altri.length ? el("div", { class: "reverse-area" }, esatti.length ? `Che contengono «${q}» (${altri.length})` : `Trovati (${altri.length})`) : null,
          altri.slice(0, 2000).map(f => voceFile(f, true)),
          trovati.length ? null : el("p", { class: "tenue" }, "Nessun file con questo nome."));
        return;
      }
      conteggio.textContent = tipoFile === "tutti" ? "" : `${file.length} file su ${E.file.length}`;
      // albero delle cartelle: si aprono e chiudono con un clic
      const figli = new Map([["", { cartelle: new Set(), file: [] }]]);
      const nodo = c => { if (!figli.has(c)) figli.set(c, { cartelle: new Set(), file: [] }); return figli.get(c); };
      for (const f of file) {
        nodo(f.cartella).file.push(f);
        const parti = f.cartella ? f.cartella.split("/") : [];
        parti.forEach((p, i) => nodo(parti.slice(0, i).join("/")).cartelle.add(parti.slice(0, i + 1).join("/")));
      }
      const conta = c => { const n = figli.get(c); return n.file.length + [...n.cartelle].reduce((s, x) => s + conta(x), 0); };
      const disegna = (c, livello) => {
        const n = figli.get(c);
        return [
          [...n.cartelle].sort().map(sub => {
            const aperta = cartelleAperte.has(sub);
            return [el("a", { href: "#", class: "file-cartella", style: `padding-left: ${6 + livello * 14}px`,
              onclick: ev => { ev.preventDefault(); aperta ? cartelleAperte.delete(sub) : cartelleAperte.add(sub); disegnaAlbero(); } },
              el("span", { class: "freccia" }, aperta ? "▾" : "▸"), " ", sub.split("/").pop(), el("span", { class: "tenue" }, ` ${conta(sub)}`)),
            aperta ? disegna(sub, livello + 1) : null];
          }),
          n.file.map(f => { const v = voceFile(f, false); v.style.paddingLeft = `${6 + livello * 14 + 13}px`; return v; }),
        ];
      };
      albero.replaceChildren(...[disegna("", 0)].flat(Infinity).filter(Boolean));
      if (!file.length) albero.append(el("p", { class: "tenue" }, "Nessun file."));
    }

    async function cercaContenuto() {
      ricercaTestoFile = cercaTesto.value;
      const parola = cercaTesto.value.trim();
      if (parola.length < 2) { avviso("Scrivi almeno due caratteri da cercare nei file."); return; }
      const nomi = cercaNome.value.trim();
      const T = await conAttesa(() => Sorgente.cerca(parola, nomi));
      if (!T) return;
      fileAperto = null;
      centro.replaceChildren(el("div", { class: "pannello" },
        el("h3", {}, `«${parola}» in ${T.risultati.length} file` + (nomi ? ` (solo i file «${nomi}»)` : "")),
        T.saltati ? el("p", { class: "tenue" }, `${T.saltati} file più grandi di 32 MB non sono stati letti: aprili e usa la ricerca nel file.`) : null,
        T.risultati.map(r => el("div", { class: "risultato-ricerca" },
          el("a", { href: "#", onclick: ev => { ev.preventDefault(); apriFile(r.percorso); } }, el("b", {}, r.nome)),
          el("span", { class: "tenue" }, ` ${r.cartella ? r.cartella + "/ · " : ""}${r.volte === 1 ? "1 volta" : r.volte + " volte"}`),
          r.righe.map(([n, t]) => el("a", { href: "#", class: "riga-trovata", onclick: ev => { ev.preventDefault(); apriFile(r.percorso, n); } },
            el("span", { class: "num" }, n), t)))),
        T.risultati.length ? null : el("p", { class: "tenue" }, "Nessun file contiene questo testo.")));
    }

    async function apriFile(percorso, riga = null) {
      fileAperto = percorso;
      rigaDaMostrare = riga;
      albero.querySelectorAll(".scelta").forEach(a => a.classList.remove("scelta"));
      const voce = albero.querySelector(`a[data-percorso="${CSS.escape(percorso)}"]`);
      if (voce) voce.classList.add("scelta");
      centro.replaceChildren(el("p", { class: "tenue" }, "Lettura..."));
      let P;
      try { P = await Sorgente.leggi(percorso); }
      catch (e) { centro.replaceChildren(el("p", { class: "errore" }, e.message)); return; }
      const f = E.file.find(x => x.percorso === percorso) || { nome: percorso, xml: eFileXml(percorso), estensione: estensioneDi(percorso).slice(1) };
      // le tabelle del file: quelle che conosce l'analisi, o i CREATE TABLE trovati nel testo
      const tabelle = P.tabelle && P.tabelle.length ? P.tabelle : P.binario ? [] : tabelleNelTesto(P.testo);
      const nomiAnalisi = stato.caricato ? (await datiReverse().catch(() => null))?.D.tabelle || {} : {};
      contesto = { tabelle: [...new Set(tabelle.map(t => t.tabella))], titolo: `Tabelle di ${f.nome}` };
      visore = P.binario ? null : visoreFile(P);
      const chip = t => el("a", { href: "#", class: "chip" + (nomiAnalisi[t.tabella] ? "" : " fuori"),
        title: nomiAnalisi[t.tabella] ? `Riga ${t.riga}: apri la scheda accanto al file` : `Riga ${t.riga}: la tabella non è nell'analisi`,
        onclick: ev => { ev.preventDefault(); if (t.riga) visore.vaiA(t.riga); if (nomiAnalisi[t.tabella]) apriNelPannello(box, contesto, t.tabella); } },
        t.tabella, t.riga ? el("span", { class: "tenue" }, ` r.${t.riga}`) : null);
      riempi(centro,
        el("div", { class: "riga-comandi" },
          el("h3", { class: "titolo-file" }, f.nome),
          el("span", { class: "tenue" }, `${percorso} · ${formattaByte(P.dimensione)}${P.codifica ? " · " + P.codifica : ""}`),
          pulsanteAffianca(box, contesto),
          f.xml ? el("button", { onclick: () => { xmlDaAprire = percorso; mostra("xml"); } }, "Apri come albero XML") : null),
        tabelle.length ? el("div", { class: "chips" }, el("span", { class: "tenue" }, `${tabelle.length} tabelle:`), tabelle.slice(0, 300).map(chip)) : null,
        P.binario ? el("div", { class: "pannello" }, el("p", {}, "File binario: non si può mostrare come testo.")) : visore.nodo);
      disegnaAffiancati(box, contesto);
      if (riga && visore) visore.vaiA(riga);
    }

    let attesa = null;
    cercaNome.addEventListener("input", () => { clearTimeout(attesa); attesa = setTimeout(disegnaAlbero, 150); });
    tipo.addEventListener("change", disegnaAlbero);
    cercaTesto.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); cercaContenuto(); } });
    disegnaAlbero();
    if (fileAperto && E.file.some(f => f.percorso === fileAperto)) apriFile(fileAperto, rigaDaMostrare);
    else {
      fileAperto = null;
      centro.replaceChildren(el("div", { class: "pannello" },
        el("p", {}, "Scegli un file a sinistra. Puoi cercare:"),
        el("ul", {},
          el("li", {}, el("b", {}, "per nome"), ": ordini.sql mostra prima i file con lo stesso nome (anche in sottocartelle diverse), poi quelli che lo contengono; *.xml tutti i file XML;"),
          el("li", {}, el("b", {}, "per contenuto"), ": scrivi un testo (il nome di una tabella o di una colonna) e premi Invio per sapere quali file lo usano."))));
      disegnaAffiancati(box, contesto);
    }
    return [...intestazione, sceltaCartella(E, "file"),
      el("div", { class: "file-griglia" },
        el("div", { class: "pannello reverse-laterale" }, cercaNome, cercaTesto, tipo, conteggio, albero),
        el("div", { class: "affianca-riga" }, centro, box))];
  },

  async xml() {
    const { E, errore } = await elencoOMessaggio("xml");
    const intestazione = [el("h2", {}, "File XML"),
      el("p", { class: "tenue" }, "I file XML della cartella (anche .xsd, .config, .xaml, .resx, mapping .hbm...) come albero da aprire nodo per nodo, " +
        "con il riepilogo degli elementi e le tabelle e colonne del database che compaiono nel file.")];
    const sceltaFile = el("input", { type: "file", accept: [...ESTENSIONI_XML].join(","), hidden: true });
    const elenco = el("div", { class: "file-albero" });
    const cerca = el("input", { type: "search", placeholder: "cerca un file XML", "aria-label": "Cerca un file XML" });
    const centro = el("div", { class: "file-centro" });
    const box = el("div", { class: "affiancati", hidden: true });
    const fileXml = E ? E.file.filter(f => f.xml) : [];

    function disegnaElenco() {
      const q = cerca.value.trim();
      const trovati = fileXml.filter(f => corrispondeNome(f.nome, q) || (q && f.percorso.toLowerCase().includes(q.toLowerCase())));
      elenco.replaceChildren(
        el("p", { class: "tenue" }, `${trovati.length} file XML` + (q ? ` su ${fileXml.length}` : "")),
        ...trovati.map(f => el("a", { href: "#", class: "file-voce" + (xmlAperto && xmlAperto.percorso === f.percorso ? " scelta" : ""),
          "data-percorso": f.percorso, title: `${f.percorso} · ${formattaByte(f.dimensione)}`,
          onclick: ev => { ev.preventDefault(); apri(f.percorso); } }, f.nome, f.cartella ? el("span", { class: "tenue" }, ` ${f.cartella}/`) : null)));
    }

    async function apri(percorso, testo = null) {
      elenco.querySelectorAll(".scelta").forEach(a => a.classList.remove("scelta"));
      const voce = elenco.querySelector(`a[data-percorso="${CSS.escape(percorso)}"]`);
      if (voce) voce.classList.add("scelta");
      centro.replaceChildren(el("p", { class: "tenue" }, "Lettura del file XML..."));
      try {
        if (testo === null) testo = xmlAperto && xmlAperto.percorso === percorso && xmlAperto.testo || (await Sorgente.xml(percorso)).testo;
      } catch (e) { centro.replaceChildren(el("p", { class: "errore" }, e.message)); return; }
      xmlAperto = { percorso, testo };
      centro.replaceChildren(await paginaXml(percorso, testo, box));
    }

    sceltaFile.addEventListener("change", async e => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) apri(f.name, await f.text());
    });
    cerca.addEventListener("input", disegnaElenco);
    disegnaElenco();
    const daAprire = xmlDaAprire || (xmlAperto && xmlAperto.percorso);
    xmlDaAprire = null;
    if (daAprire && (fileXml.some(f => f.percorso === daAprire) || (xmlAperto && xmlAperto.percorso === daAprire))) apri(daAprire);
    else centro.replaceChildren(el("div", { class: "pannello" }, el("p", {}, fileXml.length
      ? "Scegli un file XML a sinistra."
      : "In questa cartella non ci sono file XML. Puoi aprirne uno dal computer con il pulsante a sinistra.")));
    return [...intestazione, ...(errore || [sceltaCartella(E, "xml")]),
      el("div", { class: "file-griglia" },
        el("div", { class: "pannello reverse-laterale" }, cerca,
          el("label", { class: "pulsante" }, "Apri un file XML dal computer", sceltaFile), elenco),
        el("div", { class: "affianca-riga" }, centro, box))];
  },
});

// ======================================================================= XML

/** Percorso di un elemento in stile XPath: /catalogo/libro[2]/titolo */
function percorsoXml(n) {
  const parti = [];
  for (; n && n.nodeType === 1; n = n.parentElement) {
    const fratelli = n.parentElement ? [...n.parentElement.children].filter(x => x.tagName === n.tagName) : [n];
    parti.unshift(fratelli.length > 1 ? `${n.tagName}[${fratelli.indexOf(n) + 1}]` : n.tagName);
  }
  return "/" + parti.join("/");
}

const testoProprio = n => [...n.childNodes].filter(c => c.nodeType === 3 || c.nodeType === 4).map(c => c.nodeValue).join("").trim();

/** Albero XML: ogni elemento si apre con un clic, i figli si disegnano solo quando servono (file grandi). */
function alberoXml(radice) {
  const nodi = new WeakMap();           // elemento XML -> {riga, apri}
  const contenitore = el("div", { class: "xml-albero" });

  function nodo(n, livello) {
    const figli = [...n.children];
    const testo = testoProprio(n);
    const scatola = el("div", { class: "xml-figli", hidden: true });
    let disegnati = false, aperto = false;
    const freccia = el("span", { class: "freccia" }, figli.length ? "▸" : " ");
    const apri = (si = !aperto) => {
      if (!figli.length) return;
      aperto = si;
      freccia.textContent = aperto ? "▾" : "▸";
      scatola.hidden = !aperto;
      if (aperto && !disegnati) {
        disegnati = true;
        const mostra = da => {
          const parte = figli.slice(da, da + 500).map(f => nodo(f, livello + 1));
          scatola.append(...parte);
          if (da + 500 < figli.length) {
            const altri = el("a", { href: "#", class: "xml-altri", style: `padding-left: ${(livello + 1) * 16}px`,
              onclick: e => { e.preventDefault(); altri.remove(); mostra(da + 500); } }, `mostra altri ${figli.length - da - 500} elementi`);
            scatola.append(altri);
          }
        };
        mostra(0);
      }
    };
    const riga = el("div", { class: "xml-riga", style: `padding-left: ${livello * 16}px`, onclick: () => apri() },
      freccia, el("span", { class: "xml-tag" }, `<${n.tagName}`),
      [...n.attributes].map(a => [" ", el("span", { class: "xml-attr" }, a.name), "=", el("span", { class: "xml-val" }, `"${a.value}"`)]),
      el("span", { class: "xml-tag" }, figli.length || testo ? ">" : " />"),
      testo ? el("span", { class: "xml-testo" }, testo.length > 300 ? testo.slice(0, 300) + "…" : testo) : null,
      figli.length ? el("span", { class: "tenue" }, `  ${figli.length} element${figli.length === 1 ? "o" : "i"}`) : null);
    nodi.set(n, { riga, apri });
    return el("div", { class: "xml-nodo" }, riga, scatola);
  }

  contenitore.append(nodo(radice, 0));
  nodi.get(radice).apri(true);
  return {
    nodo: contenitore,
    /** Apre gli antenati, porta l'elemento in vista e lo evidenzia. */
    mostra(n) {
      const catena = [];
      for (let x = n.parentElement; x; x = x.parentElement) catena.unshift(x);
      catena.forEach(x => { if (!nodi.has(x)) return; nodi.get(x).apri(true); });
      // figli oltre i primi 500: si aprono i blocchi finché l'elemento compare
      for (let i = 0; !nodi.has(n) && i < 200; i++) {
        const altri = contenitore.querySelector(".xml-altri");
        if (!altri) break;
        altri.click();
      }
      const N = nodi.get(n);
      if (!N) return;
      contenitore.querySelectorAll(".evidenziata").forEach(r => r.classList.remove("evidenziata"));
      N.riga.classList.add("evidenziata");
      N.riga.scrollIntoView({ block: "center" });
    },
  };
}

/** Riepilogo: quante volte compare ogni elemento, con gli attributi e un percorso di esempio. */
function riepilogoXml(doc) {
  const tag = new Map();
  let profondita = 0, attributi = 0;
  const visita = (n, livello) => {
    profondita = Math.max(profondita, livello);
    let T = tag.get(n.tagName);
    if (!T) { T = { volte: 0, attributi: new Set(), esempio: percorsoXml(n), testo: 0 }; tag.set(n.tagName, T); }
    T.volte++;
    for (const a of n.attributes) { T.attributi.add(a.name); attributi++; }
    if (testoProprio(n)) T.testo++;
    for (const f of n.children) visita(f, livello + 1);
  };
  visita(doc.documentElement, 1);
  const spazi = new Set();
  doc.querySelectorAll("*").forEach(n => { if (n.namespaceURI) spazi.add(n.namespaceURI); });
  return { tag, profondita, attributi, spazi, elementi: [...tag.values()].reduce((s, T) => s + T.volte, 0) };
}

/** Tabelle e colonne del database che compaiono nel file XML: nei nomi degli elementi, negli attributi, nei valori e nel testo.
    Le colonne si contano solo vicino a un elemento che nomina la loro tabella (come nei mapping: <class table="ordini"><property column="id_cliente"/>). */
function collegamentiXml(doc, R) {
  const tabelle = new Map(Object.keys(R.D.tabelle).map(t => [t.toLowerCase(), t]));
  const colonne = Object.fromEntries(Object.values(R.D.tabelle).map(T => [T.tabella, new Map(T.colonne.map(c => [c.colonna.toLowerCase(), c.colonna]))]));
  const parole = s => String(s).toLowerCase().split(/[^a-z0-9_$]+/).filter(Boolean);
  const voci = n => [["elemento", n.localName || n.tagName], ...[...n.attributes].flatMap(a => [["attributo", a.name], [`valore di ${a.name}`, a.value]]),
    ...(testoProprio(n) && testoProprio(n).length <= 200 ? [["testo", testoProprio(n)]] : [])];
  const trovate = new Map();      // tabella -> {volte, dove:Set, primo, colonne: Map(colonna -> {volte, primo})}
  for (const n of doc.getElementsByTagName("*")) {
    for (const [dove, testo] of voci(n)) {
      for (const p of parole(testo)) {
        const t = tabelle.get(p);
        if (!t) continue;
        let T = trovate.get(t);
        if (!T) { T = { volte: 0, dove: new Set(), primo: n, colonne: new Map() }; trovate.set(t, T); }
        T.volte++; T.dove.add(dove);
        // colonne della tabella nell'elemento e nei discendenti vicini
        const vicini = [n, ...[...n.getElementsByTagName("*")].slice(0, 300)];
        for (const v of vicini) for (const [, x] of voci(v)) for (const q of parole(x)) {
          const c = colonne[t].get(q);
          if (!c) continue;
          const C = T.colonne.get(c) || { volte: 0, primo: v };
          C.volte++;
          T.colonne.set(c, C);
        }
      }
    }
  }
  return trovate;
}

async function paginaXml(percorso, testo, box) {
  const doc = new DOMParser().parseFromString(testo.replace(/^﻿/, ""), "application/xml");
  const sbaglio = doc.querySelector("parsererror");
  const nome = percorso.split("/").pop();
  let contesto = { tabelle: [], titolo: `Tabelle in ${nome}` };
  const contenuto = el("div");
  const schede = el("div", { class: "schede-xml riga-comandi" });
  const testa = el("div", { class: "riga-comandi" }, el("h3", { class: "titolo-file" }, nome),
    el("span", { class: "tenue" }, `${percorso} · ${formattaByte(testo.length)}`), pulsanteAffianca(box, contesto));
  const visoreTesto = () => {
    const limite = 2_000_000;
    const parte = testo.length > limite ? testo.slice(0, testo.lastIndexOf("\n", limite) + 1) : testo;
    return [testo.length > limite ? el("p", { class: "tenue" }, "Si vedono i primi 2 MB: per leggerlo tutto aprilo nella pagina File della cartella.") : null,
      visoreFile({ percorso, testo: parte, altro: false, fine: parte.length, dimensione: testo.length }).nodo];
  };
  if (sbaglio) {
    disegnaAffiancati(box, contesto);
    return el("div", {}, testa,
      el("div", { class: "messaggio errore" }, "Il file non è un XML valido: ", (sbaglio.querySelector("div") || sbaglio).textContent.trim().split("\n")[0]),
      visoreTesto());
  }
  const albero = alberoXml(doc.documentElement);
  const S = riepilogoXml(doc);
  const R = stato.caricato ? await datiReverse().catch(() => null) : null;
  const C = R ? collegamentiXml(doc, R) : new Map();
  contesto.tabelle.push(...[...C.entries()].sort((a, b) => b[1].volte - a[1].volte).map(([t]) => t));

  // ricerca nell'albero
  const cerca = el("input", { type: "search", placeholder: "cerca elementi, attributi, valori", "aria-label": "Cerca nel file XML" });
  const risultati = el("div", { class: "xml-risultati" });
  let attesa = null;
  cerca.addEventListener("input", () => { clearTimeout(attesa); attesa = setTimeout(() => {
    const q = cerca.value.trim().toLowerCase();
    if (!q) { risultati.replaceChildren(); return; }
    const trovati = [];
    for (const n of doc.getElementsByTagName("*")) {
      const dove = n.tagName.toLowerCase().includes(q) ? "elemento"
        : [...n.attributes].some(a => a.name.toLowerCase().includes(q) || a.value.toLowerCase().includes(q)) ? "attributo"
        : testoProprio(n).toLowerCase().includes(q) ? "testo" : null;
      if (dove) trovati.push([n, dove]);
      if (trovati.length >= 500) break;
    }
    risultati.replaceChildren(el("div", { class: "tenue" }, trovati.length >= 500 ? "primi 500 risultati" : trovati.length === 1 ? "1 risultato" : `${trovati.length} risultati`),
      ...trovati.map(([n, dove]) => el("a", { href: "#", onclick: e => { e.preventDefault(); albero.mostra(n); } },
        percorsoXml(n), el("span", { class: "tenue" }, ` (${dove})`))));
  }, 250); });

  const pagine = {
    albero: () => [el("div", { class: "riga-comandi" }, cerca), risultati, albero.nodo],
    riepilogo: () => [
      el("p", {}, `Elemento principale <${doc.documentElement.tagName}>: ${S.elementi} elementi di ${S.tag.size} tipi, ${S.attributi} attributi, ` +
        `profondità ${S.profondita}.` + (S.spazi.size ? ` Namespace: ${[...S.spazi].join(", ")}.` : "")),
      griglia({ colonne: ["elemento", "volte", "con testo", "attributi", "percorso di esempio"],
        righe: [...S.tag.entries()].sort((a, b) => b[1].volte - a[1].volte)
          .map(([t, T]) => [t, T.volte, T.testo, [...T.attributi].slice(0, 12).join(", "), T.esempio]) }, { titolo: "Elementi" })],
    database: () => {
      if (!R) return [el("p", { class: "tenue" }, "Carica i file .sql in alto per vedere quali tabelle e colonne del database compaiono in questo file.")];
      if (!C.size) return [el("p", {}, "Nel file non compare il nome di nessuna tabella del database analizzato.")];
      const totColonne = [...C.values()].reduce((s, T) => s + T.colonne.size, 0);
      return [
        el("p", {}, `Nel file compaiono ${C.size} tabelle del database su ${Object.keys(R.D.tabelle).length}` +
          (totColonne ? ` e ${totColonne} loro colonne (vicino all'elemento che nomina la tabella).` : ".") +
          " Clicca «mostra» per trovarlo nell'albero, la tabella per la sua scheda accanto."),
        el("table", { class: "tabella-xml" },
          el("tr", {}, el("th", {}, "tabella"), el("th", {}, "volte"), el("th", {}, "dove"), el("th", {}, "colonne trovate"), el("th", {}, "")),
          contesto.tabelle.map(t => {
            const T = C.get(t);
            return el("tr", {},
              el("td", {}, etichettaCategoria(R.D.tabelle[t].categoria), " ",
                el("a", { href: "#", onclick: e => { e.preventDefault(); apriNelPannello(box, contesto, t); } }, t)),
              el("td", {}, T.volte), el("td", {}, [...T.dove].join(", ")),
              el("td", {}, [...T.colonne.entries()].map(([c, X], i) => [i ? ", " : "",
                el("a", { href: "#", title: percorsoXml(X.primo), onclick: e => { e.preventDefault(); vai("albero"); albero.mostra(X.primo); } }, c)])),
              el("td", {}, el("a", { href: "#", title: percorsoXml(T.primo), onclick: e => { e.preventDefault(); vai("albero"); albero.mostra(T.primo); } }, "mostra")));
          }))];
    },
    testo: visoreTesto,
  };
  const nomi = { albero: "Albero", riepilogo: "Riepilogo", database: `Tabelle del database (${C.size})`, testo: "Testo" };
  function vai(quale) {
    schede.replaceChildren(...Object.keys(pagine).map(k => el("button", { class: k === quale ? "primario" : null, onclick: () => vai(k) }, nomi[k])));
    contenuto.replaceChildren(...[pagine[quale]()].flat(Infinity).filter(Boolean));
  }
  vai("albero");
  disegnaAffiancati(box, contesto);
  return el("div", {}, testa, schede, contenuto);
}
