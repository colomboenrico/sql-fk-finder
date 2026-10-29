"""Lettura dei file .sql di qualsiasi dimensione, anche dump da decine di GB.

Il file si legge a blocchi e si divide in istruzioni con espressioni regolari (veloci, senza caricare
tutto in memoria). Per l'analisi servono solo le istruzioni di struttura (CREATE TABLE, ALTER TABLE...):
nei file grandi i dati (INSERT, REPLACE, COPY ... FROM stdin) si saltano e resta un testo "ridotto"
con una mappa che riporta ogni sua riga alla riga del file originale. I dati si rileggono dal file
solo quando servono, per esempio per le query.
"""

import bisect
import codecs
import re
import sys
from pathlib import Path

SOGLIA_RIDUZIONE = 64 * 1024 * 1024        # sopra questa dimensione il file si riduce alla sola struttura
BLOCCO = 16 * 1024 * 1024                  # caratteri letti alla volta
RIGHE_COPY = 20000                         # righe di dati di un COPY passate insieme
ISTRUZIONI_DATI = {"INSERT", "REPLACE", "COPY"}


def compila(espressione, opzioni=0):
    """re.compile. Prima di Python 3.11 i quantificatori possessivi (*+ ++ ?+) non esistono: la ripetizione
    esterna (?:...)*+ diventa (?=(?P<a>(?:...)*))(?P=a), che in Python si comporta come un gruppo atomico
    (niente ritorni indietro, che con le ripetizioni annidate sarebbero lentissimi), e gli altri si tolgono."""
    if sys.version_info >= (3, 11):
        return re.compile(espressione, opzioni)
    espressione = espressione.replace(r"/\*(?:[^*]++|\*(?!/))*+\*/", r"/\*[\s\S]*?\*/")
    if espressione.startswith("(?:"):
        fine = _chiusura(espressione, 0)
        if espressione.startswith("*+", fine + 1):
            gruppo = espressione[:fine + 1]
            espressione = f"(?=(?P<_atomo>{gruppo}*))(?P=_atomo)" + espressione[fine + 3:]
    espressione = re.sub(r"(?<!\\)([*+?}])\+", r"\1", espressione)
    return re.compile(espressione, opzioni)


def _chiusura(espressione, inizio):
    """Posizione della parentesi che chiude quella in inizio (salta escape e classi [...])."""
    livello, i, classe = 0, inizio, False
    while i < len(espressione):
        c = espressione[i]
        if c == "\\":
            i += 2
            continue
        if classe:
            classe = c != "]"
        elif c == "[":
            classe = True
            if espressione.startswith("]", i + 1) or espressione.startswith("^]", i + 1):
                i += 2 if espressione[i + 1] == "]" else 3
                continue
        elif c == "(":
            livello += 1
        elif c == ")":
            livello -= 1
            if livello == 0:
                return i
        i += 1
    raise ValueError("parentesi non chiusa")


class Mappa:
    """Righe del testo ridotto -> righe del file originale (e viceversa)."""

    def __init__(self, coppie=()):
        self.ridotte, self.originali = [], []
        for r, o in coppie:
            self.aggiungi(r, o)

    def aggiungi(self, ridotta, originale):
        self.ridotte.append(ridotta)
        self.originali.append(originale)

    def originale(self, riga):
        i = bisect.bisect_right(self.ridotte, riga) - 1
        return riga if i < 0 else self.originali[i] + riga - self.ridotte[i]

    def ridotta(self, riga):
        i = bisect.bisect_right(self.originali, riga) - 1
        return riga if i < 0 else self.ridotte[i] + riga - self.originali[i]

    def coppie(self):
        return list(zip(self.ridotte, self.originali))


class TestoSql(str):
    """Testo di un file .sql. Se ridotto contiene solo la struttura e ha la mappa delle righe;
    percorso è il file da cui rileggere i dati."""

    def __new__(cls, testo, percorso=None, mappa=None, dimensione=None, ridotto=False):
        s = super().__new__(cls, testo)
        s.percorso = Path(percorso) if percorso else None
        s.mappa = mappa
        s.dimensione = len(testo) if dimensione is None else dimensione
        s.ridotto = ridotto
        return s


# ====================================================================== divisione in istruzioni

def _espressione(dialetto):
    """Un'istruzione fino al terminatore, saltando stringhe, nomi tra virgolette e commenti."""
    if dialetto in ("mysql", "mariadb"):
        stringhe = r"'[^'\\]*+(?:\\.[^'\\]*+)*+'|\"[^\"\\]*+(?:\\.[^\"\\]*+)*+\"|`[^`]*+`|#[^\n]*+"
        resto = r"[^;'\"`\-/#]++"
    else:
        stringhe = r"'[^']*+'|\"[^\"]*+\""
        resto = r"[^;'\"\-/$\[\n]++" if dialetto == "tsql" else r"[^;'\"\-/$]++"
    if dialetto in ("postgres", "postgresql"):
        stringhe += r"|\$(?P<tag>(?:[A-Za-z_]\w*+)?)\$[\s\S]*?\$(?P=tag)\$"
    if dialetto == "tsql":
        stringhe += r"|\[[^\]]*+\]"
        # in SQL Server le istruzioni si possono separare anche con GO o andando a capo prima di una nuova istruzione
        nuova = r"(?:GO|INSERT)\b"             # GO separa i batch; gli script di dati hanno un INSERT per riga
        a_capo = rf"\n(?![ \t]*{nuova})"
        fine = rf";|\n(?=[ \t]*{nuova})"
    else:
        a_capo, fine = r"\n", ";"
    commenti = r"--[^\n]*+|/\*(?:[^*]++|\*(?!/))*+\*/"
    # un carattere che non inizia niente di speciale; se invece inizia un commento o un blocco $$ non finito
    # nel buffer non deve essere preso da solo, così si legge altro testo
    singoli = r"-(?!-)|/(?!\*)"
    if dialetto in ("postgres", "postgresql"):
        singoli += r"|\$(?!(?:[A-Za-z_]\w*+)?\$)"
    elif dialetto not in ("mysql", "mariadb"):
        singoli += r"|\$"
    return compila(rf"(?:{resto}|{stringhe}|{commenti}|{a_capo}|{singoli})*+(?:{fine})", re.I)


ESPRESSIONI = {}
RE_INIZIO = compila(r"(?:\s|--[^\n]*+(?:\n|$)|#[^\n]*+(?:\n|$)|/\*(?:[^*]++|\*(?!/))*+\*/)*+")
RE_PAROLA = compila(r"(?:\s|--[^\n]*+\n|#[^\n]*+\n|/\*(?:[^*]++|\*(?!/))*+\*/)*+\(*\s*(?P<parola>[A-Za-z]+)")
RE_COPY_STDIN = re.compile(r"COPY\b[\s\S]*\bFROM\s+stdin", re.I)
RE_GO = re.compile(r"^\s*GO\s*$", re.I)


def parola_iniziale(frase):
    m = RE_PAROLA.match(frase)
    return m.group("parola").upper() if m else ""


def _blocchi(sorgente, avanzamento=None):
    """Testo a blocchi da una stringa o da un file (con la codifica riconosciuta dal BOM).
    Un TestoSql ridotto si rilegge dal suo file, perché i dati non sono nel testo."""
    if isinstance(sorgente, str) and not getattr(sorgente, "ridotto", False):
        if avanzamento:
            avanzamento(len(sorgente))
        yield str(sorgente)
        return
    percorso = sorgente.percorso if isinstance(sorgente, TestoSql) else Path(sorgente)
    with open(percorso, "rb") as f:
        inizio = f.read(4)
        codifica, salta = "utf-8", 0
        if inizio.startswith(codecs.BOM_UTF8):
            salta = 3
        elif inizio.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
            codifica, salta = "utf-16", 0
        f.seek(salta)
        decodifica = codecs.getincrementaldecoder(codifica)(errors="replace")
        letti = salta
        while True:
            dati = f.read(BLOCCO)
            letti += len(dati)
            testo = decodifica.decode(dati, final=not dati)
            if avanzamento:
                avanzamento(letti)
            if testo:
                yield testo
            if not dati:
                return


def istruzioni(sorgente, dialetto="mysql", avanzamento=None):
    """Istruzioni di un testo o di un file, una alla volta, senza tenere in memoria tutto il file.

    Restituisce tuple (tipo, riga, testo, inizio_grezzo):
    - ("istruzione", riga, istruzione senza il terminatore, testo grezzo dal terminatore precedente);
    - ("dati", riga, [righe], None): righe di dati di un COPY ... FROM stdin (a gruppi, dopo il suo COPY);
    riga è il numero di riga (da 1) dove inizia l'istruzione o la prima riga di dati.
    """
    regola = ESPRESSIONI.get(dialetto) or ESPRESSIONI.setdefault(dialetto, _espressione(dialetto))
    blocchi = _blocchi(sorgente, avanzamento)
    buf, pos, riga, finito = "", 0, 1, False
    in_copy = False
    vuote = ""            # testo delle istruzioni vuote (il secondo ";" di "DELIMITER ;;"): va nel grezzo della successiva

    def leggi(quanto=1):
        """Aggiunge al buffer almeno quanto caratteri (un blocco se piccolo). False alla fine del file."""
        nonlocal buf, pos, finito
        nuovi = []
        letti = 0
        while letti < quanto:
            altro = next(blocchi, None)
            if altro is None:
                finito = True
                break
            nuovi.append(altro)
            letti += len(altro)
        if not nuovi:
            return False
        buf = buf[pos:] + "".join(nuovi)
        pos = 0
        return True

    while True:
        if in_copy:
            # righe di dati fino a una riga con "\."
            if buf.startswith("\\.", pos) and (pos == 0 or buf[pos - 1] == "\n"):
                fine = pos
            else:
                k = buf.find("\n\\.", pos)
                fine = k + 1 if k >= 0 else -1
            if fine >= 0:
                if fine + 3 > len(buf) and not finito and leggi():
                    continue                     # serve vedere come finisce la riga "\."
                righe = buf[pos:fine].split("\n")[:-1]
                yield from _a_gruppi(righe, riga)
                riga += len(righe)
                a_capo = buf.find("\n", fine)
                pos = len(buf) if a_capo < 0 else a_capo + 1
                riga += 1
                in_copy = False
                continue
            ultimo = buf.rfind("\n", pos)
            if ultimo >= pos:
                righe = buf[pos:ultimo].split("\n")
                yield from _a_gruppi(righe, riga)
                riga += len(righe)
                pos = ultimo + 1
            if not leggi():
                if buf[pos:]:
                    yield from _a_gruppi([buf[pos:]], riga)
                pos, in_copy = len(buf), False
                return
            continue

        m = regola.match(buf, pos)
        if m is None:
            # istruzione non finita nel buffer: si legge di più (il doppio, per le istruzioni molto lunghe)
            if not finito and leggi(max(1, len(buf) - pos)):
                continue
            resto = buf[pos:]
            if resto.strip():
                yield ("istruzione", riga + _righe_vuote(resto), resto.strip(), resto)
            return
        grezzo = buf[pos:m.end()]
        terminatore = grezzo[-1]
        corpo = grezzo[:-1] if terminatore == ";" else grezzo
        frase = corpo.strip()
        if frase and not (dialetto == "tsql" and RE_GO.match(frase)):
            if dialetto == "tsql":                # righe GO all'inizio o alla fine
                frase = re.sub(r"^(?:GO[ \t]*(?:\n|$)\s*)+|\n[ \t]*GO[ \t]*$", "", frase, flags=re.I).strip()
            base = corpo.find(frase[:200]) if dialetto == "tsql" else 0
            yield ("istruzione", riga + corpo.count("\n", 0, base) + _righe_vuote(corpo[base:]), frase, vuote + grezzo)
            vuote = ""
            if terminatore == ";" and RE_COPY_STDIN.match(frase[:2000]):
                in_copy = True
        elif not frase:
            vuote += grezzo
        riga += grezzo.count("\n")
        pos = m.end()
        if in_copy:
            # i dati iniziano alla riga dopo il ";"
            a_capo = buf.find("\n", pos)
            while a_capo < 0 and not finito and leggi():
                a_capo = buf.find("\n", pos)
            pos = len(buf) if a_capo < 0 else a_capo + 1
            riga += 1
        if pos > BLOCCO and pos > len(buf) // 2:
            buf, pos = buf[pos:], 0


def _righe_vuote(testo):
    """Righe di spazi e commenti prima della prima parola dell'istruzione."""
    return testo.count("\n", 0, RE_INIZIO.match(testo).end())


def _a_gruppi(righe, riga):
    for i in range(0, len(righe), RIGHE_COPY):
        yield ("dati", riga + i, [r[:-1] if r.endswith("\r") else r for r in righe[i:i + RIGHE_COPY]], None)


# ====================================================================== lettura dei file

def leggi_file(percorso, dialetto="mysql", avanzamento=None, soglia=SOGLIA_RIDUZIONE):
    """Il testo di un file .sql: intero se piccolo, altrimenti solo la struttura (senza i dati)."""
    percorso = Path(percorso)
    dimensione = percorso.stat().st_size
    if dimensione <= soglia:
        testo = "".join(_blocchi(percorso))
        if avanzamento:
            avanzamento(dimensione)
        return TestoSql(testo, percorso, dimensione=dimensione)

    parti, mappa = [], Mappa()
    righe_ridotte, saltata = 1, True        # righe del testo ridotto finora; l'istruzione precedente è stata saltata
    for tipo, riga, frase, grezzo in istruzioni(percorso, dialetto, avanzamento):
        if tipo == "dati":
            saltata = True
            continue
        if parola_iniziale(frase) in ISTRUZIONI_DATI:
            saltata = True
            continue
        if saltata:
            # l'istruzione inizia su una riga nuova del testo ridotto, che corrisponde alla sua riga nel file
            if parti:
                parti.append("\n")
                righe_ridotte += 1
            inizio = riga - _righe_vuote(grezzo.lstrip(";"))
            mappa.aggiungi(righe_ridotte, inizio)
            saltata = False
        testo = grezzo if grezzo.endswith((";", "\n")) else grezzo + ";"
        parti.append(testo)
        righe_ridotte += testo.count("\n")
    return TestoSql("".join(parti), percorso, mappa=mappa, dimensione=dimensione, ridotto=True)


def file_sql_di(percorsi):
    """I file .sql di una cartella o di un elenco di percorsi (cartelle o file)."""
    if isinstance(percorsi, (str, Path)):
        percorsi = [percorsi]
    trovati = []
    for p in percorsi:
        p = Path(p).expanduser()
        if p.is_dir():
            trovati += sorted(f for f in p.glob("*.sql") if f.is_file())
        elif p.is_file() and p.suffix.lower() == ".sql":
            trovati.append(p)
    return trovati


def leggi_percorsi(percorsi, dialetto="mysql", avanzamento=None, esclusi=()):
    """[(nome, TestoSql)] per tutti i file .sql. avanzamento(letti, totale, nome) riceve i byte letti."""
    file = [f for f in file_sql_di(percorsi) if f.name not in esclusi]
    totale = sum(f.stat().st_size for f in file)
    fatti, risultato = 0, []
    for f in file:
        def passo(letti, f=f, base=fatti):
            if avanzamento:
                avanzamento(base + letti, totale, f.name)
        risultato.append((f.name, leggi_file(f, dialetto, passo)))
        fatti += f.stat().st_size
    return risultato
