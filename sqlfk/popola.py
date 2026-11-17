"""Popolare il database di prova con dati finti ma realistici e verificare che le chiavi esterne funzionino.

- popola: per le tabelle scelte (e, se serve, per quelle a cui puntano) genera righe che rispettano tipi, chiavi primarie,
  UNIQUE, NOT NULL e chiavi esterne (i valori delle chiavi esterne si prendono dalle righe che esistono nella tabella
  collegata, riempiendo prima i padri).
- verifica: per ogni chiave esterna conta le righe collegate e le orfane, prova a inserire un figlio con un padre che non
  c'è (deve essere rifiutato) e a cancellare un padre usato (bloccato, a cascata o a NULL, come dice il vincolo). Le prove
  si fanno dentro un SAVEPOINT annullato: i dati restano come erano.
Tutto in locale sul file SQLite del database di prova (sqlfk/prova.py), con dati inventati: niente rete.
"""
import random
import re
import sqlite3
from datetime import date, datetime, timedelta

from . import prova as PR

q = PR.q

NOMI = ["Mirco", "Giulia", "Luca", "Sara", "Paolo", "Anna", "Marco", "Elena", "Davide", "Chiara", "Matteo", "Francesca",
        "Alessandro", "Martina", "Andrea", "Laura", "Simone", "Valentina", "Federico", "Silvia"]
COGNOMI = ["Rossi", "Bianchi", "Verdi", "Russo", "Ferrari", "Esposito", "Romano", "Colombo", "Ricci", "Marino", "Greco",
           "Bruno", "Gallo", "Conti", "De Luca", "Costa", "Giordano", "Mancini", "Rizzo", "Lombardi"]
CITTA = [("Torino", "TO", "10121", 45.0703, 7.6869), ("Milano", "MI", "20121", 45.4642, 9.19), ("Roma", "RM", "00184", 41.9028, 12.4964),
         ("Napoli", "NA", "80133", 40.8518, 14.2681), ("Bologna", "BO", "40121", 44.4949, 11.3426), ("Firenze", "FI", "50122", 43.7696, 11.2558),
         ("Genova", "GE", "16121", 44.4056, 8.9463), ("Bari", "BA", "70121", 41.1171, 16.8719), ("Alba", "CN", "12051", 44.7, 8.0347),
         ("Cuneo", "CN", "12100", 44.3845, 7.5427), ("Asti", "AT", "14100", 44.9008, 8.2064), ("Verona", "VR", "37121", 45.4384, 10.9916)]
AZIENDE = ["srl", "spa", "snc", "sas"]
PRODOTTI = ["Vite 4 mm", "Bullone 8 mm", "Rondella", "Cacciavite", "Chiave inglese", "Cerniera", "Martello", "Pinza", "Trapano",
            "Nastro isolante", "Colla", "Guanti", "Metro", "Livella", "Lampadina", "Cavo elettrico", "Tassello", "Chiodo"]
PAROLE = ["consegna", "urgente", "ritiro", "controllo", "da verificare", "pagato", "in attesa", "completato", "nota interna"]
STATI = ["attivo", "sospeso", "chiuso", "in corso", "nuovo"]
VIE = ["Via Roma", "Corso Italia", "Via Garibaldi", "Piazza Duomo", "Via Mazzini", "Viale Europa", "Via Verdi"]


def _base(tipo):
    t = (tipo or "").upper()
    if re.search(r"POINT|GEOM|GEOGRAPHY", t):
        return "posizione"
    if re.search(r"\bBOOL", t) or t.startswith("BIT") or re.match(r"TINYINT\s*\(\s*1\s*\)", t):
        return "booleano"
    if re.match(r"\s*((TINY|SMALL|MEDIUM|BIG)?INT(EGER)?\b|SERIAL|BIGSERIAL)", t):
        return "intero"
    if any(x in t for x in ("REAL", "FLOA", "DOUB", "DEC", "NUM", "MONEY")):
        return "reale"
    if "DATETIME" in t or "TIMESTAMP" in t:
        return "dataora"
    if "DATE" in t:
        return "data"
    if t.startswith("TIME"):
        return "ora"
    return "testo"


def _lunghezza(tipo):
    m = re.search(r"\(\s*(\d+)", tipo or "")
    return int(m.group(1)) if m else None


def _decimali(tipo):
    m = re.search(r"\(\s*\d+\s*,\s*(\d+)\s*\)", tipo or "")
    return int(m.group(1)) if m else 2


def valore(colonna, tipo, i, caso):
    """Un valore credibile per la colonna, dal nome e dal tipo (i: numero della riga, per i valori unici)."""
    n, base = colonna.lower(), _base(tipo)
    citta = caso.choice(CITTA)
    if base == "posizione":
        return f"POINT({citta[4] + caso.uniform(-.05, .05):.6f} {citta[3] + caso.uniform(-.05, .05):.6f})"
    if base == "booleano":
        return caso.randint(0, 1)
    if base in ("data", "dataora", "ora") or re.search(r"(^data|_data$|date|scadenza|nascita)", n):
        giorno = date.today() - timedelta(days=caso.randint(0, 900))
        if "nascita" in n:
            giorno = date(caso.randint(1950, 2005), caso.randint(1, 12), caso.randint(1, 28))
        if base == "ora":
            return f"{caso.randint(8, 19):02d}:{caso.choice([0, 15, 30, 45]):02d}:00"
        if base == "dataora":
            return datetime(giorno.year, giorno.month, giorno.day, caso.randint(8, 19), caso.randint(0, 59)).isoformat(sep=" ")
        return giorno.isoformat()
    if re.search(r"(^lat|latitud)", n):
        return round(citta[3] + caso.uniform(-.05, .05), 6)
    if re.search(r"(^lon|^lng|longitud)", n):
        return round(citta[4] + caso.uniform(-.05, .05), 6)
    if base in ("intero", "reale"):
        if re.search(r"(qta|quantit|pezzi|numero|giacenza|scorta)", n):
            v = caso.randint(1, 50) if "giacenza" not in n and "scorta" not in n else caso.randint(0, 500)
        elif re.search(r"(prezzo|importo|totale|costo|saldo|imponibile|stipendio|price|amount)", n):
            v = round(caso.uniform(1, 500), _decimali(tipo)) if base == "reale" else caso.randint(1, 500)
        elif re.search(r"(anno|year)", n):
            v = caso.randint(2015, date.today().year)
        elif re.search(r"(eta|age)$", n):
            v = caso.randint(18, 85)
        elif re.search(r"(riga|ordine_riga|num_riga|posizione)", n):
            v = i + 1
        else:
            v = round(caso.uniform(0, 1000), 2) if base == "reale" else caso.randint(1, 1000)
        return v
    # testo
    nome, cognome = caso.choice(NOMI), caso.choice(COGNOMI)
    if re.search(r"(ragione_sociale|azienda|societa|fornitore|denominazione|company)", n):
        v = f"{cognome} {caso.choice(AZIENDE)}"
    elif re.search(r"(cognome|surname)", n):
        v = cognome
    elif re.search(r"(^nome$|first_?name|^name$|nominativo|generalit)", n):
        v = nome if n in ("nome", "first_name", "firstname") else f"{nome} {cognome}"
    elif "email" in n or n == "mail":
        v = f"{nome.lower()}.{cognome.lower().replace(' ', '')}{i}@esempio.it"
    elif re.search(r"(telefono|cellulare|phone|tel$)", n):
        v = f"+39 3{caso.randint(20, 49)} {caso.randint(1000000, 9999999)}"
    elif re.search(r"(citta|comune|city|localita)", n):
        v = citta[0]
    elif re.search(r"(^provincia$|^prov$|sigla)", n):
        v = citta[1]
    elif re.search(r"(^cap$|postal|zip)", n):
        v = citta[2]
    elif re.search(r"(indirizzo|^via$|address)", n):
        v = f"{caso.choice(VIE)} {caso.randint(1, 120)}"
    elif re.search(r"(regione)", n):
        v = caso.choice(["Piemonte", "Lombardia", "Lazio", "Campania", "Emilia-Romagna", "Toscana", "Liguria", "Puglia", "Veneto"])
    elif re.search(r"(piva|partita_iva)", n):
        v = f"{caso.randint(10**10, 10**11 - 1)}"
    elif re.search(r"(codice_fiscale|cod_fisc|^cf$)", n):
        v = (cognome[:3] + nome[:3]).upper().ljust(6, "X") + f"{caso.randint(50, 99)}A{caso.randint(1, 28):02d}L219{chr(65 + i % 26)}"
    elif re.search(r"(descrizione|prodotto|articolo|titolo|description|title)", n):
        v = caso.choice(PRODOTTI)
    elif re.search(r"(stato|status)", n):
        v = caso.choice(STATI) if (_lunghezza(tipo) or 10) > 2 else caso.choice("ASC")
    elif re.search(r"(note|commento|comment)", n):
        v = caso.choice(PAROLE)
    elif re.search(r"(codice|^cod|code|sku)", n):
        v = f"{(colonna[:1] or 'C').upper()}{i + 1:04d}"
    elif "categoria" in n:
        v = caso.choice(["Viteria", "Utensili", "Ferramenta", "Elettrico"])
    else:
        v = f"{colonna} {i + 1}"
    lung = _lunghezza(tipo)
    return v[:lung] if lung and isinstance(v, str) else v


# ====================================================================== struttura

def _struttura(conn):
    tabelle = PR._tabelle(conn)
    info = {}
    for t in tabelle:
        colonne = [{"nome": r[1], "tipo": r[2] or "", "notnull": bool(r[3]), "default": r[4], "pk": r[5]}
                   for r in conn.execute(f"PRAGMA table_info({q(t)})")]
        uniche = []
        for ix in conn.execute(f"PRAGMA index_list({q(t)})"):
            if ix[2]:                                          # indice UNIQUE (anche quello della chiave primaria)
                uniche.append([r[2] for r in conn.execute(f"PRAGMA index_info({q(ix[1])})")])
        fk = {}
        for r in conn.execute(f"PRAGMA foreign_key_list({q(t)})"):
            g = fk.setdefault(r[0], {"da": t, "a": r[2], "colonne_da": [], "colonne_a": [], "on_delete": r[6], "on_update": r[5]})
            g["colonne_da"].append(r[3])
            g["colonne_a"].append(r[4])
        info[t] = {"colonne": colonne, "uniche": uniche, "fk": [f for f in fk.values() if f["a"] in tabelle]}
    return info


def _ordine(info, scelte):
    """I padri prima dei figli (le chiavi esterne verso se stessi e i cicli non bloccano)."""
    ordine, fatte = [], set()

    def visita(t, pila):
        if t in fatte or t in pila:
            return
        pila.add(t)
        for f in info[t]["fk"]:
            if f["a"] != t and f["a"] in scelte:
                visita(f["a"], pila)
        pila.discard(t)
        fatte.add(t)
        ordine.append(t)
    for t in sorted(scelte):
        visita(t, set())
    return ordine


def popola(tabelle=None, righe=20, con_padri=True, seme=None):
    """Riempie le tabelle scelte (tutte se None) con 'righe' righe ciascuna. con_padri: riempie anche le tabelle a cui
    puntano le chiavi esterne, se sono vuote. Restituisce per tabella righe inserite, scartate e il perché."""
    caso = random.Random(seme)
    righe = max(1, min(int(righe or 20), 5000))
    with PR.connetti() as conn:
        info = _struttura(conn)
        scelte = set(tabelle or info) & set(info)
        if not scelte:
            raise PR.ErroreProva("Scegli almeno una tabella del database di prova.")
        aggiunte = set()
        if con_padri:                                      # i padri vuoti delle tabelle scelte, anche a più livelli
            da_vedere = list(scelte)
            while da_vedere:
                t = da_vedere.pop()
                for f in info[t]["fk"]:
                    p = f["a"]
                    if p not in scelte and p not in aggiunte and conn.execute(f"SELECT COUNT(*) FROM {q(p)}").fetchone()[0] == 0:
                        aggiunte.add(p)
                        da_vedere.append(p)
        esiti = []
        for t in _ordine(info, scelte | aggiunte):
            esiti.append(_popola_tabella(conn, info, t, righe, caso, padre=t in aggiunte))
        conn.commit()
    return {"tabelle": esiti, "aggiunte": sorted(aggiunte)}


def _popola_tabella(conn, info, t, quante, caso, padre=False):
    I = info[t]
    colonne = I["colonne"]
    pk = sorted([c for c in colonne if c["pk"]], key=lambda c: c["pk"])
    # solo "INTEGER PRIMARY KEY" si numera da sola in SQLite; le altre chiavi intere (INT(11)...) le numeriamo noi
    auto = len(pk) == 1 and pk[0]["tipo"].strip().upper() == "INTEGER"
    prossimo = {}
    for c in pk:
        if not auto and _base(c["tipo"]) == "intero" and c["nome"] not in {x for f in I["fk"] for x in f["colonne_da"]}:
            prossimo[c["nome"]] = (conn.execute(f"SELECT MAX({q(c['nome'])}) FROM {q(t)}").fetchone()[0] or 0) + 1
    fk_di = {}
    for f in I["fk"]:
        for c in f["colonne_da"]:
            fk_di[c] = f
    # i valori possibili delle chiavi esterne: le righe che esistono nei padri (un campione)
    padri = {}
    for k, f in enumerate(I["fk"]):
        padri[k] = conn.execute(f"SELECT {', '.join(q(c) for c in f['colonne_a'])} FROM {q(f['a'])} "
                                f"ORDER BY RANDOM() LIMIT 2000").fetchall()
    indice_fk = {id(f): k for k, f in enumerate(I["fk"])}
    # relazione 1:1 (le colonne della chiave esterna sono UNIQUE o tutta la chiave primaria): ogni padre una volta sola
    unica = {k: sorted(f["colonne_da"]) in [sorted(u) for u in I["uniche"]] for k, f in enumerate(I["fk"])}
    for k in padri:
        if unica[k]:
            usati = {tuple(r) for r in conn.execute(f"SELECT {', '.join(q(c) for c in I['fk'][k]['colonne_da'])} FROM {q(t)}")}
            padri[k] = [r for r in padri[k] if tuple(r) not in usati]
            caso.shuffle(padri[k])
    partenza = conn.execute(f"SELECT COUNT(*) FROM {q(t)}").fetchone()[0]
    inserite, scartate, motivi = 0, 0, {}
    tentativi = 0
    while inserite < quante and tentativi < quante * 5:
        tentativi += 1
        i = partenza + inserite + tentativi
        riga, mancano = {}, None
        scelte_fk = {}
        for c in colonne:
            nome = c["nome"]
            if auto and c is pk[0]:
                continue
            f = fk_di.get(nome)
            if f is not None:
                k = indice_fk[id(f)]
                if k not in scelte_fk:
                    scelte_fk[k] = (padri[k].pop() if unica[k] else caso.choice(padri[k])) if padri[k] else None
                tupla = scelte_fk[k]
                if tupla is None:
                    if c["notnull"]:
                        mancano = (f"relazione 1:1: tutte le righe di {f['a']} hanno già una riga di {t}" if unica[k]
                                   else f"{f['a']} è vuota: la chiave esterna {nome} non ha valori da usare")
                        break
                    riga[nome] = None
                else:
                    riga[nome] = tupla[f["colonne_da"].index(nome)]
                continue
            if nome in prossimo:                            # chiave intera numerata da noi
                riga[nome] = prossimo[nome]
                prossimo[nome] += 1
                continue
            if c["default"] is not None and not c["notnull"] and caso.random() < 0.15:
                continue                                    # ogni tanto il valore di default
            if not c["notnull"] and not c["pk"] and caso.random() < 0.08:
                riga[nome] = None                           # qualche NULL dove è permesso
                continue
            riga[nome] = valore(nome, c["tipo"], i, caso)
            if isinstance(riga[nome], str) and [nome] in I["uniche"] and not c["pk"]:
                lung = _lunghezza(c["tipo"]) or 80               # UNIQUE: il numero della riga rende il valore unico
                suffisso = f" {i}"
                riga[nome] = riga[nome][: max(1, lung - len(suffisso))] + suffisso
            if c["pk"] and _base(c["tipo"]) == "testo" and len(pk) == 1:
                riga[nome] = f"{(nome[:1] or 'K').upper()}{i:05d}"[: _lunghezza(c["tipo"]) or 50]
        if mancano:
            motivi[mancano] = motivi.get(mancano, 0) + 1
            scartate += 1
            break
        try:
            conn.execute(f"SAVEPOINT riga")
            conn.execute(f"INSERT INTO {q(t)} ({', '.join(q(k) for k in riga)}) VALUES ({', '.join('?' * len(riga))})"
                         if riga else f"INSERT INTO {q(t)} DEFAULT VALUES", list(riga.values()))
            conn.execute("RELEASE riga")
            inserite += 1
        except sqlite3.Error as e:
            conn.execute("ROLLBACK TO riga")
            conn.execute("RELEASE riga")
            m = str(e)
            motivi[m] = motivi.get(m, 0) + 1
            scartate += 1
    totale = conn.execute(f"SELECT COUNT(*) FROM {q(t)}").fetchone()[0]
    return {"tabella": t, "inserite": inserite, "scartate": scartate, "motivi": motivi, "totale": totale, "padre": padre}


def svuota(tabelle=None):
    """Cancella le righe delle tabelle scelte (prima i figli)."""
    with PR.connetti() as conn:
        info = _struttura(conn)
        scelte = set(tabelle or info) & set(info)
        conn.execute("PRAGMA foreign_keys = OFF")
        for t in reversed(_ordine(info, scelte)):
            conn.execute(f"DELETE FROM {q(t)}")
        conn.commit()
    return {"svuotate": sorted(scelte)}


# ====================================================================== verifica delle chiavi esterne

def _non_esistente(conn, f, valori_tipo):
    """Un valore che nel padre non c'è, del tipo giusto."""
    fuori = []
    for c, tipo in zip(f["colonne_a"], valori_tipo):
        if _base(tipo) in ("intero", "reale"):
            massimo = conn.execute(f"SELECT MAX({q(c)}) FROM {q(f['a'])}").fetchone()[0] or 0
            fuori.append(int(massimo) + 987654)
        else:
            fuori.append("NON_ESISTE_987654")
    return fuori


def verifica():
    """Per ogni chiave esterna del database di prova: righe collegate e orfane, rifiuto di un figlio senza padre, cosa
    succede cancellando un padre usato. Le prove di scrittura si annullano."""
    with PR.connetti() as conn:
        info = _struttura(conn)
        risultati = []
        for t, I in info.items():
            for f in I["fk"]:
                risultati.append(_verifica_fk(conn, info, f))
        conn.rollback()
    problemi = [r for r in risultati if r["esito"] == "problema"]
    vuote = [r for r in risultati if r["esito"] == "da provare"]
    buone = len(risultati) - len(problemi) - len(vuote)
    sintesi = (f"{len(risultati)} chiavi esterne controllate: " +
               (f"{buone} funzionano" + (f", {len(problemi)} hanno problemi" if problemi else "") + "." if risultati else "nessuna.") +
               (f" {len(vuote)} non si possono ancora provare perché la tabella che le contiene è vuota: popolala." if vuote else ""))
    return {"chiavi": risultati, "sintesi": sintesi}


def _verifica_fk(conn, info, f):
    t, p = f["da"], f["a"]
    cd, ca = f["colonne_da"], f["colonne_a"]
    pieno = " AND ".join(f"c.{q(x)} IS NOT NULL" for x in cd)
    uguale = " AND ".join(f"p.{q(y)} = c.{q(x)}" for x, y in zip(cd, ca))
    figlie = conn.execute(f"SELECT COUNT(*) FROM {q(t)} c WHERE {pieno}").fetchone()[0]
    nulle = conn.execute(f"SELECT COUNT(*) FROM {q(t)} c WHERE NOT ({pieno})").fetchone()[0]
    orfani = conn.execute(f"SELECT COUNT(*) FROM {q(t)} c WHERE {pieno} AND NOT EXISTS (SELECT 1 FROM {q(p)} p WHERE {uguale})").fetchone()[0]
    esempi = []
    etichetta = lambda tab, escluse: next((c["nome"] for c in info[tab]["colonne"] if c["nome"] not in escluse and _base(c["tipo"]) == "testo"), None)
    e1, e2 = etichetta(t, cd), etichetta(p, ca)
    scelte = [f"c.{q(x)}" for x in cd] + ([f"c.{q(e1)}"] if e1 else []) + ([f"p.{q(e2)}"] if e2 else [])
    for r in conn.execute(f"SELECT {', '.join(scelte)} FROM {q(t)} c JOIN {q(p)} p ON {uguale} LIMIT 3"):
        esempi.append(list(r))
    colonne_esempi = [f"{t}.{x}" for x in cd] + ([f"{t}.{e1}"] if e1 else []) + ([f"{p}.{e2}"] if e2 else [])
    tipi_p = [next((c["tipo"] for c in info[p]["colonne"] if c["nome"] == y), "") for y in ca]

    # 1) un figlio con un padre che non c'è deve essere rifiutato
    rifiuta = None
    conn.execute("SAVEPOINT prova_fk")
    try:
        riga = conn.execute(f"SELECT * FROM {q(t)} LIMIT 1").fetchone()
        nomi = [c["nome"] for c in info[t]["colonne"]]
        if riga is not None:
            valori = dict(zip(nomi, riga))
            for c in info[t]["colonne"]:                   # chiave nuova, per non urtare la chiave primaria
                if c["pk"] and c["nome"] not in cd:
                    valori[c["nome"]] = None if _base(c["tipo"]) == "intero" and sum(1 for x in info[t]["colonne"] if x["pk"]) == 1 \
                        else (987654321 if _base(c["tipo"]) in ("intero", "reale") else "PROVA_987654")
            for x, v in zip(cd, _non_esistente(conn, f, tipi_p)):
                valori[x] = v
            for u in info[t]["uniche"]:                    # anche gli UNIQUE: valori nuovi
                for c in u:
                    if c not in cd and not any(cc["pk"] and cc["nome"] == c for cc in info[t]["colonne"]):
                        tipo = next((x["tipo"] for x in info[t]["colonne"] if x["nome"] == c), "")
                        valori[c] = 987654322 if _base(tipo) in ("intero", "reale") else f"PROVA_{c}_987654"
            try:
                conn.execute(f"INSERT INTO {q(t)} ({', '.join(q(k) for k in valori)}) VALUES ({', '.join('?' * len(valori))})", list(valori.values()))
                rifiuta = False
            except sqlite3.IntegrityError as e:
                rifiuta = "FOREIGN KEY" in str(e).upper()
                if not rifiuta:
                    rifiuta = None                         # rifiutato per un altro motivo: la prova non dice niente
    finally:
        conn.execute("ROLLBACK TO prova_fk")
        conn.execute("RELEASE prova_fk")

    # 2) cancellare un padre usato: bloccato, a cascata o a NULL, come dice il vincolo
    cancellazione = None
    conn.execute("SAVEPOINT prova_fk")
    try:
        padre = conn.execute(f"SELECT {', '.join(f'p.{q(y)}' for y in ca)} FROM {q(p)} p WHERE EXISTS (SELECT 1 FROM {q(t)} c WHERE {uguale}) LIMIT 1").fetchone()
        if padre is not None and p != t:
            prima = conn.execute(f"SELECT COUNT(*) FROM {q(t)} WHERE {' AND '.join(f'{q(x)} = ?' for x in cd)}", padre).fetchone()[0]
            try:
                conn.execute(f"DELETE FROM {q(p)} WHERE {' AND '.join(f'{q(y)} = ?' for y in ca)}", padre)
                dopo = conn.execute(f"SELECT COUNT(*) FROM {q(t)} WHERE {' AND '.join(f'{q(x)} = ?' for x in cd)}", padre).fetchone()[0]
                azione = (f["on_delete"] or "NO ACTION").upper()
                cancellazione = (f"a cascata: con il padre sono sparite {prima - dopo} righe figlie" if azione == "CASCADE" else
                                 f"messa a NULL in {prima} righe figlie" if azione == "SET NULL" else
                                 f"permessa ({azione}): {dopo} righe figlie restano orfane")
                cancellazione_ok = azione in ("CASCADE", "SET NULL", "SET DEFAULT")
            except sqlite3.IntegrityError:
                cancellazione = "bloccata: non si cancella un padre che ha dei figli"
                cancellazione_ok = True
        else:
            cancellazione_ok = None
    finally:
        conn.execute("ROLLBACK TO prova_fk")
        conn.execute("RELEASE prova_fk")

    problemi = []
    if orfani:
        problemi.append(f"{orfani} righe orfane")
    if rifiuta is False:
        problemi.append("accetta un figlio con un padre che non c'è (il vincolo non è attivo?)")
    if cancellazione_ok is False:
        problemi.append("cancellando un padre i figli restano orfani")
    esito = "ok" if not problemi and figlie else ("problema" if problemi else "da provare")
    return {"da": t, "colonne_da": cd, "a": p, "colonne_a": ca, "on_delete": f["on_delete"], "righe_figlie": figlie, "nulle": nulle,
            "orfani": orfani, "collegate": figlie - orfani, "rifiuta_orfano": rifiuta, "cancellazione": cancellazione,
            "esito": esito, "problemi": problemi, "esempi": esempi, "colonne_esempi": colonne_esempi}
