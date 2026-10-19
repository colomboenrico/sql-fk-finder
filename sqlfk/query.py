"""Interrogare il database con le query.

Dai file .sql si costruisce un database SQLite in memoria: le tabelle dei CREATE TABLE (con le colonne e
le chiavi primarie lette dall'analisi) e i dati degli INSERT INTO e dei blocchi COPY ... FROM stdin dei
dump di PostgreSQL. Le query si possono scrivere in SQLite o nel dialetto dei file (MySQL, PostgreSQL,
SQL Server...): se SQLite non le capisce vengono tradotte con sqlglot.

Le istruzioni che modificano i dati (INSERT, UPDATE, DELETE, DROP...) cambiano solo il database in
memoria, non i file: si annullano ricostruendolo dai file.

Uso da terminale:
    python -m sqlfk.query cartella "SELECT * FROM clienti"
"""

import argparse
import re
import sqlite3
import time
from pathlib import Path

from . import analisi as A

try:
    import sqlglot
except ImportError:                        # senza sqlglot le query devono essere già in SQLite
    sqlglot = None

MAX_RIGHE = 1000                           # righe restituite per ogni risultato
MODIFICANO = {"INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT", "MERGE", "DROP", "CREATE", "ALTER", "TRUNCATE",
              "RENAME", "ATTACH", "DETACH", "VACUUM", "REINDEX", "COPY", "GRANT", "REVOKE"}
MODIFICA_IN_WITH = re.compile(r"\b(INSERT|UPDATE|DELETE|REPLACE)\b", re.I)
DIALETTI_SQLGLOT = {"mysql": "mysql", "postgres": "postgres", "postgresql": "postgres", "tsql": "tsql",
                    "oracle": "oracle", "sqlite": "sqlite", "mariadb": "mysql"}


# ====================================================================== divisione in istruzioni

def istruzioni(testo, dialetto="mysql"):
    """Divide un testo SQL in istruzioni, rispettando stringhe, commenti e i blocchi $$ di PostgreSQL.

    Restituisce una lista di (riga, istruzione, dati_copy): dati_copy sono le righe che seguono un
    COPY ... FROM stdin (fino a \\.), altrimenti None.
    """
    risultato, n, i, inizio = [], len(testo), 0, 0
    riga, riga_inizio = 1, 1
    barra = dialetto == "mysql"            # in MySQL \' dentro una stringa non la chiude
    while i < n:
        c = testo[i]
        if c == "\n":
            riga += 1
        if c in "'\"`[":
            chiusa = "]" if c == "[" else c
            if c == "[" and dialetto != "tsql":
                i += 1
                continue
            i += 1
            while i < n:
                if testo[i] == "\n":
                    riga += 1
                if barra and c == "'" and testo[i] == "\\":
                    i += 2
                    continue
                if testo[i] == chiusa:
                    if i + 1 < n and testo[i + 1] == chiusa and chiusa != "]":
                        i += 2                 # '' dentro una stringa
                        continue
                    break
                i += 1
        elif c == "-" and testo.startswith("--", i) or (c == "#" and dialetto == "mysql"):
            fine = testo.find("\n", i)
            i = n if fine < 0 else fine
            continue
        elif c == "/" and testo.startswith("/*", i):
            fine = testo.find("*/", i + 2)
            fine = n if fine < 0 else fine + 2
            riga += testo.count("\n", i, fine)
            i = fine
            continue
        elif c == "$" and dialetto in ("postgres", "postgresql"):
            m = re.match(r"\$[A-Za-z_]*\$", testo[i:])
            if m:
                fine = testo.find(m.group(), i + len(m.group()))
                fine = n if fine < 0 else fine + len(m.group())
                riga += testo.count("\n", i, fine)
                i = fine
                continue
        elif c == ";":
            frase = testo[inizio:i].strip()
            dati = None
            i += 1
            if re.match(r"COPY\b.*\bFROM\s+stdin", frase, re.I | re.S):
                # i dati del COPY: righe fino a "\."
                a_capo = testo.find("\n", i)
                partenza = n if a_capo < 0 else a_capo + 1
                fine = testo.find("\n\\.", partenza - 1)
                fine = n if fine < 0 else fine
                dati = testo[partenza:fine + 1].splitlines() if fine > partenza else []
                riga += testo.count("\n", i, fine + 3)
                i = min(n, fine + 3)
            if frase:
                risultato.append((riga_inizio, frase, dati))
            inizio, riga_inizio = i, riga
            continue
        i += 1
        if not testo[inizio:i].strip():
            inizio, riga_inizio = i, riga
    frase = testo[inizio:].strip()
    if frase:
        risultato.append((riga_inizio, frase, None))
    return risultato


def senza_commenti_iniziali(frase):
    return re.sub(r"^(\s*(--[^\n]*\n|/\*.*?\*/))*\s*", "", frase, flags=re.S)


def parola_iniziale(frase):
    m = re.match(r"\(*\s*([A-Za-z]+)", senza_commenti_iniziali(frase))
    return m.group(1).upper() if m else ""


def modifica(frase):
    """True se l'istruzione cambia dati o struttura."""
    prima = parola_iniziale(frase)
    if prima == "WITH":
        return bool(MODIFICA_IN_WITH.search(frase))
    return prima in MODIFICANO


# ====================================================================== costruzione del database

def q(nome):
    """Nome tra virgolette per SQLite: taxa.virus -> "taxa.virus" """
    return '"' + nome.replace('"', '""') + '"'


class Database:
    """Database SQLite in memoria costruito dai file .sql."""

    def __init__(self, file_sql, df_schema, pk, dialetto="mysql"):
        self.dialetto = dialetto
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.execute("PRAGMA foreign_keys = OFF")
        self.tabelle = {}                  # nome in minuscolo (e senza schema) -> nome della tabella
        self.problemi = []                 # istruzioni di dati non caricate
        inizio = time.time()
        self._crea_tabelle(df_schema, pk)
        self._carica_dati(file_sql)
        self.conn.commit()
        self.secondi = time.time() - inizio

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

    def tabella_di(self, nome):
        """Nome scritto nei file (public."Clienti", dbo.[clienti], `clienti`) -> nome della tabella."""
        n = A.nome_qualificato(nome)
        return self.tabelle.get(n.lower()) or self.tabelle.get(n.split(".")[-1].lower())

    # ------------------------------------------------------------ dati
    def _carica_dati(self, file_sql):
        for nome_file, testo in file_sql:
            if nome_file in A.FILE_GENERATI:
                continue
            for riga, frase, dati in istruzioni(testo, self.dialetto):
                prima = parola_iniziale(frase)
                try:
                    if prima == "COPY" and dati is not None:
                        self._copy(frase, dati)
                    elif prima in ("INSERT", "REPLACE"):
                        self._insert(frase)
                    elif prima == "ALTER":
                        self._aggiungi_colonne(frase)
                except Exception as e:     # un'istruzione sbagliata non ferma le altre
                    self.problemi.append({"file": nome_file, "riga": riga, "istruzione": frase[:200],
                                          "problema": str(e)[:300]})

    RE_INSERT = re.compile(r"^\s*(INSERT|REPLACE)\s+(?:IGNORE\s+)?(?:INTO\s+)?"
                           r"((?:[`\"\[]?[^\s`\"\[\]().]+[`\"\]]?\s*\.\s*)*[`\"\[]?[^\s`\"\[\]().]+[`\"\]]?)", re.I)

    def _insert(self, frase):
        m = self.RE_INSERT.match(senza_commenti_iniziali(frase))
        if not m:
            raise ValueError("INSERT non riconosciuto")
        tabella = self.tabella_di(m.group(2))
        if not tabella:
            raise ValueError(f"la tabella {A.pulisci(m.group(2))} non ha un CREATE TABLE nei file")
        corpo = senza_commenti_iniziali(frase)[m.end():]
        # clausole che SQLite non conosce
        corpo = re.sub(r"\bON\s+DUPLICATE\s+KEY\s+UPDATE\b.*$", "", corpo, flags=re.I | re.S)
        corpo = re.sub(r"(?<![\w'])[Nn]'", "'", corpo)       # N'testo' di SQL Server
        diretta = f"INSERT OR REPLACE INTO {q(tabella)} {corpo}" if m.group(1).upper() == "REPLACE" \
            else f"INSERT INTO {q(tabella)} {corpo}"
        try:
            self.conn.execute(diretta)
        except sqlite3.Error as errore:
            tradotta = self.traduci(diretta)
            if tradotta == diretta:
                raise errore
            self.conn.execute(tradotta)

    RE_ADD_COLUMN = re.compile(r"^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(\S+)\s+(.*)$", re.I | re.S)

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

    def _copy(self, frase, righe):
        m = re.match(r"COPY\s+(\S+?)\s*(?:\(([^)]*)\))?\s+FROM\s+stdin", frase, re.I | re.S)
        tabella = self.tabella_di(m.group(1)) if m else None
        if not tabella:
            raise ValueError(f"la tabella {m.group(1) if m else '?'} non ha un CREATE TABLE nei file")
        colonne = [A.pulisci(c) for c in m.group(2).split(",")] if m.group(2) else \
            [r[1] for r in self.conn.execute(f"PRAGMA table_info({q(tabella)})")]

        def valore(v):
            if v == "\\N":
                return None
            return re.sub(r"\\(.)", lambda x: {"t": "\t", "n": "\n", "r": "\r", "\\": "\\"}.get(x.group(1), x.group(1)), v)

        valori = [[valore(v) for v in r.split("\t")] for r in righe if r != ""]
        self.conn.executemany(f"INSERT INTO {q(tabella)} ({', '.join(q(c) for c in colonne)}) "
                              f"VALUES ({', '.join('?' * len(colonne))})", valori)

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
        """Righe di ogni tabella."""
        return [{"tabella": t, "righe": self.conn.execute(f"SELECT COUNT(*) FROM {q(t)}").fetchone()[0]}
                for (t,) in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]

    def esegui(self, testo, consenti_modifiche=False, max_righe=MAX_RIGHE):
        """Esegue una o più istruzioni separate da ;.

        Se ce n'è una che modifica e consenti_modifiche è False non esegue niente e restituisce
        {"serve_conferma": True, "modifiche": [...]}. Altrimenti un risultato per istruzione:
        colonne, righe (al massimo max_righe), totale, righe modificate, query tradotta, errore.
        """
        frasi = [f for _, f, _ in istruzioni(testo, "postgres" if self.dialetto in ("postgres", "postgresql") else "sqlite")]
        if not frasi:
            return {"risultati": []}
        modifiche = [f for f in frasi if modifica(f)]
        if modifiche and not consenti_modifiche:
            return {"serve_conferma": True, "modifiche": [f[:300] for f in modifiche]}
        risultati = []
        for frase in frasi:
            r = {"istruzione": frase, "tradotta": None, "colonne": [], "righe": [], "totale": 0,
                 "modificate": None, "errore": None}
            inizio = time.time()
            try:
                cursore = self._esegui_una(frase, r)
                if cursore.description:
                    r["colonne"] = [d[0] for d in cursore.description]
                    righe = cursore.fetchmany(max_righe)
                    r["righe"] = [[v if not isinstance(v, bytes) else v.hex() for v in riga] for riga in righe]
                    r["totale"] = len(righe) + sum(1 for _ in cursore)
                else:
                    r["modificate"] = cursore.rowcount if cursore.rowcount >= 0 else 0
                self.conn.commit()
            except Exception as e:
                self.conn.rollback()
                r["errore"] = str(e)
            r["secondi"] = round(time.time() - inizio, 3)
            risultati.append(r)
            if r["errore"]:
                break                      # come un client SQL: ci si ferma al primo errore
        return {"risultati": risultati}

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
            tradotta = self.traduci(frase)
            if tradotta.strip() == frase.strip():
                raise
            r["tradotta"] = tradotta
            try:
                return self.conn.execute(tradotta)
            except sqlite3.Error:
                raise errore from None

    def dump(self):
        """Il database com'è adesso (con le modifiche) come script SQL."""
        return "\n".join(self.conn.iterdump()) + "\n"

    def file_sqlite(self):
        """Il database come file .sqlite (bytes), apribile con DBeaver o DB Browser for SQLite."""
        copia = sqlite3.connect(":memory:")
        self.conn.backup(copia)
        dati = copia.serialize()
        copia.close()
        return bytes(dati)


def da_cartella(cartella, dialetto="mysql"):
    file_sql = [(p.name, p.read_text(encoding="utf-8", errors="replace"))
                for p in sorted(Path(cartella).glob("*.sql")) if p.name not in A.FILE_GENERATI]
    df, pk, _, _ = A.leggi_testi(file_sql, dialetto)
    return Database(file_sql, df, pk, dialetto)


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
    linee.append(f"({r['totale']} righe" + (f", mostrate {len(r['righe'])}" if r["totale"] > len(r["righe"]) else "") + ")")
    return "\n".join(linee)


def main():
    p = argparse.ArgumentParser(description="Esegue query sui dati dei file .sql (database SQLite in memoria)")
    p.add_argument("cartella", help="cartella con i file .sql")
    p.add_argument("query", nargs="?", help="query da eseguire (se manca: elenco delle tabelle con le righe)")
    p.add_argument("--dialetto", default="mysql")
    p.add_argument("--modifiche", action="store_true", help="permette INSERT, UPDATE, DELETE... (solo in memoria)")
    args = p.parse_args()
    db = da_cartella(args.cartella, args.dialetto)
    for x in db.problemi:
        print(f"{x['file']}:{x['riga']}: dati non caricati: {x['problema']}")
    if not args.query:
        for c in db.conteggi():
            print(f"{c['tabella']}: {c['righe']} righe")
        return
    esito = db.esegui(args.query, args.modifiche)
    if esito.get("serve_conferma"):
        raise SystemExit("La query modifica i dati: aggiungi --modifiche per eseguirla (cambia solo la copia in memoria).")
    for r in esito["risultati"]:
        if r["tradotta"]:
            print(f"(tradotta in SQLite: {r['tradotta']})")
        print(testo_risultato(r), "\n")


if __name__ == "__main__":
    main()
