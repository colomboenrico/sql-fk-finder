"""Analisi dei collegamenti tra tabelle SQL: lettura dei CREATE TABLE, gruppi di entità,
chiavi esterne candidate, chiavi primarie composte.

È il codice usato sia dal notebook `collegamenti_tabelle_sql.ipynb` sia dall'app (server.py).
"""
import bisect
import hashlib
import logging
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage

from .regole import REGOLA_DI

try:
    import sqlglot
    from sqlglot import exp
    logging.getLogger("sqlglot").setLevel(logging.ERROR)   # niente warning "falling back..."
    HA_SQLGLOT = True
except ImportError:
    HA_SQLGLOT = False


# ====================================================================== impostazioni

@dataclass
class Impostazioni:
    # Dialetto SQL: "mysql", "tsql" (SQL Server), "oracle", "postgres", ...
    dialetto: str = "mysql"
    # Colonne troppo generiche per essere collegamenti: compaiono ovunque.
    generiche: set = field(default_factory=lambda: {
        "id", "nome", "descrizione", "descr", "note", "data", "stato", "tipo",
        "codice", "valore", "importo", "created_at", "updated_at", "deleted_at",
        "data_ins", "data_mod", "utente_ins", "utente_mod", "attivo", "flag",
    })
    # Soglia di somiglianza tra nomi di colonne (da 0 a 1): più alta = meno risultati ma più precisi
    soglia_simili: float = 0.85
    # Quanto devono somigliarsi i nomi di due tabelle per stare nello stesso gruppo
    soglia_gruppi: float = 0.75
    # Parole che nei nomi delle tabelle non indicano un'entità (prefissi e suffissi tecnici)
    parole_non_entita: set = field(default_factory=lambda: {
        "tbl", "tab", "tb", "t", "tmp", "temp", "bak", "backup", "old", "new", "x",
        "ext", "cfg", "web", "log",
    })
    # Regole di integrità referenziale scritte negli ALTER/CREATE TABLE:
    # "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT", "NO ACTION" oppure "" (nessuna clausola)
    on_delete: str = "RESTRICT"
    on_update: str = "CASCADE"
    # Sinonimi: ogni elemento è un gruppo di parole che indicano la stessa entità, per esempio "comune = citta = paese"
    sinonimi: list = field(default_factory=list)


# ====================================================================== funzioni di supporto

RE_CREATE = re.compile(r"CREATE\s+(?:TEMPORARY\s+)?TABLE\b[^(;]*?\(", re.I | re.S)
VINCOLI = ("PRIMARY", "KEY", "UNIQUE", "INDEX", "CONSTRAINT", "FOREIGN",
           "FULLTEXT", "SPATIAL", "CHECK", "PERIOD")


def togli_commenti(sql, dialetto="mysql"):
    """Sostituisce i commenti con spazi della stessa lunghezza: righe e posizioni restano quelle del file."""
    vuoto = lambda m: re.sub(r"[^\n]", " ", m.group())
    sql = re.sub(r"/\*.*?\*/", vuoto, sql, flags=re.S)     # /* ... */ e /*! ... */
    sql = re.sub(r"--[^\n]*", vuoto, sql)                   # -- commento
    if dialetto == "mysql":
        sql = re.sub(r"#[^\n]*", vuoto, sql)                # # commento (solo MySQL)
    return sql


class Righe:
    """Numero di riga (da 1) di una posizione nel testo."""

    def __init__(self, testo):
        self.inizi = [0] + [i + 1 for i, c in enumerate(testo) if c == "\n"]

    def __call__(self, posizione):
        return bisect.bisect_right(self.inizi, posizione)


def parti_con_posizione(sql, inizio, fine):
    """Come split_virgole su sql[inizio:fine], ma con la posizione di ogni parte nel testo."""
    parti, partenza, depth, quote = [], inizio, 0, None
    for i in range(inizio, fine):
        c = sql[i]
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            parti.append((partenza, sql[partenza:i]))
            partenza = i + 1
    parti.append((partenza, sql[partenza:fine]))
    risultato = []
    for pos, testo in parti:
        spazi = len(testo) - len(testo.lstrip())
        if testo.strip():
            risultato.append((pos + spazi, testo.strip()))
    return risultato


def pulisci(nome):
    return nome.strip().strip('`"[]').strip()


SCHEMI_PREDEFINITI = {"public", "dbo", "main"}


def nome_qualificato(nome):
    """public.ordini -> ordini; vendite.ordini -> vendite.ordini (tabelle di schemi diversi restano distinte)."""
    parti = [pulisci(p) for p in nome.strip().split(".")]
    if len(parti) > 1 and parti[-2].lower() not in SCHEMI_PREDEFINITI:
        return f"{parti[-2]}.{parti[-1]}"
    return parti[-1]


def nome_tabella(intestazione):
    nome = re.sub(r"^\s*CREATE\s+(?:TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?",
                  "", intestazione, flags=re.I).strip()
    return nome_qualificato(nome)


def chiusura_parentesi(sql, start):
    """Posizione della ')' che chiude la '(' in start, ignorando le stringhe."""
    depth, quote = 0, None
    for i in range(start, len(sql)):
        c = sql[i]
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
    return None


def split_virgole(body):
    """Divide il corpo del CREATE TABLE sulle virgole di primo livello."""
    parti, buf, depth, quote = [], "", 0, None
    for c in body:
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            parti.append(buf.strip())
            buf = ""
            continue
        buf += c
    if buf.strip():
        parti.append(buf.strip())
    return parti


def e_vincolo(riga):
    if riga[:1] in ("`", '"', "["):        # nome tra virgolette: è una colonna
        return False
    return riga.split()[0].upper() in VINCOLI


def colonne_regex(body):
    """Parser di riserva: estrae (nome, tipo) da ogni riga del CREATE TABLE."""
    risultato = []
    for riga in split_virgole(body):
        if not riga or e_vincolo(riga):
            continue
        m = re.match(r'([`"\[][^`"\]]+[`"\]]|[^\s,]+)\s+\[?(\w+)\]?(\s*\([^)]*\))?', riga)
        if m:
            tipo = (m.group(2) + (m.group(3) or "")).replace(" ", "").upper()
            risultato.append((pulisci(m.group(1)), tipo))
    return risultato


def pk_da_body(body):
    """Chiave primaria dichiarata nel CREATE TABLE (lista di colonne)."""
    for riga in split_virgole(body):
        if re.match(r"(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY", riga, re.I):
            m = re.search(r"\(([^)]*)\)", riga)
            if m:
                return [pulisci(c.split("(")[0].strip().split()[0]) for c in m.group(1).split(",") if c.strip()]
        elif re.search(r"\bPRIMARY\s+KEY\b", riga, re.I) and not e_vincolo(riga):
            return [pulisci(riga.split()[0])]
    return []


def normalizza(nome):
    """COD_ART, CodArt, cod-art -> codart"""
    return re.sub(r"[^a-z0-9]", "", str(nome).lower())


# Nomi diversi per lo stesso tipo nei vari database
SINONIMI_TIPI = {
    "INTEGER": "INT", "INT4": "INT", "SERIAL": "INT", "MEDIUMINT": "INT",
    "INT8": "BIGINT", "BIGSERIAL": "BIGINT", "INT2": "SMALLINT", "SMALLSERIAL": "SMALLINT",
    "CHARACTER": "CHAR", "NCHAR": "CHAR", "NVARCHAR": "VARCHAR", "VARCHAR2": "VARCHAR", "NVARCHAR2": "VARCHAR",
    "BOOL": "BOOLEAN", "NUMERIC": "DECIMAL", "NUMBER": "DECIMAL", "TIMESTAMPTZ": "TIMESTAMP",
    "DATETIME": "TIMESTAMP", "DATETIME2": "TIMESTAMP", "FLOAT8": "DOUBLE", "FLOAT4": "FLOAT", "REAL": "FLOAT",
}


def tipo_base(t):
    """INT(11) -> INT; integer -> INT; character varying(80) -> VARCHAR"""
    if not isinstance(t, str) or not t:
        return ""
    testo = t.strip().upper()
    if re.match(r"(CHARACTER|CHAR)\s+VARYING\b", testo):
        return "VARCHAR"
    if re.match(r"DOUBLE\s+PRECISION\b", testo):
        return "DOUBLE"
    m = re.match(r"\w+", testo)
    base = m.group(0) if m else ""
    return SINONIMI_TIPI.get(base, base)


def radice(nome):
    """articoli / articolo / tbl_articoli / items -> stessa radice"""
    n = re.sub(r"^(tbl|tab|tb|t)_", "", str(nome).lower())
    if len(n) > 3:
        n = re.sub(r"s$", "", n)
    if len(n) > 3:
        n = re.sub(r"[aeio]$", "", n)
    return n.replace("_", "")


def senza_accenti(testo):
    """città -> citta"""
    return "".join(c for c in unicodedata.normalize("NFKD", str(testo)) if not unicodedata.combining(c))


# Plurali inglesi irregolari più comuni nei nomi delle tabelle
IRREGOLARI_EN = {"people": "person", "children": "child", "men": "man", "women": "woman", "mice": "mouse",
                 "feet": "foot", "teeth": "tooth", "geese": "goose", "data": "datum", "indices": "index",
                 "matrices": "matrix", "analyses": "analysis", "statuses": "status", "addresses": "address"}
# Desinenze italiane del plurale -> desinenze del singolare
# (si usa solo la prima che corrisponde: banchi -> banco, non banche)
DESINENZE_IT = (("chi", ("co", "chio")), ("ghi", ("go", "ghio")), ("che", ("ca",)), ("ghe", ("ga",)),
                ("cie", ("cia",)), ("gie", ("gia",)), ("ce", ("cia", "ca")), ("ge", ("gia", "ga")),
                ("ci", ("cio", "co", "ce")), ("gi", ("gio", "go", "ge")), ("i", ("o", "e", "io", "a")), ("e", ("a",)))


def singolari(parola):
    """Possibili singolari di una parola, italiano e inglese, compresa la parola stessa.

    province -> {province, provincia}; banchi -> {banchi, banco}; banche -> {banche, banca};
    negozi -> {..., negozio}; categories -> {..., category}; boxes -> {..., box}; città -> {citta}
    """
    w = re.sub(r"[^a-z0-9]", "", senza_accenti(parola).lower())
    forme = {w}
    if len(w) < 3:
        return forme
    if w in IRREGOLARI_EN:
        forme.add(IRREGOLARI_EN[w])
    for fine, sostituti in DESINENZE_IT:
        if w.endswith(fine):
            forme.update(w[:-len(fine)] + x for x in sostituti)
            break
    if w.endswith("ies"):
        forme.add(w[:-3] + "y")
    if w.endswith("ves"):
        forme.update((w[:-3] + "f", w[:-3] + "fe"))
    if re.search(r"(s|x|z|ch|sh)es$", w):
        forme.add(w[:-2])
    if w.endswith("s") and not w.endswith("ss"):
        forme.add(w[:-1])
    return forme


def mappa_sinonimi(elenco):
    """["comune = citta = paese"] -> {forma: segno del gruppo}: le parole dello stesso gruppo diventano equivalenti."""
    mappa = {}
    for i, riga in enumerate(elenco or []):
        parole = [p.strip() for p in re.split(r"[=,;]", str(riga)) if p.strip()]
        if len(parole) < 2:
            continue
        for p in parole:
            for forma in singolari(p):
                mappa[forma] = f"~{i}"
    return mappa


def chiavi_entita(nome, sinonimi=None):
    """Chiavi per riconoscere un'entità: i possibili singolari del nome (senza schema e prefissi tecnici)
    più il gruppo di sinonimi a cui appartiene. Due nomi indicano la stessa entità se hanno una chiave in comune."""
    n = senza_accenti(str(nome)).lower().split(".")[-1]
    n = re.sub(r"^(tbl|tab|tb|t)_", "", n)
    forme = singolari(n)
    if sinonimi:
        forme |= {sinonimi[f] for f in forme if f in sinonimi}
    return forme


def riferimento(col):
    """id_articolo / articolo_id / articoloId / cod_articolo -> 'articolo'"""
    c = re.sub(r"([a-z])([A-Z])", r"\1_\2", str(col)).lower()
    if c in ("id", "cod", "codice", "fk", "num"):       # solo il prefisso: nessuna tabella
        return None
    m = (re.fullmatch(r"(?:id|cod|codice|fk|num)_?(.+)", c)
         or re.fullmatch(r"(.+?)_?(?:id|cod|codice|fk)", c))
    return m.group(1) if m else None


def clausola_regole(imp, colonne_not_null, dialetto=None):
    """(" ON DELETE ... ON UPDATE ...", nota) secondo le Impostazioni.

    SET NULL non si può usare se una colonna della chiave esterna è NOT NULL;
    MySQL (InnoDB) non accetta SET DEFAULT. In questi casi si usa RESTRICT e lo si segnala.
    """
    parti, note = [], []
    for evento, regola in (("DELETE", imp.on_delete), ("UPDATE", imp.on_update)):
        regola = (regola or "").strip().upper()
        if not regola or regola == "NESSUNA":
            continue
        if regola == "SET NULL" and colonne_not_null:
            note.append(f"ON {evento} SET NULL non è possibile su una colonna NOT NULL: uso RESTRICT")
            regola = "RESTRICT"
        if regola == "SET DEFAULT" and (dialetto or imp.dialetto) == "mysql":
            note.append(f"MySQL non accetta ON {evento} SET DEFAULT: uso RESTRICT")
            regola = "RESTRICT"
        parti.append(f"ON {evento} {regola}")
    return (" " + " ".join(parti) if parti else ""), "; ".join(note)


def nome_vincolo(tabella, colonne, dest):
    """fk_ordini_id_cliente_clienti; al massimo 64 caratteri (limite di MySQL), senza doppioni."""
    nome = re.sub(r"\W+", "_", f"fk_{tabella}_{colonne}_{dest}")
    if len(nome) > 64:
        nome = nome[:55] + "_" + hashlib.md5(nome.encode()).hexdigest()[:8]
    return nome


def parti_nome(nome):
    """ordini_righe -> [ordini, righe]; OrdiniRighe -> [ordini, righe]"""
    nome = re.sub(r"([a-z])([A-Z])", r"\1_\2", str(nome))
    return [p for p in re.split(r"[^A-Za-z0-9]+", nome.lower()) if p]


# ====================================================================== lettura dei file

FILE_GENERATI = {"fk_candidate.sql", "create_table_con_fk.sql"}   # scritti dal notebook o dall'app
COLONNE_SCHEMA = ["file", "riga", "tabella", "colonna", "tipo", "not null", "unique", "metodo", "riga tabella"]
COLONNE_FK_DICHIARATE = ["tabella", "colonna", "→ tabella", "→ colonna", "file", "riga"]
RE_FK = re.compile(r"FOREIGN\s+KEY\s*(?:[^\s(]+\s*)?\(([^)]*)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)", re.I)
RE_REFERENCES = re.compile(r"\bREFERENCES\s+([^\s(]+)\s*\(([^)]*)\)", re.I)
RE_ALTER_CHIAVE = re.compile(r"ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s]+)\s+ADD\s+(?:CONSTRAINT\s+\S+\s+)?"
                             r"(PRIMARY\s+KEY|UNIQUE)\s*(?:CLUSTERED\s+|NONCLUSTERED\s+)?\(([^)]*)\)", re.I)
RE_ALTER_FK = re.compile(r"ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s]+)\s+ADD\s+(?:CONSTRAINT\s+\S+\s+)?"
                         r"FOREIGN\s+KEY\s*(?:[^\s(]+\s*)?\(([^)]*)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)", re.I)


def vincoli_colonne(body):
    """{nome normalizzato: (not null, unique)} per le colonne del CREATE TABLE."""
    righe, uniche = {}, set()
    for riga in split_virgole(body):
        if not riga:
            continue
        if e_vincolo(riga):
            if re.match(r"(CONSTRAINT\s+\S+\s+)?UNIQUE\b", riga, re.I):     # UNIQUE KEY nome (colonna)
                m = re.search(r"\(([^)]*)\)", riga)
                if m and "," not in m.group(1):
                    uniche.add(normalizza(pulisci(m.group(1).split("(")[0])))
        else:
            righe[normalizza(pulisci(riga.split()[0]))] = riga
    return {n: (bool(re.search(r"\bNOT\s+NULL\b", r, re.I)),
                bool(re.search(r"\bUNIQUE\b", r, re.I)) or n in uniche)
            for n, r in righe.items()}


def fk_dichiarata(tabella, colonne, dest, colonne_dest, file, riga=None):
    nomi = lambda testo: ", ".join(pulisci(c) for c in testo.split(","))
    return {"tabella": tabella, "colonna": nomi(colonne), "→ tabella": nome_qualificato(dest),
            "→ colonna": nomi(colonne_dest), "file": file, "riga": riga}


def leggi_testi(file_sql, dialetto="mysql"):
    """Legge CREATE TABLE e chiavi esterne dichiarate da una lista di (nome file, testo SQL).

    Restituisce: colonne (DataFrame), chiavi primarie dichiarate (dict tabella -> colonne),
    chiavi esterne dichiarate (DataFrame), errori di lettura (lista: file, riga, tabella, problema).
    """
    righe, pk, fk, errori, viste, chiavi_alter = [], {}, [], [], {}, []

    for nome_file, testo in file_sql:
        if nome_file in FILE_GENERATI:
            continue
        sql = togli_commenti(testo, dialetto)
        riga_di = Righe(sql)

        # chiavi esterne aggiunte dopo: ALTER TABLE x ADD FOREIGN KEY (...) REFERENCES y (...)
        for m in RE_ALTER_CHIAVE.finditer(sql):
            colonne = [pulisci(c.strip().split()[0]) for c in m.group(3).split(",") if c.strip()]
            chiavi_alter.append((nome_qualificato(m.group(1)), m.group(2).upper().startswith("PRIMARY"), colonne))

        for m in RE_ALTER_FK.finditer(sql):
            fk.append(fk_dichiarata(nome_qualificato(m.group(1)), m.group(2), m.group(3), m.group(4),
                                    nome_file, riga_di(m.start())))

        for m in RE_CREATE.finditer(sql):
            apertura = m.end() - 1
            chiusura = chiusura_parentesi(sql, apertura)
            tabella = nome_tabella(sql[m.start():apertura])
            riga_tabella = riga_di(m.start())
            if chiusura is None:
                errori.append({"codice": "E001", "file": nome_file, "riga": riga_tabella, "tabella": tabella,
                               "problema": f"CREATE TABLE {tabella}: manca la parentesi di chiusura, la tabella non è stata letta"})
                continue
            if tabella in viste:
                errori.append({"codice": "E002", "file": nome_file, "riga": riga_tabella, "tabella": tabella,
                               "problema": f"la tabella {tabella} è definita due volte (la prima in {viste[tabella]}): vale l'ultima"})
                righe = [r for r in righe if r["tabella"] != tabella]
            viste[tabella] = f"{nome_file}:{riga_tabella}"

            body = sql[apertura + 1:chiusura]
            riga_colonna = {}
            for pos, parte in parti_con_posizione(sql, apertura + 1, chiusura):
                if not e_vincolo(parte):
                    riga_colonna.setdefault(normalizza(pulisci(parte.split()[0])), []).append(riga_di(pos))

            # 1) sqlglot sul solo "CREATE TABLE nome ( ... )", senza ENGINE/COMMENT/ecc.
            colonne, metodo = None, "regex"
            if HA_SQLGLOT:
                try:
                    stmt = sqlglot.parse_one(sql[m.start():chiusura + 1], read=dialetto)
                    if isinstance(stmt, exp.Create):
                        defs = list(stmt.find_all(exp.ColumnDef))
                        if defs:
                            colonne = [(c.name, c.kind.sql(dialect=dialetto).upper() if c.kind else None)
                                       for c in defs]
                            metodo = "sqlglot"
                except Exception:
                    pass

            # 2) parser di riserva
            if colonne is None:
                colonne = colonne_regex(body)

            vincoli = vincoli_colonne(body)
            gia = set()
            for nome, tipo in colonne:
                n = normalizza(nome)
                posizioni = riga_colonna.get(n, [riga_tabella])
                if n in gia:
                    errori.append({"codice": "E003", "file": nome_file, "riga": posizioni[min(1, len(posizioni) - 1)],
                                   "tabella": tabella,
                                   "problema": f"la colonna {nome} è definita due volte nella tabella {tabella}"})
                    continue
                gia.add(n)
                not_null, unico = vincoli.get(n, (False, False))
                righe.append({"file": nome_file, "riga": posizioni[0], "tabella": tabella,
                              "colonna": nome, "tipo": tipo, "not null": not_null, "unique": unico,
                              "metodo": metodo, "riga tabella": riga_tabella})

            pk[tabella] = pk_da_body(body) or pk.get(tabella, [])

            # chiavi esterne dichiarate dentro il CREATE TABLE
            for pos, riga in parti_con_posizione(sql, apertura + 1, chiusura):
                if e_vincolo(riga):
                    m_fk = RE_FK.search(riga)
                    if m_fk:
                        fk.append(fk_dichiarata(tabella, m_fk.group(1), m_fk.group(2), m_fk.group(3),
                                                nome_file, riga_di(pos)))
                else:
                    m_fk = RE_REFERENCES.search(riga)        # colonna int REFERENCES altra(id)
                    if m_fk:
                        fk.append(fk_dichiarata(tabella, riga.split()[0], m_fk.group(1), m_fk.group(2),
                                                nome_file, riga_di(pos)))

    for tabella, primaria, colonne in chiavi_alter:
        if primaria:
            if not pk.get(tabella):
                pk[tabella] = colonne
        elif len(colonne) == 1:
            for r in righe:
                if r["tabella"] == tabella and normalizza(r["colonna"]) == normalizza(colonne[0]):
                    r["unique"] = True

    df_schema = pd.DataFrame(righe, columns=COLONNE_SCHEMA)
    df_fk_dichiarate = pd.DataFrame(fk, columns=COLONNE_FK_DICHIARATE).drop_duplicates(
        ["tabella", "colonna", "→ tabella"]).reset_index(drop=True)
    return df_schema, pk, df_fk_dichiarate, errori


def leggi_cartella(cartella, dialetto="mysql"):
    """Legge tutti i file .sql della cartella (vedi leggi_testi)."""
    file_sql = [(f.name, f.read_text(encoding="utf-8", errors="replace"))
                for f in sorted(Path(cartella).glob("*.sql"))]
    return leggi_testi(file_sql, dialetto)


# ====================================================================== togliere entità

def tabelle_entita(tabelle, parola, sinonimi=None):
    """Tabelle che appartengono all'entità: 'piatto' -> piatti, piatto_ingredienti, tbl_piatti...
    sinonimi: elenco come nelle Impostazioni ("comune = citta"): 'comune' trova anche le tabelle citta."""
    base = normalizza(senza_accenti(parola))
    if len(base) < 3:                              # parola troppo corta: troverebbe di tutto
        return []
    mappa = mappa_sinonimi(sinonimi)
    cercate = chiavi_entita(base, mappa)
    # per i nomi attaccati (piattiingredienti): l'inizio della parola senza la desinenza
    inizi = {f[:-1] for f in singolari(base) if len(f) >= 5}
    return sorted(t for t in tabelle
                  if any(chiavi_entita(p, mappa) & cercate
                         or (len(p) > len(base) + 2 and any(p.startswith(i) for i in inizi))
                         for p in parti_nome(senza_accenti(t))))


def filtra_schema(df_schema, pk_dichiarate, rimosse):
    """Toglie dallo schema le tabelle rimosse."""
    rimosse = set(rimosse)
    return (df_schema[~df_schema["tabella"].isin(rimosse)],
            {t: c for t, c in pk_dichiarate.items() if t not in rimosse})


# ====================================================================== gruppi di entità

def parole_entita(tabella, parole_non_entita, sinonimi=None):
    """tbl_ordini_righe -> [(ordini, {ordini, ordino, ordine...}), (righe, {righe, riga})]:
    le parole che indicano entità con i loro possibili singolari."""
    parti = [p for p in parti_nome(senza_accenti(tabella))
             if p not in parole_non_entita and not p.isdigit() and len(p) >= 2]
    parti = parti or [normalizza(tabella)]
    return [(p, frozenset(chiavi_entita(p, sinonimi))) for p in parti]


def somiglianza_parole(a, b):
    """1 se sono la stessa parola (anche al plurale o sinonimi); 0 se differiscono solo nella desinenza
    (banchi/banche sono parole diverse); altrimenti la quota di inizio comune (anagraf/anagrafica)."""
    (pa, fa), (pb, fb) = a, b
    if not fa.isdisjoint(fb):
        return 1.0
    n = 0
    while n < min(len(pa), len(pb)) and pa[n] == pb[n]:
        n += 1
    if n >= max(len(pa), len(pb)) - 2:
        return 0.0
    return n / max(len(pa), len(pb))


def inizio_comune(a, b):
    """Quota di inizio comune: anagrafic / anagrafich -> 8 lettere su 10 = 0,8"""
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n / max(len(a), len(b))


def raggruppa_tabelle(tabelle, imp=None):
    """Clustering gerarchico (legame medio) delle tabelle in base alla somiglianza dei nomi.

    Restituisce: DataFrame dei gruppi (gruppo, n_tabelle, tabelle) e dict tabella -> gruppo.
    """
    imp = imp or Impostazioni()
    tabelle = sorted(set(tabelle))
    if len(tabelle) < 2:
        etichette = [1] * len(tabelle)
    else:
        sinonimi = mappa_sinonimi(imp.sinonimi)
        parole = [parole_entita(t, imp.parole_non_entita, sinonimi) for t in tabelle]
        distanze = []                          # matrice delle distanze in forma compatta
        for i in range(len(tabelle)):
            for j in range(i + 1, len(tabelle)):
                # quota di parole di ciascuna tabella che si ritrovano nell'altra (tra 0 e 1)
                uguali_i = sum(any(not fa.isdisjoint(fb) for _, fb in parole[j]) for _, fa in parole[i])
                uguali_j = sum(any(not fb.isdisjoint(fa) for _, fa in parole[i]) for _, fb in parole[j])
                comuni = (uguali_i + uguali_j) / (len(parole[i]) + len(parole[j]))
                distanze.append(1 - max(somiglianza_parole(parole[i][0], parole[j][0]), comuni))
        etichette = fcluster(linkage(distanze, method="average"), t=1 - imp.soglia_gruppi, criterion="distance")

    membri = {}
    for t, e in zip(tabelle, etichette):
        membri.setdefault(e, []).append(t)

    righe, gruppo_di, usati = [], {}, Counter()
    for elenco in membri.values():
        prime = Counter(next((p for p in parti_nome(t) if p not in imp.parole_non_entita), t) for t in elenco)
        nome = min(prime, key=lambda p: (-prime[p], len(p), p))
        usati[nome] += 1
        if usati[nome] > 1:
            nome = f"{nome} ({usati[nome]})"
        for t in elenco:
            gruppo_di[t] = nome
        righe.append({"gruppo": nome, "n_tabelle": len(elenco), "tabelle": ", ".join(elenco)})

    df_gruppi = (pd.DataFrame(righe, columns=["gruppo", "n_tabelle", "tabelle"])
                   .sort_values(["n_tabelle", "gruppo"], ascending=[False, True])
                   .reset_index(drop=True))
    return df_gruppi, gruppo_di


# ====================================================================== schema iniziale

def riepilogo_iniziale(df_schema, pk_dichiarate, fk_dichiarate, df_gruppi):
    """Il database com'è nei file, prima di cercare collegamenti."""
    tabelle = set(df_schema["tabella"])
    n_pk = [len(pk_dichiarate.get(t, [])) for t in tabelle]
    collegate = (set(fk_dichiarate["tabella"]) | set(fk_dichiarate["→ tabella"])) & tabelle
    voci = [
        ("Tabelle", len(tabelle)),
        ("Colonne", len(df_schema)),
        ("Tabelle con chiave primaria su una colonna", sum(n == 1 for n in n_pk)),
        ("Tabelle con chiave primaria composta", sum(n > 1 for n in n_pk)),
        ("Tabelle senza chiave primaria dichiarata", sum(n == 0 for n in n_pk)),
        ("Chiavi esterne già dichiarate", len(fk_dichiarate)),
        ("Tabelle collegate da chiavi esterne dichiarate", len(collegate)),
        ("Tabelle non collegate a nessun'altra", len(tabelle - collegate)),
        ("Gruppi di entità con almeno 2 tabelle", int((df_gruppi["n_tabelle"] > 1).sum())),
        ("Tabelle che non stanno in nessun gruppo", int((df_gruppi["n_tabelle"] == 1).sum())),
    ]
    return pd.DataFrame(voci, columns=["voce", "valore"])


# ====================================================================== chiavi primarie

def prepara(df_schema, pk_dichiarate, fk_dichiarate=None, imp=None):
    """Colonne, chiavi primarie e indici di ricerca usati da tutte le analisi."""
    imp = imp or Impostazioni()
    S = SimpleNamespace()
    S.fk_dichiarate = set()               # (tabella, colonne normalizzate, tabella puntata)
    if fk_dichiarate is not None:
        for r in fk_dichiarate.to_dict("records"):
            S.fk_dichiarate.add((r["tabella"], tuple(normalizza(c) for c in r["colonna"].split(",")),
                                 r["→ tabella"]))
    col = df_schema.drop_duplicates(["tabella", "colonna"]).copy()
    col["norm"] = col["colonna"].map(normalizza)
    col["tipo_base"] = col["tipo"].map(tipo_base)
    S.df_schema, S.col = df_schema, col
    S.col_per_tab = col.groupby("tabella")["colonna"].apply(list).to_dict()

    # tabella -> {nome normalizzato: nome vero della colonna}
    S.colonne_norm = {t: {} for t in S.col_per_tab}
    for r in col.itertuples():
        S.colonne_norm[r.tabella].setdefault(r.norm, r.colonna)

    # chiavi primarie: dichiarate (con i nomi veri delle colonne) o indovinate
    S.pk, S.pk_indovinata = {}, set()
    for t, colonne_t in S.col_per_tab.items():
        S.pk[t] = [S.colonne_norm[t].get(normalizza(c), c) for c in pk_dichiarate.get(t, [])]
        if not S.pk[t]:
            for c in colonne_t:
                rif = riferimento(c)
                if c.lower() == "id" or (rif and chiavi_entita(rif) & chiavi_entita(t)):
                    S.pk[t] = [c]
                    S.pk_indovinata.add(t)
                    break

    S.riepilogo = pd.DataFrame([
        {"tabella": t,
         "n_colonne": len(colonne_t),
         "chiave primaria": ", ".join(S.pk[t]) or "-",
         "n colonne PK": len(S.pk[t]),
         "pk dichiarata": bool(S.pk[t]) and t not in S.pk_indovinata}
        for t, colonne_t in sorted(S.col_per_tab.items())
    ], columns=["tabella", "n_colonne", "chiave primaria", "n colonne PK", "pk dichiarata"])

    # vincoli effettivi: le colonne della chiave primaria sono sempre NOT NULL
    S.imp = imp
    S.not_null, S.unique = set(), set()
    for r in col.to_dict("records"):
        chiave = (r["tabella"], r["colonna"])
        if r.get("not null") or r["colonna"] in S.pk.get(r["tabella"], []):
            S.not_null.add(chiave)
        if r.get("unique") or S.pk.get(r["tabella"]) == [r["colonna"]]:
            S.unique.add(chiave)

    S.pk_singola = {t: c[0] for t, c in S.pk.items() if len(c) == 1}
    S.pk_composta = {t: c for t, c in S.pk.items() if len(c) > 1}
    S.pk_di, S.parte_pk_di = {}, {}       # nome normalizzato -> tabelle in cui è PK / parte di PK composta
    for t, c in S.pk_singola.items():
        S.pk_di.setdefault(normalizza(c), []).append(t)
    for t, colonne_pk in S.pk_composta.items():
        for c in colonne_pk:
            S.parte_pk_di.setdefault(normalizza(c), []).append(t)

    S.generiche_norm = {normalizza(g) for g in imp.generiche}
    S.col_utili = col[~col["norm"].isin(S.generiche_norm)]
    S.tipi = {(r.tabella, r.colonna): r.tipo for r in col.itertuples()}
    S.sinonimi = mappa_sinonimi(imp.sinonimi)
    S.per_entita = {}                     # chiave dell'entità -> tabelle
    for t in S.col_per_tab:
        for k in chiavi_entita(t, S.sinonimi):
            S.per_entita.setdefault(k, []).append(t)
    return S


def tabelle_per_nome(S, nome):
    """Tabelle il cui nome indica la stessa entità di 'nome' (plurali, accenti, sinonimi)."""
    return sorted({d for k in chiavi_entita(nome, S.sinonimi) for d in S.per_entita.get(k, [])})


# ====================================================================== stesso nome e nomi simili

def trova_stesso_nome(S):
    """Colonne (non generiche) che compaiono con lo stesso nome in più tabelle."""
    stesso_nome = (
        S.col_utili.groupby("norm")
            .agg(colonna=("colonna", "first"),
                 n_tabelle=("tabella", "nunique"),
                 tabelle=("tabella", lambda x: ", ".join(sorted(set(x)))),
                 tipi=("tipo", lambda x: ", ".join(sorted(set(map(str, x))))))
            .query("n_tabelle > 1")
            .reset_index()
    )
    n_tipi = S.col_utili.groupby("norm")["tipo_base"].nunique()
    stesso_nome["tipi coerenti"] = stesso_nome["norm"].map(n_tipi) == 1
    stesso_nome["è PK in"] = stesso_nome["norm"].map(lambda n: ", ".join(S.pk_di.get(n, [])) or "-")
    stesso_nome["parte di PK composta in"] = stesso_nome["norm"].map(
        lambda n: ", ".join(S.parte_pk_di.get(n, [])) or "-")
    return (stesso_nome.drop(columns="norm")
                       .sort_values("n_tabelle", ascending=False)
                       .reset_index(drop=True))


COLONNE_SIMILI = ["tabella 1", "colonna 1", "tipo 1", "tabella 2", "colonna 2", "tipo 2",
                  "somiglianza", "stesso tipo"]


def trova_nomi_simili(S, imp=None):
    """Coppie di colonne in tabelle diverse con nomi simili ma non uguali."""
    soglia = (imp or Impostazioni()).soglia_simili
    gruppi = S.col_utili.groupby("norm")
    uniche = list(gruppi.groups)
    simili = []

    for a, b in combinations(uniche, 2):
        if abs(len(a) - len(b)) > 4:
            continue
        contiene = (a in b or b in a) and min(len(a), len(b)) >= 4
        sm = SequenceMatcher(None, a, b)
        if not contiene and (sm.real_quick_ratio() < soglia or sm.quick_ratio() < soglia):
            continue                       # scarto veloce
        score = sm.ratio()
        if score < soglia and not contiene:
            continue
        for ra in gruppi.get_group(a).itertuples():
            for rb in gruppi.get_group(b).itertuples():
                if ra.tabella != rb.tabella:
                    simili.append({
                        "tabella 1": ra.tabella, "colonna 1": ra.colonna, "tipo 1": ra.tipo,
                        "tabella 2": rb.tabella, "colonna 2": rb.colonna, "tipo 2": rb.tipo,
                        "somiglianza": round(score, 2),
                        "stesso tipo": ra.tipo_base == rb.tipo_base,
                    })

    df_simili = pd.DataFrame(simili, columns=COLONNE_SIMILI)
    return (df_simili.sort_values(["stesso tipo", "somiglianza"], ascending=False)
                     .reset_index(drop=True))


# ====================================================================== chiavi esterne candidate

COLONNE_FK = ["tabella", "colonna", "tipo", "→ tabella", "→ colonna", "tipo dest",
              "affidabilità", "tipi ok", "relazione", "obbligatoria", "già dichiarata", "sql"]


def tipo_relazione(S, tabella, colonne):
    """("1:1" o "1:N", obbligatoria) per una chiave esterna fatta dalle colonne indicate.

    1:1 se la chiave esterna è anche UNIQUE o coincide con la chiave primaria della tabella;
    obbligatoria se tutte le sue colonne sono NOT NULL.
    """
    norm = sorted(normalizza(c) for c in colonne)
    uno = ((len(colonne) == 1 and (tabella, colonne[0]) in S.unique)
           or norm == sorted(normalizza(c) for c in S.pk.get(tabella, [])))
    return ("1:1" if uno else "1:N"), all((tabella, c) in S.not_null for c in colonne)


def trova_fk(S):
    """Chiavi esterne candidate e colonne che sembrano chiavi senza tabella corrispondente."""
    cand = {}

    # Regola C: la tabella contiene tutte le colonne di una chiave primaria composta
    composte = {}
    for dest, colonne_pk in S.pk_composta.items():
        norm_pk = [normalizza(c) for c in colonne_pk]
        if all(n in S.generiche_norm for n in norm_pk):
            continue
        for t, nomi in S.colonne_norm.items():
            if t != dest and all(n in nomi for n in norm_pk):
                composte[(t, dest)] = ([nomi[n] for n in norm_pk], colonne_pk)

    for r in S.col.itertuples():
        t, c = r.tabella, r.colonna
        if S.pk.get(t) == [c]:
            continue                                   # è la PK della sua tabella

        # Regola A: stesso nome della PK di un'altra tabella
        if r.norm != "id":
            for dest in S.pk_di.get(r.norm, []):
                if dest != t:
                    cand[(t, c, dest)] = ("alta", S.pk_singola[dest])

        # Regola B: il nome della colonna rimanda a una tabella
        rif = riferimento(c)
        if rif:
            for dest in tabelle_per_nome(S, rif):
                if dest != t and (t, c, dest) not in cand and (t, dest) not in composte:
                    cand[(t, c, dest)] = ("media", S.pk_singola.get(dest, "?"))

    imp = getattr(S, "imp", None) or Impostazioni()

    def riga_fk(t, col_o, dest, col_d, conf, tipi_ok):
        relazione, obbligatoria = tipo_relazione(S, t, col_o)
        regole, nota = clausola_regole(imp, any((t, c) in S.not_null for c in col_o))
        return {
            "tabella": t, "colonna": ", ".join(col_o),
            "tipo": ", ".join(str(S.tipi.get((t, c)) or "") for c in col_o),
            "→ tabella": dest, "→ colonna": ", ".join(col_d),
            "tipo dest": ", ".join(str(S.tipi.get((dest, c)) or "") for c in col_d),
            "affidabilità": conf, "tipi ok": tipi_ok,
            "relazione": relazione, "obbligatoria": obbligatoria,
            "sql": (f"ALTER TABLE {t} ADD CONSTRAINT {nome_vincolo(t, '_'.join(col_o), dest)} "
                    f"FOREIGN KEY ({', '.join(col_o)}) REFERENCES {dest} ({', '.join(col_d)}){regole};"
                    + (f"   -- {nota}" if nota else "")),
        }

    righe_fk = []
    for (t, c, dest), (conf, col_dest) in cand.items():
        tipo_o, tipo_d = S.tipi.get((t, c)), S.tipi.get((dest, col_dest))
        righe_fk.append(riga_fk(t, [c], dest, [col_dest], conf,
                                col_dest != "?" and tipo_base(tipo_o) == tipo_base(tipo_d)))

    for (t, dest), (col_o, col_d) in composte.items():
        righe_fk.append(riga_fk(t, col_o, dest, col_d, "alta",
                                all(tipo_base(S.tipi.get((t, a))) == tipo_base(S.tipi.get((dest, b)))
                                    for a, b in zip(col_o, col_d))))

    for r in righe_fk:
        chiave = tuple(normalizza(c) for c in r["colonna"].split(","))
        r["già dichiarata"] = (r["tabella"], chiave, r["→ tabella"]) in S.fk_dichiarate
    df_fk = pd.DataFrame(righe_fk, columns=COLONNE_FK)
    df_fk = df_fk.sort_values(["affidabilità", "tabella", "colonna"]).reset_index(drop=True)

    # Colonne con nome "da chiave" che non trovano nessuna tabella: da guardare a mano
    gia_trovate = {(t, c.strip()) for t, cs in zip(df_fk["tabella"], df_fk["colonna"]) for c in cs.split(",")}
    sospette = S.col[
        S.col["colonna"].map(lambda x: riferimento(x) is not None)
        & ~S.col.apply(lambda r: (r.tabella, r.colonna) in gia_trovate, axis=1)
        & ~S.col.apply(lambda r: S.pk.get(r.tabella) == [r.colonna], axis=1)
    ][["tabella", "colonna", "tipo"]].reset_index(drop=True)
    return df_fk, sospette


# ====================================================================== PK composte colonna per colonna

COLONNE_PK_COMPOSTE = ["tabella", "chiave primaria", "colonna", "tipo", "→ tabella", "→ colonna",
                       "tipo dest", "→ colonna è PK", "tipi ok", "affidabilità", "come"]


def collegamenti_pk_composte(S):
    """Per ogni tabella con PK composta: a cosa si collega ogni colonna della chiave."""
    righe = []
    for t, colonne_pk in sorted(S.pk_composta.items()):
        for c in colonne_pk:
            n = normalizza(c)
            generica = n in S.generiche_norm
            trovati = []                    # (tabella, colonna, è PK, affidabilità, come)

            # 1) una tabella con il nome del campo: codice -> codici, id_cliente -> clienti
            per_nome = set(tabelle_per_nome(S, c))
            if riferimento(c):
                per_nome |= set(tabelle_per_nome(S, riferimento(c)))
            per_nome = sorted(per_nome - {t})
            for d in per_nome:
                if n in S.colonne_norm[d]:
                    cd = S.colonne_norm[d][n]
                    e_pk = cd in S.pk.get(d, [])
                    trovati.append((d, cd, e_pk, "alta" if e_pk else "media",
                                    "tabella con il nome del campo; campo presente"
                                    + (" ed è chiave primaria" if e_pk else ", ma non è chiave primaria")))
                elif d in S.pk_singola:
                    trovati.append((d, S.pk_singola[d], True, "media",
                                    "tabella con il nome del campo; campo assente, collegato alla sua chiave primaria"))
                else:
                    trovati.append((d, "?", False, "bassa",
                                    "tabella con il nome del campo, ma senza campo né chiave primaria corrispondente"))

            # 2) tabelle in cui il campo è chiave primaria
            if not trovati and not generica:
                for d in S.pk_di.get(n, []):
                    if d != t:
                        trovati.append((d, S.pk_singola[d], True, "alta",
                                        "il campo è la chiave primaria di un'altra tabella"))
                for d in S.parte_pk_di.get(n, []):
                    if d != t:
                        trovati.append((d, S.colonne_norm[d].get(n, c), True, "media",
                                        "il campo fa parte della chiave primaria composta di un'altra tabella"))

            # 3) tabelle che hanno solo lo stesso campo
            if not trovati and not generica:
                for d, nomi in sorted(S.colonne_norm.items()):
                    if d != t and n in nomi:
                        trovati.append((d, nomi[n], False, "bassa",
                                        "stesso campo in un'altra tabella, non chiave primaria"))

            if not trovati:
                trovati.append(("-", "-", False, "-",
                                "colonna generica: il nome da solo non basta" if generica
                                else "nessuna tabella corrispondente"))

            for d, cd, e_pk, aff, come in trovati:
                tipo_o, tipo_d = S.tipi.get((t, c)), S.tipi.get((d, cd))
                righe.append({
                    "tabella": t, "chiave primaria": ", ".join(colonne_pk), "colonna": c, "tipo": tipo_o,
                    "→ tabella": d, "→ colonna": cd, "tipo dest": tipo_d,
                    "→ colonna è PK": "sì" if e_pk else "no",
                    "tipi ok": d != "-" and cd != "?" and tipo_base(tipo_o) == tipo_base(tipo_d),
                    "affidabilità": aff, "come": come,
                })
    return pd.DataFrame(righe, columns=COLONNE_PK_COMPOSTE)


def descrivi_pk_composte(df, tabella=None):
    """Testo leggibile, una tabella alla volta."""
    righe = []
    for t, g in df.groupby("tabella", sort=True):
        if tabella and t != tabella:
            continue
        righe.append(f"{t}   (chiave primaria: {g['chiave primaria'].iat[0]})")
        for r in g.to_dict("records"):
            if r["→ tabella"] == "-":
                righe.append(f"  {r['colonna']}: nessun collegamento")
            else:
                avviso = "  ATTENZIONE: tipi diversi" if not r["tipi ok"] else ""
                righe.append(f"  {r['colonna']} -> {r['→ tabella']}.{r['→ colonna']}  "
                             f"[{r['affidabilità']}]{avviso}")
            righe.append(f"      {r['come']}")
        righe.append("")
    return "\n".join(righe)


# ====================================================================== controlli di progettazione

# Colonne tecniche da non considerare ridondanti (date e utenti di modifica, flag...)
TECNICHE = {"createdat", "updatedat", "deletedat", "datains", "datamod", "utenteins", "utentemod",
            "attivo", "flag", "note", "id", "timestamp", "versione"}
# Nomi che indicano un campo composto (non atomico, contro la prima forma normale)
NOMI_COMPOSTI = {"generalita", "generalità", "nominativo", "nomecognome", "cognomenome", "residenza",
                 "indirizzocompleto", "recapiti", "recapito", "domicilio"}
TIPI_NON_ATOMICI = {"SET", "JSON", "JSONB", "ARRAY"}


def fk_accettate(S, df_fk, fk_dichiarate):
    """Collegamenti considerati veri per i controlli: le chiavi esterne già dichiarate e, per ogni
    colonna, la candidata migliore ad affidabilità alta con tipi compatibili.
    Lista di (tabella, [colonne], tabella puntata)."""
    archi, viste = [], set()
    for r in fk_dichiarate.to_dict("records"):
        if r["tabella"] in S.col_per_tab and r["→ tabella"] in S.col_per_tab:
            archi.append((r["tabella"], [c.strip() for c in r["colonna"].split(",")], r["→ tabella"]))
            viste.add((r["tabella"], r["colonna"]))
    buone = df_fk[(df_fk["affidabilità"] == "alta") & df_fk["tipi ok"] & ~df_fk["già dichiarata"]]
    for r in buone.sort_values(["tabella", "colonna", "→ tabella"]).to_dict("records"):
        if (r["tabella"], r["colonna"]) not in viste:
            viste.add((r["tabella"], r["colonna"]))
            archi.append((r["tabella"], [c.strip() for c in r["colonna"].split(",")], r["→ tabella"]))
    return archi


def controlli_progettazione(S, df_fk, fk_dichiarate=None):
    """Controlli di buona progettazione ricavabili dalla sola struttura (senza i dati).

    Sono avvisi da verificare: integrità dell'entità, tabelle ponte N:M, normalizzazione (1NF, 2NF, 3NF)
    e relazioni ridondanti.
    """
    if fk_dichiarate is None:
        fk_dichiarate = pd.DataFrame(columns=COLONNE_FK_DICHIARATE)
    archi = fk_accettate(S, df_fk, fk_dichiarate)
    Q = SimpleNamespace()

    # ---- integrità dell'entità: ogni tabella deve avere una chiave primaria
    Q.senza_pk = pd.DataFrame([
        {"tabella": t,
         "chiave indovinata": ", ".join(S.pk[t]) if t in S.pk_indovinata else "-",
         "suggerimento": (f"dichiarare PRIMARY KEY ({', '.join(S.pk[t])})" if t in S.pk_indovinata
                          else f"aggiungere una chiave artificiale, per esempio id_{t} INT AUTO_INCREMENT PRIMARY KEY")}
        for t in sorted(S.col_per_tab) if not S.pk.get(t) or t in S.pk_indovinata
    ], columns=["tabella", "chiave indovinata", "suggerimento"])

    # ---- tabelle ponte: chiave primaria composta da chiavi esterne verso tabelle diverse -> relazione N:M
    verso = {}                                    # (tabella, colonna) -> tabella puntata
    for t, colonne, dest in archi:
        if len(colonne) == 1:
            verso.setdefault((t, colonne[0]), dest)
    ponti = []
    for t, chiave in sorted(S.pk_composta.items()):
        collegate = [(c, verso[(t, c)]) for c in chiave if (t, c) in verso]
        destinazioni = sorted({d for _, d in collegate})
        if len(destinazioni) >= 2:
            attributi = [c for c in S.col_per_tab[t] if c not in chiave]
            ponti.append({"tabella ponte": t, "collega": " N:M ".join(destinazioni),
                          "tramite": ", ".join(f"{c} → {d}" for c, d in collegate),
                          "attributi della relazione": ", ".join(attributi) or "-"})
    Q.ponti = pd.DataFrame(ponti, columns=["tabella ponte", "collega", "tramite", "attributi della relazione"])

    # ---- normalizzazione
    problemi = []
    for t, colonne_t in sorted(S.col_per_tab.items()):
        chiave = S.pk.get(t, [])
        # 1NF: campi composti, tipi multivalore, gruppi ripetuti (telefono1, telefono2...)
        gruppi = {}
        for c in colonne_t:
            n = normalizza(c)
            if n in NOMI_COMPOSTI or re.search(r"(nome.*cognome|cognome.*nome|indirizzo.*completo)", n):
                problemi.append({"tabella": t, "colonna": c, "forma normale": "1NF",
                                 "problema": "campo composto: probabilmente contiene più informazioni",
                                 "suggerimento": "dividerlo in campi atomici (per esempio cognome e nome; via, CAP, città)"})
            elif tipo_base(S.tipi.get((t, c))) in TIPI_NON_ATOMICI:
                problemi.append({"tabella": t, "colonna": c, "forma normale": "1NF",
                                 "problema": f"tipo {tipo_base(S.tipi.get((t, c)))}: contiene più valori",
                                 "suggerimento": "spostare i valori in una tabella collegata, una riga per valore"})
            m = re.fullmatch(r"(.*?[a-z])_?(\d+)", c.lower())
            if m and len(m.group(1)) >= 3:
                gruppi.setdefault(m.group(1), []).append(c)
        for radice_gruppo, membri in gruppi.items():
            if len(membri) >= 2:
                problemi.append({"tabella": t, "colonna": ", ".join(membri), "forma normale": "1NF",
                                 "problema": "gruppo ripetuto: lo stesso dato in più colonne numerate",
                                 "suggerimento": f"creare una tabella {t}_{radice_gruppo} con una riga per valore"})

    # 2NF e 3NF: una colonna non chiave che si trova già, non chiave, nella tabella collegata
    # (le colonne che sono a loro volta chiavi esterne si guardano tra le relazioni ridondanti)
    colonne_fk_di = {}
    for t, colonne, _ in archi:
        colonne_fk_di.setdefault(t, set()).update(normalizza(c) for c in colonne)
    gia = set()
    for t, colonne, dest in archi:
        if dest == t:
            continue
        chiave_t = {normalizza(c) for c in S.pk.get(t, [])}
        chiave_d = {normalizza(c) for c in S.pk.get(dest, [])}
        colonne_fk = {normalizza(c) for c in colonne}
        for n, c in S.colonne_norm[t].items():
            if (n in chiave_t or n in colonne_fk_di.get(t, set()) or n in TECNICHE or n in S.generiche_norm
                    or n not in S.colonne_norm[dest] or n in chiave_d or (t, n) in gia):
                continue
            gia.add((t, n))
            parziale = len(chiave_t) > 1 and colonne_fk < chiave_t
            if parziale:
                problemi.append({"tabella": t, "colonna": c, "forma normale": "2NF",
                                 "problema": (f"dipende solo da {', '.join(colonne)} (una parte della chiave "
                                              f"primaria): è già in {dest}"),
                                 "suggerimento": f"toglierla da {t}: si ricava da {dest} con un join"})
            else:
                problemi.append({"tabella": t, "colonna": c, "forma normale": "3NF",
                                 "problema": (f"dipendenza transitiva: {t} → {', '.join(colonne)} → {dest}.{S.colonne_norm[dest][n]}"),
                                 "suggerimento": f"toglierla da {t}: si ricava da {dest} con un join"})
    Q.normalizzazione = pd.DataFrame(problemi, columns=["tabella", "colonna", "forma normale", "problema", "suggerimento"])

    # ---- relazioni ridondanti: un collegamento diretto che ripete un percorso già esistente
    uscite = {}
    for t, colonne, dest in archi:
        if dest != t:
            uscite.setdefault(t, []).append((dest, colonne))
    ridondanti = []
    for t, colonne, dest in archi:
        if dest == t:
            continue
        # cerca un percorso t -> ... -> dest di 2 o 3 passi senza usare questo collegamento
        percorsi = [[t]]
        trovato = None
        for _ in range(3):
            nuovi = []
            for p in percorsi:
                for d, cols in uscite.get(p[-1], []):
                    if d in p or (p[-1] == t and d == dest):
                        continue
                    if d == dest and len(p) >= 2:
                        trovato = p + [d]
                        break
                    nuovi.append(p + [d])
                if trovato:
                    break
            if trovato:
                break
            percorsi = nuovi
        if trovato:
            ridondanti.append({"tabella": t, "colonna": ", ".join(colonne), "→ tabella": dest,
                               "percorso già esistente": " → ".join(trovato),
                               "suggerimento": f"probabilmente ridondante: {dest} si raggiunge già da {trovato[1]}"})
    Q.ridondanti = pd.DataFrame(ridondanti, columns=["tabella", "colonna", "→ tabella", "percorso già esistente", "suggerimento"])

    # ---- riepilogo
    relazioni = df_fk[(df_fk["affidabilità"] == "alta") & df_fk["tipi ok"]]
    Q.riepilogo = pd.DataFrame([
        ("Tabelle senza chiave primaria dichiarata", len(Q.senza_pk)),
        ("Collegamenti 1:1 (alta affidabilità)", int((relazioni["relazione"] == "1:1").sum())),
        ("Collegamenti 1:N (alta affidabilità)", int((relazioni["relazione"] == "1:N").sum())),
        ("Relazioni N:M (tabelle ponte)", len(Q.ponti)),
        ("Avvisi 1NF", int((Q.normalizzazione["forma normale"] == "1NF").sum())),
        ("Avvisi 2NF", int((Q.normalizzazione["forma normale"] == "2NF").sum())),
        ("Avvisi 3NF", int((Q.normalizzazione["forma normale"] == "3NF").sum())),
        ("Relazioni probabilmente ridondanti", len(Q.ridondanti)),
    ], columns=["voce", "valore"])
    return Q


# ====================================================================== diagnostica (stile compilatore)

# codice -> (gravità, regola)
CODICI = {
    "E001": ("errore", "lettura"), "E002": ("errore", "lettura"), "E003": ("errore", "lettura"),
    "E010": ("errore", "integrità dell'entità"), "E011": ("errore", "integrità dell'entità"),
    "E020": ("errore", "integrità referenziale"), "E021": ("errore", "integrità referenziale"),
    "E022": ("errore", "integrità referenziale"), "E023": ("errore", "integrità referenziale"),
    "E024": ("errore", "integrità referenziale"), "E025": ("errore", "integrità referenziale"),
    "W026": ("avviso", "integrità referenziale"), "W027": ("avviso", "integrità referenziale"),
    "W030": ("avviso", "chiave esterna mancante"), "W031": ("avviso", "chiave esterna mancante"),
    "I032": ("info", "chiave esterna mancante"), "W033": ("avviso", "chiave esterna mancante"),
    "W034": ("avviso", "relazioni ridondanti"),
    "I035": ("info", "relazioni"), "I036": ("info", "relazioni"), "I038": ("info", "relazioni"),
    "W101": ("avviso", "prima forma normale"), "W102": ("avviso", "prima forma normale"),
    "W103": ("avviso", "prima forma normale"),
    "W201": ("avviso", "seconda forma normale"), "W301": ("avviso", "terza forma normale"),
}
FAMIGLIE_TIPI = {"intero": {"SMALLINT", "INT", "BIGINT", "TINYINT"}, "testo": {"CHAR", "VARCHAR", "TEXT"},
                 "decimale": {"DECIMAL", "FLOAT", "DOUBLE"}}
COLONNE_DIAGNOSTICA = ["gravità", "codice", "file", "riga", "tabella", "colonna", "messaggio", "suggerimento", "regola"]
ORDINE_GRAVITA = {"errore": 0, "avviso": 1, "info": 2}


def diagnostica(R, errori_lettura=(), originali=None, dialetto="mysql"):
    """Tutti i problemi dello schema come un compilatore: gravità, codice, file, riga, messaggio, suggerimento."""
    S = R.S
    pos_colonna, pos_tabella = {}, {}
    for r in S.df_schema.to_dict("records"):
        pos_colonna[(r["tabella"], r["colonna"])] = (r["file"], r.get("riga"))
        pos_tabella.setdefault(r["tabella"], (r["file"], r.get("riga tabella")))
    risultati = []

    def segnala(codice, tabella, colonna, messaggio, suggerimento="", posizione=None):
        gravita = CODICI[codice][0]
        regola = f"{REGOLA_DI[codice]['id']} {REGOLA_DI[codice]['titolo']}" if codice in REGOLA_DI else CODICI[codice][1]
        prima = (colonna or "").split(",")[0].strip()
        file, riga = posizione or pos_colonna.get((tabella, prima)) or pos_tabella.get(tabella, ("", None))
        risultati.append({"gravità": gravita, "codice": codice, "file": file, "riga": riga,
                          "tabella": tabella, "colonna": colonna or "", "messaggio": messaggio,
                          "suggerimento": suggerimento, "regola": regola})

    # ---- lettura dei file
    for e in errori_lettura:
        segnala(e.get("codice", "E001"), e.get("tabella", ""), "", e["problema"],
                "correggere il file .sql", (e["file"], e.get("riga")))

    # ---- integrità dell'entità
    for t in sorted(S.col_per_tab):
        if not S.pk.get(t):
            segnala("E010", t, "", f"la tabella {t} non ha una chiave primaria",
                    f"aggiungere una chiave artificiale: id_{t} INT NOT NULL AUTO_INCREMENT PRIMARY KEY")
        elif t in S.pk_indovinata:
            segnala("E010", t, S.pk[t][0], f"la tabella {t} non dichiara la chiave primaria",
                    f"dichiarare PRIMARY KEY ({S.pk[t][0]}), che sembra la chiave")
        else:
            for c in S.pk[t]:
                if c not in S.col_per_tab[t]:
                    segnala("E011", t, "", f"la chiave primaria di {t} usa la colonna {c}, che non esiste",
                            "correggere il nome della colonna nella PRIMARY KEY")

    # ---- chiavi esterne già dichiarate
    bloccate = {}
    if dialetto == "mysql" and originali:
        for t, (_, coda) in originali.items():
            if re.search(r"\bPARTITION\s+BY\b", coda, re.I):
                bloccate[t] = ("E025", f"MySQL non accetta chiavi esterne con la tabella partizionata {t}",
                               "togliere il partizionamento oppure rinunciare alla chiave esterna")
            elif re.search(r"\bENGINE\s*=\s*MyISAM\b", coda, re.I):
                bloccate[t] = ("W026", f"la tabella {t} è MyISAM: MySQL ignora le sue chiavi esterne",
                               f"convertirla: ALTER TABLE {t} ENGINE=InnoDB")
    for r in R.fk_dichiarate.to_dict("records"):
        t, dest = r["tabella"], r["→ tabella"]
        colonne = [c.strip() for c in r["colonna"].split(",")]
        colonne_dest = [c.strip() for c in r["→ colonna"].split(",")]
        posizione = (r.get("file"), r.get("riga")) if r.get("file") else None
        testo = f"{t}({r['colonna']}) → {dest}({r['→ colonna']})"
        if t not in S.col_per_tab:
            continue
        if dest not in S.col_per_tab:
            if dest not in R.rimosse:
                segnala("E020", t, r["colonna"], f"la chiave esterna {testo} punta a una tabella che non esiste",
                        f"creare la tabella {dest} o correggere il nome", posizione)
            continue
        mancanti = [c for c in colonne if normalizza(c) not in S.colonne_norm[t]]
        if mancanti:
            segnala("E021", t, r["colonna"], f"la chiave esterna {testo} usa colonne che non esistono in {t}: {', '.join(mancanti)}",
                    "correggere il nome della colonna", posizione)
            continue
        mancanti = [c for c in colonne_dest if normalizza(c) not in S.colonne_norm[dest]]
        if mancanti:
            segnala("E022", t, r["colonna"], f"la chiave esterna {testo} punta a colonne che non esistono in {dest}: {', '.join(mancanti)}",
                    "correggere il nome della colonna puntata", posizione)
            continue
        vere_dest = [S.colonne_norm[dest][normalizza(c)] for c in colonne_dest]
        chiave_dest = sorted(normalizza(c) for c in S.pk.get(dest, []))
        if sorted(normalizza(c) for c in vere_dest) != chiave_dest and not (
                len(vere_dest) == 1 and (dest, vere_dest[0]) in S.unique):
            segnala("E023", t, r["colonna"], f"la chiave esterna {testo} non punta alla chiave primaria (né a una colonna UNIQUE) di {dest}",
                    f"farla puntare a {dest}({', '.join(S.pk.get(dest, [])) or '?'})", posizione)
        vere = [S.colonne_norm[t][normalizza(c)] for c in colonne]
        coppie = [(tipo_base(S.tipi.get((t, a))), tipo_base(S.tipi.get((dest, b)))) for a, b in zip(vere, vere_dest)]
        if any(x != y for x, y in coppie):
            tipi = ", ".join(f"{S.tipi.get((t, a))} / {S.tipi.get((dest, b))}" for a, b in zip(vere, vere_dest))
            # PostgreSQL e altri accettano tipi della stessa famiglia (INT/BIGINT, VARCHAR/TEXT); MySQL no
            famiglia = lambda x: next((k for k, v in FAMIGLIE_TIPI.items() if x in v), x)
            if dialetto != "mysql" and all(famiglia(x) == famiglia(y) for x, y in coppie):
                segnala("W027", t, r["colonna"], f"la chiave esterna {testo} collega tipi diversi ma compatibili ({tipi})",
                        "funziona, ma conviene usare lo stesso tipo nelle due colonne", posizione)
            else:
                segnala("E024", t, r["colonna"], f"la chiave esterna {testo} collega tipi diversi ({tipi})",
                        "usare lo stesso tipo nelle due colonne", posizione)
        for tab in (t, dest):
            if tab in bloccate:
                codice, messaggio, suggerimento = bloccate[tab]
                segnala(codice, t, r["colonna"], f"chiave esterna {testo}: {messaggio}", suggerimento, posizione)
                break

    # ---- chiavi esterne mancanti (candidate)
    ridondanti = {(r["tabella"], r["colonna"], r["→ tabella"]): r for r in R.qualita.ridondanti.to_dict("records")}
    candidate = R.fk[~R.fk["già dichiarata"]].to_dict("records")
    candidate.sort(key=lambda r: (r["tabella"], r["colonna"], r["affidabilità"] != "alta", not r["tipi ok"], r["→ tabella"]))
    scelta = set()
    for r in candidate:
        t, c, dest = r["tabella"], r["colonna"], r["→ tabella"]
        testo = f"{t}.{c} → {dest}({r['→ colonna']})"
        if (t, c, dest) in ridondanti:
            segnala("W034", t, c, f"il collegamento {testo} è probabilmente ridondante: c'è già {ridondanti[(t, c, dest)]['percorso già esistente']}",
                    "non aggiungere questa chiave esterna (o togliere la colonna)")
        elif r["affidabilità"] == "alta" and not r["tipi ok"]:
            segnala("W031", t, c, f"{testo} sembra una chiave esterna ma i tipi sono diversi ({r['tipo']} / {r['tipo dest']})",
                    "allineare i tipi, poi aggiungere la chiave esterna")
        elif r["affidabilità"] == "alta" and r["→ colonna"] != "?" and (t, c) not in scelta:
            scelta.add((t, c))
            blocco = bloccate.get(t) or bloccate.get(dest)
            segnala("W030", t, c, f"manca la chiave esterna {testo} (relazione {r['relazione']})"
                    + (f"; attenzione: {blocco[1]}" if blocco else ""),
                    r["sql"].split("   --")[0])
            if not r["obbligatoria"]:
                segnala("I038", t, c, f"la relazione {testo} è facoltativa: {c} può essere NULL",
                        f"se ogni riga di {t} deve avere un {dest}, dichiarare {c} NOT NULL")
        elif r["affidabilità"] == "media":
            segnala("I032", t, c, f"possibile chiave esterna {testo} (affidabilità media)",
                    "verificare sui dati prima di aggiungerla")
    for r in R.sospette.to_dict("records"):
        segnala("W033", r["tabella"], r["colonna"], f"{r['tabella']}.{r['colonna']} sembra una chiave esterna ma non c'è una tabella a cui collegarla",
                "controllare se la tabella manca dai file o ha un nome diverso")

    # ---- relazioni N:M e tabelle isolate
    for r in R.qualita.ponti.to_dict("records"):
        segnala("I036", r["tabella ponte"], "", f"{r['tabella ponte']} è una tabella ponte: relazione {r['collega']}",
                "nessuna azione: è il modo corretto di rappresentare una relazione N:M")
    for t in R.isolate:
        segnala("I035", t, "", f"la tabella {t} non è collegata a nessun'altra",
                "verificare se è davvero indipendente (configurazioni, log) o se manca un collegamento")

    # ---- normalizzazione
    for r in R.qualita.normalizzazione.to_dict("records"):
        if r["forma normale"] == "1NF":
            codice = ("W102" if r["problema"].startswith("gruppo") else
                      "W103" if r["problema"].startswith("tipo") else "W101")
        else:
            codice = "W201" if r["forma normale"] == "2NF" else "W301"
        segnala(codice, r["tabella"], r["colonna"], f"{r['tabella']}.{r['colonna']}: {r['problema']}", r["suggerimento"])

    df = pd.DataFrame(risultati, columns=COLONNE_DIAGNOSTICA)
    df["riga"] = df["riga"].astype("Int64")
    df["_g"] = df["gravità"].map(ORDINE_GRAVITA)
    return (df.sort_values(["file", "riga", "_g", "codice"], na_position="first")
              .drop(columns="_g").reset_index(drop=True))


def conteggi_diagnostica(df):
    return {g: int((df["gravità"] == g).sum()) for g in ORDINE_GRAVITA}


def riassunto_diagnostica(df):
    n = conteggi_diagnostica(df)
    parola = lambda k, uno, molti: f"{n[k]} {uno if n[k] == 1 else molti}"
    return ", ".join([parola("errore", "errore", "errori"), parola("avviso", "avviso", "avvisi"), f"{n['info']} info"])


def testo_diagnostica(df, con_info=True, con_regole=False):
    """Report come l'output di un compilatore: file:riga: gravità codice: messaggio."""
    righe = []
    for r in df.to_dict("records"):
        if not con_info and r["gravità"] == "info":
            continue
        dove = f"{r['file']}:{r['riga']}" if r["file"] and not pd.isna(r["riga"]) else (r["file"] or "schema")
        righe.append(f"{dove}: {r['gravità']} {r['codice']}: {r['messaggio']}")
        if r["suggerimento"]:
            righe.append(f"    suggerimento: {r['suggerimento']}")
        if con_regole and r["regola"]:
            righe.append(f"    regola: {r['regola']}")
    n = conteggi_diagnostica(df)
    righe.append("")
    righe.append(riassunto_diagnostica(df))
    return "\n".join(righe) + "\n"


# ====================================================================== tabelle isolate e analisi completa

# ====================================================================== aree, sottogruppi e categorie

PAROLE_STORICO = {"log", "logs", "storico", "storici", "history", "hist", "audit", "archivio", "archive",
                  "tracking", "eventi", "events", "versioni", "versions", "revisioni", "revisions"}
PAROLE_DETTAGLIO = {"righe", "riga", "dettaglio", "dettagli", "det", "details", "detail", "items", "item",
                    "lines", "line", "voci", "voce", "rows", "row", "positions"}
TIPI_DATA = {"DATE", "DATETIME", "TIMESTAMP", "TIMESTAMPTZ", "TIME", "SMALLDATETIME", "DATETIME2"}
CATEGORIE = {
    "codifica": "tabella di codifica (lookup): pochi campi, viene solo puntata dalle altre",
    "anagrafica": "entità principale: viene puntata dalle altre tabelle",
    "movimento": "fatto o evento con data, punta alle anagrafiche",
    "dettaglio": "righe che dipendono da un'altra tabella (la sua chiave contiene la chiave del padre)",
    "ponte": "tabella ponte di una relazione N:M",
    "storico": "storico, log o archivio",
    "dipendente": "punta ad altre tabelle ma nessuna punta a lei",
    "isolata": "nessun collegamento con altre tabelle",
}


def aree_e_categorie(R, gruppo_di):
    """Due livelli di raggruppamento e il ruolo di ogni tabella.

    - sottogruppi: i gruppi per somiglianza dei nomi (raggruppa_tabelle);
    - aree: sottogruppi molto collegati tra loro dalle chiavi esterne (dichiarate e trovate ad alta
      affidabilità), trovati con la modularità (rilevamento di comunità). Le tabelle puntate da moltissime
      altre (centrali, per esempio una tabella collection) collegherebbero tutto in un unico blocco:
      i loro collegamenti contano poco nella divisione, e la tabella va nell'area a cui è più legata;
    - collegamenti tra sottogruppi e tra aree, con il numero di chiavi esterne e il tipo di relazione;
    - categoria di ogni tabella (codifica, anagrafica, movimento, dettaglio, ponte, storico, dipendente, isolata).
    """
    import networkx as nx

    S = R.S
    tabelle = sorted(S.col_per_tab)
    gruppo = {t: gruppo_di.get(t, t) for t in tabelle}
    archi = [(t, c, d) for t, c, d in fk_accettate(S, R.fk, R.fk_dichiarate) if t != d]
    ponti = {r["tabella ponte"]: r for r in R.qualita.ponti.to_dict("records")}

    uscenti, entranti = Counter(), Counter()
    puntata_da = {}
    for t, _, d in archi:
        uscenti[t] += 1
        entranti[d] += 1
        puntata_da.setdefault(d, set()).add(t)

    # tabelle centrali: puntate da molte tabelle di sottogruppi diversi
    collegate = {t for t, _, d in archi} | {d for _, _, d in archi}
    minimo = max(4, round(0.1 * len(collegate)))
    centrali = {d for d, da in puntata_da.items()
                if len(da) >= minimo and len({gruppo[t] for t in da} - {gruppo[d]}) >= 3}

    # ---- aree: comunità nel grafo dei sottogruppi
    gruppi = sorted(set(gruppo.values()))
    G = nx.Graph()
    G.add_nodes_from(gruppi)
    for t, _, d in archi:
        a, b = gruppo[t], gruppo[d]
        if a == b:
            continue
        peso = 0.1 if (t in centrali or d in centrali) else 1.0
        G.add_edge(a, b, weight=G[a][b]["weight"] + peso if G.has_edge(a, b) else peso)
    con_link = [g for g in gruppi if G.degree(g) > 0]
    comunita = list(nx.community.greedy_modularity_communities(G.subgraph(con_link), weight="weight")) if con_link else []
    area_di = {}
    gruppi_centrali = {gruppo[t] for t in centrali}
    n_fk = Counter()                       # chiavi esterne che toccano ogni sottogruppo: dà il nome all'area
    for t, _, d in archi:
        n_fk[gruppo[t]] += 1
        n_fk[gruppo[d]] += 1
    for membri in comunita:
        # il nome viene dal sottogruppo più collegato, ma non da uno di tabelle centrali (sono di tutti)
        capo = max(membri, key=lambda g: (g not in gruppi_centrali, n_fk[g], sum(gruppo[t] == g for t in tabelle), g))
        for g in membri:
            area_di[g] = capo
    # i sottogruppi centrali vanno nell'area con cui hanno più collegamenti non centrali, se ce n'è una
    for g in con_link:
        vicini = Counter()
        for v in G[g]:
            vicini[area_di[v]] += G[g][v]["weight"]
        if vicini and area_di[g] == g and len([x for x in area_di.values() if x == g]) == 1:
            area_di[g] = vicini.most_common(1)[0][0]
    interni = {gruppo[t] for t, _, d in archi if gruppo[t] == gruppo[d]}
    for g in gruppi:
        if g not in area_di:
            # nessun collegamento con altri sottogruppi: area a sé se ha più tabelle o FK interne
            n = sum(gruppo[t] == g for t in tabelle)
            area_di[g] = g if (n > 1 or g in interni) else "senza collegamenti"

    # ---- categorie delle tabelle
    def date(t):
        # le colonne generiche (data_ins, created_at...) ci sono ovunque e non fanno di una tabella un movimento
        return any(tipo_base(S.tipi.get((t, c))) in TIPI_DATA and normalizza(c) not in S.generiche_norm
                   for c in S.col_per_tab[t])

    def codifica(t):
        # pochi campi, oltre alla chiave solo testi (sigla, descrizione)
        altre = [c for c in S.col_per_tab[t] if c not in S.pk.get(t, [])]
        return len(S.col_per_tab[t]) <= 3 and all(
            tipo_base(S.tipi.get((t, c))) in {"VARCHAR", "CHAR", "TEXT", "NVARCHAR", "NCHAR", "STRING", ""} for c in altre)

    pk_norm = {t: {normalizza(c) for c in S.pk.get(t, [])} for t in tabelle}
    padre_in_chiave = set()
    for t, colonne, d in archi:
        # la chiave contiene quella del padre (non conta una tabella centrale presente in tutte le chiavi)
        if d not in centrali and len(pk_norm[t]) > 1 and {normalizza(c) for c in colonne} < pk_norm[t]:
            padre_in_chiave.add(t)

    # un movimento ha una data e punta ad almeno un'entità vera (non solo a codifiche: un dipendente con
    # data di assunzione che punta al reparto resta un'anagrafica)
    codifiche = {t for t in tabelle if entranti[t] and not uscenti[t] and codifica(t)}
    punta_entita = {t for t, _, d in archi if d not in codifiche}

    righe_t = []
    for t in tabelle:
        parole = set(parti_nome(senza_accenti(t)))
        if parole & PAROLE_STORICO and t not in ponti:
            cat = "storico"
        elif not uscenti[t] and not entranti[t]:
            cat = "isolata"
        elif t in ponti:
            cat = "ponte"
        elif uscenti[t] and (t in padre_in_chiave or parole & PAROLE_DETTAGLIO):
            cat = "dettaglio"
        elif t in punta_entita and date(t) and t not in centrali:
            cat = "movimento"
        elif t in codifiche:
            cat = "codifica"
        elif entranti[t]:
            cat = "anagrafica"
        else:
            cat = "dipendente"
        righe_t.append({"tabella": t, "categoria": cat, "centrale": t in centrali,
                        "sottogruppo": gruppo[t], "area": area_di[gruppo[t]],
                        "FK uscenti": uscenti[t], "FK entranti": entranti[t],
                        "puntata da": len(puntata_da.get(t, ())), "perché": CATEGORIE[cat]})
    df_t = pd.DataFrame(righe_t, columns=["tabella", "categoria", "centrale", "sottogruppo", "area", "FK uscenti",
                                          "FK entranti", "puntata da", "perché"])
    cat_di = dict(zip(df_t["tabella"], df_t["categoria"]))

    # ---- collegamenti tra sottogruppi
    tra = {}
    for t, colonne, d in archi:
        a, b = gruppo[t], gruppo[d]
        if a == b:
            continue
        rel = tipo_relazione(S, t, colonne)[0]
        v = tra.setdefault((a, b), {"n": 0, "rel": Counter(), "fk": []})
        v["n"] += 1
        v["rel"][rel] += 1
        v["fk"].append(f"{t}.{', '.join(colonne)} → {d}")
    for p, r in ponti.items():
        dest = r["collega"].split(" N:M ")
        for x, y in combinations(dest, 2):
            if x in gruppo and y in gruppo and gruppo[x] != gruppo[y]:
                a, b = sorted((gruppo[x], gruppo[y]))
                v = tra.setdefault((a, b, "N:M"), {"n": 0, "rel": Counter(), "fk": []})
                v["n"] += 1
                v["rel"]["N:M"] += 1
                v["fk"].append(f"{x} N:M {y} tramite {p}")
    righe_c = []
    for chiave, v in tra.items():
        a, b = chiave[0], chiave[1]
        righe_c.append({"da sottogruppo": a, "a sottogruppo": b, "da area": area_di[a], "a area": area_di[b],
                        "stessa area": area_di[a] == area_di[b], "n collegamenti": v["n"],
                        "relazione": ", ".join(f"{k}" + (f" ×{n}" if n > 1 else "") for k, n in sorted(v["rel"].items())),
                        "dettaglio": "; ".join(v["fk"])})
    df_c = pd.DataFrame(righe_c, columns=["da sottogruppo", "a sottogruppo", "da area", "a area", "stessa area",
                                          "n collegamenti", "relazione", "dettaglio"])
    df_c = df_c.sort_values(["stessa area", "n collegamenti", "da sottogruppo"],
                            ascending=[True, False, True]).reset_index(drop=True)

    # ---- collegamenti tra aree
    righe_a = {}
    for r in df_c[~df_c["stessa area"]].to_dict("records"):
        a, b = sorted((r["da area"], r["a area"]))
        v = righe_a.setdefault((a, b), {"area 1": a, "area 2": b, "n collegamenti": 0, "tramite": []})
        v["n collegamenti"] += r["n collegamenti"]
        v["tramite"].append(f"{r['da sottogruppo']} → {r['a sottogruppo']}")
    df_ca = pd.DataFrame([{**v, "tramite": ", ".join(v["tramite"])} for v in righe_a.values()],
                         columns=["area 1", "area 2", "n collegamenti", "tramite"])
    df_ca = df_ca.sort_values("n collegamenti", ascending=False).reset_index(drop=True)

    # ---- sottogruppi e aree
    righe_g = []
    for g in gruppi:
        membri = [t for t in tabelle if gruppo[t] == g]
        cats = Counter(cat_di[t] for t in membri)
        righe_g.append({"area": area_di[g], "sottogruppo": g, "n_tabelle": len(membri),
                        "categorie": ", ".join(f"{k} {n}" for k, n in cats.most_common()),
                        "tabelle": ", ".join(membri)})
    df_g = pd.DataFrame(righe_g, columns=["area", "sottogruppo", "n_tabelle", "categorie", "tabelle"])
    righe_ar = []
    for a, parte in df_g.groupby("area"):
        vicine = sorted({x for k in righe_a for x in k if a in k} - {a})
        membri = [t for t in tabelle if area_di[gruppo[t]] == a]
        righe_ar.append({"area": a, "n_sottogruppi": len(parte), "n_tabelle": int(parte["n_tabelle"].sum()),
                         "sottogruppi": ", ".join(parte.sort_values("n_tabelle", ascending=False)["sottogruppo"]),
                         "tabelle centrali": ", ".join(t for t in membri if t in centrali) or "-",
                         "collegata a": ", ".join(vicine) or "-"})
    df_ar = pd.DataFrame(righe_ar, columns=["area", "n_sottogruppi", "n_tabelle", "sottogruppi",
                                            "tabelle centrali", "collegata a"])
    ultima = df_ar["area"] == "senza collegamenti"
    df_ar = (pd.concat([df_ar[~ultima].sort_values(["n_tabelle", "area"], ascending=[False, True]), df_ar[ultima]])
               .reset_index(drop=True))
    ordine = {a: i for i, a in enumerate(df_ar["area"])}
    df_g = df_g.sort_values(["area", "n_tabelle", "sottogruppo"], key=lambda s: s.map(ordine) if s.name == "area" else s,
                            ascending=[True, False, True]).reset_index(drop=True)
    return SimpleNamespace(aree=df_ar, sottogruppi=df_g, tabelle=df_t, collegamenti=df_c, collegamenti_aree=df_ca,
                           area_di_tabella={t: area_di[gruppo[t]] for t in tabelle}, categoria_di=cat_di,
                           centrali=sorted(centrali))


def trova_isolate(S, stesso_nome, df_simili, df_fk, df_pk_composte):
    collegate = set(df_fk["tabella"]) | set(df_fk["→ tabella"])
    for tabelle in stesso_nome["tabelle"]:
        collegate |= set(tabelle.split(", "))
    collegate |= set(df_simili["tabella 1"]) | set(df_simili["tabella 2"])
    trovate = df_pk_composte[df_pk_composte["→ tabella"] != "-"]
    collegate |= set(trovate["tabella"]) | set(trovate["→ tabella"])
    return sorted(set(S.col_per_tab) - collegate)


def analizza(df_schema, pk_dichiarate, rimosse=(), simili_tutti=None, fk_dichiarate=None, gruppi=None, imp=None,
             errori=None, originali=None):
    """Tutte le analisi sullo schema, senza le tabelle rimosse.

    simili_tutti: coppie di nomi simili già calcolate su tutto lo schema (la parte lenta):
    togliendo tabelle basta scartare le coppie che le contengono.
    """
    imp = imp or Impostazioni()
    rimosse = set(rimosse)
    if fk_dichiarate is None:
        fk_dichiarate = pd.DataFrame(columns=COLONNE_FK_DICHIARATE)
    fk_dichiarate = fk_dichiarate[~fk_dichiarate["tabella"].isin(rimosse)
                                  & ~fk_dichiarate["→ tabella"].isin(rimosse)]
    S = prepara(*filtra_schema(df_schema, pk_dichiarate, rimosse), fk_dichiarate, imp)
    if simili_tutti is None:
        simili = trova_nomi_simili(S, imp)
    else:
        simili = simili_tutti[~simili_tutti["tabella 1"].isin(rimosse)
                              & ~simili_tutti["tabella 2"].isin(rimosse)].reset_index(drop=True)
    stesso = trova_stesso_nome(S)
    fk, sosp = trova_fk(S)
    composte = collegamenti_pk_composte(S)
    qualita = controlli_progettazione(S, fk, fk_dichiarate)
    R = SimpleNamespace(S=S, stesso_nome=stesso, simili=simili, fk=fk, sospette=sosp, qualita=qualita,
                        pk_composte=composte,
                        isolate=trova_isolate(S, stesso, simili, fk, composte),
                        rimosse=sorted(rimosse), fk_dichiarate=fk_dichiarate, gruppi=gruppi)
    if gruppi is not None:
        gruppo_di = {t: r["gruppo"] for r in gruppi.to_dict("records") for t in r["tabelle"].split(", ")}
        R.aree = aree_e_categorie(R, gruppo_di)
    errori_validi = [e for e in (errori or []) if e.get("tabella") not in rimosse]
    R.diagnostica = diagnostica(R, errori_validi, originali, imp.dialetto)
    return R


# ====================================================================== salvataggio

def scrivi_excel(R, destinazione):
    """Scrive il file Excel con un foglio per ogni analisi (destinazione: percorso o file aperto)."""
    with pd.ExcelWriter(destinazione) as xls:
        if hasattr(R, "diagnostica"):
            R.diagnostica.to_excel(xls, sheet_name="Diagnostica", index=False)
        R.S.riepilogo.to_excel(xls, sheet_name="Tabelle", index=False)
        R.S.df_schema.to_excel(xls, sheet_name="Colonne", index=False)
        if R.gruppi is not None:
            R.gruppi.to_excel(xls, sheet_name="Gruppi", index=False)
        if getattr(R, "aree", None) is not None:
            R.aree.aree.to_excel(xls, sheet_name="Aree", index=False)
            R.aree.sottogruppi.to_excel(xls, sheet_name="Sottogruppi", index=False)
            R.aree.collegamenti.to_excel(xls, sheet_name="Collegamenti sottogruppi", index=False)
            R.aree.collegamenti_aree.to_excel(xls, sheet_name="Collegamenti aree", index=False)
            R.aree.tabelle.to_excel(xls, sheet_name="Categorie tabelle", index=False)
        R.fk_dichiarate.to_excel(xls, sheet_name="FK dichiarate", index=False)
        R.stesso_nome.to_excel(xls, sheet_name="Stesso nome", index=False)
        R.simili.to_excel(xls, sheet_name="Nomi simili", index=False)
        R.fk.to_excel(xls, sheet_name="FK candidate", index=False)
        R.pk_composte.to_excel(xls, sheet_name="PK composte", index=False)
        R.qualita.riepilogo.to_excel(xls, sheet_name="Qualità schema", index=False)
        R.qualita.senza_pk.to_excel(xls, sheet_name="Senza chiave primaria", index=False)
        R.qualita.ponti.to_excel(xls, sheet_name="Relazioni N-M", index=False)
        R.qualita.normalizzazione.to_excel(xls, sheet_name="Normalizzazione", index=False)
        R.qualita.ridondanti.to_excel(xls, sheet_name="Relazioni ridondanti", index=False)
        R.sospette.to_excel(xls, sheet_name="Da verificare", index=False)
        pd.DataFrame({"tabella": R.isolate}).to_excel(xls, sheet_name="Isolate", index=False)
        pd.DataFrame({"tabella": R.rimosse}).to_excel(xls, sheet_name="Tolte", index=False)


def testo_alter(R):
    """Le istruzioni ALTER TABLE proposte, divise per affidabilità."""
    righe = ["-- Chiavi esterne CANDIDATE: controllarle prima di eseguirle"]
    for conf in ("alta", "media"):
        righe.append(f"\n-- ===== Affidabilità {conf} =====")
        for _, r in R.fk[R.fk["affidabilità"] == conf].iterrows():
            nota = "" if r["tipi ok"] else "   -- ATTENZIONE: tipi diversi o colonna destinazione sconosciuta"
            righe.append(r["sql"] + nota)
    return "\n".join(righe) + "\n"


def create_originali(file_sql, dialetto="mysql"):
    """tabella -> (CREATE TABLE fino alla parentesi di chiusura esclusa, resto fino al ';' escluso).

    È il testo dei file senza commenti: tipi, ENGINE, COMMENT ecc. restano come sono.
    """
    testi = {}
    for nome_file, testo in file_sql:
        if nome_file in FILE_GENERATI:
            continue
        sql = togli_commenti(testo, dialetto)
        for m in RE_CREATE.finditer(sql):
            apertura = m.end() - 1
            chiusura = chiusura_parentesi(sql, apertura)
            if chiusura is None:
                continue
            fine = sql.find(";", chiusura)
            fine = len(sql) if fine == -1 else fine
            pulito = lambda t: re.sub(r"\n[ \t]*(?=\n)", "", re.sub(r"[ \t]+\n", "\n", t))
            testi[nome_tabella(sql[m.start():apertura])] = (pulito(sql[m.start():chiusura]).rstrip(),
                                                            pulito(sql[chiusura:fine]).rstrip())
    return testi


def create_originali_cartella(cartella, dialetto="mysql"):
    file_sql = [(f.name, f.read_text(encoding="utf-8", errors="replace"))
                for f in sorted(Path(cartella).glob("*.sql"))]
    return create_originali(file_sql, dialetto)


def _ordine_creazione(tabelle, dipende):
    """Prima le tabelle a cui puntano le altre (ordinamento topologico); i cicli restano in fondo."""
    mancanti = {t: {d for d in dipende[t] if d in dipende and d != t} for t in tabelle}
    ordine = []
    while True:
        pronte = sorted(t for t, d in mancanti.items() if not d)
        if not pronte:
            break
        for t in pronte:
            ordine.append(t)
            del mancanti[t]
        for d in mancanti.values():
            d.difference_update(pronte)
    return ordine, sorted(mancanti)


def testo_create(R, originali, dialetto="mysql"):
    """I CREATE TABLE originali con dentro le chiavi esterne trovate.

    Attive: affidabilità alta con tipi compatibili (una sola per colonna) e quelle già dichiarate
    con ALTER TABLE nei file. Commentate con --: affidabilità media, tipi diversi, alternative.
    """
    tabelle = sorted(t for t in R.S.col_per_tab if t in originali)
    vincoli = {t: [] for t in tabelle}            # (attivo, testo, nota)
    dipende = {t: set() for t in tabelle}

    # MySQL non accetta chiavi esterne su tabelle partizionate né su tabelle MyISAM
    bloccate = {}
    if dialetto == "mysql":
        for t in tabelle:
            coda = originali[t][1]
            if re.search(r"\bPARTITION\s+BY\b", coda, re.I):
                bloccate[t] = f"MySQL non accetta chiavi esterne con la tabella partizionata {t}"
            elif re.search(r"\bENGINE\s*=\s*MyISAM\b", coda, re.I):
                bloccate[t] = f"la tabella {t} è MyISAM, che non supporta le chiavi esterne: serve ENGINE=InnoDB"

    imp = getattr(R.S, "imp", None) or Impostazioni()

    def aggiungi(t, colonne, dest, colonne_dest, attivo, nota):
        regole, nota_regole = clausola_regole(imp, any((t, c) in R.S.not_null for c in colonne.split(", ")),
                                              dialetto)
        testo = (f"CONSTRAINT {nome_vincolo(t, colonne.replace(', ', '_'), dest)} "
                 f"FOREIGN KEY ({colonne}) REFERENCES {dest} ({colonne_dest}){regole}")
        if nota_regole:
            nota += f"; {nota_regole}"
        if attivo and (t in bloccate or dest in bloccate):
            attivo, nota = False, "da verificare: " + bloccate.get(t, bloccate.get(dest))
        vincoli[t].append((attivo, testo, nota))
        if attivo:
            dipende[t].add(dest)

    # chiavi esterne già dichiarate con ALTER TABLE: nel testo del CREATE non ci sono
    for r in R.fk_dichiarate.to_dict("records"):
        t = r["tabella"]
        if t not in vincoli:
            continue
        if re.search(r"\bREFERENCES\s+[`\"\[]?" + re.escape(r["→ tabella"]) + r"\b",
                     originali[t][0] + originali[t][1], re.I):
            dipende[t].add(r["→ tabella"])
        else:
            aggiungi(t, r["colonna"], r["→ tabella"], r["→ colonna"], True, "già dichiarata nei file con ALTER TABLE")

    # chiavi esterne candidate: per ogni colonna la migliore, le altre commentate
    candidate = R.fk[~R.fk["già dichiarata"]].to_dict("records")
    candidate.sort(key=lambda r: (r["tabella"], r["colonna"], r["affidabilità"] != "alta",
                                  not r["tipi ok"], r["→ tabella"]))
    ridondanti = {(r["tabella"], r["colonna"], r["→ tabella"]): r["percorso già esistente"]
                  for r in R.qualita.ridondanti.to_dict("records")} if hasattr(R, "qualita") else {}
    attiva_per = {}
    for r in candidate:
        t, c = r["tabella"], r["colonna"]
        if t not in vincoli:
            continue
        if r["→ colonna"] == "?":
            attivo, nota = False, "da verificare: la tabella puntata non ha una chiave primaria di una sola colonna"
        elif not r["tipi ok"]:
            attivo, nota = False, f"da verificare: tipi diversi ({r['tipo']} / {r['tipo dest']})"
        elif r["affidabilità"] != "alta":
            attivo, nota = False, "da verificare: affidabilità media"
        elif t in bloccate or r["→ tabella"] in bloccate:
            attivo, nota = False, "da verificare: " + bloccate.get(t, bloccate.get(r["→ tabella"]))
        elif (t, c, r["→ tabella"]) in ridondanti:
            attivo, nota = False, f"da verificare: probabilmente ridondante, c'è già {ridondanti[(t, c, r['→ tabella'])]}"
        elif (t, c) in attiva_per:
            attivo, nota = False, f"alternativa: la colonna punta già a {attiva_per[(t, c)]}"
        else:
            attivo, nota = True, "affidabilità alta"
            attiva_per[(t, c)] = r["→ tabella"]
        aggiungi(t, c, r["→ tabella"], r["→ colonna"], attivo, nota)

    ordine, cicli = _ordine_creazione(tabelle, dipende)
    attive = sum(a for v in vincoli.values() for a, _, _ in v)
    commentate = sum(not a for v in vincoli.values() for a, _, _ in v)
    righe = [
        "-- CREATE TABLE con le chiavi esterne trovate (generato da sql-fk-finder)",
        f"-- {len(tabelle)} tabelle, {attive} chiavi esterne attive, {commentate} da verificare (commentate con --).",
        "-- Le chiavi esterne commentate si attivano togliendo i due trattini all'inizio della riga.",
        "-- Prima di eseguire lo script, verifica che nei dati non ci siano valori orfani.",
        "",
    ]
    if dialetto == "mysql":
        righe += ["SET FOREIGN_KEY_CHECKS = 0;", ""]
    else:
        righe += ["-- Le tabelle sono in ordine: prima quelle a cui puntano le altre.", ""]

    for t in ordine + cicli:
        corpo, coda = originali[t]
        if t in cicli:
            righe.append("-- tabella in un ciclo di chiavi esterne: con altri database potrebbe servire crearle dopo")
        aggiunte = []
        if not R.S.pk.get(t) or t in R.S.pk_indovinata:
            aggiunte.append("  -- ,id_" + t + " INT NOT NULL AUTO_INCREMENT PRIMARY KEY   -- da verificare: tabella "
                            "senza chiave primaria dichiarata (integrità dell'entità): chiave artificiale proposta")
        aggiunte += [f"  ,{testo}   -- {nota}" for attivo, testo, nota in vincoli[t] if attivo]
        aggiunte += [f"  -- ,{testo}   -- {nota}" for attivo, testo, nota in vincoli[t] if not attivo]
        righe.append(corpo + "\n" + "\n".join(aggiunte) + "\n" + coda + ";" if aggiunte else corpo + coda + ";")
        righe.append("")

    if dialetto == "mysql":
        righe.append("SET FOREIGN_KEY_CHECKS = 1;")
    return "\n".join(righe) + "\n"


def salva(R, cartella, originali=None, dialetto="mysql"):
    """Crea possibili_collegamenti.xlsx, fk_candidate.sql e, se ci sono i CREATE TABLE originali,
    create_table_con_fk.sql nella cartella."""
    file_excel = Path(cartella) / "possibili_collegamenti.xlsx"
    file_alter = Path(cartella) / "fk_candidate.sql"
    scrivi_excel(R, file_excel)
    file_alter.write_text(testo_alter(R), encoding="utf-8")
    salvati = [file_excel, file_alter]
    if originali:
        file_create = Path(cartella) / "create_table_con_fk.sql"
        file_create.write_text(testo_create(R, originali, dialetto), encoding="utf-8")
        salvati.append(file_create)
    return salvati
