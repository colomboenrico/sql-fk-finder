// Ponte tra l'interfaccia e l'app: il percorso su disco dei file scelti, così il server li legge
// direttamente dal disco (anche file da decine di GB) invece di riceverli dal browser.
const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("sqlfkApp", {
  percorso: file => {
    try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
  },
});
