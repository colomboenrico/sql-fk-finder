"""Controllo dell'app: verifica che Python, librerie, analisi, query e lettura delle finestre funzionino.

Usa una copia separata degli esempi (cartella esempi): non tocca il lavoro aperto nell'app. Tutto in locale.
L'app aggiunge i controlli sulla rete (internet bloccato, nessuna connessione aperta).
"""

import importlib
import platform
import sys
import time
from pathlib import Path

ESEMPI = Path(__file__).resolve().parent.parent / "esempi"
ATTESI = {"errore": 2, "avviso": 18, "info": 15}          # diagnostica degli esempi


def controlla():
    """[{voce, esito: ok | errore | info, dettaglio}]"""
    risultati = []

    def voce(nome, funzione):
        inizio = time.time()
        try:
            esito, dettaglio = funzione()
        except Exception as e:
            esito, dettaglio = "errore", f"{type(e).__name__}: {e}"
        risultati.append({"voce": nome, "esito": esito, "dettaglio": dettaglio, "secondi": round(time.time() - inizio, 2)})

    voce("Python", lambda: ("ok", f"{platform.python_version()} ({sys.executable})"))

    def librerie():
        nomi = ["pandas", "scipy", "sqlglot", "pyvis", "openpyxl", "networkx"] + (["comtypes"] if sys.platform == "win32" else [])
        mancanti = []
        for n in nomi:
            try:
                importlib.import_module(n)
            except ImportError:
                mancanti.append(n)
        return ("errore", "mancano: " + ", ".join(mancanti)) if mancanti else ("ok", ", ".join(nomi))
    voce("Librerie", librerie)

    def analisi():
        from . import analisi as A
        df, pk, fk, errori = A.leggi_cartella(ESEMPI)
        R = A.analizza(df, pk, fk_dichiarate=fk, errori=errori)
        conti = A.conteggi_diagnostica(R.diagnostica)
        ok = all(conti.get(k) == v for k, v in ATTESI.items())
        return ("ok" if ok else "errore",
                f"{df['tabella'].nunique()} tabelle degli esempi, {conti.get('errore')} errori, {conti.get('avviso')} avvisi, "
                f"{conti.get('info')} info" + ("" if ok else f" (attesi {ATTESI})"))
    voce("Analisi delle chiavi", analisi)

    def query():
        from . import query as QY
        db = QY.da_cartella(ESEMPI)
        r = db.esegui("SELECT COUNT(*) FROM comuni")["risultati"][0]
        db.chiudi()
        return ("ok", "database delle query: 5 comuni negli esempi") if r["righe"] == [[5]] else ("errore", str(r))
    voce("Query sui dati", query)

    def lettura_file_grandi():
        from . import lettura as L
        testo = "CREATE TABLE a (x INT);\n" + "INSERT INTO a VALUES (1);\n" * 1000 + "ALTER TABLE a ADD PRIMARY KEY (x);\n"
        frasi = [f for t, _, f, _ in L.istruzioni(testo, "mysql") if t == "istruzione"]
        return ("ok", "lettura a blocchi dei file .sql") if len(frasi) == 1002 else ("errore", f"{len(frasi)} istruzioni invece di 1002")
    voce("Lettura dei file", lettura_file_grandi)

    def finestre():
        from . import finestre as FIN
        if not FIN.SU_WINDOWS:
            return "info", "la lettura delle finestre dei programmi è per Windows: su questo sistema non serve"
        n = len(FIN.Lettore().finestre())
        return "ok", f"UI Automation funziona: {n} finestre aperte trovate"
    voce("Lettura delle finestre (Windows)", finestre)

    def interfaccia():
        from . import analisi as A, interfaccia as UI
        from .finestre import Nodo as N, fotografia
        df, pk, fk, _ = A.leggi_cartella(ESEMPI)
        R = A.analizza(df, pk, fk_dichiarate=fk)
        modulo = N("gruppo", "Provincia", figli=[N("testo", "Provincia:"), N("testo modificabile", valore="Torino"),
                                                  N("testo", "Regione:"), N("menu", opzioni=["Piemonte", "Lombardia"])])
        foto = fotografia(N("finestra", "Prova", figli=[modulo]), (), "prova.exe")
        V = UI.verifica([foto], R)
        trovata = any(r["tabella"] == "province" and r["→ tabella"] == "regioni" for r in V.relazioni.to_dict("records"))
        return ("ok", "analisi delle schermate: relazione province → regioni riconosciuta") if trovata else ("errore", "relazione non riconosciuta")
    voce("Analisi delle schermate", interfaccia)
    return risultati
