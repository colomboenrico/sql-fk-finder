// Ponte tra l'interfaccia e l'app: il percorso su disco dei file scelti, così il server li legge
// direttamente dal disco (anche file da decine di GB) invece di riceverli dal browser.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("sqlfkApp", {
  percorso: file => {
    try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
  },
  // controllo dell'app (anche automatico al primo avvio)
  controlla: () => ipcRenderer.invoke("controlla"),
  alControllo: funzione => ipcRenderer.on("controllo", (_e, risultato) => funzione(risultato)),
  // rapporti salvati in Documenti/SQL FK Finder/rapporti/<nome>
  salvaRapporto: (nome, file) => ipcRenderer.invoke("salva-rapporto", nome, file),
  apriCartella: cartella => ipcRenderer.invoke("apri-cartella", cartella),
});
