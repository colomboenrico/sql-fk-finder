"""Verifica con l'interfaccia grafica del software: come una persona che guarda le pagine.

L'app apre l'interfaccia del software (per esempio http://localhost:3000) e fotografa ogni pagina
(sqlfk/web/fotografia.js): titoli, moduli con i campi e le voci dei menu a tendina, tabelle con
intestazioni, valori e link, schede "etichetta: valore". Da queste fotografie, in locale e con regole
precise (nessun servizio esterno):

1. si ricavano le classi: ogni elenco, modulo o scheda è una vista di un'entità, con i suoi attributi;
2. ogni classe si collega a una tabella del database e ogni attributo a una colonna: per nome
   (plurali, accenti, sinonimi) e, se il database delle query è pronto, anche per i valori mostrati;
3. si ricavano le relazioni che l'interfaccia mostra:
   - un link da una cella o da un campo verso la pagina di un'altra entità,
   - un menu a tendina il cui nome (o le cui voci) indicano un'altra entità,
   - un elenco di un'entità dentro la scheda di un'altra (i figli dentro il padre),
   - un attributo che ha il nome di un'altra entità e corrisponde a una colonna (indizio debole);
4. si confrontano con le chiavi esterne dichiarate e previste: confermate, mancate, non viste,
   con precisione e richiamo per affidabilità.
"""

import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from types import SimpleNamespace
from urllib.parse import urlparse

import pandas as pd

from . import analisi as A

PAROLE_VUOTE = {"il", "lo", "la", "i", "gli", "le", "di", "del", "della", "dei", "delle", "e", "ed", "a", "da", "in", "per",
                "con", "su", "un", "una", "the", "of", "and", "or", "to", "for", "in", "on", "by", "with", "a", "an",
                "elenco", "lista", "list", "dettaglio", "dettagli", "detail", "details", "scheda", "nuovo", "nuova", "new",
                "modifica", "edit", "crea", "create", "aggiungi", "add", "gestione", "manage", "view", "vedi", "all",
                "tutti", "tutte", "cerca", "search", "pagina", "page", "home", "index", "info", "admin", "dashboard"}
FORTI = {"link", "menu", "valori", "elenco nella scheda"}


# ====================================================================== nomi

def parole(testo):
    """'Growth Media - List' -> ['growth', 'media']; 'strainDetails' -> ['strain', 'details']"""
    t = A.senza_accenti(str(testo or ""))
    t = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", t)
    return [p for p in re.split(r"[^A-Za-z0-9]+", t.lower()) if p and p not in PAROLE_VUOTE and not p.isdigit()]


def norm(testo):
    return re.sub(r"[^a-z0-9]", "", A.senza_accenti(str(testo or "")).lower())


def schema_url(url):
    """http://host/strains/123/edit?x=1 -> /strains/{id}/edit"""
    percorso = urlparse(url).path or "/"
    segmenti = []
    for s in percorso.strip("/").split("/"):
        if not s:
            continue
        if re.fullmatch(r"\d+|[0-9a-f]{8,}(-[0-9a-f]{4,})*|[A-Za-z]*\d[\w.-]*|%[0-9A-F]{2}.*", s, re.I):
            segmenti.append("{id}")
        else:
            segmenti.append(s)
    return "/" + "/".join(segmenti)


class Colonne:
    """Collega le etichette dell'interfaccia alle colonne delle tabelle."""

    def __init__(self, S):
        self.S = S
        self.norm = {t: {norm(c): c for c in cols} for t, cols in S.col_per_tab.items()}

    def colonna(self, tabella, etichetta, nome_campo=""):
        """La colonna di tabella che corrisponde a un'etichetta ("Collection ID" -> collectionid), o None."""
        cols = self.norm.get(tabella, {})
        if not cols:
            return None
        provati = [norm(nome_campo), norm(etichetta)] + [norm("".join(parole(etichetta)))]
        ws = parole(etichetta)
        if ws:
            provati += ["".join(ws[:-1]) if ws[-1] in ("id", "code", "codice", "cod", "name", "nome") and len(ws) > 1 else "",
                        "id" + "".join(ws), "".join(ws) + "id", "id" + ws[-1], ws[-1] + "id"]
        for p in provati:
            if p and p in cols:
                return cols[p]
        # plurali e singolari: "Collections" -> collection
        for p in provati[:3]:
            for forma in A.singolari(p) if p else ():
                if forma in cols:
                    return cols[forma]
        migliore, valore = None, 0.0
        base = provati[1] or provati[0]
        for n, c in cols.items():
            r = SequenceMatcher(None, base, n).ratio() if base else 0
            if r > valore:
                migliore, valore = c, r
        return migliore if valore >= 0.86 else None


# ====================================================================== dalle fotografie alle viste

def viste_di(fotografie):
    """Elementi dell'interfaccia: elenchi (tabelle), moduli e schede, uniti tra pagine con lo stesso schema di indirizzo."""
    elementi = {}

    def elemento(tipo, pagina, nome, foto):
        chiave = (tipo, pagina, norm(nome))
        if chiave not in elementi:
            elementi[chiave] = SimpleNamespace(tipo=tipo, pagina=pagina, nome=nome, url=foto["url"], titolo=foto.get("titolo", ""),
                                               intestazioni=foto.get("intestazioni", []), attributi={}, volte=0)
        e = elementi[chiave]
        e.volte += 1
        return e

    def attributo(e, nome, campo="", tipo="", valori=(), link=(), opzioni=()):
        if not nome or len(nome) > 80:
            return
        a = e.attributi.setdefault(nome, SimpleNamespace(nome=nome, campo=campo, tipo=tipo, valori=set(), link=set(), opzioni=[]))
        a.valori.update(v for v in valori if v and len(v) <= 80)
        a.link.update(link)
        if opzioni and not a.opzioni:
            a.opzioni = list(opzioni)

    for f in fotografie:
        pagina = schema_url(f["url"])
        principale = (f.get("intestazioni") or [f.get("titolo") or ""])[0]
        for t in f.get("tabelle", []):
            e = elemento("elenco", pagina, t.get("titolo") or principale, f)
            for i, intest in enumerate(t.get("intestazioni", [])):
                valori = [r[i] for r in t.get("righe", []) if i < len(r)]
                link = [h for r in t.get("link", []) if i < len(r) for h in r[i]]
                attributo(e, intest, valori=valori, link=link)
        for m in f.get("moduli", []):
            campi = m.get("campi", [])
            if len(campi) == 1 and not campi[0].get("opzioni") and \
                    (not campi[0].get("etichetta") or re.search(r"cerca|search|filtr|trova|find|query", campi[0].get("etichetta", "") + campi[0].get("nome", ""), re.I)):
                continue                    # una casella di ricerca da sola non descrive un'entità
            e = elemento("modulo", pagina, m.get("titolo") or principale, f)
            for c in m["campi"]:
                attributo(e, c.get("etichetta") or c.get("nome"), c.get("nome", ""), c.get("tipo", ""),
                          valori=[c.get("valore", "")], opzioni=[o.get("valore") or o.get("testo") for o in c.get("opzioni", [])])
        for d in f.get("dettagli", []):
            if len(d.get("coppie", [])) < 2:
                continue
            e = elemento("scheda", pagina, d.get("titolo") or principale, f)
            for c in d["coppie"]:
                attributo(e, c.get("etichetta"), valori=[c.get("valore", "")], link=c.get("link", []))
    return [e for e in elementi.values() if e.attributi]


# ====================================================================== collegamento al database

def valori_in(db, tabella, colonna, valori, limite=60):
    """Quota dei valori mostrati che si trovano nella colonna (solo se il database delle query è aperto)."""
    valori = [v for v in list(valori)[:limite] if v not in ("", "-", "null", "None")]
    if db is None or not valori or not tabella or not colonna:
        return None
    try:
        segnaposti = ", ".join("?" * len(valori))
        trovati = db.conn.execute(f'SELECT COUNT(DISTINCT CAST("{colonna}" AS TEXT)) FROM "{tabella}" '
                                  f'WHERE CAST("{colonna}" AS TEXT) IN ({segnaposti})', valori).fetchone()[0]
        return trovati / len(set(valori))
    except Exception:
        return None


def collega(elementi, R, db=None):
    """Per ogni elemento la tabella più adatta: (tabella, punteggio, motivo)."""
    S = R.S
    C = Colonne(S)
    risultato = {}
    for e in elementi:
        nomi = parole(e.nome) + [p for s in e.pagina.split("/") if s and s != "{id}" for p in parole(s)]
        per_nome = Counter()
        for p in nomi:
            for t in A.tabelle_per_nome(S, p):
                per_nome[t] += 1
        candidate = set(per_nome)
        # anche le tabelle con molte colonne uguali agli attributi
        etichette = list(e.attributi.values())
        if len(etichette) >= 2:
            for t in S.col_per_tab:
                if t in candidate:
                    continue
                uguali = sum(1 for a in etichette[:30] if norm(a.nome) in C.norm[t] or norm(a.campo) in C.norm[t])
                if uguali >= max(2, len(etichette) // 3):
                    candidate.add(t)
        migliore = (None, 0.0, "")
        for t in candidate:
            presi = [a for a in etichette if C.colonna(t, a.nome, a.campo)]
            quota = len(presi) / len(etichette) if etichette else 0
            punteggio = (2.0 if per_nome[t] else 0.0) + 3.0 * quota
            motivi = (["nome"] if per_nome[t] else []) + ([f"{len(presi)} di {len(etichette)} attributi sono colonne"] if presi else [])
            if db is not None and presi:
                quote = [q for q in (valori_in(db, t, C.colonna(t, a.nome, a.campo), a.valori) for a in presi[:6] if a.valori)
                         if q is not None]
                if quote:
                    media = sum(quote) / len(quote)
                    punteggio += 2.0 * media
                    motivi.append(f"valori trovati nei dati {round(100 * media)}%")
            if punteggio > migliore[1] or (punteggio == migliore[1] and migliore[0] and len(t) < len(migliore[0])):
                migliore = (t, punteggio, ", ".join(motivi))
        if migliore[0] and migliore[1] >= 1.0:
            risultato[id(e)] = migliore
    return risultato


# ====================================================================== relazioni mostrate dall'interfaccia

def nome_schermata(e):
    """Il nome di una schermata per le persone: il titolo della finestra o della pagina, con le schede scelte."""
    if e.url.startswith("finestra://"):
        parti = e.url.split("/")[3:]
        return " > ".join(p for p in parti if p) or e.titolo or e.pagina
    return (e.intestazioni[0] if e.intestazioni else "") or e.titolo or e.pagina


def relazioni(elementi, mappa, R, db=None):
    """[(tabella figlia, colonna o None, tabella padre, tipo di indizio, dove)]"""
    S = R.S
    C = Colonne(S)
    tabella_di_pagina = {}                         # schema di indirizzo -> tabella della sua entità principale
    scheda_di_pagina = {}                          # tabella di una scheda o di un modulo della pagina
    for e in elementi:
        t = mappa.get(id(e))
        if t and (e.pagina not in tabella_di_pagina or e.tipo in ("scheda", "modulo")):
            tabella_di_pagina[e.pagina] = t[0]
        if t and e.tipo in ("scheda", "modulo"):
            scheda_di_pagina.setdefault(e.pagina, t[0])
    # una pagina /strains/{id} senza scheda riconosciuta: la tabella del suo primo segmento
    for e in elementi:
        if e.pagina not in tabella_di_pagina:
            segmenti = [s for s in e.pagina.split("/") if s and s != "{id}"]
            if segmenti:
                trovate = A.tabelle_per_nome(S, segmenti[0])
                if trovate:
                    tabella_di_pagina[e.pagina] = min(trovate, key=len)

    risultato = []
    for e in elementi:
        if id(e) not in mappa:
            continue
        ta = mappa[id(e)][0]
        dove = f"{e.pagina} ({e.tipo} {e.nome})".strip()
        info = lambda attr=None: {"schermata": nome_schermata(e), "elemento": e.nome, "tipo": e.tipo, "attributo": attr}
        # elenco di un'altra entità dentro la scheda di questa pagina: i figli dentro il padre
        # (sul web la pagina di un record /x/{id}; nei programmi una schermata con la scheda o il modulo del padre)
        padre = scheda_di_pagina.get(e.pagina) or (tabella_di_pagina.get(e.pagina) if "{id}" in e.pagina else None)
        if e.tipo == "elenco" and padre and padre != ta:
            risultato.append((ta, None, padre, "elenco nella scheda", dove, info()))
        for a in e.attributi.values():
            colonna = C.colonna(ta, a.nome, a.campo)
            # 1. link verso la pagina di un'altra entità
            destinazioni = Counter(tabella_di_pagina.get(schema_url(h)) for h in a.link)
            destinazioni.pop(None, None)
            destinazioni.pop(ta, None)
            if destinazioni:
                risultato.append((ta, colonna, destinazioni.most_common(1)[0][0], "link", dove + f" · {a.nome}", info(a.nome)))
                continue
            per_nome = [t for p in parole(a.nome) for t in A.tabelle_per_nome(S, p) if t != ta]
            # 2. menu a tendina: il nome o le voci indicano l'entità puntata
            if a.tipo == "menu" or a.opzioni:
                padre = min(per_nome, key=len) if per_nome else None
                if a.opzioni and db is not None:
                    migliore = (padre, 0.0)
                    for t in (per_nome or list(S.pk_singola)):
                        q = valori_in(db, t, S.pk_singola.get(t), a.opzioni)
                        if q is not None and q > migliore[1]:
                            migliore = (t, q)
                    if migliore[1] >= 0.8:
                        risultato.append((ta, colonna, migliore[0], "menu", dove + f" · menu {a.nome}", info(a.nome)))
                        continue
                if padre:
                    risultato.append((ta, colonna, padre, "menu", dove + f" · menu {a.nome}", info(a.nome)))
                continue
            # 3. valori mostrati che sono i nomi dei record di un'altra entità ("Torino" in province): indizio forte
            if per_nome and a.valori and db is not None:
                padre = min(per_nome, key=len)
                quote = [valori_in(db, padre, c, a.valori) for c in S.col_per_tab.get(padre, [])[:12]]
                if max([q for q in quote if q is not None] or [0]) >= 0.8:
                    risultato.append((ta, colonna, padre, "valori", dove + f" · {a.nome}", info(a.nome)))
                    continue
            # 4. attributo con il nome di un'altra entità che corrisponde a una colonna (indizio debole)
            if per_nome and colonna and not (S.pk.get(ta) and colonna in S.pk[ta] and len(S.pk[ta]) == 1):
                risultato.append((ta, colonna, min(per_nome, key=len), "nome", dove + f" · {a.nome}", info(a.nome)))
    return risultato


# ====================================================================== confronto con le previsioni

def verifica(fotografie, R, db=None):
    S = R.S
    C = Colonne(S)
    elementi = viste_di(fotografie)
    mappa = collega(elementi, R, db)
    rel = relazioni(elementi, mappa, R, db)

    # ---- classi: gli elementi della stessa tabella sono la stessa classe
    per_tabella = defaultdict(list)
    for e in elementi:
        per_tabella[mappa[id(e)][0] if id(e) in mappa else f"? {e.nome or e.pagina}"].append(e)
    righe_classi, righe_attr = [], []
    for t, es in per_tabella.items():
        collegata = not t.startswith("? ")
        # il nome della classe: quello mostrato dall'interfaccia se indica l'entità, altrimenti quello della tabella
        adatti = [e.nome for e in es if e.nome and (not collegata or t in A.tabelle_per_nome(S, " ".join(parole(e.nome))) or
                                                     any(t in A.tabelle_per_nome(S, p) for p in parole(e.nome)))]
        nome = Counter(adatti).most_common(1) or ([(t.split(".")[-1].replace("_", " ").capitalize(), 1)] if collegata else
                                                 Counter(e.nome for e in es if e.nome).most_common(1))
        attributi = {}
        for e in es:
            for a in e.attributi.values():
                attributi.setdefault(norm(a.nome), a)
        presi = {k: C.colonna(t, a.nome, a.campo) for k, a in attributi.items()} if collegata else {}
        righe_classi.append({
            "classe": nome[0][0] if nome else (es[0].pagina if es else t), "tabella": t if collegata else "-",
            "motivo": max((mappa[id(e)] for e in es if id(e) in mappa), key=lambda x: x[1])[2] if collegata else "nessuna tabella adatta",
            "viste": ", ".join(sorted({f"{e.tipo}" for e in es})), "pagine": ", ".join(sorted({e.pagina for e in es}))[:200],
            "attributi": len(attributi), "attributi = colonne": sum(1 for v in presi.values() if v),
            "attributi senza colonna": ", ".join(a.nome for k, a in attributi.items() if not presi.get(k))[:200] or "-",
        })
        for k, a in attributi.items():
            righe_attr.append({"classe": righe_classi[-1]["classe"], "attributo": a.nome, "tabella": t if collegata else "-",
                               "colonna": presi.get(k) or "-", "tipo nell'interfaccia": a.tipo or "testo",
                               "esempi di valori": ", ".join(sorted(a.valori)[:5])[:150] or "-"})
    df_classi = pd.DataFrame(righe_classi).sort_values(["tabella", "classe"]).reset_index(drop=True) if righe_classi else \
        pd.DataFrame(columns=["classe", "tabella", "motivo", "viste", "pagine", "attributi", "attributi = colonne", "attributi senza colonna"])
    df_attr = pd.DataFrame(righe_attr, columns=["classe", "attributo", "tabella", "colonna", "tipo nell'interfaccia", "esempi di valori"])

    # ---- relazioni dell'interfaccia, unite per coppia di tabelle e colonna
    unite = {}
    for figlia, col, padre, tipo, dove, info in rel:
        k = (figlia, A.normalizza(col) if col else None, padre)
        v = unite.setdefault(k, {"figlia": figlia, "colonna": col, "padre": padre, "indizi": Counter(), "dove": [], "viste": []})
        v["indizi"][tipo] += 1
        if len(v["viste"]) < 3:
            v["viste"].append({**info, "indizio": tipo})
        if len(v["dove"]) < 4 and dove not in v["dove"]:
            v["dove"].append(dove)
    # le relazioni senza colonna valgono per la coppia di tabelle: si tolgono se c'è già quella con la colonna
    con_colonna = {(k[0], k[2]) for k in unite if k[1]}
    unite = {k: v for k, v in unite.items() if k[1] or (k[0], k[2]) not in con_colonna}

    def cols(r, chiave):
        return [A.normalizza(x.strip()) for x in str(r[chiave]).split(",")]

    dichiarate = R.fk_dichiarate.to_dict("records")
    previste = R.fk[~R.fk["già dichiarata"] & (R.fk["→ colonna"] != "?")].to_dict("records")

    def corrisponde(r, figlia, col, padre):
        if {r["tabella"], r["→ tabella"]} != {figlia, padre}:
            return False
        if col is None:
            return True
        return col in cols(r, "colonna") or col in cols(r, "→ colonna")

    def ponte(figlia, padre, elenco):
        """Una tabella ponte con una chiave verso ciascuna delle due tabelle (relazione N:M): (nome, [chiavi])."""
        verso = defaultdict(list)
        for r in elenco:
            verso[r["tabella"]].append(r)
        for t, rs in verso.items():
            a = [r for r in rs if r["→ tabella"] == figlia]
            b = [r for r in rs if r["→ tabella"] == padre]
            if a and b and t not in (figlia, padre):
                return t, a[:1] + b[:1]
        return None
    tutte = dichiarate + previste
    conferme_ponte = []                            # chiavi dei ponti confermate da un elenco nella scheda

    righe_rel = []
    for (figlia, col, padre), v in unite.items():
        forte = any(t in FORTI for t in v["indizi"])
        if any(corrisponde(r, figlia, col, padre) for r in dichiarate):
            esito = "chiave esterna dichiarata"
        else:
            trovate = [r for r in previste if corrisponde(r, figlia, col, padre)]
            if trovate:
                esito = "prevista (" + ("alta" if any(r["affidabilità"] == "alta" for r in trovate) else "media") + ")"
            elif any({r["tabella"], r["→ tabella"]} == {figlia, padre} for r in previste):
                esito = "mancata (previste altre colonne tra queste tabelle)"
            elif col is None and ponte(figlia, padre, tutte):
                nome_ponte, chiavi = ponte(figlia, padre, tutte)
                conferme_ponte.extend(chiavi)
                esito = f"N:M tramite {nome_ponte} (" + ("dichiarata" if all(k in dichiarate for k in chiavi) else "prevista") + ")"
            else:
                esito = "mancata"
        v["esito"], v["forte"] = esito, forte
        righe_rel.append({"esito": esito, "tabella": figlia, "colonna": v["colonna"] or "-", "→ tabella": padre,
                          "indizi": ", ".join(f"{t} {n}" for t, n in v["indizi"].most_common()),
                          "forza": "forte" if forte else "debole", "dove": " | ".join(v["dove"])})
    df_rel = pd.DataFrame(righe_rel, columns=["esito", "tabella", "colonna", "→ tabella", "indizi", "forza", "dove"])
    if len(df_rel):
        df_rel["_o"] = df_rel["esito"].map(lambda x: 0 if x.startswith("mancata") else 1)
        df_rel = df_rel.sort_values(["_o", "forza", "tabella"]).drop(columns="_o").reset_index(drop=True)

    # ---- le previsioni viste dall'interfaccia
    viste_tabelle = {mappa[id(e)][0] for e in elementi if id(e) in mappa}
    righe_prev, visti = [], set()
    for r in previste:
        k = (r["tabella"], r["colonna"], r["→ tabella"], r["→ colonna"])
        if k in visti:
            continue
        visti.add(k)
        conferme = [v for (f, c, p), v in unite.items() if corrisponde(r, f, c, p)]
        if not conferme and r in conferme_ponte:
            conferme = [{"indizi": Counter({"elenco nella scheda": 1}), "dove": ["relazione N:M vista nell'interfaccia"]}]
        if conferme:
            esito = "confermata dall'interfaccia" if any(any(t in FORTI for t in v["indizi"]) for v in conferme) else "indizio debole"
        elif r["tabella"] in viste_tabelle and r["→ tabella"] in viste_tabelle:
            esito = "non vista nell'interfaccia"
        else:
            esito = "non verificabile (tabelle non viste)"
        righe_prev.append({"esito": esito, "affidabilità": r["affidabilità"], "tabella": r["tabella"], "colonna": r["colonna"],
                           "→ tabella": r["→ tabella"], "→ colonna": r["→ colonna"],
                           "dove": " | ".join(d for v in conferme for d in v["dove"])[:200] or "-"})
    df_prev = pd.DataFrame(righe_prev, columns=["esito", "affidabilità", "tabella", "colonna", "→ tabella", "→ colonna", "dove"])
    if len(df_prev):
        df_prev = df_prev.sort_values(["esito", "affidabilità", "tabella"]).reset_index(drop=True)

    # ---- numeri
    def quota(a, b):
        return round(100 * a / b, 1) if b else None
    forti_non_dichiarate = df_rel[(df_rel["forza"] == "forte") & (df_rel["esito"] != "chiave esterna dichiarata")
                                  & ~df_rel["esito"].str.endswith("(dichiarata)")] if len(df_rel) else df_rel
    numeri = []
    for livello in ("alta", "media", "tutte"):
        p = df_prev if livello == "tutte" else df_prev[df_prev["affidabilità"] == livello]
        verificabili = p[~p["esito"].str.startswith("non verificabile")] if len(p) else p
        giuste = verificabili[verificabili["esito"] == "confermata dall'interfaccia"] if len(verificabili) else verificabili
        trovate = forti_non_dichiarate[forti_non_dichiarate["esito"].str.startswith("prevista") |
                                       forti_non_dichiarate["esito"].str.endswith("(prevista)")] if len(forti_non_dichiarate) else forti_non_dichiarate
        if livello != "tutte" and len(trovate):
            trovate = trovate[trovate["esito"] == f"prevista ({livello})"]
        numeri.append({"previsioni": livello, "previste": len(p), "verificabili": len(verificabili), "confermate": len(giuste),
                       "precisione %": quota(len(giuste), len(verificabili)),
                       "relazioni forti dell'interfaccia (non dichiarate)": len(forti_non_dichiarate),
                       "trovate dall'analisi": len(trovate), "richiamo %": quota(len(trovate), len(forti_non_dichiarate))})
    pagine = {schema_url(f["url"]) for f in fotografie}
    riepilogo = pd.DataFrame([
        ("Pagine fotografate", len(fotografie)), ("Pagine diverse (schemi di indirizzo)", len(pagine)),
        ("Elenchi, moduli e schede", len(elementi)), ("Classi", len(df_classi)),
        ("Classi collegate a una tabella", int((df_classi["tabella"] != "-").sum()) if len(df_classi) else 0),
        ("Attributi collegati a una colonna", int((df_attr["colonna"] != "-").sum()) if len(df_attr) else 0),
        ("Relazioni mostrate dall'interfaccia", len(df_rel)),
        ("di cui con indizi forti (link, menu, valori, elenchi nella scheda)", int((df_rel["forza"] == "forte").sum()) if len(df_rel) else 0),
        ("di cui mancate dall'analisi", int(df_rel["esito"].str.startswith("mancata").sum()) if len(df_rel) else 0),
        ("Confronto con i dati", "sì (database delle query aperto)" if db is not None else "no (costruisci il database nella pagina Query)"),
    ], columns=["voce", "valore"])
    spiegazione, mappa_sw = racconta(fotografie, elementi, mappa, unite, df_classi, df_attr, df_prev, numeri, R)
    return SimpleNamespace(riepilogo=riepilogo, numeri=pd.DataFrame(numeri), classi=df_classi, attributi=df_attr,
                           relazioni=df_rel, previsioni=df_prev, spiegazione=spiegazione, mappa=mappa_sw)


# ====================================================================== il racconto: come comunicano le parti

COME = {
    "menu": "il menu a tendina «{attributo}» del {tipo} «{elemento}» fa scegliere un record di {padre}",
    "valori": "la colonna «{attributo}» dell'{tipo} «{elemento}» mostra valori che sono record di {padre}",
    "link": "«{attributo}» nell'{tipo} «{elemento}» porta alla schermata di {padre}",
    "elenco nella scheda": "dentro la scheda di {padre} c'è l'elenco «{elemento}» dei suoi record di {figlia}",
    "nome": "l'{tipo} «{elemento}» ha il campo «{attributo}», che ha il nome di {padre} (indizio debole)",
}
TIPO_ELEMENTO = {"modulo": "modulo", "elenco": "elenco", "scheda": "scheda"}


def racconta(fotografie, elementi, mappa, unite, df_classi, df_attr, df_prev, numeri, R):
    """Il risultato in parole semplici, schermata per schermata, e i dati per la mappa del software."""
    S = R.S
    programmi = Counter(f["url"].split("/")[2] for f in fotografie if f["url"].startswith("finestra://"))
    nome_classe = {r["tabella"]: r["classe"] for r in df_classi.to_dict("records") if r["tabella"] != "-"}
    def chi(t):
        return f"«{nome_classe[t]}» (tabella {t})" if t in nome_classe else f"tabella {t}"

    frasi_per_schermata = defaultdict(list)
    relazioni_mappa = []
    for (figlia, _, padre), v in unite.items():
        col = v["colonna"]
        vista = v["viste"][0] if v["viste"] else {"schermata": "?", "elemento": "", "tipo": "", "attributo": "", "indizio": ""}
        come = COME.get(vista["indizio"], "{elemento}").format(attributo=vista.get("attributo") or "", elemento=vista.get("elemento") or "",
                                                               tipo=TIPO_ELEMENTO.get(vista.get("tipo"), "elemento"), padre=chi(padre), figlia=chi(figlia))
        pk = S.pk.get(padre, [])
        legame = f"ogni record di {chi(figlia)} è collegato a uno di {chi(padre)}" + \
                 (f" ({figlia}.{col} → {padre}.{', '.join(pk)})" if col else "")
        esito = v.get("esito", "")
        sql = ""
        if esito == "chiave esterna dichiarata":
            giudizio = "Nel database è già una chiave esterna dichiarata."
            stato = "dichiarata"
        elif esito.startswith("prevista"):
            giudizio = f"L'analisi l'aveva prevista (affidabilità {esito[10:-1]}): confermata dall'interfaccia."
            stato = "confermata"
        elif esito.startswith("N:M"):
            giudizio = f"È una relazione molti a molti tramite la tabella ponte {esito.split()[2]}, " + \
                       ("già dichiarata nel database." if esito.endswith("(dichiarata)") else "che l'analisi aveva previsto: confermata.")
            legame = f"un record di {chi(padre)} ha più record di {chi(figlia)} e viceversa"
            stato = "confermata"
        else:
            giudizio = "L'analisi non l'aveva prevista: è un collegamento da aggiungere al database (dopo averlo controllato)."
            stato = "mancata"
            if col and len(pk) == 1:
                sql = (f"ALTER TABLE {figlia} ADD CONSTRAINT {A.nome_vincolo(figlia, [col], padre)} "
                       f"FOREIGN KEY ({col}) REFERENCES {padre} ({pk[0]});")
        if not v.get("forte"):
            stato = "debole" if stato == "mancata" else stato
            giudizio += " È solo un indizio debole: da verificare."
        frasi_per_schermata[vista["schermata"]].append({
            "testo": f"{come[0].upper() + come[1:]}: {legame}. {giudizio}", "stato": stato, "sql": sql})
        relazioni_mappa.append({"da": figlia, "a": padre, "colonna": col or "", "verso": pk, "stato": stato,
                                "come": vista["indizio"], "schermata": vista["schermata"]})

    # previsioni che l'interfaccia non mostra
    non_viste = [f"{r['tabella']}.{r['colonna']} → {r['→ tabella']} (affidabilità {r['affidabilità']})"
                 for r in df_prev.to_dict("records") if r["esito"] == "non vista nell'interfaccia"] if len(df_prev) else []

    # classi della mappa: le entità viste, più le tabelle raggiunte solo da un collegamento
    attributi = defaultdict(list)
    for a in df_attr.to_dict("records"):
        if a["tabella"] != "-":
            attributi[a["tabella"]].append({"nome": a["attributo"], "colonna": a["colonna"]})
    schermate_di = defaultdict(set)
    for e in elementi:
        if id(e) in mappa:
            schermate_di[mappa[id(e)][0]].add(nome_schermata(e))
    classi = []
    for t in sorted(set(nome_classe) | {r["da"] for r in relazioni_mappa} | {r["a"] for r in relazioni_mappa}):
        classi.append({"tabella": t, "classe": nome_classe.get(t, ""), "schermate": sorted(schermate_di.get(t, [])),
                       "attributi": attributi.get(t, []), "vista": t in nome_classe, "pk": S.pk.get(t, [])})

    tot = next((n for n in numeri if n["previsioni"] == "tutte"), {})
    stati = Counter(r["stato"] for r in relazioni_mappa)
    sintesi = (
        (f"Ho letto {len(fotografie)} schermate" + (f" del programma {', '.join(programmi)}" if programmi else "") + ". ") +
        f"Mostrano {len(nome_classe)} entità, collegate ad altrettante tabelle del database. "
        f"Tra le entità ho visto {len(relazioni_mappa)} collegamenti: {stati['confermata']} confermano previsioni dell'analisi, "
        f"{stati['dichiarata']} sono chiavi esterne già dichiarate, {stati['mancata']} l'analisi non li aveva previsti"
        + (f", {stati['debole']} sono indizi deboli" if stati["debole"] else "") + ". " +
        (f"Delle {tot.get('verificabili', 0)} previsioni verificabili (con le due tabelle viste nell'interfaccia) "
         f"{tot.get('confermate', 0)} sono confermate: precisione {tot.get('precisione %')}%." if tot.get("verificabili") else
         "Nessuna previsione dell'analisi riguarda due tabelle viste nell'interfaccia.") +
        (f" {len(non_viste)} previsioni riguardano tabelle viste ma l'interfaccia non mostra il collegamento." if non_viste else ""))
    spiegazione = {"sintesi": sintesi,
                   "schermate": [{"nome": k, "frasi": v} for k, v in sorted(frasi_per_schermata.items())],
                   "non_viste": non_viste}
    return spiegazione, {"classi": classi, "relazioni": relazioni_mappa}
