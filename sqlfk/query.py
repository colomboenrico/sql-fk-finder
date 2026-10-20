"""Interrogare il database con le query.

Dai file .sql si costruisce un database SQLite: le tabelle dei CREATE TABLE (con le colonne e le chiavi
primarie lette dall'analisi, più le colonne di ALTER TABLE ... ADD COLUMN) e i dati degli INSERT INTO e
dei blocchi COPY ... FROM stdin dei dump di PostgreSQL. I file si leggono a blocchi (sqlfk.lettura),
quindi vanno bene anche dump da decine di GB:

- con pochi dati il database sta in memoria;
- con molti dati è un file SQLite nella cartella di cache (~/.sqlfk/cache, o la variabile SQLFK_CACHE):
  si costruisce una volta sola e le volte dopo, con gli stessi file, si riapre subito.

Le query si possono scrivere in SQLite o nel dialetto dei file (MySQL, PostgreSQL, SQL Server...): se
SQLite non le capisce vengono tradotte con sqlglot. Le istruzioni che modificano i dati (INSERT, UPDATE,
DELETE, DROP...) cambiano solo il database SQLite, non i file: si annullano ricostruendolo dai file.

Uso da terminale:
    python -m sqlfk.query cartella "SELECT * FROM clienti"
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path

from . import analisi as A
from . import lettura as L

try:
    import sqlglot
except ImportError:                        # senza sqlglot le query devono essere già in SQLite
    sqlglot = None

MAX_RIGHE = 1000                           # righe restituite per ogni risultato
SOGLIA_MEMORIA = 256 * 1024 * 1024         # sopra questa dimensione dei file il database va su disco
MAX_PROBLEMI = 500                         # istruzioni non caricate di cui si tiene il dettaglio
TRADUCI_FINO_A = 200_000                   # oltre questa lunghezza un INSERT non si traduce con sqlglot (lento)
CARTELLA_CACHE = Path(os.environ.get("SQLFK_CACHE") or Path.home() / ".sqlfk" / "cache")
TABELLA_INFO = "_sqlfk_info"
MODIFICANO = {"INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT", "MERGE", "DROP", "CREATE", "ALTER", "TRUNCATE",
              "RENAME", "ATTACH", "DETACH", "VACUUM", "REINDEX", "COPY", "GRANT", "REVOKE"}
MODIFICA_IN_WITH = re.compile(r"\b(INSERT|UPDATE|DELETE|REPLACE)\b", re.I)
DIALETTI_SQLGLOT = {"mysql": "mysql", "postgres": "postgres", "postgresql": "postgres", "tsql": "tsql",
                    "oracle": "oracle", "sqlite": "sqlite", "mariadb": "mysql"}


class Interrotto(Exception):
    """La costruzione del database è stata interrotta."""


# ====================================================================== istruzioni

parola_iniziale = L.parola_iniziale


def istruzioni(testo, dialetto="mysql"):
    """[(riga, istruzione)] di un testo (per esempio le query scritte nell'editor)."""
    return [(riga, frase) for tipo, riga, frase, _ in L.istruzioni(testo, dialetto) if tipo == "istruzione"]


def senza_commenti_iniziali(frase):
    return frase[L.RE_INIZIO.match(frase).end():]


def modifica(frase):
    """True se l'istruzione cambia dati o struttura."""
    prima = parola_iniziale(frase)
    if prima == "WITH":
        return bool(MODIFICA_IN_WITH.search(frase))
    return prima in MODIFICANO


def q(nome):
    """Nome tra virgolette per SQLite: taxa.virus -> "taxa.virus" """
    return '"' + str(nome).replace('"', '""') + '"'


# ---------------------------------------------------------------------- da MySQL a SQLite

ESCAPE_MYSQL = {"0": "", "'": "'", '"': '"', "b": "\b", "n": "\n", "r": "\r", "t": "\t", "Z": "\x1a", "\\": "\\",
                "%": "\\%", "_": "\\_"}
RE_DA_MYSQL = re.compile(r"'([^'\\]*(?:(?:\\.|'')[^'\\]*)*)'|(?<![\w.])0x([0-9A-Fa-f]+)\b|(?<![\w'])_(?:binary|utf8mb4|utf8mb3|utf8|latin1)\s*(?=')",
                         re.S)
RE_ESCAPE = re.compile(r"\\(.)|''", re.S)


def da_mysql(testo):
    """Valori di un INSERT di mysqldump scritti come li vuole SQLite: 'l\\'ha' -> 'l''ha', 0xFFEE -> X'FFEE',
    _binary '...' -> '...'."""
    def sostituisci(m):
        if m.group(1) is not None:
            interno = m.group(1)
            if "\\" not in interno:
                return m.group(0)
            interno = RE_ESCAPE.sub(lambda e: "'" if e.group(1) is None else ESCAPE_MYSQL.get(e.group(1), e.group(1)), interno)
            return "'" + interno.replace("'", "''") + "'"
        if m.group(2) is not None:
            cifre = m.group(2)
            return f"X'{cifre if len(cifre) % 2 == 0 else '0' + cifre}'"
        return ""
    return RE_DA_MYSQL.sub(sostituisci, testo)


def valore_copy(v):
    """Un campo di COPY ... FROM stdin: \\N = NULL, \\t \\n \\\\ ... = caratteri."""
    if v == "\\N":
        return None
    if "\\" not in v:
        return v
    return re.sub(r"\\(.)", lambda x: {"t": "\t", "n": "\n", "r": "\r", "b": "\b", "f": "\f", "v": "\v"}.get(x.group(1), x.group(1)), v)


# ====================================================================== il database

class Database:
    """Database SQLite costruito dai file .sql (in memoria, o nel file percorso se indicato).

    file_sql: [(nome, testo)]; i testi ridotti (TestoSql dei file grandi) si rileggono dal loro file.
    avanzamento(letti, totale, nome): byte letti; fermo: threading.Event per interrompere.
    """

    def __init__(self, file_sql, df_schema, pk, dialetto="mysql", percorso=None, avanzamento=None, fermo=None):
        self.dialetto = dialetto
        self.percorso = Path(percorso) if percorso else None
        self.conn = sqlite3.connect(str(self.percorso) if self.percorso else ":memory:", check_same_thread=False)
        self.tabelle = {}                  # nome in minuscolo (e senza schema) -> nome della tabella
        self.problemi, self.n_problemi = [], 0
        self.righe = {}                    # tabella -> righe (contate durante il caricamento)
        self.fermo = fermo
        inizio = time.time()
        c = self.conn
        c.execute("PRAGMA foreign_keys = OFF")
        c.execute("PRAGMA journal_mode = OFF")         # costruzione veloce: se si interrompe si ricomincia
        c.execute("PRAGMA synchronous = OFF")
        c.execute("PRAGMA temp_store = MEMORY")
        c.execute("PRAGMA cache_size = -262144")       # 256 MB di cache
        self._crea_tabelle(df_schema, pk)
        self._carica_dati(file_sql, avanzamento)
        self.secondi = time.time() - inizio
        self._salva_info(completo=True)
        c.commit()
        if self.percorso:
            c.execute("PRAGMA journal_mode = DELETE")  # da qui le modifiche delle query sono sicure
            c.execute("PRAGMA synchronous = NORMAL")

    @classmethod
    def apri(cls, percorso, dialetto="mysql"):
        """Riapre un database già costruito (dalla cache)."""
        db = cls.__new__(cls)
        db.dialetto, db.percorso, db.fermo = dialetto, Path(percorso), None
        db.conn = sqlite3.connect(str(percorso), check_same_thread=False)
        info = dict(db.conn.execute(f"SELECT chiave, valore FROM {TABELLA_INFO}"))
        db.righe = json.loads(info.get("righe", "{}"))
        db.problemi = json.loads(info.get("problemi", "[]"))
        db.n_problemi = int(info.get("n_problemi", len(db.problemi)))
        db.secondi = float(info.get("secondi", 0))
        db.tabelle = {}
        for t in db.nomi_tabelle_db():
            db.tabelle[t.lower()] = t
            db.tabelle.setdefault(t.split(".")[-1].lower(), t)
        return db

    def _salva_info(self, completo):
        """Conteggi e problemi dentro il database su disco, per riaprirlo senza ricalcolarli."""
        if not self.percorso:
            return
        c = self.conn
        c.execute(f"CREATE TABLE IF NOT EXISTS {TABELLA_INFO} (chiave TEXT PRIMARY KEY, valore TEXT)")
        for k, v in {"righe": json.dumps(self.righe), "problemi": json.dumps(self.problemi),
                     "n_problemi": str(self.n_problemi), "secondi": str(round(self.secondi, 2)),
                     "dialetto": self.dialetto, "completo": "1" if completo else "0"}.items():
            c.execute(f"INSERT OR REPLACE INTO {TABELLA_INFO} VALUES (?, ?)", (k, v))

    # ------------------------------------------------------------ tabelle
    def _crea_tabelle(self, df_schema, pk):
        colonne = df_schema.drop_duplicates(["tabella", "colonna"])
        for t, parte in colonne.groupby("tabella", sort=True):
            definizioni = []
            for r in parte.to_dict("records"):
                tipo = A.tipo_base(r["tipo"]) or ""
                definizioni.append(f'{q(r["colonna"])} {tipo}'.strip() + (" NOT NULL" if r.get("not null") else ""))
            chiave = [c for c in pk.get(t, []) if c in set(parte["colonna"])]
            if chiave:
                definizioni.append(f"PRIMARY KEY ({', '.join(q(c) for c in chiave)})")
            try:
                self.conn.execute(f"CREATE TABLE {q(t)} ({', '.join(definizioni)})")
            except sqlite3.Error:          # per esempio una chiave primaria strana: senza vincoli
                self.conn.execute(f"CREATE TABLE {q(t)} ({', '.join(q(c) for c in parte['colonna'])})")
            self.tabelle[t.lower()] = t
            self.tabelle.setdefault(t.split(".")[-1].lower(), t)
            self.righe[t] = 0

    def tabella_di(self, nome):
        """Nome scritto nei file (public."Clienti", dbo.[clienti], `clienti`) -> nome della tabella."""
        n = A.nome_qualificato(nome)
        return self.tabelle.get(n.lower()) or self.tabelle.get(n.split(".")[-1].lower())

    def nomi_tabelle_db(self):
        return [t for (t,) in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                if not t.startswith(TABELLA_INFO) and not t.startswith("sqlite_")]

    # ------------------------------------------------------------ dati
    def _problema(self, nome_file, riga, frase, errore):
        self.n_problemi += 1
        if len(self.problemi) < MAX_PROBLEMI:
            self.problemi.append({"file": nome_file, "riga": riga, "istruzione": frase[:200], "problema": str(errore)[:300]})

    def _carica_dati(self, file_sql, avanzamento=None):
        file_sql = [(n, t) for n, t in file_sql if n not in A.FILE_GENERATI]
        totale = sum(getattr(t, "dimensione", len(t)) for _, t in file_sql) or 1
        fatti, ultimo_commit = 0, time.time()
        for nome_file, testo in file_sql:
            dimensione = getattr(testo, "dimensione", len(testo))

            def passo(letti, base=fatti, nome=nome_file):
                if avanzamento:
                    avanzamento(base + letti, totale, nome)

            copy = None                    # (tabella, istruzione INSERT con i ?) del COPY in corso
            percorso = getattr(testo, "percorso", None)
            if getattr(testo, "ridotto", False) and not (percorso and Path(percorso).exists()):
                self._problema(nome_file, 0, "", f"file originale non trovato ({percorso}): i suoi dati non sono caricati")
                fatti += dimensione
                continue
            for tipo, riga, frase, _ in L.istruzioni(testo, self.dialetto, passo):
                if self.fermo is not None and self.fermo.is_set():
                    raise Interrotto()
                try:
                    if tipo == "dati":
                        if copy:
                            self._righe_copy(copy, frase)
                        continue
                    copy = None
                    prima = parola_iniziale(frase)
                    if prima == "COPY":
                        copy = self._inizia_copy(frase)
                    elif prima in ("INSERT", "REPLACE"):
                        self._insert(frase)
                    elif prima == "ALTER":
                        self._aggiungi_colonne(frase)
                except Exception as e:     # un'istruzione sbagliata non ferma le altre
                    self._problema(nome_file, riga, frase if tipo == "istruzione" else "\t".join(frase[:1]), e)
                if time.time() - ultimo_commit > 5:
                    self.conn.commit()
                    ultimo_commit = time.time()
            fatti += dimensione

    RE_INSERT = re.compile(r"(INSERT|REPLACE)\s+(?:IGNORE\s+)?(?:INTO\s+)?"
                           r"((?:[`\"\[]?[^\s`\"\[\]().]+[`\"\]]?\s*\.\s*)*[`\"\[]?[^\s`\"\[\]().]+[`\"\]]?)", re.I)

    def _insert(self, frase):
        testo = senza_commenti_iniziali(frase)
        m = self.RE_INSERT.match(testo)
        if not m:
            raise ValueError("INSERT non riconosciuto")
        tabella = self.tabella_di(m.group(2))
        if not tabella:
            raise ValueError(f"la tabella {A.pulisci(m.group(2))} non ha un CREATE TABLE nei file")
        corpo = testo[m.end():]
        if self.dialetto in ("mysql", "mariadb"):
            if "ON DUPLICATE" in corpo.upper()[-2000:]:
                corpo = re.sub(r"\bON\s+DUPLICATE\s+KEY\s+UPDATE\b.*$", "", corpo, flags=re.I | re.S)
            if "\\" in corpo or "0x" in corpo or "_binary" in corpo or "_utf8" in corpo:
                corpo = da_mysql(corpo)
        elif self.dialetto == "tsql":
            corpo = re.sub(r"(?<![\w'])[Nn]'", "'", corpo)       # N'testo' di SQL Server
        verbo = "INSERT OR REPLACE" if m.group(1).upper() == "REPLACE" else "INSERT"
        diretta = f"{verbo} INTO {q(tabella)} {corpo}"
        try:
            cursore = self.conn.execute(diretta)
        except sqlite3.Error as errore:
            if len(diretta) > TRADUCI_FINO_A:
                raise
            tradotta = self.traduci(diretta)
            if tradotta == diretta:
                raise errore
            cursore = self.conn.execute(tradotta)
        self.righe[tabella] = self.righe.get(tabella, 0) + max(cursore.rowcount, 0)

    RE_ADD_COLUMN = re.compile(r"ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(\S+)\s+(.*)$", re.I | re.S)

    def _aggiungi_colonne(self, frase):
        """ALTER TABLE x ADD [COLUMN] [IF NOT EXISTS] nome tipo, ...: le colonne aggiunte dopo il CREATE TABLE."""
        m = self.RE_ADD_COLUMN.match(senza_commenti_iniziali(frase))
        tabella = self.tabella_di(m.group(1)) if m else None
        if not tabella:
            return
        esistenti = {r[1].lower() for r in self.conn.execute(f"PRAGMA table_info({q(tabella)})")}
        for parte in A.split_virgole(m.group(2)):
            c = re.match(r"\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`\"\[]?[\w$]+[`\"\]]?)\s+(\S+)", parte, re.I)
            if not c or c.group(1).upper() in ("CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "INDEX", "KEY"):
                continue
            nome = A.pulisci(c.group(1))
            if nome.lower() not in esistenti:
                self.conn.execute(f"ALTER TABLE {q(tabella)} ADD COLUMN {q(nome)} {A.tipo_base(c.group(2))}")
                esistenti.add(nome.lower())

    def _inizia_copy(self, frase):
        m = re.match(r"COPY\s+(\S+?)\s*(?:\(([^)]*)\))?\s+FROM\s+stdin", senza_commenti_iniziali(frase), re.I | re.S)
        tabella = self.tabella_di(m.group(1)) if m else None
        if not tabella:
            raise ValueError(f"la tabella {m.group(1) if m else '?'} non ha un CREATE TABLE nei file")
        colonne = [A.pulisci(c) for c in m.group(2).split(",")] if m.group(2) else \
            [r[1] for r in self.conn.execute(f"PRAGMA table_info({q(tabella)})")]
        return tabella, len(colonne), (f"INSERT INTO {q(tabella)} ({', '.join(q(c) for c in colonne)}) "
                                       f"VALUES ({', '.join('?' * len(colonne))})")

    def _righe_copy(self, copy, righe):
        tabella, n, istruzione = copy
        valori = []
        for r in righe:
            if not r:
                continue
            campi = [valore_copy(v) for v in r.split("\t")]
            if len(campi) != n:            # riga rovinata: si completa o si taglia
                campi = (campi + [None] * n)[:n]
            valori.append(campi)
        self.conn.executemany(istruzione, valori)
        self.righe[tabella] = self.righe.get(tabella, 0) + len(valori)

    # ------------------------------------------------------------ query
    def traduci(self, frase):
        """La stessa istruzione in SQLite, tradotta da sqlglot (o invariata se non serve o non si può)."""
        if sqlglot is None or self.dialetto == "sqlite":
            return frase
        try:
            tradotte = sqlglot.transpile(frase, read=DIALETTI_SQLGLOT.get(self.dialetto, self.dialetto), write="sqlite")
        except Exception:
            return frase
        return ";\n".join(tradotte) if tradotte else frase

    def conteggi(self):
        """Righe di ogni tabella (contate durante il caricamento e aggiornate dopo le modifiche)."""
        risultato = []
        for t in self.nomi_tabelle_db():
            if t not in self.righe:
                self.righe[t] = self.conn.execute(f"SELECT COUNT(*) FROM {q(t)}").fetchone()[0]
            risultato.append({"tabella": t, "righe": self.righe[t]})
        return risultato

    def _ricontare(self, frase):
        """Dopo una modifica: si ricontano le righe delle tabelle nominate nell'istruzione."""
        esistenti = set(self.nomi_tabelle_db())
        for t in list(self.righe):
            if t not in esistenti:
                del self.righe[t]
        testo = frase.lower()
        for t in esistenti:
            if t.lower() in testo or t.split(".")[-1].lower() in testo:
                self.righe.pop(t, None)
        self.conteggi()
        try:
            self._salva_info(completo=True)
            self.conn.commit()
        except sqlite3.Error:
            pass

    def esegui(self, testo, consenti_modifiche=False, max_righe=MAX_RIGHE):
        """Esegue una o più istruzioni separate da ;.

        Se ce n'è una che modifica e consenti_modifiche è False non esegue niente e restituisce
        {"serve_conferma": True, "modifiche": [...]}. Altrimenti un risultato per istruzione:
        colonne, righe (al massimo max_righe), altre (se ci sono altre righe oltre quelle), righe modificate,
        query tradotta, errore.
        """
        frasi = [f for _, f in istruzioni(testo, "postgres" if self.dialetto in ("postgres", "postgresql") else "sqlite")]
        if not frasi:
            return {"risultati": []}
        modifiche = [f for f in frasi if modifica(f)]
        if modifiche and not consenti_modifiche:
            return {"serve_conferma": True, "modifiche": [f[:300] for f in modifiche]}
        risultati = []
        for frase in frasi:
            r = {"istruzione": frase, "tradotta": None, "colonne": [], "righe": [], "totale": 0, "altre": False,
                 "modificate": None, "errore": None}
            inizio = time.time()
            try:
                cursore = self._esegui_una(frase, r)
                if cursore.description:
                    r["colonne"] = [d[0] for d in cursore.description]
                    righe = cursore.fetchmany(max_righe)
                    r["righe"] = [[v if not isinstance(v, bytes) else v.hex() for v in riga] for riga in righe]
                    r["totale"] = len(righe)
                    r["altre"] = len(righe) == max_righe and cursore.fetchone() is not None
                    cursore.close()
                else:
                    r["modificate"] = cursore.rowcount if cursore.rowcount >= 0 else 0
                self.conn.commit()
                if modifica(frase):
                    self._ricontare(frase)
            except Exception as e:
                self.conn.rollback()
                r["errore"] = "Query interrotta." if "interrupted" in str(e) else str(e)
            r["secondi"] = round(time.time() - inizio, 3)
            risultati.append(r)
            if r["errore"]:
                break                      # come un client SQL: ci si ferma al primo errore
        return {"risultati": risultati}

    def csv(self, testo):
        """Tutto il risultato di una query (di sola lettura) in CSV, a pezzi (bytes): per i risultati grandi."""
        frasi = [f for _, f in istruzioni(testo, "postgres" if self.dialetto in ("postgres", "postgresql") else "sqlite")]
        if len(frasi) != 1 or modifica(frasi[0]):
            raise ValueError("Per il CSV completo serve una sola query che legge i dati (SELECT).")
        cursore = self._esegui_una(frasi[0], {})
        if not cursore.description:
            raise ValueError("La query non restituisce righe.")
        buffer = io.StringIO()
        scrittore = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
        scrittore.writerow([d[0] for d in cursore.description])
        yield ("\ufeff" + buffer.getvalue()).encode("utf-8")
        while True:
            righe = cursore.fetchmany(5000)
            if not righe:
                break
            buffer.seek(0)
            buffer.truncate()
            scrittore.writerows([[v.hex() if isinstance(v, bytes) else v for v in r] for r in righe])
            yield buffer.getvalue().encode("utf-8")

    def interrompi(self):
        """Ferma la query in corso (chiamabile da un altro thread)."""
        self.conn.interrupt()

    RE_QUALIFICATO = re.compile(r'(?<![\w."`\]])((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+))(?![\w."(])')

    def nomi_tabelle(self, frase):
        """public.clienti -> "clienti", vendite.libri -> "vendite.Libri": in SQLite il punto indica un altro database."""
        def sostituisci(m):
            nome = re.sub(r"\s+", "", m.group(1))
            pulito = A.nome_qualificato(nome)
            if pulito.lower() in self.tabelle and ("." in pulito or nome.split(".")[0].strip('"`[]').lower() in A.SCHEMI_PREDEFINITI):
                return q(self.tabelle[pulito.lower()])
            return m.group(1)
        parti = re.split(r"('(?:[^']|'')*')", frase)      # niente sostituzioni dentro le stringhe
        return "".join(p if i % 2 else self.RE_QUALIFICATO.sub(sostituisci, p) for i, p in enumerate(parti))

    def _esegui_una(self, frase, r):
        con_nomi = self.nomi_tabelle(frase)
        if con_nomi != frase:
            r["tradotta"], frase = con_nomi, con_nomi
        try:
            return self.conn.execute(frase)
        except sqlite3.Error as errore:
            if "interrupted" in str(errore):
                raise
            tradotta = self.traduci(frase)
            if tradotta.strip() == frase.strip():
                raise
            r["tradotta"] = tradotta
            try:
                return self.conn.execute(tradotta)
            except sqlite3.Error:
                raise errore from None

    # ------------------------------------------------------------ esportazione
    def dump(self):
        """Il database com'è adesso (con le modifiche) come script SQL, a pezzi (bytes)."""
        parti, n = [], 0
        for riga in self.conn.iterdump():
            if TABELLA_INFO in riga[:60]:
                continue
            parti.append(riga)
            n += len(riga)
            if n > 4_000_000:
                yield ("\n".join(parti) + "\n").encode("utf-8")
                parti, n = [], 0
        yield ("\n".join(parti) + "\n").encode("utf-8")

    def file_sqlite(self):
        """Il database come file .sqlite (bytes, a pezzi), apribile con DBeaver o DB Browser for SQLite."""
        if self.percorso:
            self.conn.commit()
            with open(self.percorso, "rb") as f:
                while True:
                    blocco = f.read(8 * 1024 * 1024)
                    if not blocco:
                        return
                    yield blocco
        copia = sqlite3.connect(":memory:")
        self.conn.backup(copia)
        yield bytes(copia.serialize())
        copia.close()

    def chiudi(self):
        try:
            self.conn.close()
        except sqlite3.Error:
            pass


# ====================================================================== cache su disco

def dimensione_dati(file_sql):
    return sum(getattr(t, "dimensione", len(t)) for n, t in file_sql if n not in A.FILE_GENERATI)


def chiave_cache(file_sql, df_schema, pk, dialetto):
    """Impronta di file, schema e dialetto: se non cambia, il database su disco si può riusare."""
    voci = [dialetto, json.dumps(pk, sort_keys=True),
            hashlib.sha1(df_schema[["tabella", "colonna", "tipo", "not null"]].to_csv(index=False).encode()).hexdigest()]
    for nome, testo in file_sql:
        if nome in A.FILE_GENERATI:
            continue
        percorso = getattr(testo, "percorso", None)
        if percorso and Path(percorso).exists():
            st = Path(percorso).stat()
            voci.append(f"{nome}|{Path(percorso).resolve()}|{st.st_size}|{st.st_mtime_ns}")
        else:
            voci.append(f"{nome}|{hashlib.sha1(str(testo).encode('utf-8', 'replace')).hexdigest()}")
    return hashlib.sha1("\n".join(voci).encode()).hexdigest()[:20]


def percorso_cache(chiave):
    return CARTELLA_CACHE / f"{chiave}.sqlite"


def in_cache(file_sql, df_schema, pk, dialetto):
    """Il percorso del database già costruito per questi file, o None."""
    p = percorso_cache(chiave_cache(file_sql, df_schema, pk, dialetto))
    if not p.exists():
        return None
    try:
        con = sqlite3.connect(str(p))
        completo = con.execute(f"SELECT valore FROM {TABELLA_INFO} WHERE chiave = 'completo'").fetchone()
        con.close()
        return p if completo and completo[0] == "1" else None
    except sqlite3.Error:
        return None


def prepara(file_sql, df_schema, pk, dialetto="mysql", avanzamento=None, fermo=None, su_disco=None):
    """Il database delle query: riaperto dalla cache, oppure costruito (in memoria o su disco)."""
    if su_disco is None:
        su_disco = dimensione_dati(file_sql) > SOGLIA_MEMORIA
    if not su_disco:
        return Database(file_sql, df_schema, pk, dialetto, avanzamento=avanzamento, fermo=fermo)
    pronto = in_cache(file_sql, df_schema, pk, dialetto)
    if pronto:
        return Database.apri(pronto, dialetto)
    finale = percorso_cache(chiave_cache(file_sql, df_schema, pk, dialetto))
    finale.parent.mkdir(parents=True, exist_ok=True)
    serve = int(dimensione_dati(file_sql) * 1.2)
    libero = shutil.disk_usage(finale.parent).free
    if libero < serve:
        raise OSError(f"Spazio su disco insufficiente in {finale.parent}: servono circa {serve / 1e9:.1f} GB, "
                      f"liberi {libero / 1e9:.1f} GB. Libera spazio o imposta la variabile SQLFK_CACHE su un altro disco.")
    parziale = finale.with_suffix(".parziale.sqlite")
    parziale.unlink(missing_ok=True)
    try:
        db = Database(file_sql, df_schema, pk, dialetto, percorso=parziale, avanzamento=avanzamento, fermo=fermo)
    except BaseException:
        parziale.unlink(missing_ok=True)
        raise
    db.chiudi()
    os.replace(parziale, finale)
    return Database.apri(finale, dialetto)


def svuota_cache():
    """Cancella i database costruiti (si ricostruiscono quando servono). Restituisce i byte liberati."""
    liberati = 0
    if CARTELLA_CACHE.exists():
        for f in CARTELLA_CACHE.glob("*.sqlite*"):
            try:
                liberati += f.stat().st_size
                f.unlink()
            except OSError:
                pass
    return liberati


def da_cartella(cartella, dialetto="mysql", avanzamento=None):
    file_sql = L.leggi_percorsi(cartella, dialetto, esclusi=A.FILE_GENERATI)
    df, pk, _, _ = A.leggi_testi(file_sql, dialetto)
    return prepara(file_sql, df, pk, dialetto, avanzamento)


def testo_risultato(r, larghezza=30):
    """Un risultato come tabella di testo, per il terminale e il notebook."""
    if r["errore"]:
        return f"Errore: {r['errore']}"
    if not r["colonne"]:
        return f"Righe modificate: {r['modificate']}"
    corto = lambda v: ("NULL" if v is None else str(v))[:larghezza]
    larghe = [max([len(c)] + [len(corto(x[i])) for x in r["righe"]]) for i, c in enumerate(r["colonne"])]
    linee = [" | ".join(c.ljust(w) for c, w in zip(r["colonne"], larghe)),
             "-+-".join("-" * w for w in larghe)]
    linee += [" | ".join(corto(v).ljust(w) for v, w in zip(riga, larghe)) for riga in r["righe"]]
    linee.append(f"({r['totale']} righe" + (", ce ne sono altre" if r.get("altre") else "") + ")")
    return "\n".join(linee)


def main():
    p = argparse.ArgumentParser(description="Esegue query sui dati dei file .sql (database SQLite costruito dai file)")
    p.add_argument("cartella", help="cartella con i file .sql")
    p.add_argument("query", nargs="?", help="query da eseguire (se manca: elenco delle tabelle con le righe)")
    p.add_argument("--dialetto", default="mysql")
    p.add_argument("--modifiche", action="store_true", help="permette INSERT, UPDATE, DELETE... (solo nel database SQLite)")
    p.add_argument("--svuota-cache", action="store_true", help="cancella i database costruiti in precedenza")
    args = p.parse_args()
    if args.svuota_cache:
        print(f"Liberati {svuota_cache() / 1e6:.0f} MB")
    ultimo = [time.time()]

    def avanzamento(letti, totale, nome):
        if time.time() - ultimo[0] > 2:
            ultimo[0] = time.time()
            print(f"  lettura {nome}: {letti / 1e9:.2f} di {totale / 1e9:.2f} GB ({100 * letti / totale:.0f}%)", flush=True)
    db = da_cartella(args.cartella, args.dialetto, avanzamento)
    for x in db.problemi:
        print(f"{x['file']}:{x['riga']}: dati non caricati: {x['problema']}")
    if db.n_problemi > len(db.problemi):
        print(f"... e altre {db.n_problemi - len(db.problemi)} istruzioni non caricate")
    if not args.query:
        for c in db.conteggi():
            print(f"{c['tabella']}: {c['righe']} righe")
        return
    esito = db.esegui(args.query, args.modifiche)
    if esito.get("serve_conferma"):
        raise SystemExit("La query modifica i dati: aggiungi --modifiche per eseguirla (cambia solo il database SQLite).")
    for r in esito["risultati"]:
        if r["tradotta"]:
            print(f"(tradotta in SQLite: {r['tradotta']})")
        print(testo_risultato(r), "\n")


if __name__ == "__main__":
    main()
