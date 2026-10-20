// App desktop: avvia il motore Python (sqlfk.ponte) e mostra l'interfaccia in una finestra.
//
// Nessuna rete: l'interfaccia si carica da un protocollo interno (sqlfk://app/) e ogni richiesta passa a
// Python attraverso le pipe del processo (standard input e output), senza porte né socket. Tutte le
// richieste verso internet (http, https, ws) sono bloccate.
//
// Funziona dalla cartella del progetto (npm start) e come app installata (crea_eseguibili): in quel caso
// Python con le librerie e il modulo sqlfk sono tra le risorse dell'app.
const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const RADICE = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");   // contiene sqlfk/
const ICONA = path.join(__dirname, "icona.png");
const LIBRERIE = "import pandas, scipy, pyvis, openpyxl, networkx";   // clingo è facoltativo: senza, la sua pagina lo dice
const WIN = process.platform === "win32";
const INDIRIZZO = "sqlfk://app/";
let ponte = null;
let finestraPrincipale = false;

// niente servizi di rete di Chromium in sottofondo
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("no-pings");
protocol.registerSchemesAsPrivileged([
  { scheme: "sqlfk", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------- Python
// [comando, argomenti]: prima il Python incluso nell'app (con le librerie), poi quelli del computer
function candidati() {
  const casa = os.homedir();
  const incluso = WIN ? path.join(RADICE, "python", "python.exe") : path.join(RADICE, "python", "bin", "python3");
  const elenco = [];
  if (process.env.SQLFK_PYTHON) elenco.push([process.env.SQLFK_PYTHON, []]);
  elenco.push([incluso, []]);
  if (WIN) {
    const programmi = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python");
    elenco.push(["python", []], ["py", ["-3"]],
      [path.join(casa, "anaconda3", "python.exe"), []], [path.join(casa, "miniconda3", "python.exe"), []],
      ...["Python313", "Python312", "Python311", "Python310"].map(v => [path.join(programmi, v, "python.exe"), []]));
  } else {
    // /usr/bin/python3 alla fine: sul Mac senza gli strumenti per sviluppatori apre la richiesta di installarli
    elenco.push(["/opt/anaconda3/bin/python", []], [path.join(casa, "anaconda3", "bin", "python"), []],
      [path.join(casa, "miniconda3", "bin", "python"), []], ["/opt/homebrew/bin/python3", []],
      ["/usr/local/bin/python3", []], ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", []],
      ["python3", []], ["python", []], ["/usr/bin/python3", []]);
  }
  return elenco;
}

function trovaPython() {
  for (const [python, argomenti] of candidati()) {
    if (path.isAbsolute(python) && !fs.existsSync(python)) continue;
    try {
      const r = spawnSync(python, [...argomenti, "-c", LIBRERIE], { cwd: RADICE, timeout: 60000, windowsHide: true });
      if (r.status === 0) return [python, argomenti];
    } catch { /* il prossimo */ }
  }
  return null;
}

// ---------------------------------------------------------------- il ponte con Python (pipe, niente rete)
class Ponte {
  constructor([python, argomenti]) {
    this.attese = new Map();
    this.prossimo = 1;
    this.processo = spawn(python, [...argomenti, "-m", "sqlfk.ponte"], {
      cwd: RADICE, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
             SQLFK_PID_APP: String(process.pid) },
    });
    this.errori = "";
    let resto = "";
    this.pronto = new Promise((risolvi, rifiuta) => {
      this.processo.stdout.setEncoding("utf8");
      this.processo.stdout.on("data", dati => {
        resto += dati;
        let i;
        while ((i = resto.indexOf("\n")) >= 0) {
          const riga = resto.slice(0, i);
          resto = resto.slice(i + 1);
          if (!riga.trim()) continue;
          let m;
          try { m = JSON.parse(riga); } catch { continue; }
          if (m.pronto) { risolvi(); continue; }
          this.ricevi(m);
        }
      });
      this.processo.stderr.on("data", d => { this.errori = (this.errori + d).slice(-4000); process.stderr.write(d); });
      this.processo.on("exit", codice => {
        rifiuta(new Error(`Il motore Python si è chiuso (codice ${codice}).\n${this.errori.slice(-1500)}`));
        for (const a of this.attese.values()) a.errore(new Error("Il motore Python si è chiuso."));
        this.attese.clear();
      });
    });
  }

  // la risposta è un flusso: la testa (stato, intestazioni) arriva prima, poi i dati a pezzi
  richiesta(metodo, percorso, corpo) {
    const id = this.prossimo++;
    return new Promise((risolvi, rifiuta) => {
      let controllo = null;
      const flusso = new ReadableStream({ start: c => { controllo = c; } });
      const a = {
        testa: (stato, intestazioni) => { a.iniziata = true; risolvi({ stato, intestazioni, flusso }); },
        pezzo: dati => controllo.enqueue(new Uint8Array(Buffer.from(dati, "base64"))),
        fine: m => {
          if (!a.iniziata) risolvi({ stato: m.stato, intestazioni: m.intestazioni || {}, flusso });
          if (m.errore) controllo.enqueue(new TextEncoder().encode(JSON.stringify({ errore: m.errore })));
          controllo.close();
          this.attese.delete(id);
        },
        errore: e => { if (!a.iniziata) rifiuta(e); else controllo.error(e); },
      };
      this.attese.set(id, a);
      const messaggio = { id, metodo, percorso };
      if (corpo && corpo.length) messaggio.corpo = Buffer.from(corpo).toString("base64");
      this.processo.stdin.write(JSON.stringify(messaggio) + "\n");
    });
  }

  ricevi(m) {
    const a = this.attese.get(m.id);
    if (!a) return;
    if (m.testa) a.testa(m.stato, m.intestazioni || {});
    else if (m.pezzo) a.pezzo(m.pezzo);
    else if (m.fine) a.fine(m);
  }

  chiudi() {
    try { this.processo.stdin.end(); } catch { /* già chiuso */ }
    setTimeout(() => { try { this.processo.kill(); } catch { /* già uscito */ } }, 1500);
  }
}

function registraProtocollo() {
  protocol.handle("sqlfk", async richiesta => {
    const u = new URL(richiesta.url);
    const corpo = richiesta.method === "POST" ? Buffer.from(await richiesta.arrayBuffer()) : null;
    const r = await ponte.richiesta(richiesta.method, u.pathname + u.search, corpo);
    const intestazioni = { ...r.intestazioni };
    delete intestazioni["Content-Length"];
    delete intestazioni["Connection"];
    return new Response(r.flusso, { status: r.stato, headers: intestazioni });
  });
}

// ---------------------------------------------------------------- niente rete
function bloccaRete() {
  const filtro = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] };
  session.defaultSession.webRequest.onBeforeRequest(filtro, (_d, cb) => cb({ cancel: true }));
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-navigate", (evento, url) => { if (!url.startsWith(INDIRIZZO)) evento.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => url.startsWith(INDIRIZZO)
      ? { action: "allow", overrideBrowserWindowOptions: { width: 1300, height: 900, autoHideMenuBar: true, icon: ICONA } }
      : { action: "deny" });
  });
}

function creaFinestra() {
  finestraPrincipale = true;
  const finestra = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, title: "SQL FK Finder", icon: ICONA, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.js") },
  });
  finestra.loadURL(INDIRIZZO);
  return finestra;
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(ICONA);   // icona nel Dock del Mac
  bloccaRete();
  const python = trovaPython();
  if (!python) {
    dialog.showErrorBox("Python non trovato",
      "Manca il Python dell'app con le sue librerie.\n\nNell'app creata con crea_eseguibili è incluso; dalla cartella " +
      "del progetto serve un Python 3 con le librerie installate (pip install -r requirements.txt).\n\n" +
      "Se Python è in un percorso particolare, avvia l'app con la variabile SQLFK_PYTHON impostata al percorso dell'eseguibile python.");
    app.quit();
    return;
  }
  ponte = new Ponte(python);
  try {
    await ponte.pronto;
  } catch (e) {
    dialog.showErrorBox("Errore all'avvio", e.message);
    app.quit();
    return;
  }
  registraProtocollo();
  registraComandi();
  controlloAllAvvio(creaFinestra());
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) creaFinestra(); });
});

app.on("window-all-closed", () => { if (finestraPrincipale) app.quit(); });
app.on("will-quit", () => { if (ponte) ponte.chiudi(); });

// ---------------------------------------------------------------- controllo dell'app
// Controlla Python, librerie, analisi, query, lettura delle finestre (in Python, su una copia degli esempi,
// senza toccare il lavoro aperto) e che l'app non usi la rete. Il risultato si salva in autoverifica.txt.
function fileControllo() { return path.join(app.getPath("userData"), "autoverifica.txt"); }

async function controllaApp(wc) {
  const controlli = [];
  const aggiungi = (voce, esito, dettaglio) => controlli.push({ voce, esito, dettaglio });
  aggiungi("App", "ok", `${app.getName()} ${app.getVersion()}, Electron ${process.versions.electron}, ${process.platform} ${process.arch}`);
  aggiungi("Interfaccia", wc.getURL().startsWith(INDIRIZZO) ? "ok" : "errore", wc.getURL());
  try {
    const r = await ponte.richiesta("GET", "/api/autoverifica", null);
    const dati = JSON.parse(await new Response(r.flusso).text());
    for (const c of dati.controlli || []) aggiungi(c.voce, c.esito, c.dettaglio);
  } catch (e) {
    aggiungi("Motore Python", "errore", e.message);
  }
  const internet = await wc.executeJavaScript("fetch('https://example.com').then(() => 'raggiunto').catch(() => 'bloccato')", true);
  aggiungi("Internet", internet === "bloccato" ? "ok" : "errore", internet === "bloccato" ? "bloccato: l'app non va in rete" : "RAGGIUNTO");
  const pid = [process.pid, ponte.processo.pid];
  let connessioni = "";
  try {
    if (WIN) {
      const out = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout || "";
      connessioni = out.split("\n").filter(r => pid.some(p => r.trim().endsWith(" " + p))).join("\n").trim();
    } else {
      connessioni = pid.map(p => (spawnSync("lsof", ["-nP", "-a", "-p", String(p), "-i"], { encoding: "utf8" }).stdout || "").trim())
        .filter(Boolean).join("\n");
    }
    aggiungi("Connessioni di rete", connessioni ? "errore" : "ok", connessioni || "nessuna porta e nessuna connessione aperta");
  } catch (e) {
    aggiungi("Connessioni di rete", "info", "controllo non disponibile: " + e.message);
  }
  const errori = controlli.filter(c => c.esito === "errore").length;
  const testo = [`Controllo di SQL FK Finder - ${new Date().toLocaleString("it-IT")}`,
    errori ? `${errori} problemi trovati` : "Tutto a posto.", "",
    ...controlli.map(c => `[${c.esito === "ok" ? "OK" : c.esito === "info" ? "INFO" : "ERRORE"}] ${c.voce}: ${c.dettaglio}`)].join("\n") + "\n";
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(fileControllo(), testo);
  return { controlli, errori, file: fileControllo(), testo };
}

// cartella dei rapporti: Documenti/SQL FK Finder/rapporti
function cartellaRapporti() { return path.join(app.getPath("documents"), "SQL FK Finder", "rapporti"); }

function registraComandi() {
  ipcMain.handle("controlla", e => controllaApp(e.sender));
  ipcMain.handle("salva-rapporto", (_e, nome, file) => {
    const pulito = String(nome || "rapporto").replace(/[^\w .-]+/g, "_").slice(0, 80);
    const cartella = path.join(cartellaRapporti(), pulito);
    fs.mkdirSync(cartella, { recursive: true });
    for (const [n, contenuto] of Object.entries(file || {})) {
      fs.writeFileSync(path.join(cartella, path.basename(n)), contenuto);
    }
    return cartella;
  });
  ipcMain.handle("apri-cartella", (_e, cartella) => {
    // solo le cartelle dell'app (rapporti e controllo): niente percorsi qualsiasi
    const p = path.resolve(String(cartella || ""));
    if (p.startsWith(cartellaRapporti()) || p.startsWith(app.getPath("userData"))) return shell.openPath(p);
    return "cartella non permessa";
  });
}

// al primo avvio il controllo si fa da solo; con SQLFK_AUTOVERIFICA=1 si fa, si scrive e l'app si chiude
async function controlloAllAvvio(finestra) {
  await new Promise(r => finestra.webContents.once("did-finish-load", r));
  if (process.env.SQLFK_AUTOVERIFICA) {
    const r = await controllaApp(finestra.webContents);
    console.log(r.testo);
    fs.writeFileSync(path.join(os.tmpdir(), "sqlfk_autoverifica.txt"), r.testo);
    console.log("AUTOVERIFICA FINE", r.file);
    app.quit();
    return;
  }
  if (!fs.existsSync(fileControllo())) {
    const r = await controllaApp(finestra.webContents);
    finestra.webContents.send("controllo", r);
  }
}
