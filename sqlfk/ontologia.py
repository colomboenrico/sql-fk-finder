"""Ontologia OWL (Turtle) e mapping R2RML generati dallo schema analizzato.

Corrispondenze principali:
    tabella                 -> classe OWL (nome al singolare, CamelCase)
    colonna                 -> proprietà di dato (owl:DatatypeProperty) con il tipo XSD
    chiave esterna          -> proprietà d'oggetto (owl:ObjectProperty) dalla tabella figlia alla padre
    chiave primaria         -> owl:hasKey
    NOT NULL                -> restrizione di cardinalità minima 1
    relazione 1:1           -> proprietà funzionale e funzionale inversa
    tabella ponte senza attributi propri -> proprietà d'oggetto diretta N:M tra le due classi

Uso da terminale:
    python -m sqlfk.ontologia esempi --base http://example.org/negozio/
"""
import argparse
import re
import sys
from pathlib import Path

from . import analisi as A

TIPI_XSD = {
    "INT": "integer", "BIGINT": "integer", "SMALLINT": "integer", "TINYINT": "integer",
    "DECIMAL": "decimal", "FLOAT": "double", "DOUBLE": "double",
    "BOOLEAN": "boolean", "BIT": "boolean",
    "DATE": "date", "TIMESTAMP": "dateTime", "TIME": "time", "YEAR": "gYear",
    "UUID": "string", "CHAR": "string", "VARCHAR": "string", "TEXT": "string",
}

# Desinenze del plurale italiano che si possono tornare al singolare senza dubbi
SINGOLARI_SICURI_IT = (("zioni", "zione"), ("sioni", "sione"), ("tori", "tore"), ("sori", "sore"), ("ture", "tura"),
                       ("chi", "co"), ("ghi", "go"), ("che", "ca"), ("ghe", "ga"), ("ie", "ia"))


# ====================================================================== nomi

def parole(nome):
    """'tbl_ordini_righe' -> ['ordini', 'righe']; 'OrdiniRighe' -> ['ordini', 'righe']"""
    nome = A.senza_accenti(str(nome)).split(".")[-1]
    p = A.parti_nome(nome)
    if len(p) > 1 and p[0] in ("tbl", "tab", "tb", "t"):
        p = p[1:]
    return p or [A.normalizza(nome) or "x"]


def lingua_inglese(tabelle):
    """Le tabelle sembrano in inglese se molte finiscono con la s del plurale (customers, orders) o in consonante
    (strain, person): in italiano le parole finiscono quasi sempre in vocale."""
    finali = [parole(t)[-1] for t in tabelle]
    if not finali:
        return False
    plurale_s = sum(f.endswith("s") and not f.endswith("ss") for f in finali) / len(finali)
    consonante = sum(not f[-1:] in "aeiou" for f in finali) / len(finali)
    return plurale_s > 0.4 or consonante > 0.5


def indizi_singolari(S):
    """Parole che compaiono nello schema e servono a scegliere il singolare: id_ordine -> 'ordine'."""
    indizi = set()
    for t, colonne in S.col_per_tab.items():
        indizi.update(parole(t))
        for c in colonne:
            indizi.update(parole(c))
            rif = A.riferimento(c)
            if rif:
                indizi.update(parole(rif))
    return indizi


def singolare(parola, indizi, inglese):
    """Il singolare più sicuro: regole certe, poi gli indizi dello schema; altrimenti la parola com'è."""
    w = parola.lower()
    if w in A.IRREGOLARI_EN:
        return A.IRREGOLARI_EN[w]
    for fine, sostituto in ([] if inglese else SINGOLARI_SICURI_IT):
        if w.endswith(fine) and len(w) > len(fine) + 1:
            return w[:-len(fine)] + sostituto
    candidati = sorted(A.singolari(w) - {w}, key=len, reverse=True)
    for c in candidati:
        if c in indizi:
            return c
    if inglese or w.endswith("s"):
        if w.endswith("ies") and len(w) > 4:
            return w[:-3] + "y"
        if re.search(r"(ss|us|x|z|ch|sh)es$", w):
            return w[:-2]
        if w.endswith("s") and not w.endswith(("ss", "us", "is")) and len(w) > 3:
            return w[:-1]
    return w


def camel(lista, maiuscola):
    testo = "".join(p[:1].upper() + p[1:] for p in lista if p)
    testo = re.sub(r"[^A-Za-z0-9_]", "", testo) or "X"
    if testo[0].isdigit():
        testo = "N" + testo
    return testo[:1].upper() + testo[1:] if maiuscola else testo[:1].lower() + testo[1:]


def parole_colonna(c):
    """CODANAG -> ['codanag']; ragione_sociale -> ['ragione', 'sociale']; idCliente -> ['id', 'cliente']"""
    return [p for p in A.parti_nome(A.senza_accenti(c)) if p] or [A.normalizza(c) or "x"]


def stringa(testo):
    """Letterale Turtle tra virgolette."""
    return '"' + str(testo).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


# ====================================================================== modello

def modello(R, inglese=None):
    """Classi, proprietà e collegamenti ricavati dall'analisi (tabelle tolte escluse)."""
    S = R.S
    tabelle = sorted(S.col_per_tab)
    if inglese is None:
        inglese = lingua_inglese(tabelle)
    indizi = indizi_singolari(S)

    # ---- collegamenti: FK dichiarate e, per ogni colonna, la migliore trovata ad affidabilità alta
    collegamenti, viste = [], set()
    for r in R.fk_dichiarate.to_dict("records"):
        if r["tabella"] in S.col_per_tab and r["→ tabella"] in S.col_per_tab:
            da = [S.colonne_norm[r["tabella"]].get(A.normalizza(c.strip()), c.strip()) for c in r["colonna"].split(",")]
            a = [S.colonne_norm[r["→ tabella"]].get(A.normalizza(c.strip()), c.strip()) for c in r["→ colonna"].split(",")]
            collegamenti.append({"da": r["tabella"], "colonne": da, "a": r["→ tabella"], "colonne_a": a, "dichiarata": True})
            viste.add((r["tabella"], tuple(A.normalizza(c) for c in da)))
    buone = R.fk[(R.fk["affidabilità"] == "alta") & R.fk["tipi ok"] & ~R.fk["già dichiarata"] & (R.fk["→ colonna"] != "?")]
    ridondanti = {(r["tabella"], r["colonna"], r["→ tabella"]) for r in R.qualita.ridondanti.to_dict("records")}
    for r in buone.sort_values(["tabella", "colonna", "→ tabella"]).to_dict("records"):
        da = [c.strip() for c in r["colonna"].split(",")]
        chiave = (r["tabella"], tuple(A.normalizza(c) for c in da))
        if chiave in viste or (r["tabella"], r["colonna"], r["→ tabella"]) in ridondanti:
            continue                              # già presa, o relazione ridondante (W034)
        viste.add(chiave)
        collegamenti.append({"da": r["tabella"], "colonne": da, "a": r["→ tabella"],
                             "colonne_a": [c.strip() for c in r["→ colonna"].split(",")], "dichiarata": False})

    # ---- tabelle ponte N:M senza attributi propri: diventano una proprietà diretta, non una classe
    ponti = {}
    for t, chiave in S.pk_composta.items():
        uscenti = [l for l in collegamenti if l["da"] == t]
        coperte = {A.normalizza(c) for l in uscenti for c in l["colonne"]}
        destinazioni = {l["a"] for l in uscenti}
        altre = [c for c in S.col_per_tab[t] if A.normalizza(c) not in coperte]
        if (len(uscenti) == 2 and len(destinazioni) == 2 and not altre
                and {A.normalizza(c) for c in chiave} <= coperte):
            ponti[t] = uscenti

    # ---- classi
    classi, usati = {}, set()
    # prima le tabelle dello schema predefinito, così tengono il nome semplice
    for t in sorted(tabelle, key=lambda x: ("." in x, x)):
        if t in ponti:
            continue
        nome = camel([singolare(p, indizi, inglese) for p in parole(t)], True)
        if nome in usati and "." in t:            # stessa tabella in un altro schema: nome con lo schema
            nome = camel(A.parti_nome(t.split(".")[0]), True) + nome
        base, n = nome, 2
        while nome in usati:
            nome, n = f"{base}{n}", n + 1
        usati.add(nome)
        classi[t] = nome

    # ---- proprietà di dato: le colonne che non sono chiavi esterne
    colonne_fk = {(l["da"], A.normalizza(c)) for l in collegamenti for c in l["colonne"]}
    conteggio = {}
    for t in classi:
        for c in S.col_per_tab[t]:
            if (t, A.normalizza(c)) not in colonne_fk:
                k = camel(parole_colonna(c), False)
                conteggio[k] = conteggio.get(k, 0) + 1
    dati = {}                                     # (tabella, colonna) -> nome proprietà
    for t, classe in classi.items():
        for c in S.col_per_tab[t]:
            if (t, A.normalizza(c)) in colonne_fk:
                continue
            k = camel(parole_colonna(c), False)
            dati[(t, c)] = k if conteggio[k] == 1 else camel([classe] + parole_colonna(c), False)

    # ---- proprietà d'oggetto
    prefisso = "has" if inglese else "ha"
    oggetti = []
    for l in collegamenti:
        if l["da"] in ponti or l["da"] not in classi or l["a"] not in classi:
            continue
        verso = [x for x in collegamenti if x["da"] == l["da"] and x["a"] == l["a"] and x["da"] not in ponti]
        if len(verso) == 1:
            nome = prefisso + classi[l["a"]]
        else:                                     # più FK verso la stessa tabella: nome dalla colonna
            rif = A.riferimento(l["colonne"][0]) or l["colonne"][0]
            nome = prefisso + camel(parole_colonna(rif) + (parole_colonna(l["colonne"][1]) if len(l["colonne"]) > 1 else []), True)
        relazione, obbligatoria = A.tipo_relazione(S, l["da"], l["colonne"])
        oggetti.append({**l, "nome": nome, "relazione": relazione, "obbligatoria": obbligatoria})
    # nomi in conflitto con le proprietà di dato
    nomi_dati = set(dati.values())
    for o in oggetti:
        if o["nome"] in nomi_dati:
            o["nome"] += "Rel"

    nm = []
    for t, (l1, l2) in sorted(ponti.items()):
        if l1["a"] not in classi or l2["a"] not in classi:
            continue
        nome = camel(parole(t), False)              # la relazione prende il nome della tabella ponte
        nm.append({"ponte": t, "da": l1, "a": l2, "nome": nome,
                   "inverso": nome + ("Inverse" if inglese else "Inversa")})
    for p in nm:                                  # evita conflitti con altri nomi
        for chiave in ("nome", "inverso"):
            if p[chiave] in nomi_dati or any(o["nome"] == p[chiave] for o in oggetti):
                p[chiave] = p[chiave] + "Rel"

    return {"S": S, "classi": classi, "dati": dati, "oggetti": oggetti, "nm": nm,
            "ponti": ponti, "inglese": inglese}


# ====================================================================== OWL

def genera_owl(R, base, titolo="Ontologia", inglese=None):
    """Ontologia OWL 2 in Turtle."""
    M = modello(R, inglese)
    S, classi, dati, oggetti, nm = M["S"], M["classi"], M["dati"], M["oggetti"], M["nm"]
    ns = base.rstrip("/#") + "/ontologia#"
    righe = [
        f"@prefix : <{ns}> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
        "@prefix dct: <http://purl.org/dc/terms/> .",
        "",
        f"<{ns.rstrip('#')}> a owl:Ontology ;",
        f"    rdfs:label {stringa(titolo)} ;",
        f"    rdfs:comment {stringa('Generata da sql-fk-finder a partire dalle CREATE TABLE. Le proprietà annotate come proposte vengono da chiavi esterne trovate dai nomi delle colonne: vanno verificate.')} ;",
        "    dct:creator \"sql-fk-finder\" .",
        "",
        "# ---------------------------------------------------------------- classi",
    ]
    restrizioni = {t: [] for t in classi}

    for t, classe in classi.items():
        righe.append(f":{classe} a owl:Class ;")
        righe.append(f"    rdfs:label {stringa(classe)} ;")
        righe.append(f"    rdfs:comment {stringa(f'Tabella {t}')} .")
    righe += ["", "# ---------------------------------------------------------------- proprietà di dato"]
    dominio_dati = {}
    for (t, c), nome in dati.items():
        dominio_dati.setdefault(nome, []).append((t, c))
    for nome, uso in sorted(dominio_dati.items()):
        t, c = uso[0]
        xsd = TIPI_XSD.get(A.tipo_base(S.tipi.get((t, c))), "string")
        righe.append(f":{nome} a owl:DatatypeProperty, owl:FunctionalProperty ;")
        righe.append(f"    rdfs:label {stringa(c)} ;")
        tipo_sql = S.tipi.get((t, c)) or "?"
        righe.append(f"    rdfs:comment {stringa(f'Colonna {t}.{c} ({tipo_sql})')} ;")
        righe.append(f"    rdfs:domain :{classi[t]} ;")
        righe.append(f"    rdfs:range xsd:{xsd} .")
        if (t, c) in S.not_null:
            restrizioni[t].append(f"[ a owl:Restriction ; owl:onProperty :{nome} ; owl:minCardinality \"1\"^^xsd:nonNegativeInteger ]")

    righe += ["", "# ---------------------------------------------------------------- proprietà d'oggetto (chiavi esterne)"]
    per_nome = {}
    for o in oggetti:
        per_nome.setdefault(o["nome"], []).append(o)
    for nome, gruppo in sorted(per_nome.items()):
        o = gruppo[0]
        tipi = ["owl:ObjectProperty", "owl:FunctionalProperty"]
        if all(x["relazione"] == "1:1" for x in gruppo):
            tipi.append("owl:InverseFunctionalProperty")
        domini = sorted({classi[x["da"]] for x in gruppo})
        commenti = "; ".join(
            f"{x['da']}({', '.join(x['colonne'])}) -> {x['a']}({', '.join(x['colonne_a'])}), relazione {x['relazione']}, "
            + ("chiave esterna dichiarata" if x["dichiarata"] else "proposta da sql-fk-finder (affidabilità alta), da verificare")
            for x in gruppo)
        righe.append(f":{nome} a {', '.join(tipi)} ;")
        righe.append(f"    rdfs:label {stringa(nome)} ;")
        righe.append(f"    rdfs:comment {stringa(commenti)} ;")
        dominio = f":{domini[0]}" if len(domini) == 1 else f"[ a owl:Class ; owl:unionOf ( {' '.join(':' + d for d in domini)} ) ]"
        righe.append(f"    rdfs:domain {dominio} ;")
        righe.append(f"    rdfs:range :{classi[o['a']]} .")
        for x in gruppo:
            if x["obbligatoria"]:
                restrizioni[x["da"]].append(f"[ a owl:Restriction ; owl:onProperty :{nome} ; owl:minCardinality \"1\"^^xsd:nonNegativeInteger ]")

    if nm:
        righe += ["", "# ---------------------------------------------------------------- relazioni N:M (tabelle ponte senza attributi)"]
    for p in nm:
        c1, c2 = classi[p["da"]["a"]], classi[p["a"]["a"]]
        righe.append(f":{p['nome']} a owl:ObjectProperty ;")
        righe.append(f"    rdfs:label {stringa(p['nome'])} ;")
        ponte = p["ponte"]
        righe.append(f"    rdfs:comment {stringa(f'Relazione N:M tramite la tabella ponte {ponte}')} ;")
        righe.append(f"    rdfs:domain :{c1} ;")
        righe.append(f"    rdfs:range :{c2} ;")
        righe.append(f"    owl:inverseOf :{p['inverso']} .")
        righe.append(f":{p['inverso']} a owl:ObjectProperty ;")
        righe.append(f"    rdfs:label {stringa(p['inverso'])} ;")
        righe.append(f"    rdfs:domain :{c2} ;")
        righe.append(f"    rdfs:range :{c1} .")

    righe += ["", "# ---------------------------------------------------------------- chiavi e campi obbligatori"]
    proprieta_colonna = {}
    for (t, c), nome in dati.items():
        proprieta_colonna[(t, A.normalizza(c))] = nome
    for o in oggetti:
        for c in o["colonne"]:
            proprieta_colonna.setdefault((o["da"], A.normalizza(c)), o["nome"])
    for t, classe in classi.items():
        chiave = S.pk.get(t, [])
        if chiave and t not in S.pk_indovinata:
            props = []
            for c in chiave:
                p = proprieta_colonna.get((t, A.normalizza(c)))
                if p and p not in props:
                    props.append(p)
            if props:
                righe.append(f":{classe} owl:hasKey ( {' '.join(':' + p for p in props)} ) .")
        if restrizioni[t]:
            righe.append(f":{classe} rdfs:subClassOf")
            righe.append("    " + " ,\n    ".join(restrizioni[t]) + " .")
    return "\n".join(righe) + "\n", M


# ====================================================================== R2RML

def genera_r2rml(R, base, M=None, inglese=None):
    """Mapping R2RML: come trasformare le righe del database in individui dell'ontologia."""
    M = M or modello(R, inglese)
    S, classi, dati, oggetti, nm = M["S"], M["classi"], M["dati"], M["oggetti"], M["nm"]
    ns = base.rstrip("/#") + "/ontologia#"
    radice_dati = base.rstrip("/#") + "/dati/"
    righe = [
        f"@prefix : <{ns}> .",
        f"@prefix map: <{base.rstrip('/#')}/mapping#> .",
        "@prefix rr: <http://www.w3.org/ns/r2rml#> .",
        "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
        "",
    ]

    def soggetto(t, colonne=None):
        """Template dell'IRI di un individuo; colonne: quali colonne della tabella usare al posto della chiave."""
        chiave = colonne or S.pk.get(t, [])
        if not chiave:
            return None
        return f"{radice_dati}{classi[t]}/" + "/".join("{" + c + "}" for c in chiave)

    for t, classe in classi.items():
        righe.append(f"map:{classe} a rr:TriplesMap ;")
        righe.append(f"    rr:logicalTable [ rr:tableName {stringa(t)} ] ;")
        modello_iri = soggetto(t)
        if modello_iri:
            righe.append(f"    rr:subjectMap [ rr:template {stringa(modello_iri)} ; rr:class :{classe} ] ;")
        else:                                     # senza chiave primaria: nodi anonimi
            tutte = "/".join("{" + c + "}" for c in S.col_per_tab[t])
            righe.append(f"    rr:subjectMap [ rr:template {stringa(radice_dati + classe + '/' + tutte)} ; "
                         f"rr:termType rr:BlankNode ; rr:class :{classe} ] ;")
        mappe = []
        for c in S.col_per_tab[t]:
            nome = dati.get((t, c))
            if not nome:
                continue
            xsd = TIPI_XSD.get(A.tipo_base(S.tipi.get((t, c))), "string")
            tipo = "" if xsd == "string" else f" ; rr:datatype xsd:{xsd}"
            mappe.append(f"rr:predicateObjectMap [ rr:predicate :{nome} ; rr:objectMap [ rr:column {stringa(c)}{tipo} ] ]")
        for o in oggetti:
            if o["da"] != t:
                continue
            condizioni = " ".join(f"rr:joinCondition [ rr:child {stringa(c)} ; rr:parent {stringa(p)} ] ;"
                                  for c, p in zip(o["colonne"], o["colonne_a"])).rstrip(" ;")
            mappe.append(f"rr:predicateObjectMap [ rr:predicate :{o['nome']} ; rr:objectMap [ "
                         f"rr:parentTriplesMap map:{classi[o['a']]} ; {condizioni} ] ]")
        if mappe:                                 # la subjectMap termina con ';'
            righe += ["    " + m + (" ;" if i < len(mappe) - 1 else " .") for i, m in enumerate(mappe)]
        else:
            righe[-1] = righe[-1].rstrip(" ;") + " ."
        righe.append("")

    for p in nm:
        t = p["ponte"]
        c1, c2 = p["da"], p["a"]
        righe.append(f"map:{camel(parole(t), True)}_NM a rr:TriplesMap ;")
        righe.append(f"    rr:logicalTable [ rr:tableName {stringa(t)} ] ;")
        righe.append(f"    rr:subjectMap [ rr:template {stringa(soggetto(c1['a'], c1['colonne']))} ] ;")
        righe.append(f"    rr:predicateObjectMap [ rr:predicate :{p['nome']} ; "
                     f"rr:objectMap [ rr:template {stringa(soggetto(c2['a'], c2['colonne']))} ] ] .")
        righe.append("")
    return "\n".join(righe) + "\n"


def riepilogo(M):
    return {
        "classi": len(M["classi"]),
        "proprieta_dato": len(set(M["dati"].values())),
        "proprieta_oggetto": len({o["nome"] for o in M["oggetti"]}),
        "collegamenti": len(M["oggetti"]),
        "proposte": sum(not o["dichiarata"] for o in M["oggetti"]),
        "relazioni_nm": len(M["nm"]),
        "lingua": "inglese" if M["inglese"] else "italiano",
        "tabelle": [{"tabella": t, "classe": c} for t, c in sorted(M["classi"].items())],
        "ponti": [{"tabella": p["ponte"], "proprieta": p["nome"]} for p in M["nm"]],
    }


def base_predefinita(nome):
    slug = re.sub(r"[^a-z0-9]+", "-", A.senza_accenti(str(nome)).lower()).strip("-") or "database"
    return f"http://example.org/{slug}/"


# ====================================================================== terminale

def main():
    parser = argparse.ArgumentParser(prog="python -m sqlfk.ontologia",
                                     description="Genera l'ontologia OWL e il mapping R2RML da file .sql")
    parser.add_argument("cartella", help="cartella con i file .sql")
    parser.add_argument("--base", help="IRI di base, es. http://example.org/negozio/")
    parser.add_argument("--dialetto", default="mysql")
    parser.add_argument("--uscita", default=".", help="cartella in cui scrivere ontologia.ttl e mapping_r2rml.ttl")
    args = parser.parse_args()

    imp = A.Impostazioni(dialetto=args.dialetto)
    df, pk, fk, errori = A.leggi_cartella(args.cartella, imp.dialetto)
    if df.empty:
        print("errore: nessun CREATE TABLE trovato", file=sys.stderr)
        return 2
    R = A.analizza(df, pk, fk_dichiarate=fk, imp=imp)
    base = args.base or base_predefinita(Path(args.cartella).resolve().name)
    owl, M = genera_owl(R, base, Path(args.cartella).resolve().name)
    uscita = Path(args.uscita)
    (uscita / "ontologia.ttl").write_text(owl, encoding="utf-8")
    (uscita / "mapping_r2rml.ttl").write_text(genera_r2rml(R, base, M), encoding="utf-8")
    n = riepilogo(M)
    print(f"{n['classi']} classi, {n['proprieta_dato']} proprietà di dato, {n['proprieta_oggetto']} proprietà d'oggetto "
          f"per {n['collegamenti']} collegamenti ({n['proposte']} proposti da verificare), {n['relazioni_nm']} relazioni N:M "
          f"(nomi in {n['lingua']})")
    print(f"Salvati: {uscita / 'ontologia.ttl'}, {uscita / 'mapping_r2rml.ttl'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
