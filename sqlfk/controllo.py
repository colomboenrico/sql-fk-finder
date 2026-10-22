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
        nomi = ["pandas", "scipy", "sqlglot", "pyvis", "openpyxl", "networkx", "clingo"] + (["comtypes"] if sys.platform == "win32" else [])
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

    def esplora_cartella():
        from . import esplora as ESP
        E = ESP.elenco(ESEMPI)
        nomi = [f["nome"] for f in E["file"] if ESP.corrisponde(f["nome"], "esempio_5.sql")]
        pezzo = ESP.leggi(ESEMPI, "esempio_5.sql", 0, 200)
        trovati = ESP.cerca_testo(ESEMPI, "tessere_sanitarie")["risultati"]
        try:
            ESP.leggi(ESEMPI, "../README.md")
            fuori = False
        except ESP.FuoriCartella:
            fuori = True
        ok = nomi == ["esempio_5.sql"] and pezzo["altro"] and not pezzo["binario"] and trovati and fuori
        return ("ok", f"{len(E['file'])} file negli esempi: ricerca per nome e per contenuto, lettura a pezzi, "
                      "nessun accesso fuori dalla cartella") if ok else ("errore", f"nomi {nomi}, pezzo {pezzo['fine']}, fuori {fuori}")
    voce("File della cartella", esplora_cartella)

    def estensioni():
        from . import analisi as A, estensioni as EXT, query as QY
        df, pk, fk, errori = A.leggi_cartella(ESEMPI)
        R = A.analizza(df, pk, fk_dichiarate=fk, errori=errori)
        compile(EXT.generate_sqlalchemy_models(R), "modelli_sqlalchemy.py", "exec")
        script = EXT.generate_migration_script(R)
        db = QY.da_cartella(ESEMPI)
        chiavi = EXT.check_inclusion(db, R)
        profilo = EXT.profile_data(db, R)
        db.chiudi()
        confermata = any(r["table"] == "comuni" and r["→ table"] == "province" and r["verdict"] == EXT.CONFIRMED
                         for r in chiavi.to_dict("records"))
        crud = EXT.analyze_crud("CREATE VIEW v AS SELECT * FROM comuni JOIN province USING (id_provincia);")
        ok = confermata and "1NF" in script and not profilo.empty and set(crud["table"]) == {"comuni", "province"}
        return ("ok", "modelli SQLAlchemy, script di normalizzazione, chiavi verificate sui dati (comuni → province confermata), "
                      "profilo e matrice CRUD") if ok else ("errore", f"confermata {confermata}, CRUD {sorted(set(crud['table']))}")
    voce("Estensioni", estensioni)

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

    def asp():
        from . import analisi as A, asp as ASP
        if not ASP.disponibile():
            return "errore", "clingo non è installato (pip install clingo)"
        df, pk, fk, _ = A.leggi_cartella(ESEMPI)
        X = ASP.risolvi(A.analizza(df, pk, fk_dichiarate=fk), secondi=20)
        scartata = any(r["tabella"] == "comuni" and r["→ tabella"] == "regioni" for r in X.scartate.to_dict("records"))
        import clingo
        return ("ok" if scartata and X.ottimo else "errore",
                f"clingo {clingo.__version__}: {len(X.scelte)} chiavi scelte negli esempi, la ridondante comuni → regioni scartata")
    voce("Scelta con clingo (ASP)", asp)
    return risultati
