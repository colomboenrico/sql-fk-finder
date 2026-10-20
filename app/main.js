// App desktop: avvia il server Python (sqlfk.server) e mostra la sua interfaccia in una finestra.
// Funziona sia dalla cartella del progetto (npm start) sia come app installata (eseguibile creato con
// crea_eseguibili): in quel caso il modulo Python sqlfk è tra le risorse dell'app.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

// cartella che contiene sqlfk/ e requirements.txt
const RADICE = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
const REQUISITI = path.join(RADICE, "requirements.txt");
const ICONA = path.join(__dirname, "icona.png");
const LIBRERIE = "import pandas, scipy, pyvis, openpyxl, networkx";
const WIN = process.platform === "win32";
let server = null;
let indirizzo = null;
let finestraPrincipale = false;           // finché non c'è, chiudere la finestra dell'installazione non chiude l'app

// ambiente Python creato dall'app al primo avvio, se le librerie mancano
function cartellaAmbiente() { return path.join(app.getPath("userData"), "python"); }
function pythonAmbiente() { return path.join(cartellaAmbiente(), WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python"); }

// [comando, argomenti iniziali] dei Python da provare, in ordine
function candidati() {
  const casa = os.homedir();
  const elenco = [];
  if (process.env.SQLFK_PYTHON) elenco.push([process.env.SQLFK_PYTHON, []]);
  elenco.push([pythonAmbiente(), []]);
  if (WIN) {
    const programmi = path.join(process.env.LOCALAPPDATA || "", "Programs", "Python");
    elenco.push(["python", []], ["py", ["-3"]],
      [path.join(casa, "anaconda3", "python.exe"), []], [path.join(casa, "miniconda3", "python.exe"), []],
      ...["Python313", "Python312", "Python311", "Python310"].map(v => [path.join(programmi, v, "python.exe"), []]));
  } else {
    // un'app avviata dal Finder o dal menu non ha il PATH del terminale: si provano anche i percorsi soliti
    // /usr/bin/python3 alla fine: sul Mac senza gli strumenti per sviluppatori apre la richiesta di installarli
    elenco.push(["/opt/anaconda3/bin/python", []], [path.join(casa, "anaconda3", "bin", "python"), []],
      [path.join(casa, "miniconda3", "bin", "python"), []], ["/opt/homebrew/bin/python3", []],
      ["/usr/local/bin/python3", []], ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", []],
      ["python3", []], ["python", []], ["/usr/bin/python3", []]);
  }
  return elenco;
}

function prova(python, argomenti, codice) {
  try {
    const r = spawnSync(python, [...argomenti, "-c", codice], { cwd: RADICE, timeout: 60000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

// {pronto: [cmd, args]} se un Python ha già le librerie, altrimenti {base: [cmd, args]} (Python 3.9 o più recente)
function trovaPython() {
  let base = null;
  for (const [python, argomenti] of candidati()) {
    if (path.isAbsolute(python) && !fs.existsSync(python)) continue;
    if (!prova(python, argomenti, "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)")) continue;
    if (prova(python, argomenti, LIBRERIE)) return { pronto: [python, argomenti] };
    if (!base && python !== pythonAmbiente()) base = [python, argomenti];
  }
  return { base };
}

function esegui(comando, argomenti, finestra) {
  return new Promise((risolvi, rifiuta) => {
    const p = spawn(comando, argomenti, { cwd: RADICE, windowsHide: true });
    let uscita = "";
    const leggi = dati => {
      uscita += dati;
      const riga = String(dati).trim().split("\n").pop();
      if (riga && finestra && !finestra.isDestroyed()) {
        finestra.webContents.executeJavaScript(
          `document.getElementById("dettaglio").textContent = ${JSON.stringify(riga.slice(0, 160))}`).catch(() => {});
      }
    };
    p.stdout.on("data", leggi);
    p.stderr.on("data", leggi);
    p.on("error", rifiuta);
    p.on("exit", codice => codice === 0 ? risolvi() : rifiuta(new Error(uscita.slice(-2000))));
  });
}

// crea un ambiente Python dell'app e ci installa le librerie (serve internet, solo la prima volta)
async function installaLibrerie([python, argomenti]) {
  const finestra = new BrowserWindow({ width: 560, height: 220, resizable: false, title: "SQL FK Finder",
                                       icon: ICONA, autoHideMenuBar: true, webPreferences: { sandbox: true } });
  finestra.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    "<body style='font-family:-apple-system,Segoe UI,sans-serif;padding:24px'><h3>Installazione delle librerie Python</h3>" +
    "<p>Solo al primo avvio: serve internet e qualche minuto.</p><p id='dettaglio' style='color:#666;font-size:12px'>avvio...</p></body>"));
  try {
    await esegui(python, [...argomenti, "-m", "venv", cartellaAmbiente()], finestra);
    await esegui(pythonAmbiente(), ["-m", "pip", "install", "--upgrade", "pip"], finestra);
    await esegui(pythonAmbiente(), ["-m", "pip", "install", "-r", REQUISITI], finestra);
  } finally {
    if (!finestra.isDestroyed()) finestra.destroy();
  }
  return [pythonAmbiente(), []];
}

async function preparaPython() {
  const trovato = trovaPython();
  if (trovato.pronto) return trovato.pronto;
  if (!trovato.base) {
    const scelta = dialog.showMessageBoxSync({
      type: "error", title: "Python non trovato", buttons: ["Scarica Python", "Esci"], defaultId: 0,
      message: "Serve Python 3 (3.9 o più recente).",
      detail: "Installalo da python.org (su Windows spunta \"Add python.exe to PATH\"), poi riapri l'app: " +
              "le librerie le installa l'app da sola.\n\nSe Python è in un percorso particolare, avvia l'app con " +
              "la variabile SQLFK_PYTHON impostata al percorso dell'eseguibile python.",
    });
    if (scelta === 0) await shell.openExternal("https://www.python.org/downloads/");
    return null;
  }
  const scelta = dialog.showMessageBoxSync({
    type: "question", title: "Primo avvio", buttons: ["Installa", "Esci"], defaultId: 0,
    message: "Mancano le librerie Python dell'app (pandas, scipy, sqlglot...).",
    detail: `Le installo ora in una cartella dell'app (${cartellaAmbiente()}), senza toccare il tuo Python. ` +
            "Serve internet e qualche minuto, solo questa volta.",
  });
  if (scelta !== 0) return null;
  try {
    return await installaLibrerie(trovato.base);
  } catch (e) {
    fs.rmSync(cartellaAmbiente(), { recursive: true, force: true });
    dialog.showErrorBox("Installazione non riuscita",
      "Non sono riuscito a installare le librerie. Puoi installarle a mano con:\n  pip install -r requirements.txt\n\n" + e.message);
    return null;
  }
}

function avviaServer([python, argomenti]) {
  return new Promise((risolvi, rifiuta) => {
    server = spawn(python, [...argomenti, "-m", "sqlfk.server", "--porta", "0", "--con-app"], {
      cwd: RADICE, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
    });
    let errori = "";
    server.stdout.on("data", dati => {
      const m = String(dati).match(/SQLFK_PORTA=(\d+)/);
      if (m) risolvi(`http://127.0.0.1:${m[1]}/`);
    });
    server.stderr.on("data", dati => { errori += dati; process.stderr.write(dati); });
    server.on("exit", codice => rifiuta(new Error(`Il server Python si è chiuso (codice ${codice}).\n${errori.slice(-1500)}`)));
  });
}

function creaFinestra() {
  finestraPrincipale = true;
  const finestra = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "SQL FK Finder",
    icon: ICONA,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
                      preload: path.join(__dirname, "preload.js") },
  });

  // "Apri in una finestra a parte" per gli schemi: nuova finestra dell'app; i link esterni nel browser
  finestra.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(indirizzo)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 1300, height: 900, autoHideMenuBar: true, icon: ICONA } };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  finestra.loadURL(indirizzo);
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(ICONA);   // icona nel Dock del Mac
  const python = await preparaPython();
  if (!python) {
    app.quit();
    return;
  }
  try {
    indirizzo = await avviaServer(python);
  } catch (e) {
    dialog.showErrorBox("Errore all'avvio", e.message);
    app.quit();
    return;
  }
  creaFinestra();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) creaFinestra(); });
});

app.on("window-all-closed", () => { if (finestraPrincipale) app.quit(); });
app.on("will-quit", () => { if (server) server.kill(); });
