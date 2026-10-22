"""Reverse engineering del database: cosa rappresenta probabilmente ogni tabella e come si legge il database.

Per ogni tabella, con regole (nessuna intelligenza artificiale):
- un nome leggibile (al singolare quando è sicuro: comuni -> comune);
- la categoria (anagrafica, codifica, movimento, dettaglio, ponte, storico...) dall'analisi delle aree;
- il significato probabile delle colonne: identificativo, riferimento a un'altra tabella, date, importi,
  quantità, stato, tipologia, nomi e descrizioni, recapiti, codici, indicatori, allegati, posizione...;
- i "padri" (le tabelle a cui punta) e i "figli" (le tabelle che puntano a lei), con le chiavi dichiarate
  e quelle trovate ad affidabilità alta (senza le relazioni ridondanti);
- una descrizione in parole semplici, scritta come ipotesi ("probabilmente").

Il filo logico mette le tabelle di ogni area in un ordine che si legge bene: prima quelle da cui dipendono
le altre (anagrafiche, codifiche), poi movimenti, dettagli, ponti.
"""

import re
from collections import defaultdict, deque

from . import analisi as A
from . import modello as MR
from . import ontologia as O

# significato delle colonne: (parole esatte, inizi di parola, significato, gruppo). Si confrontano le PAROLE del
# nome della colonna (data_ordine -> data, ordine; dataOrdine -> data, ordine), non pezzi qualsiasi:
# "pathogenicity" non è una città e "commentontaxonomy" non è una tassa.
SIGNIFICATI = [
    ({"data", "date", "dt", "giorno", "day", "time", "ora", "timestamp", "created", "updated", "modified", "inserted", "scadenza",
      "nascita", "birth", "at", "on", "dal", "al", "inizio", "fine", "start", "end"}, ("datet", "timestam"), "data o momento", "date"),
    # i codici prima degli importi: partita_iva è un codice, non un'imposta
    ({"codice", "code", "cod", "sigla", "acronym", "acronimo", "abbrev", "iso", "cf", "piva", "fiscale", "partita"}, ("acronim",), "codice", "codici"),
    ({"importo", "prezzo", "price", "totale", "total", "costo", "cost", "amount", "imponibile", "iva", "vat", "tax", "sconto",
      "discount", "saldo", "balance", "valore", "value", "euro", "fee", "stipendio", "salary", "netto", "lordo"},
     ("importi", "prezz", "impor"), "importo o valore economico", "importi"),
    ({"qta", "qty", "quantita", "quantity", "pezzi", "grammi", "peso", "weight", "litri", "kg", "num", "numero", "count", "conteggio"},
     ("quantit",), "quantità o misura", "quantità"),
    ({"stato", "status", "state", "esito"}, (), "stato", "stato"),
    ({"tipo", "type", "tipologia", "categoria", "category", "classe", "class", "genere", "kind"}, ("tipolog",), "tipologia o classificazione", "tipologia"),
    ({"nome", "name", "cognome", "surname", "ragsoc", "denominazione", "titolo", "title", "label", "descrizione", "description",
      "descr", "desc", "fullname"}, ("descri", "denomin", "ragione"), "nome o descrizione", "nomi"),
    ({"mail", "email", "telefono", "phone", "tel", "cell", "cellulare", "fax", "indirizzo", "address", "via", "citta", "city", "cap",
      "zip", "nazione", "country", "web", "sito", "website", "comune"}, ("telefon", "indirizz", "addres"), "recapito o indirizzo", "recapiti"),
    ({"flag", "attivo", "active", "enabled", "abilitato", "is", "has", "visibile", "visible", "deleted", "cancellato", "public",
      "pubblico", "available"}, (), "indicatore sì/no", "indicatori"),
    ({"file", "path", "percorso", "url", "link", "img", "image", "immagine", "foto", "photo", "allegato", "attachment", "documento",
      "doc", "pdf", "filename"}, ("allegat", "attachm"), "file, link o allegato", "allegati"),
    ({"lat", "lon", "lng", "latitudine", "longitudine", "latitude", "longitude", "coord", "geom", "altitudine", "altitude"}, (),
     "posizione geografica", "posizione"),
    ({"note", "notes", "nota", "commento", "comment", "comments", "osservazioni", "remark", "remarks", "memo"},
     ("comment", "osservaz"), "note libere", "note"),
    ({"user", "utente", "login", "password", "pwd", "ruolo", "role", "username"}, (), "utente o accesso", "utenti"),
    ({"versione", "version", "rev", "revisione"}, (), "versione", "versioni"),
]
NOMI_GRUPPI = {"date": "date", "importi": "importi", "quantità": "quantità", "stato": "uno stato", "tipologia": "una tipologia",
               "nomi": "nomi e descrizioni", "recapiti": "recapiti", "codici": "codici", "indicatori": "indicatori sì/no",
               "allegati": "file o allegati", "posizione": "una posizione geografica", "note": "note", "utenti": "dati di accesso",
               "versioni": "versioni"}
TIPI_DATA = {"DATE", "DATETIME", "TIMESTAMP", "TIMESTAMPTZ", "TIME", "SMALLDATETIME", "DATETIME2"}
DETTAGLIO = {"righe", "riga", "dettaglio", "dettagli", "items", "item", "lines", "line", "rows", "voci", "details", "detail"}
ORDINE_CATEGORIE = {"anagrafica": 0, "codifica": 1, "dipendente": 2, "movimento": 3, "dettaglio": 4, "ponte": 5, "storico": 6, "isolata": 7}


def significato(colonna, tipo):
    """(significato, gruppo) di una colonna dalle parole del nome e dal tipo, o (None, None)."""
    parole = A.parti_nome(A.senza_accenti(str(colonna))) or [str(colonna).lower()]
    for esatte, inizi, testo, gruppo in SIGNIFICATI:
        if any(p in esatte or (len(p) >= 5 and p.startswith(inizi)) for p in parole):
            return testo, gruppo
    if A.tipo_base(tipo) in TIPI_DATA:
        return "data o momento", "date"
    if A.tipo_base(tipo) in ("BOOLEAN", "BOOL", "BIT"):
        return "indicatore sì/no", "indicatori"
    return None, None


def elenco(voci, massimo=4):
    voci = list(dict.fromkeys(v for v in voci if v))
    if len(voci) > massimo:
        voci = voci[:massimo] + [f"altre {len(voci) - massimo}"]
    if len(voci) <= 1:
        return "".join(voci)
    return ", ".join(voci[:-1]) + " e " + voci[-1]


def descrivi(R, gruppo_di=None):
    """{"tabelle": {tabella: scheda}, "filo": [aree con i passi], "sintesi": testo}"""
    S = R.S
    gruppo_di = gruppo_di or {}
    aree = getattr(R, "aree", None)
    categoria_di = aree.categoria_di if aree is not None else {}
    area_di = aree.area_di_tabella if aree is not None else {}
    centrali = set(aree.centrali) if aree is not None else set()
    inglese = O.lingua_inglese(list(S.col_per_tab))
    indizi = O.indizi_singolari(S)

    # collegamenti: dichiarati e trovati ad affidabilità alta, senza le relazioni ridondanti
    collegamenti = MR.struttura(R, gruppo_di, "collegamenti")["collegamenti"]
    padri, figli = defaultdict(list), defaultdict(list)
    for l in collegamenti:
        if l["da"] == l["a"]:
            continue
        padri[l["da"]].append({"tabella": l["a"], "colonne": l["colonne_da"], "tipo": l["tipo"], "relazione": l["relazione"],
                               "obbligatoria": l["obbligatoria"]})
        figli[l["a"]].append({"tabella": l["da"], "colonne": l["colonne_da"], "tipo": l["tipo"], "relazione": l["relazione"]})

    def nome(t):
        parole = O.parole(t)
        singolari = [O.singolare(p, indizi, inglese) for p in parole]
        if len(singolari) == 2 and parole[1] in DETTAGLIO:
            return f"{singolari[1]} di {singolari[0]}"
        return " ".join(singolari)

    def chi(t):
        return f"«{t}»"

    # candidate non scelte (affidabilità media o in conflitto): "possibile riferimento"
    possibili = defaultdict(dict)
    for r in R.fk[R.fk["→ colonna"] != "?"].to_dict("records"):
        for c in str(r["colonna"]).split(","):
            possibili[r["tabella"]].setdefault(A.normalizza(c.strip()), (r["→ tabella"], r["affidabilità"]))

    schede = {}
    for t, colonne in sorted(S.col_per_tab.items()):
        pk = S.pk.get(t, [])
        fk_col = {A.normalizza(c): p["tabella"] for p in padri[t] for c in p["colonne"]}
        forme_tabella = set().union(*(A.singolari(p) for p in O.parole(t)))
        righe_col, gruppi = [], defaultdict(list)
        for c in colonne:
            tipo = S.tipi.get((t, c)) or ""
            if A.normalizza(c) in fk_col:
                ruolo, testo = "FK", f"riferimento a {fk_col[A.normalizza(c)]}"
                if c in pk:
                    ruolo = "PK, FK"
            elif c in pk:
                ruolo, testo = "PK", "identificativo" if len(pk) == 1 else "parte dell'identificativo"
                if A.normalizza(c) in possibili[t]:
                    padre, aff = possibili[t][A.normalizza(c)]
                    ruolo, testo = "PK, FK?", f"{testo}; possibile riferimento a {padre} (affidabilità {aff})"
            elif A.normalizza(c) in possibili[t]:
                padre, aff = possibili[t][A.normalizza(c)]
                ruolo, testo = "FK?", f"possibile riferimento a {padre} (affidabilità {aff})"
            else:
                ruolo = ""
                if A.normalizza(c) in forme_tabella:          # regioni.regione: il nome del record
                    testo, gruppo = "nome o descrizione", "nomi"
                else:
                    testo, gruppo = significato(c, tipo)
                if gruppo:
                    gruppi[gruppo].append(c)
            righe_col.append({"colonna": c, "tipo": tipo, "ruolo": ruolo, "significato": testo or ""})
        categoria = categoria_di.get(t) or ("isolata" if not padri[t] and not figli[t] else "anagrafica" if figli[t] else "dipendente")
        parole_t = O.parole(t)
        padre_dal_nome = None
        if categoria in ("anagrafica", "codifica", "dipendente", "isolata") and len(parole_t) > 1 and parole_t[-1] in DETTAGLIO:
            # ordini_righe: righe di dettaglio di ordini, anche se la chiave esterna non è sicura
            trovate = [x for x in A.tabelle_per_nome(S, parole_t[0]) if x != t]
            if trovate:
                categoria, padre_dal_nome = "dettaglio", min(trovate, key=len)
        n = nome(t)
        contiene = elenco([f"{NOMI_GRUPPI[g]} ({', '.join(cs[:2])})" for g, cs in gruppi.items()])
        frase_contiene = f" Contiene {contiene}." if contiene else ""
        p_txt = elenco([f"{chi(p['tabella'])} ({', '.join(p['colonne'])})" for p in padri[t]])
        f_txt = elenco([chi(f["tabella"]) for f in figli[t]], 5)
        chiave = f"chiave {', '.join(pk)}" if pk else "nessuna chiave primaria"
        if categoria == "ponte" and len(padri[t]) >= 2:
            a, b = padri[t][0]["tabella"], padri[t][1]["tabella"]
            attributi = [c for c in colonne if A.normalizza(c) not in fk_col]
            sintesi = f"collega {chi(a)} e {chi(b)} (molti a molti)"
            testo = (f"Probabilmente collega {chi(a)} e {chi(b)} in una relazione molti a molti: ogni riga dice che un record di "
                     f"{chi(a)} è associato a uno di {chi(b)}" + (f", con {elenco(attributi)}" if attributi else "") + ".")
        elif categoria == "codifica":
            descr = next((r["colonna"] for r in righe_col if r["significato"] == "nome o descrizione"), None)
            sintesi = f"elenco semplice di «{n}»"
            testo = (f"Probabilmente un elenco semplice di «{n}», con pochi campi ({chiave}"
                     + (f", il nome in {descr}" if descr else "") + "): forse una tabella di codifica (valori fissi)"
                     + (f", usata da {f_txt}" if f_txt else "") + ".")
        elif categoria == "movimento":
            sintesi = f"operazioni o eventi di tipo «{n}» nel tempo"
            testo = (f"Probabilmente registra operazioni o eventi di tipo «{n}» nel tempo ({chiave})."
                     + (f" Ogni record si riferisce a {p_txt}." if p_txt else "") + frase_contiene
                     + (f" Ne dipendono {f_txt}." if f_txt else ""))
        elif categoria == "dettaglio" and padre_dal_nome and not padri[t]:
            sintesi = f"righe di dettaglio di {chi(padre_dal_nome)} (dal nome)"
            testo = (f"Probabilmente le righe di dettaglio di {chi(padre_dal_nome)}, come dice il nome; la chiave esterna non è "
                     f"sicura (verificare le colonne {', '.join(pk) or 'della chiave'})." + frase_contiene
                     + (f" È usata da {f_txt}." if f_txt else ""))
        elif categoria == "dettaglio" and padri[t]:
            principale = next((p for p in padri[t] if set(map(A.normalizza, p["colonne"])) <= set(map(A.normalizza, pk))), padri[t][0])
            altri = [p for p in padri[t] if p is not principale]
            sintesi = f"righe di dettaglio di {chi(principale['tabella'])}"
            testo = (f"Probabilmente le righe di dettaglio di {chi(principale['tabella'])}: ogni riga appartiene a un record di "
                     f"{chi(principale['tabella'])} ({', '.join(principale['colonne'])})"
                     + (f" e si riferisce a {elenco([chi(p['tabella']) for p in altri])}" if altri else "") + "." + frase_contiene)
        elif categoria == "storico":
            sintesi = f"storico o registro di «{n}»"
            testo = (f"Probabilmente uno storico o un registro: conserva eventi o versioni passate"
                     + (f" di {p_txt}" if p_txt else "") + "." + frase_contiene)
        elif categoria == "isolata":
            sintesi = "non collegata alle altre tabelle"
            testo = ("Non è collegata alle altre tabelle: probabilmente configurazione, parametri, un registro o dati importati "
                     f"({chiave})." + frase_contiene)
        elif categoria == "dipendente":
            sintesi = f"dati di «{n}» collegati a {elenco([chi(p['tabella']) for p in padri[t]])}"
            testo = (f"Probabilmente informazioni di tipo «{n}» che dipendono da altre tabelle ({chiave}): ogni record si riferisce a "
                     f"{p_txt}." + frase_contiene)
        else:                                     # anagrafica
            sintesi = f"anagrafica di «{n}»" + (" (tabella centrale)" if t in centrali else "")
            testo = (f"Probabilmente l'anagrafica di «{n}»: entità stabili, una per riga ({chiave})."
                     + (f" Ogni record si riferisce a {p_txt}." if p_txt else "") + frase_contiene
                     + (f" È usata da {f_txt}." if f_txt else "")
                     + (" È una tabella centrale: moltissime altre la usano." if t in centrali else ""))
        schede[t] = {"tabella": t, "nome": n, "area": area_di.get(t, ""), "gruppo": gruppo_di.get(t, t), "categoria": categoria,
                     "centrale": t in centrali, "sintesi": sintesi, "descrizione": testo, "colonne": righe_col,
                     "padre_dal_nome": padre_dal_nome if categoria == "dettaglio" and not padri[t] else None,
                     "padri": padri[t], "figli": figli[t]}

    # ---- filo logico: per area, prima le tabelle da cui dipendono le altre
    per_area = defaultdict(list)
    for t, s in schede.items():
        per_area[s["area"] or "tutte le tabelle"].append(t)
    filo = []
    for area, tabelle in sorted(per_area.items(), key=lambda x: (x[0] == "senza collegamenti", -len(x[1]), x[0])):
        insieme = set(tabelle)
        entrate = {t: {p["tabella"] for p in padri[t] if p["tabella"] in insieme} | ({schede[t]["padre_dal_nome"]} & insieme)
                   for t in tabelle}
        pronte = lambda: sorted((t for t, e in entrate.items() if not e),
                                key=lambda t: (not schede[t]["centrale"], ORDINE_CATEGORIE.get(schede[t]["categoria"], 9),
                                               -len(figli[t]), t))
        ordine = []
        while entrate:
            libere = pronte()
            if not libere:                         # un ciclo: si prende la tabella più usata
                libere = [max(entrate, key=lambda t: len(figli[t]))]
            t = libere[0]
            ordine.append(t)
            del entrate[t]
            for e in entrate.values():
                e.discard(t)
        radici = {t for t in tabelle if not ({p["tabella"] for p in padri[t] if p["tabella"] in insieme} |
                                             ({schede[t]["padre_dal_nome"]} & insieme))}
        cuore = [t for t in ordine if t in radici and any(f["tabella"] in insieme for f in figli[t])][:3]
        intro = (f"{len(tabelle)} tabelle." + (f" Si parte da {elenco([chi(t) for t in cuore])}, da cui dipendono le altre." if cuore else ""))
        passi = []
        for t in ordine:
            s = schede[t]
            da = [p["tabella"] for p in padri[t]]
            frase = f"{s['sintesi'][0].upper() + s['sintesi'][1:]}" + (f"; dipende da {elenco([chi(x) for x in da])}" if da and s["categoria"] not in ("ponte", "dettaglio") else "")
            passi.append({"tabella": t, "categoria": s["categoria"], "frase": frase + "."})
        filo.append({"area": area, "introduzione": intro, "passi": passi})

    piu_usate = sorted(schede, key=lambda t: -len(figli[t]))[:4]
    piu_usate = [t for t in piu_usate if figli[t]]
    conteggio = defaultdict(int)
    for s in schede.values():
        conteggio[s["categoria"]] += 1
    sintesi = (f"Il database ha {len(schede)} tabelle" + (f" in {len(filo)} aree" if len(filo) > 1 else "") + "."
               + (f" Le entità più usate dalle altre sono {elenco([chi(t) for t in piu_usate])}." if piu_usate else "")
               + " Per categoria: " + elenco([f"{n} {c}" for c, n in sorted(conteggio.items(), key=lambda x: ORDINE_CATEGORIE.get(x[0], 9))], 8) + "."
               + " Le descrizioni sono ipotesi ricavate da nomi, chiavi e collegamenti: vanno confermate con chi conosce il programma o con i dati.")
    return {"tabelle": schede, "filo": filo, "sintesi": sintesi}
