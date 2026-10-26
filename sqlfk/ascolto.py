"""Ascolto delle query di un programma: quali istruzioni SQL manda al database ogni suo tasto.

Il programma da studiare usa un database MySQL sullo stesso computer. MySQL scrive tutte le query che riceve nel
suo *general log* (un file di testo). Questo modulo legge quel file, senza nessuna connessione: né al database
né in rete. Le query si raggruppano in **azioni** (il tasto premuto nel programma):

- dal vivo: si dà un nome all'azione, si preme Inizia, si clicca nel programma, si preme Fine;
- da un log già registrato: le query si dividono nelle pause (nessuna query per qualche secondo).

Per ogni azione: le query in ordine con la loro forma (i valori diventano ?), le tabelle lette e scritte (CRUD),
i valori per colonna, le condizioni di JOIN e i valori che passano da una tabella all'altra (collegamenti usati
davvero dal programma).
"""
import os
import re
import time
from datetime import datetime
from pathlib import Path

try:
    import sqlglot
    from sqlglot import exp
except ImportError:                       # senza sqlglot restano forma, verbo e tabelle trovate con le espressioni regolari
    sqlglot = None

from . import analisi as A
from . import estensioni as EXT

# --------------------------------------------------------------------- lettura del general log

# MySQL 5.7, 8, 9:  2026-10-26T09:12:01.123456Z	    8 Query	SELECT ...
RE_NUOVO = re.compile(r"^(?P<ora>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?P<conn>\d+)\s+(?P<cmd>[A-Za-z][A-Za-z ]*?)(?:\t(?P<testo>.*))?$")
# MySQL 5.5/5.6 e MariaDB:  261026  9:12:01	    8 Query	SELECT ...   (l'ora manca se è la stessa della riga prima)
RE_VECCHIO = re.compile(r"^(?:(?P<ora>\d{6}\s+\d{1,2}:\d{2}:\d{2})|)\s*\t\s*(?P<conn>\d+)\s+(?P<cmd>[A-Za-z][A-Za-z ]*?)(?:\t(?P<testo>.*))?$")
COMANDI_SQL = {"Query", "Execute"}
INTESTAZIONI = ("Tcp port:", "Time ", "Time\t")


def _secondi(ora):
    """Ora del log -> secondi (per misurare le pause); None se non si capisce."""
    if not ora:
        return None
    try:
        if "T" in ora:
            return datetime.fromisoformat(ora.replace("Z", "+00:00")).timestamp()
        return datetime.strptime(re.sub(r"\s+", " ", ora), "%y%m%d %H:%M:%S").timestamp()
    except ValueError:
        return None


class Lettore:
    """Trasforma le righe del general log in voci {ora, secondi, conn, comando, testo}, anche a pezzi
    (lettura dal vivo): una query su più righe continua finché non comincia una nuova voce."""

    def __init__(self):
        self.voci = []
        self.ora = None                    # l'ultima ora letta (le righe del vecchio formato la omettono)

    def riga(self, riga):
        riga = riga.rstrip("\r")
        m = RE_NUOVO.match(riga) or RE_VECCHIO.match(riga)
        if m:
            if m.group("ora"):
                self.ora = m.group("ora").strip()
            self.voci.append({"ora": self.ora, "secondi": _secondi(self.ora), "conn": int(m.group("conn")),
                              "comando": m.group("cmd").strip(), "testo": (m.group("testo") or "").rstrip()})
        elif self.voci and not riga.startswith(INTESTAZIONI) and "started with:" not in riga:
            self.voci[-1]["testo"] += "\n" + riga          # seguito di una query su più righe

    def testo(self, testo):
        for r in testo.split("\n"):
            self.riga(r)
        return self.voci


def leggi_log(testo):
    """Tutte le voci di un general log."""
    return Lettore().testo(testo)


def query_di(voci):
    """Solo le voci che sono istruzioni SQL (Query, Execute), senza le righe vuote."""
    return [v for v in voci if v["comando"] in COMANDI_SQL and v["testo"].strip()]


# --------------------------------------------------------------------- forma e analisi di una query

RE_STRINGA = re.compile(r"'(?:[^'\\]|\\.|'')*'|\"(?:[^\"\\]|\\.)*\"")
RE_NUMERO = re.compile(r"(?<![\w.$])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w$])")
RE_ESADECIMALE = re.compile(r"\b0x[0-9a-fA-F]+\b|\bX'[0-9a-fA-F]*'", re.I)
RE_LISTA = re.compile(r"\bIN\s*\(\s*\?(?:\s*,\s*\?)+\s*\)", re.I)
RE_RIGHE = re.compile(r"(\(\s*\?(?:\s*,\s*\?)*\s*\))(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))+")
TECNICHE = re.compile(r"^\s*(?:SET\b|SHOW\b|USE\b|SELECT\s+(?:@@|DATABASE\(\)|VERSION\(\)|CONNECTION_ID\(\)|LAST_INSERT_ID\(\)|FOUND_ROWS\(\)|1\b)"
                      r"|COMMIT\b|ROLLBACK\b|START\s+TRANSACTION\b|BEGIN\b|SAVEPOINT\b|RELEASE\b|DO\s+SLEEP|KILL\b|FLUSH\b|PING\b)", re.I)


def forma(sql):
    """La query con i valori sostituiti da ?: due query che differiscono solo per i valori hanno la stessa forma."""
    f = RE_STRINGA.sub("?", sql)
    f = RE_ESADECIMALE.sub("?", f)
    f = RE_NUMERO.sub("?", f)
    f = RE_RIGHE.sub(r"\1, ...", f)                 # INSERT con molte righe di valori
    f = RE_LISTA.sub("IN (?, ...)", f)              # IN (1, 2, 3)
    return re.sub(r"\s+", " ", f).strip().rstrip(";").strip()


def impronta(sql):
    return forma(sql).lower()


def tecnica(sql):
    """Query di servizio del collegamento (SET, SHOW, transazioni, SELECT @@...): non dicono cosa fa il tasto."""
    return bool(TECNICHE.match(sql))


def _valore(nodo):
    if isinstance(nodo, exp.Literal):
        return nodo.this
    if isinstance(nodo, exp.Null):
        return None
    if isinstance(nodo, exp.Neg) and isinstance(nodo.this, exp.Literal):
        return "-" + nodo.this.this
    if isinstance(nodo, exp.Boolean):
        return str(nodo.this)
    return nodo.sql(dialect="mysql")[:80]


def analizza_query(sql, dialetto="mysql", colonne_di=None):
    """{verbo, forma, tecnica, tabelle: [[tabella, operazione]], valori: [{tabella, colonna, valore, uso}],
    join: [[tabella, colonna, tabella, colonna]], metodo}. colonne_di(tabella): le colonne in ordine (dallo schema), per gli
    INSERT che non le elencano."""
    risultato = {"verbo": (re.match(r"\s*(\w+)", sql) or [None, ""])[1].upper(), "forma": forma(sql), "tecnica": tecnica(sql),
                 "tabelle": [], "valori": [], "join": [], "metodo": "regex"}
    if risultato["tecnica"]:
        return risultato
    albero = None
    if sqlglot is not None:
        try:
            albero = sqlglot.parse_one(sql, read=dialetto)
        except Exception:
            albero = None
    if albero is None or isinstance(albero, exp.Command):
        clean, masked = EXT._clean_and_mask(sql, dialetto)
        visti = set()
        for t, op, _, _ in EXT._regex_tables(clean, masked, 0, len(masked)):
            if (t, op) not in visti:
                visti.add((t, op)); risultato["tabelle"].append([t, op])
        return risultato
    risultato["metodo"] = "ast"
    visti = set()
    for t, op, _, _ in EXT._ast_tables([albero]):
        if (t, op) not in visti:
            visti.add((t, op)); risultato["tabelle"].append([t, op])
    # alias -> tabella (SELECT ... FROM ordini o JOIN clienti c)
    alias = {}
    for t in albero.find_all(exp.Table):
        nome = EXT._table_name(t)
        alias[(t.alias or t.name).lower()] = nome
        alias[t.name.lower()] = nome
    principale = None
    if isinstance(albero, (exp.Insert, exp.Update, exp.Delete)):
        bersaglio = albero.find(exp.Table)
        principale = EXT._table_name(bersaglio) if bersaglio else None
    elif risultato["tabelle"]:
        principale = risultato["tabelle"][0][0]

    def tabella_di(colonna):
        q = colonna.table.lower() if colonna.table else ""
        return alias.get(q) if q else principale

    # valori inseriti (INSERT ... (colonne) VALUES (...)): la prima riga
    if isinstance(albero, exp.Insert):
        schema = albero.this if isinstance(albero.this, exp.Schema) else None
        colonne = [c.name for c in schema.expressions] if schema else (list(colonne_di(principale)) if colonne_di and principale else [])
        valori = albero.expression
        righe = valori.expressions if isinstance(valori, exp.Values) else []
        if colonne and righe:
            prima = righe[0].expressions if isinstance(righe[0], exp.Tuple) else [righe[0]]
            for c, v in zip(colonne, prima):
                risultato["valori"].append({"tabella": principale, "colonna": c, "valore": _valore(v), "uso": "inserito"})
    # valori modificati (UPDATE ... SET colonna = valore)
    if isinstance(albero, exp.Update):
        for e in albero.expressions:
            if isinstance(e, exp.EQ) and isinstance(e.this, exp.Column):
                risultato["valori"].append({"tabella": tabella_di(e.this) or principale, "colonna": e.this.name,
                                            "valore": _valore(e.expression), "uso": "modificato"})
    # condizioni (colonna = valore) e collegamenti (colonna = colonna di un'altra tabella)
    dove = albero.args.get("where")
    nodi = list(dove.find_all(exp.EQ)) if dove else []
    for j in albero.find_all(exp.Join):
        if j.args.get("on"):
            nodi += list(j.args["on"].find_all(exp.EQ))
    for e in nodi:
        a, b = e.this, e.expression
        if isinstance(a, exp.Column) and isinstance(b, exp.Column):
            ta, tb = tabella_di(a), tabella_di(b)
            if ta and tb and ta != tb:
                risultato["join"].append([ta, a.name, tb, b.name])
        elif isinstance(a, exp.Column) or isinstance(b, exp.Column):
            colonna, valore = (a, b) if isinstance(a, exp.Column) else (b, a)
            if isinstance(valore, (exp.Literal, exp.Neg, exp.Null, exp.Boolean)):
                risultato["valori"].append({"tabella": tabella_di(colonna), "colonna": colonna.name,
                                            "valore": _valore(valore), "uso": "condizione"})
    return risultato


# --------------------------------------------------------------------- azioni

def nuova_azione(nome, voci, rumore=(), dialetto="mysql", colonne_di=None):
    """Un'azione (il tasto premuto) con le sue query, già analizzate; senza quelle del rumore di fondo."""
    query = []
    for v in query_di(voci):
        if impronta(v["testo"]) in rumore:
            continue
        q = analizza_query(v["testo"], dialetto, colonne_di)
        query.append({"ora": v["ora"], "conn": v["conn"], "testo": v["testo"], **q})
    return {"nome": nome, "inizio": voci[0]["ora"] if voci else None, "fine": voci[-1]["ora"] if voci else None, "query": query}


def riassunto(azione):
    """CRUD per tabella, collegamenti (JOIN e valori che passano da una colonna a un'altra), valori usati."""
    crud, join, valori = {}, set(), {}
    generati = []                                         # valori presi da LAST_INSERT_ID(): l'id appena creato
    ultimo_insert = None
    for q in azione["query"]:
        if q["tecnica"]:
            continue
        for v in q["valori"]:
            if "last_insert_id" in str(v["valore"]).lower() and ultimo_insert and v["tabella"]:
                generati.append({"valore": f"id appena creato in {ultimo_insert}",
                                 "posti": [f"{ultimo_insert} (INSERT)", f"{v['tabella']}.{v['colonna']} (inserito)"]})
        if q["verbo"] in ("INSERT", "REPLACE") and q["tabelle"]:
            ultimo_insert = next((t for t, op in q["tabelle"] if op == "CREATE"), ultimo_insert)
        for t, op in q["tabelle"]:
            crud.setdefault(t, set()).add(op[0])
        for j in q["join"]:
            join.add(tuple(j))
        for v in q["valori"]:
            if v["valore"] not in (None, "", "0", "1") and v["tabella"]:
                valori.setdefault(str(v["valore"]), set()).add((v["tabella"], v["colonna"], v["uso"]))
    # lo stesso valore in colonne di tabelle diverse (letto in una, scritto nell'altra): possibile collegamento
    flussi = []
    for valore, posti in valori.items():
        tabelle = {p[0] for p in posti}
        if len(tabelle) >= 2 and len(valore) <= 40:
            flussi.append({"valore": valore, "posti": sorted([f"{t}.{c} ({u})" for t, c, u in posti])})
    return {"crud": {t: "".join(x for x in "CRUD" if x in ops) for t, ops in sorted(crud.items())},
            "join": sorted(join), "flussi": generati + flussi,
            "query": len(azione["query"]), "tecniche": sum(1 for q in azione["query"] if q["tecnica"])}


def rumore_probabile(voci, minimo=5):
    """Impronte delle query che il programma manda da solo, a intervalli regolari (controllo delle notifiche, timer):
    almeno 'minimo' volte, con intervalli simili tra una volta e l'altra. Più le query tecniche (SET, SHOW, SELECT @@...)."""
    tempi = {}
    for v in query_di(voci):
        if v["secondi"] is not None:
            tempi.setdefault(impronta(v["testo"]), []).append(v["secondi"])
    trovate = set()
    for imp, t in tempi.items():
        if tecnica(imp):
            if not re.match(r"\s*(start|begin|commit|rollback|savepoint|release)\b", imp):
                trovate.add(imp)                          # le transazioni restano: dicono come è fatta l'azione
            continue
        if len(t) < minimo:
            continue
        intervalli = [b - a for a, b in zip(t, t[1:]) if b - a > 0.05]
        if len(intervalli) < minimo - 1:
            continue
        # intervalli quasi uguali: un timer, non una persona. Si guarda la mediana, così le pause lunghe
        # (programma chiuso e riaperto, registrazione fermata) non nascondono il timer
        mediana = sorted(intervalli)[len(intervalli) // 2]
        regolari = sum(1 for x in intervalli if abs(x - mediana) <= 0.35 * mediana)
        if mediana > 0 and regolari >= max(minimo - 1, 0.8 * len(intervalli)):
            trovate.add(imp)
    return trovate


def dividi_per_pause(voci, pausa=2.0, rumore=(), dialetto="mysql", colonne_di=None):
    """Azioni da un log già registrato: una nuova azione dopo ogni pausa di almeno 'pausa' secondi senza query."""
    sql = [v for v in query_di(voci) if impronta(v["testo"]) not in rumore]
    gruppi, attuale, prima = [], [], None
    for v in sql:
        t = v["secondi"]
        if attuale and t is not None and prima is not None and t - prima >= pausa:
            gruppi.append(attuale)
            attuale = []
        attuale.append(v)
        if t is not None:
            prima = t
    if attuale:
        gruppi.append(attuale)
    azioni = []
    for i, g in enumerate(gruppi, 1):
        ora = (g[0]["ora"] or "")[11:19] if g[0]["ora"] and "T" in g[0]["ora"] else (g[0]["ora"] or "")
        azioni.append(nuova_azione(f"Azione {i}" + (f" ({ora})" if ora else ""), g, (), dialetto, colonne_di))
    return azioni


# --------------------------------------------------------------------- registrazione dal vivo

class Ascolto:
    """Lo stato dell'ascolto: il file del log seguito dal vivo, le azioni registrate e il rumore di fondo."""

    def __init__(self):
        self.percorso = None
        self.posizione = 0                 # byte del file già letti
        self.resto = ""                    # l'ultima riga non ancora finita
        self.lettore = Lettore()
        self.in_corso = None               # {"nome", "da", "rumore"}: indice della prima voce dell'azione
        self.azioni = []
        self.rumore = set()                # impronte delle query che il programma manda anche senza fare niente

    # -- file
    def segui(self, percorso, dall_inizio=False):
        p = Path(str(percorso)).expanduser()
        if not p.is_file():
            raise FileNotFoundError(f"Il file del log non esiste: {p}")
        self.percorso, self.resto, self.lettore, self.in_corso = p, "", Lettore(), None
        self.posizione = 0 if dall_inizio else p.stat().st_size
        return self.leggi()

    def leggi(self, massimo=64 * 1024 * 1024):
        """Le righe arrivate dall'ultima lettura (il file può anche ricominciare da capo, se MySQL lo ricrea)."""
        if not self.percorso:
            return 0
        try:
            dimensione = self.percorso.stat().st_size
        except OSError:
            return 0
        if dimensione < self.posizione:                    # file svuotato o ricreato
            self.posizione, self.resto = 0, ""
        if dimensione == self.posizione:
            return 0
        with open(self.percorso, "rb") as f:
            f.seek(self.posizione)
            dati = f.read(min(massimo, dimensione - self.posizione))
        self.posizione += len(dati)
        testo = self.resto + dati.decode("utf-8", errors="replace")
        righe = testo.split("\n")
        self.resto = righe.pop()
        prima = len(self.lettore.voci)
        for r in righe:
            self.lettore.riga(r)
        return len(self.lettore.voci) - prima

    def stato(self, ultime=25):
        self.leggi()
        voci = query_di(self.lettore.voci)
        return {"percorso": str(self.percorso) if self.percorso else None, "lette": len(voci),
                "in_corso": {**self.in_corso, "query": len(query_di(self.lettore.voci[self.in_corso["da"]:]))} if self.in_corso else None,
                "ultime": [{"ora": v["ora"], "conn": v["conn"], "forma": forma(v["testo"])[:300], "tecnica": tecnica(v["testo"]),
                            "rumore": impronta(v["testo"]) in self.rumore} for v in voci[-ultime:]],
                "rumore": len(self.rumore), "azioni": len(self.azioni)}

    # -- azioni
    def inizia(self, nome, rumore=False):
        if not self.percorso:
            raise ValueError("Prima scegli il file del log di MySQL.")
        self.leggi()
        self.in_corso = {"nome": str(nome or "").strip() or f"Azione {len(self.azioni) + 1}", "da": len(self.lettore.voci),
                         "rumore": bool(rumore), "dalle": time.strftime("%H:%M:%S")}
        return self.in_corso

    def fine(self, dialetto="mysql", colonne_di=None):
        if not self.in_corso:
            raise ValueError("Nessuna registrazione in corso.")
        time.sleep(0.3)                                   # MySQL scrive il log subito, ma lasciamo arrivare le ultime righe
        self.leggi()
        voci = self.lettore.voci[self.in_corso["da"]:]
        in_corso, self.in_corso = self.in_corso, None
        if in_corso["rumore"]:
            nuove = {impronta(v["testo"]) for v in query_di(voci)}
            self.rumore |= nuove
            return {"rumore": len(nuove)}
        azione = nuova_azione(in_corso["nome"], voci, self.rumore, dialetto, colonne_di)
        self.azioni.append(azione)
        return {"azione": len(self.azioni) - 1, "query": len(azione["query"])}

    def annulla(self):
        self.in_corso = None

    def importa(self, testo, pausa=2.0, dialetto="mysql", rumore_automatico=True, colonne_di=None):
        voci = leggi_log(testo)
        trovato = rumore_probabile(voci) - self.rumore if rumore_automatico else set()
        self.rumore |= trovato
        nuove = dividi_per_pause(voci, pausa, self.rumore, dialetto, colonne_di)
        self.azioni += nuove
        esempio = {}
        for v in query_di(voci):
            esempio.setdefault(impronta(v["testo"]), forma(v["testo"]))
        return {"azioni": len(nuove), "query": sum(len(a["query"]) for a in nuove),
                "rumore": sorted(esempio.get(x, x) for x in trovato if not tecnica(x))}

    # -- progetto
    def dati(self):
        return {"azioni": self.azioni, "rumore": sorted(self.rumore)}

    def carica(self, d):
        d = d or {}
        self.azioni = [a for a in d.get("azioni", []) if isinstance(a, dict) and "query" in a]
        self.rumore = set(d.get("rumore", []))


def specifica_markdown(azioni, origine=""):
    """Il documento per ricreare il programma: per ogni tasto le query in ordine, con i parametri al posto dei valori."""
    righe = [f"# Azioni del programma e query SQL", "", f"Registrate con SQL FK Finder il {time.strftime('%d/%m/%Y')}" +
             (f" (database: {origine})" if origine else "") + ".", ""]
    for a in azioni:
        R = riassunto(a)
        righe += [f"## {a['nome']}", ""]
        if R["crud"]:
            righe += ["| tabella | operazioni |", "|---|---|"] + [f"| {t} | {ops} |" for t, ops in R["crud"].items()] + [""]
        righe.append("Query in ordine (i valori sono sostituiti da `?`):")
        righe.append("")
        for i, q in enumerate([q for q in a["query"] if not q["tecnica"]], 1):
            righe += [f"{i}. `{q['forma']}`"]
            parametri = [f"{v['tabella']}.{v['colonna']} = {v['valore']!r} ({v['uso']})" for v in q["valori"] if v["tabella"]]
            if parametri:
                righe.append(f"   - valori: {'; '.join(parametri[:12])}")
        if R["join"]:
            righe += ["", "Collegamenti usati: " + ", ".join(f"{a}.{b} = {c}.{d}" for a, b, c, d in R["join"])]
        righe.append("")
    return "\n".join(righe) + "\n"


def collegamenti_usati(azioni):
    """Coppie di colonne di tabelle diverse che il programma collega: dalle JOIN e dai valori che passano
    da una tabella all'altra in un'azione. {(tabella, colonna, tabella, colonna): [prove]}"""
    coppie = {}
    for a in azioni:
        R = riassunto(a)
        for t1, c1, t2, c2 in R["join"]:
            coppie.setdefault(tuple(sorted([(t1, c1), (t2, c2)])), []).append(f"JOIN in «{a['nome']}»")
        for f in R["flussi"]:
            posti = []
            for p in f["posti"]:
                m = re.match(r"([^\s(]+)\.([^\s(.]+) \(", p)
                if m:
                    posti.append((m.group(1), m.group(2)))
            for i in range(len(posti)):
                for j in range(i + 1, len(posti)):
                    if posti[i][0] != posti[j][0]:
                        coppie.setdefault(tuple(sorted([posti[i], posti[j]])), []).append(f"stesso valore {f['valore']} in «{a['nome']}»")
            if f["valore"].startswith("id appena creato in ") and posti:
                origine = f["valore"].replace("id appena creato in ", "")
                coppie.setdefault(tuple(sorted([(origine, "(chiave)"), posti[-1]])), []).append(f"id generato da INSERT in «{a['nome']}»")
    return {k: sorted(set(v)) for k, v in coppie.items()}
