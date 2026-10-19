// App desktop: avvia il server Python (sqlfk.server) e mostra la sua interfaccia in una finestra.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const RADICE = path.join(__dirname, "..");          // cartella del progetto, contiene sqlfk/
const ICONA = path.join(__dirname, "icona.png");
let server = null;
let indirizzo = null;

// Python da usare: SQLFK_PYTHON se impostata, altrimenti il primo che ha le librerie necessarie.
function trovaPython() {
  const casa = os.homedir();
  const candidati = process.platform === "win32"
    ? [process.env.SQLFK_PYTHON, "python", "py",
       path.join(casa, "anaconda3", "python.exe"), path.join(casa, "miniconda3", "python.exe")]
    : [process.env.SQLFK_PYTHON, "python3", "python",
       "/opt/anaconda3/bin/python", path.join(casa, "anaconda3", "bin", "python"),
       path.join(casa, "miniconda3", "bin", "python"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  for (const python of candidati.filter(Boolean)) {
    const prova = spawnSync(python, ["-c", "import pandas, scipy, pyvis, openpyxl"], { cwd: RADICE, timeout: 30000 });
    if (prova.status === 0) return python;
  }
  return null;
}

function avviaServer(python) {
  return new Promise((risolvi, rifiuta) => {
    server = spawn(python, ["-m", "sqlfk.server", "--porta", "0", "--con-app"], { cwd: RADICE, stdio: ["pipe", "pipe", "pipe"] });
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
  const finestra = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "SQL FK Finder",
    icon: ICONA,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
  const python = trovaPython();
  if (!python) {
    dialog.showErrorBox("Python non trovato",
      "Serve Python 3 con le librerie del progetto.\n\n" +
      "Installale con:\n  pip install -r requirements.txt\n\n" +
      "Se Python è in un percorso particolare, avvia l'app con la variabile SQLFK_PYTHON " +
      "impostata al percorso dell'eseguibile python.");
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

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => { if (server) server.kill(); });
