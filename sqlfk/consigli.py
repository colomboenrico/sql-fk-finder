"""Suggerimenti per migliorare un database, scritti come li darebbe un esperto: cosa cambiare, perché e come.

Tutto in locale, con regole: la diagnostica dell'analisi (chiavi mancanti, normalizzazione, tipi...) più controlli su
tipi, nomi e vincoli (importi in virgola mobile, date nel testo, campi ripetuti, parole riservate...). Nessun modello di
linguaggio e nessuna rete: le frasi si compongono dai risultati dei controlli.
"""
import re
from collections import Counter

from . import analisi as A

GRAVITA = {"errore": 0, "avviso": 1, "info": 2}

RISERVATE = {"order", "group", "user", "key", "table", "select", "where", "from", "index", "date", "time", "timestamp", "desc",
             "asc", "check", "column", "default", "limit", "range", "rank", "row", "rows", "values", "value", "type", "status",
             "position", "level", "comment", "condition", "option", "read", "release", "schema", "system", "union", "update",
             "delete", "insert", "primary", "references", "role", "session", "start", "end", "interval", "year", "month", "day"}
DENARO = re.compile(r"(prezzo|importo|totale|costo|saldo|imponibile|iva|sconto|price|amount|cost|total|balance|stipendio|salario)", re.I)
DATA = re.compile(r"(^data|_data$|^data_|date|^dt_|scadenza|nascita|_il$|creat|modific|aggiorn|timestamp)", re.I)
UNICO = re.compile(r"^(email|e_mail|mail|codice_fiscale|cod_fisc|cf|partita_iva|piva|p_iva|iban|username|login|isbn|ean|barcode|targa)$", re.I)
ETICHETTA = re.compile(r"^(nome|ragione_sociale|descrizione|titolo|denominazione|name|title|description)$", re.I)


def _tipo(S, t, c):
    return (S.tipi.get((t, c)) or "").upper()


def _base(tipo):
    return A.tipo_base(tipo) if tipo else ""


def _consiglio(gravita, tabella, colonna, titolo, perche, come="", correzione=None, regola=""):
    return {"gravità": gravita, "tabella": tabella or "", "colonna": colonna or "", "titolo": titolo, "perché": perche,
            "come": come, "correzione": correzione, "regola": regola}


# la diagnostica dell'analisi, detta in parole: (gravità, titolo, perché) per codice; il resto viene dal messaggio
FRASI = {
    "W030": "Dichiara la chiave esterna che già usi",
    "E010": "Aggiungi una chiave primaria",
    "I038": "Decidi se il collegamento è obbligatorio",
    "I032": "Valuta il tipo di relazione",
}


def dalla_diagnostica(R):
    fuori = []
    for d in R.diagnostica.to_dict("records"):
        titolo = FRASI.get(d["codice"]) or d["messaggio"][:1].upper() + d["messaggio"][1:]
        sql = d["suggerimento"] if str(d.get("suggerimento", "")).lstrip().upper().startswith(("ALTER", "CREATE")) else ""
        fuori.append(_consiglio(d["gravità"], d.get("tabella"), d.get("colonna"), titolo,
                                d["messaggio"][:1].upper() + d["messaggio"][1:] + ".",
                                sql or (d.get("suggerimento") or ""), None, d.get("regola") or ""))
    return fuori


def controlli(R):
    """I controlli in più su tipi, nomi e vincoli."""
    S = R.S
    fuori = []
    tabelle = sorted(S.col_per_tab)
    for t in tabelle:
        colonne = list(S.col_per_tab[t])
        pk = set(S.pk.get(t, []))
        unici = {c for (tt, c) in S.unique if tt == t} if isinstance(S.unique, set) else set()
        for c in colonne:
            tipo = _tipo(S, t, c)
            base = _base(tipo)
            if DENARO.search(c) and base in ("FLOAT", "DOUBLE", "REAL"):
                fuori.append(_consiglio(
                    "avviso", t, c, f"Usa DECIMAL per {t}.{c}",
                    f"{t}.{c} sembra un importo ma è {tipo}: i numeri in virgola mobile arrotondano (0,1 + 0,2 non fa 0,3) e nei conti "
                    "gli errori si sommano.", f"ALTER TABLE {t} MODIFY {c} DECIMAL(12,2);",
                    {"campo": "tipo", "valore": "DECIMAL(12,2)"}, "Tipi adatti ai dati"))
            if DATA.search(c) and base in ("VARCHAR", "CHAR", "TEXT", "NVARCHAR", "NCHAR", "VARCHAR2", "STRING"):
                fuori.append(_consiglio(
                    "avviso", t, c, f"Usa un tipo data per {t}.{c}",
                    f"{t}.{c} sembra una data ma è {tipo}: nel testo le date non si ordinano bene, non si controllano (31/02 passa) e "
                    "i confronti sono lenti.", f"ALTER TABLE {t} MODIFY {c} DATE;   -- o DATETIME se serve anche l'ora",
                    {"campo": "tipo", "valore": "DATE"}, "Tipi adatti ai dati"))
            if UNICO.match(c) and c not in pk and c not in unici:
                fuori.append(_consiglio(
                    "info", t, c, f"Rendi unico {t}.{c}",
                    f"{c} di solito identifica una sola riga: senza UNIQUE si possono inserire due {t} con lo stesso {c}.",
                    f"ALTER TABLE {t} ADD CONSTRAINT uq_{t}_{c} UNIQUE ({c});", {"campo": "uq", "valore": True}, "Integrità dei dati"))
            if ETICHETTA.match(c) and c not in pk and (t, c) not in S.not_null:
                fuori.append(_consiglio(
                    "info", t, c, f"Rendi obbligatorio {t}.{c}",
                    f"{c} è il dato che dice chi o cosa è una riga di {t}: una riga senza {c} di solito è un errore di inserimento.",
                    f"ALTER TABLE {t} MODIFY {c} {tipo or 'VARCHAR(100)'} NOT NULL;", {"campo": "nn", "valore": True}, "Integrità dei dati"))
            if c.lower() in RISERVATE:
                fuori.append(_consiglio(
                    "info", t, c, f"Rinomina la colonna {t}.{c}",
                    f"«{c}» è una parola riservata di SQL in qualche database: nelle query va sempre tra virgolette e prima o poi crea errori.",
                    f"un nome che dica cosa contiene, per esempio {c}_{t} o numero_{c}"))
            if base in ("VARCHAR", "NVARCHAR") and (m := re.search(r"\((\d+)\)", tipo)) and int(m.group(1)) > 2000:
                fuori.append(_consiglio("info", t, c, f"Riduci {t}.{c} o usa TEXT",
                                        f"VARCHAR({m.group(1)}) è molto lungo: se è un testo libero TEXT è più chiaro, se è un codice va più corto.",
                                        ""))
        if len(colonne) > 40:
            fuori.append(_consiglio("info", t, "", f"Dividi {t}: ha {len(colonne)} colonne",
                                    "Tabelle così larghe di solito mescolano più cose (anagrafica, indirizzi, impostazioni): dividerle in tabelle "
                                    "1:1 o 1:N le rende più chiare e veloci.", ""))
        if t.lower().startswith(("tbl_", "tab_", "t_")):
            fuori.append(_consiglio("info", t, "", f"Togli il prefisso dal nome {t}",
                                    "Prefissi come tbl_ non aggiungono informazioni: tutte le tabelle sono tabelle.", ""))
    # nomi coerenti: singolare e plurale, maiuscole
    plurali = [t for t in tabelle if re.search(r"[ie]$", t.lower())]
    singolari = [t for t in tabelle if re.search(r"[oa]$", t.lower()) and t not in plurali]
    if plurali and singolari and min(len(plurali), len(singolari)) >= max(2, len(tabelle) // 5):
        fuori.append(_consiglio("info", "", "", "Scegli nomi tutti al plurale o tutti al singolare",
                                f"Ci sono nomi al plurale ({', '.join(plurali[:4])}...) e al singolare ({', '.join(singolari[:4])}...): una "
                                "regola sola rende il database più facile da usare e da ricordare.", ""))
    stili = Counter("maiuscole" if re.search(r"[A-Z]", t) else "minuscole" for t in tabelle)
    if len(stili) > 1 and min(stili.values()) >= 1 and len(tabelle) > 3:
        fuori.append(_consiglio("info", "", "", "Usa uno stile solo per i nomi",
                                f"{stili['maiuscole']} tabelle hanno lettere maiuscole e {stili['minuscole']} no: su alcuni database e "
                                "sistemi operativi i nomi distinguono maiuscole e minuscole e le query si rompono.", ""))
    return fuori


def suggerimenti(R):
    """Tutti i consigli, i più importanti prima, con un punteggio di qualità da 0 a 100."""
    tutti = dalla_diagnostica(R) + controlli(R)
    visti, unici = set(), []
    for c in tutti:
        chiave = (c["titolo"], c["tabella"], c["colonna"])
        if chiave not in visti:
            visti.add(chiave)
            unici.append(c)
    unici.sort(key=lambda c: (GRAVITA.get(c["gravità"], 3), c["tabella"], c["colonna"]))
    conta = Counter(c["gravità"] for c in unici)
    tabelle = max(1, len(R.S.col_per_tab))
    penalita = (12 * conta["errore"] + 4 * conta["avviso"] + 1 * conta["info"]) / tabelle * 4
    punteggio = max(0, min(100, round(100 - penalita)))
    if punteggio >= 85:
        giudizio = "Il database è progettato bene: restano dettagli."
    elif punteggio >= 60:
        giudizio = "Il database è buono, ma alcune cose vanno sistemate."
    else:
        giudizio = "Il database ha problemi di progettazione da correggere prima di usarlo."
    principali = [c["titolo"] for c in unici if c["gravità"] != "info"][:3]
    sintesi = (f"{giudizio} Ho controllato {len(R.S.col_per_tab)} tabelle e trovato {conta['errore']} errori, {conta['avviso']} avvisi e "
               f"{conta['info']} consigli." + (f" Da cui partire: {'; '.join(principali)}." if principali else ""))
    return {"punteggio": punteggio, "sintesi": sintesi, "conta": dict(conta), "suggerimenti": unici}
