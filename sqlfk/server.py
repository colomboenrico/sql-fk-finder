"""Server locale dell'app: espone l'analisi come API JSON e serve l'interfaccia web (cartella web/).

Uso:
    python -m sqlfk.server             # porta 8765, poi apri http://127.0.0.1:8765 nel browser
    python -m sqlfk.server --apri      # apre anche il browser
    python -m sqlfk.server --porta 0   # porta libera scelta dal sistema (la usa Electron)

Quando è pronto stampa una riga "SQLFK_PORTA=<numero>".
Accetta connessioni solo dal computer stesso (127.0.0.1).
"""
import argparse
import io
import json
import os
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

from . import analisi as A
from . import grafici as G
from . import modello as MR
from . import ontologia as O
from .regole import REGOLE

WEB = Path(__file__).parent / "web"
TIPI_FILE = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
             ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml"}


def tabella(df):
    """DataFrame -> {"colonne": [...], "righe": [[...], ...]} pronto per JSON."""
    if df is None:
        return {"colonne": [], "righe": []}
    dati = json.loads(df.to_json(orient="split", index=False, force_ascii=False))
    return {"colonne": dati["columns"], "righe": dati["data"]}


class Errore(Exception):
    """Errore da mostrare all'utente così com'è."""


class Sessione:
    """Lo stato dell'app: i file caricati e i risultati dell'analisi."""

    def __init__(self):
        self.lock = threading.Lock()
        self.imp = A.Impostazioni()
        self.file_sql = []
        self.origine = ""
        self.rimosse = set()
        self.df_schema = None

    # ------------------------------------------------------------ caricamento e analisi
    def carica(self, file_sql, origine):
        file_sql = [(n, t) for n, t in file_sql if n.lower().endswith(".sql") and n not in A.FILE_GENERATI]
        if not file_sql:
            raise Errore("Nessun file .sql da leggere.")
        df, pk, fk, errori = A.leggi_testi(file_sql, self.imp.dialetto)
        if df.empty:
            raise Errore("Nei file non c'è nessun CREATE TABLE.")
        self.file_sql, self.origine = file_sql, origine
        self.df_schema, self.pk, self.fk, self.errori = df, pk, fk, errori
        self.create = A.create_originali(file_sql, self.imp.dialetto)
        self.rimosse &= set(df["tabella"])
        self.gruppi, self.gruppo_di = A.raggruppa_tabelle(df["tabella"].unique(), self.imp)
        # i nomi simili (la parte lenta) si calcolano una volta sola, su tutto lo schema
        self.simili = A.trova_nomi_simili(A.prepara(df, pk, None, self.imp), self.imp)
        self.ricalcola()

    def ricalcola(self):
        self.R = A.analizza(self.df_schema, self.pk, self.rimosse, self.simili,
                            self.fk, self.gruppi, self.imp, self.errori, self.create)

    def richiedi_dati(self):
        if self.df_schema is None:
            raise Errore("Prima carica i file .sql.")

    # ------------------------------------------------------------ risposte
    def stato(self):
        base = {"caricato": self.df_schema is not None, "sqlglot": A.HA_SQLGLOT,
                "impostazioni": {"dialetto": self.imp.dialetto,
                                 "soglia_simili": self.imp.soglia_simili,
                                 "soglia_gruppi": self.imp.soglia_gruppi,
                                 "generiche": sorted(self.imp.generiche),
                                 "parole_non_entita": sorted(self.imp.parole_non_entita),
                                 "on_delete": self.imp.on_delete, "on_update": self.imp.on_update,
                                 "sinonimi": list(self.imp.sinonimi)}}
        if self.df_schema is None:
            return base
        R = self.R
        base.update({
            "origine": self.origine,
            "file": [n for n, _ in self.file_sql],
            "tabelle_totali": int(self.df_schema["tabella"].nunique()),
            "tabelle_analizzate": len(R.S.col_per_tab),
            "colonne": len(R.S.col),
            "gruppi": int((self.gruppi["n_tabelle"] > 1).sum()),
            "aree": int((R.aree.aree["area"] != "senza collegamenti").sum()),
            "pk_composte": len(R.S.pk_composta),
            "fk_dichiarate": len(self.fk),
            "fk_candidate": len(R.fk),
            "problemi": A.conteggi_diagnostica(R.diagnostica),
            "fk_alta": int((R.fk["affidabilità"] == "alta").sum()),
            "isolate": len(R.isolate),
            "rimosse": sorted(self.rimosse),
        })
        return base

    def panoramica(self):
        self.richiedi_dati()
        return {"riepilogo": tabella(A.riepilogo_iniziale(self.df_schema, self.pk, self.fk, self.gruppi)),
                "fk_dichiarate": tabella(self.fk),
                "errori": self.errori}

    def gruppi_tabelle(self):
        self.richiedi_dati()
        df = self.gruppi.copy()
        df["tolte"] = df["tabelle"].map(lambda s: sum(t in self.rimosse for t in s.split(", ")))
        return {"gruppi": tabella(df)}

    def aree(self):
        """Aree (sottogruppi collegati dalle FK), sottogruppi, collegamenti tra loro e categorie delle tabelle."""
        self.richiedi_dati()
        X = self.R.aree
        return {"aree": tabella(X.aree), "sottogruppi": tabella(X.sottogruppi), "tabelle": tabella(X.tabelle),
                "collegamenti": tabella(X.collegamenti), "collegamenti_aree": tabella(X.collegamenti_aree),
                "categorie": A.CATEGORIE, "centrali": X.centrali}

    def pk_composte(self):
        self.richiedi_dati()
        df = self.R.pk_composte
        return {"tabelle": sorted(self.R.S.pk_composta),
                "testi": {t: A.descrivi_pk_composte(df, t) for t in self.R.S.pk_composta},
                "dettaglio": tabella(df)}

    def altri(self):
        self.richiedi_dati()
        R = self.R
        return {"stesso_nome": tabella(R.stesso_nome), "simili": tabella(R.simili),
                "sospette": tabella(R.sospette), "isolate": tabella(pd.DataFrame({"tabella": R.isolate}))}

    def schema_iniziale(self, file_html=None):
        """Schema del database com'è nei file, senza le tabelle tolte."""
        df, pk = A.filtra_schema(self.df_schema, self.pk, self.rimosse)
        fk = self.fk[~self.fk["tabella"].isin(self.rimosse) & ~self.fk["→ tabella"].isin(self.rimosse)]
        return G.schema_iniziale(df, pk, fk, self.gruppo_di, file_html)

    def diagnostica(self):
        self.richiedi_dati()
        return {"problemi": tabella(self.R.diagnostica), "riassunto": A.riassunto_diagnostica(self.R.diagnostica)}

    def sorgente(self, nome, riga, intorno=8):
        """Le righe del file intorno a quella indicata (per mostrare dove sta il problema)."""
        self.richiedi_dati()
        testo = next((t for n, t in self.file_sql if n == nome), None)
        if testo is None:
            raise Errore(f"File non trovato: {nome}")
        righe = testo.splitlines()
        inizio, fine = max(1, riga - intorno), min(len(righe), riga + intorno)
        return {"file": nome, "riga": riga, "righe": [[n, righe[n - 1]] for n in range(inizio, fine + 1)]}

    def diagramma(self, tipo="collegamenti", medie=False):
        """Tabelle con le colonne e collegamenti tra colonne, per il diagramma e il modello relazionale."""
        self.richiedi_dati()
        return MR.struttura(self.R, self.gruppo_di, tipo, medie)

    def ontologia(self, base="", lingua="auto"):
        """(ontologia OWL, mapping R2RML, riepilogo, base usata)"""
        self.richiedi_dati()
        nome = Path(self.origine).name if self.origine else "database"
        base = base.strip() or O.base_predefinita(nome.replace("cartella ", ""))
        inglese = None if lingua == "auto" else lingua == "inglese"
        owl, M = O.genera_owl(self.R, base, nome, inglese)
        return owl, O.genera_r2rml(self.R, base, M), O.riepilogo(M), base

    def regole(self):
        """Le regole di progettazione con quanti errori, avvisi e info le violano."""
        d = self.R.diagnostica if self.df_schema is not None else None
        elenco = []
        for r in REGOLE:
            conta = {"errore": 0, "avviso": 0, "info": 0}
            if d is not None:
                for g in d[d["codice"].isin(r["codici"])]["gravità"]:
                    conta[g] += 1
            elenco.append({**r, "conteggi": conta})
        return {"regole": elenco}

    def qualita(self):
        self.richiedi_dati()
        Q = self.R.qualita
        return {"riepilogo": tabella(Q.riepilogo), "senza_pk": tabella(Q.senza_pk), "ponti": tabella(Q.ponti),
                "normalizzazione": tabella(Q.normalizzazione), "ridondanti": tabella(Q.ridondanti),
                "regole": {"on_delete": self.imp.on_delete, "on_update": self.imp.on_update}}

    def togli(self, tabelle):
        self.richiedi_dati()
        nuove = set(tabelle) & set(self.df_schema["tabella"])
        self.rimosse |= nuove
        self.ricalcola()
        return {"tolte": len(nuove)}

    def rimetti(self, tabelle=None, tutte=False):
        self.richiedi_dati()
        scelte = set(self.rimosse) if tutte else set(tabelle or []) & self.rimosse
        self.rimosse -= scelte
        self.ricalcola()
        return {"rimesse": len(scelte)}

    def imposta(self, dati, ricarica=True):
        imp = self.imp
        if "dialetto" in dati:
            imp.dialetto = str(dati["dialetto"])
        for chiave in ("on_delete", "on_update"):
            if chiave in dati:
                regola = str(dati[chiave]).strip().upper()
                if regola not in ("", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION"):
                    raise Errore(f"Regola non valida: {regola}")
                setattr(imp, chiave, regola)
        for chiave in ("soglia_simili", "soglia_gruppi"):
            if chiave in dati:
                valore = float(dati[chiave])
                if not 0 < valore <= 1:
                    raise Errore("Le soglie devono essere tra 0 e 1.")
                setattr(imp, chiave, valore)
        if "sinonimi" in dati:
            imp.sinonimi = [str(r).strip() for r in dati["sinonimi"] if "=" in str(r)]
        for chiave in ("generiche", "parole_non_entita"):
            if chiave in dati:
                setattr(imp, chiave, {p.strip().lower() for p in dati[chiave] if p.strip()})
        if ricarica and self.file_sql:
            self.carica(self.file_sql, self.origine)       # rifà tutto con le nuove impostazioni
        return self.stato()

    # ------------------------------------------------------------ file di progetto
    FORMATO_PROGETTO = "sqlfk-progetto"

    def progetto(self):
        """Tutto quello che serve per riaprire il lavoro: file .sql, impostazioni, tabelle tolte.
        (La disposizione del diagramma la aggiunge l'interfaccia.)"""
        self.richiedi_dati()
        return {"formato": self.FORMATO_PROGETTO, "versione": 1, "origine": self.origine,
                "impostazioni": self.stato()["impostazioni"], "rimosse": sorted(self.rimosse),
                "file": [{"nome": n, "testo": t} for n, t in self.file_sql]}

    def apri_progetto(self, p):
        if not isinstance(p, dict) or p.get("formato") != self.FORMATO_PROGETTO:
            raise Errore("Questo non è un file di progetto di SQL FK Finder.")
        if int(p.get("versione", 1)) > 1:
            raise Errore("Il progetto è stato salvato da una versione più recente dell'app.")
        file_sql = [(str(f["nome"]), str(f["testo"])) for f in p.get("file", [])]
        if not file_sql:
            raise Errore("Il progetto non contiene file .sql.")
        self.imp = A.Impostazioni()
        self.imposta(p.get("impostazioni") or {}, ricarica=False)
        self.rimosse = {str(t) for t in p.get("rimosse", [])}
        self.carica(file_sql, str(p.get("origine") or "progetto"))
        return self.stato()


SESSIONE = Sessione()


# ====================================================================== HTTP

class Gestore(BaseHTTPRequestHandler):
    server_version = "sqlfk"

    def log_message(self, formato, *args):        # niente log per ogni richiesta
        pass

    # ------------------------------------------------------------ risposte
    def invia(self, codice, corpo, tipo, extra=None):
        self.send_response(codice)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(corpo)

    def json(self, dati, codice=200):
        self.invia(codice, json.dumps(dati, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def corpo_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def esegui(self, funzione):
        try:
            with SESSIONE.lock:
                risultato = funzione()
            if isinstance(risultato, tuple):            # (corpo, tipo, intestazioni)
                self.invia(200, *risultato)
            else:
                self.json(risultato)
        except Errore as e:
            self.json({"errore": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            self.json({"errore": f"{type(e).__name__}: {e}"}, 500)

    # ------------------------------------------------------------ GET
    def do_GET(self):
        url = urlparse(self.path)
        percorso = url.path
        s = SESSIONE
        rotte = {
            "/api/stato": s.stato,
            "/api/panoramica": s.panoramica,
            "/api/gruppi": s.gruppi_tabelle,
            "/api/aree": s.aree,
            "/api/tabelle": lambda: (s.richiedi_dati(), {"tabelle": tabella(s.R.S.riepilogo)})[1],
            "/api/pk_composte": s.pk_composte,
            "/api/fk": lambda: (s.richiedi_dati(), {"fk": tabella(s.R.fk)})[1],
            "/api/altri": s.altri,
            "/api/qualita": s.qualita,
            "/api/diagnostica": s.diagnostica,
            "/api/regole": s.regole,
            "/api/progetto": s.progetto,
            "/api/scarica/report": self.scarica_report,
            "/api/schema_iniziale": lambda: self.schema("iniziale"),
            "/api/schema_collegamenti": lambda: self.schema("collegamenti"),
            "/api/scarica/excel": self.scarica_excel,
            "/api/scarica/sql": self.scarica_sql,
            "/api/scarica/create": self.scarica_create,
        }
        if percorso in rotte:
            return self.esegui(rotte[percorso])
        if percorso == "/api/modello":
            q = parse_qs(url.query)
            formato = q.get("formato", ["json"])[0]
            if formato not in MR.FORMATI:
                return self.json({"errore": f"Formato sconosciuto: {formato}"}, 400)

            def risposta():
                M = s.diagramma(q.get("tipo", ["collegamenti"])[0], q.get("medie", ["0"])[0] == "1")
                testo = MR.esporta(M, formato)
                if q.get("anteprima", ["0"])[0] == "1":
                    return {"testo": testo, "tabelle": len(M["tabelle"]), "collegamenti": len(M["collegamenti"])}
                nome = f"modello_relazionale.{MR.FORMATI[formato]}"
                return (testo.encode("utf-8"), "text/plain; charset=utf-8",
                        {"Content-Disposition": f'attachment; filename="{nome}"'})
            return self.esegui(risposta)
        if percorso == "/api/diagramma":
            q = parse_qs(url.query)
            return self.esegui(lambda: s.diagramma(q.get("tipo", ["collegamenti"])[0], q.get("medie", ["0"])[0] == "1"))
        if percorso in ("/api/ontologia", "/api/scarica/ontologia", "/api/scarica/r2rml"):
            q = parse_qs(url.query)
            base, lingua = q.get("base", [""])[0], q.get("lingua", ["auto"])[0]

            def risposta():
                owl, r2rml, riepilogo, base_usata = s.ontologia(base, lingua)
                if percorso == "/api/ontologia":
                    return {**riepilogo, "base": base_usata, "anteprima": "\n".join(owl.splitlines()[:250])}
                testo, nome = (owl, "ontologia.ttl") if percorso.endswith("ontologia") else (r2rml, "mapping_r2rml.ttl")
                return (testo.encode("utf-8"), "text/turtle; charset=utf-8",
                        {"Content-Disposition": f'attachment; filename="{nome}"'})
            return self.esegui(risposta)
        if percorso == "/api/sorgente":
            q = parse_qs(url.query)
            return self.esegui(lambda: s.sorgente(q.get("file", [""])[0], int(q.get("riga", ["1"])[0] or 1)))
        if percorso == "/api/cerca_entita":
            parola = parse_qs(url.query).get("parola", [""])[0]
            return self.esegui(lambda: (s.richiedi_dati(), {"tabelle": A.tabelle_entita(
                [t for t in s.df_schema["tabella"].unique() if t not in s.rimosse], parola, s.imp.sinonimi)})[1])
        self.statico(percorso)

    def schema(self, quale):
        s = SESSIONE
        s.richiedi_dati()
        if quale == "iniziale":
            html = s.schema_iniziale()
        else:
            html = G.schema_collegamenti(s.R)
        return html.encode("utf-8"), "text/html; charset=utf-8", {}

    def scarica_excel(self):
        SESSIONE.richiedi_dati()
        buffer = io.BytesIO()
        A.scrivi_excel(SESSIONE.R, buffer)
        return (buffer.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                {"Content-Disposition": 'attachment; filename="possibili_collegamenti.xlsx"'})

    def scarica_sql(self):
        SESSIONE.richiedi_dati()
        return (A.testo_alter(SESSIONE.R).encode("utf-8"), "application/sql; charset=utf-8",
                {"Content-Disposition": 'attachment; filename="fk_candidate.sql"'})

    def scarica_report(self):
        SESSIONE.richiedi_dati()
        return (A.testo_diagnostica(SESSIONE.R.diagnostica, con_regole=True).encode("utf-8"), "text/plain; charset=utf-8",
                {"Content-Disposition": 'attachment; filename="diagnostica.txt"'})

    def scarica_create(self):
        SESSIONE.richiedi_dati()
        testo = A.testo_create(SESSIONE.R, SESSIONE.create, SESSIONE.imp.dialetto)
        return (testo.encode("utf-8"), "application/sql; charset=utf-8",
                {"Content-Disposition": 'attachment; filename="create_table_con_fk.sql"'})

    def statico(self, percorso):
        nome = "index.html" if percorso in ("", "/") else percorso.lstrip("/")
        file = (WEB / nome).resolve()
        if WEB.resolve() not in file.parents or not file.is_file():
            return self.invia(404, b"Non trovato", "text/plain; charset=utf-8")
        self.invia(200, file.read_bytes(), TIPI_FILE.get(file.suffix, "application/octet-stream"))

    # ------------------------------------------------------------ POST
    def do_POST(self):
        s = SESSIONE
        try:
            dati = self.corpo_json()
        except ValueError:
            return self.json({"errore": "Richiesta non valida."}, 400)
        percorso = urlparse(self.path).path

        def carica_cartella():
            cartella = Path(str(dati.get("cartella", "")).strip()).expanduser()
            if not cartella.is_dir():
                raise Errore(f"La cartella non esiste: {cartella}")
            file_sql = [(f.name, f.read_text(encoding="utf-8", errors="replace"))
                        for f in sorted(cartella.glob("*.sql"))]
            s.carica(file_sql, str(cartella))
            return s.stato()

        def carica_file():
            file_sql = [(str(f["nome"]), str(f["testo"])) for f in dati.get("file", [])]
            s.carica(file_sql, dati.get("origine") or f"{len(file_sql)} file caricati")
            return s.stato()

        def togli_gruppo():
            s.richiedi_dati()
            return s.togli([t for t, g in s.gruppo_di.items() if g == dati.get("gruppo")])

        def salva_cartella():
            s.richiedi_dati()
            cartella = Path(str(dati.get("cartella", "")).strip()).expanduser()
            if not cartella.is_dir():
                raise Errore(f"La cartella non esiste: {cartella}")
            file = list(A.salva(s.R, cartella, s.create, s.imp.dialetto))
            owl, r2rml, _, _ = s.ontologia()
            file.append(cartella / "ontologia.ttl")
            file[-1].write_text(owl, encoding="utf-8")
            file.append(cartella / "mapping_r2rml.ttl")
            file[-1].write_text(r2rml, encoding="utf-8")
            file.append(cartella / "diagnostica.txt")
            file[-1].write_text(A.testo_diagnostica(s.R.diagnostica, con_regole=True), encoding="utf-8")
            file.append(cartella / "schema_iniziale.html")
            s.schema_iniziale(file[-1])
            file.append(cartella / "schema_collegamenti.html")
            G.schema_collegamenti(s.R, file[-1])
            return {"salvati": [str(f) for f in file]}

        rotte = {
            "/api/carica_cartella": carica_cartella,
            "/api/carica_file": carica_file,
            "/api/togli": lambda: s.togli(dati.get("tabelle", [])),
            "/api/togli_gruppo": togli_gruppo,
            "/api/rimetti": lambda: s.rimetti(dati.get("tabelle"), bool(dati.get("tutte"))),
            "/api/impostazioni": lambda: s.imposta(dati),
            "/api/salva_cartella": salva_cartella,
            "/api/progetto": lambda: s.apri_progetto(dati),
        }
        if percorso not in rotte:
            return self.json({"errore": "Indirizzo sconosciuto."}, 404)
        self.esegui(rotte[percorso])


def main():
    parser = argparse.ArgumentParser(description="Server locale di sql-fk-finder")
    parser.add_argument("--porta", type=int, default=8765, help="0 = porta libera scelta dal sistema")
    parser.add_argument("--apri", action="store_true", help="apre l'interfaccia nel browser")
    parser.add_argument("--cartella", help="cartella di file .sql da caricare all'avvio")
    parser.add_argument("--con-app", action="store_true",
                        help="si chiude quando si chiude l'app che l'ha avviato (usato da Electron)")
    args = parser.parse_args()

    if args.con_app:
        # Electron tiene aperto lo stdin del server: quando l'app si chiude, anche in modo brusco,
        # lo stdin arriva alla fine e il server esce.
        def aspetta_chiusura():
            sys.stdin.read()
            os._exit(0)
        threading.Thread(target=aspetta_chiusura, daemon=True).start()

    if args.cartella:
        cartella = Path(args.cartella).expanduser()
        SESSIONE.carica([(f.name, f.read_text(encoding="utf-8", errors="replace"))
                         for f in sorted(cartella.glob("*.sql"))], str(cartella))

    server = ThreadingHTTPServer(("127.0.0.1", args.porta), Gestore)
    porta = server.server_address[1]
    print(f"SQLFK_PORTA={porta}", flush=True)
    print(f"Interfaccia: http://127.0.0.1:{porta}  (Ctrl+C per chiudere)", flush=True)
    if args.apri:
        webbrowser.open(f"http://127.0.0.1:{porta}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
