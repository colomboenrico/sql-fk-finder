"""Modello relazionale (schema logico) ricavato dall'analisi, ed esportazioni in vari formati.

    testo     Fatture (numero (pk), data, id_cliente (fk → clienti), importo)   notazione dello schema logico
    md        lo stesso in Markdown, con le chiavi in evidenza
    mermaid   erDiagram (lo disegnano GitHub, Notion, mermaid.live)
    plantuml  diagramma delle entità di PlantUML
    dot       Graphviz: dot -Tpng modello.dot -o modello.png
    dbml      dbdiagram.io
    json      struttura completa

Uso da terminale:
    python -m sqlfk.modello esempi --formato mermaid > modello.mmd
"""
import argparse
import json
import re
import sys

from . import analisi as A

FORMATI = {"testo": "txt", "md": "md", "mermaid": "mmd", "plantuml": "puml", "dot": "dot", "dbml": "dbml", "json": "json"}


def struttura(R, gruppo_di=None, tipo="collegamenti", medie=False):
    """Tabelle con le colonne e collegamenti tra colonne.

    tipo: "iniziale" = solo chiavi esterne dichiarate; "collegamenti" = dichiarate più quelle trovate
    (una per colonna, la migliore; ad affidabilità alta, o anche media se medie=True; senza le relazioni ridondanti).
    """
    S = R.S
    gruppo_di = gruppo_di or {}
    fk_colonne = {}
    collegamenti = []

    def aggiungi(r, tipo_link):
        da = [c.strip() for c in r["colonna"].split(",")]
        a = [c.strip() for c in r["→ colonna"].split(",")]
        if r["tabella"] not in S.col_per_tab or r["→ tabella"] not in S.col_per_tab:
            return
        vere = [S.colonne_norm[r["tabella"]].get(A.normalizza(c), c) for c in da]
        relazione, obbligatoria = A.tipo_relazione(S, r["tabella"], vere)
        collegamenti.append({"da": r["tabella"], "colonne_da": vere, "a": r["→ tabella"], "colonne_a": a,
                             "tipo": tipo_link, "relazione": relazione, "obbligatoria": obbligatoria})
        for c in vere:
            fk_colonne.setdefault((r["tabella"], A.normalizza(c)), []).append(r["→ tabella"])

    for r in R.fk_dichiarate.to_dict("records"):
        aggiungi(r, "dichiarata")
    if tipo == "collegamenti":
        ridondanti = {(r["tabella"], r["colonna"], r["→ tabella"]) for r in R.qualita.ridondanti.to_dict("records")}
        scelte = set()
        candidate = R.fk[~R.fk["già dichiarata"] & (R.fk["→ colonna"] != "?")].to_dict("records")
        candidate.sort(key=lambda r: (r["affidabilità"] != "alta", not r["tipi ok"]))
        for r in candidate:
            if r["affidabilità"] == "media" and not medie:
                continue
            if (r["tabella"], r["colonna"]) in scelte or (r["tabella"], r["colonna"], r["→ tabella"]) in ridondanti:
                continue                      # una sola candidata per colonna, la migliore; niente ridondanze
            scelte.add((r["tabella"], r["colonna"]))
            aggiungi(r, r["affidabilità"])

    aree = getattr(R, "aree", None)
    tabelle = []
    for t, colonne in sorted(S.col_per_tab.items()):
        chiave = {A.normalizza(c) for c in S.pk.get(t, [])}
        tabelle.append({
            "nome": t, "gruppo": gruppo_di.get(t, t), "pk_indovinata": t in S.pk_indovinata,
            "area": aree.area_di_tabella.get(t, "") if aree else "",
            "categoria": aree.categoria_di.get(t, "") if aree else "",
            "colonne": [{"nome": c, "tipo": S.tipi.get((t, c)) or "",
                         "pk": A.normalizza(c) in chiave,
                         "fk": (t, A.normalizza(c)) in fk_colonne,
                         "verso": sorted(set(fk_colonne.get((t, A.normalizza(c)), []))),
                         "unique": (t, c) in S.unique, "not_null": (t, c) in S.not_null}
                        for c in colonne]})
    return {"tabelle": tabelle, "collegamenti": collegamenti}


# ====================================================================== esportazioni

def ident(nome):
    """Nome utilizzabile come identificatore: taxa.virus -> taxa_virus"""
    n = re.sub(r"[^A-Za-z0-9_]", "_", A.senza_accenti(nome))
    return n if not n[:1].isdigit() else "t_" + n


def tipo_semplice(tipo):
    return (A.tipo_base(tipo) or "text").lower()


def come_testo(M, markdown=False):
    """Schema logico: Tabella (chiave (pk), attributo, colonna (fk → tabella), ...)"""
    righe = []
    if markdown:
        righe += ["# Modello relazionale", "",
                  "Chiave primaria in **grassetto**, chiavi esterne in *corsivo* con la tabella a cui puntano.", ""]
    for t in M["tabelle"]:
        parti = []
        for c in t["colonne"]:
            nome = c["nome"]
            if markdown:
                if c["pk"]:
                    nome = f"**{nome}**"
                if c["fk"]:
                    nome = f"*{nome}* → {', '.join(c['verso'])}"
            else:
                segni = (["pk"] if c["pk"] else []) + ([f"fk → {', '.join(c['verso'])}"] if c["fk"] else [])
                if segni:
                    nome += f" ({'; '.join(segni)})"
            parti.append(nome)
        nota = " (chiave primaria non dichiarata)" if t["pk_indovinata"] else ""
        righe.append(("- " if markdown else "") + f"{t['nome']} ({', '.join(parti)}){nota}")
    if not markdown:
        righe += ["", "pk = chiave primaria; fk → tabella = chiave esterna verso la tabella indicata"]
    return "\n".join(righe) + "\n"


def come_mermaid(M):
    righe = ["erDiagram"]
    for t in M["tabelle"]:
        righe.append(f"    {ident(t['nome'])} {{")
        for c in t["colonne"]:
            chiavi = ", ".join(k for k, v in (("PK", c["pk"]), ("FK", c["fk"]), ("UK", c["unique"] and not c["pk"])) if v)
            righe.append(f"        {tipo_semplice(c['tipo'])} {ident(c['nome'])}" + (f" {chiavi}" if chiavi else ""))
        righe.append("    }")
    for l in M["collegamenti"]:
        figlio = ("|o" if not l["obbligatoria"] else "||") if l["relazione"] == "1:1" else ("}o" if not l["obbligatoria"] else "}|")
        righe.append(f"    {ident(l['da'])} {figlio}--|| {ident(l['a'])} : \"{', '.join(l['colonne_da'])}\"")
    return "\n".join(righe) + "\n"


def come_plantuml(M):
    righe = ["@startuml", "hide circle", "skinparam linetype ortho", ""]
    for t in M["tabelle"]:
        righe.append(f'entity "{t["nome"]}" as {ident(t["nome"])} {{')
        chiave = [c for c in t["colonne"] if c["pk"]]
        altre = [c for c in t["colonne"] if not c["pk"]]
        for c in chiave:
            righe.append(f"  * {c['nome']} : {c['tipo'] or '?'} <<PK>>" + (" <<FK>>" if c["fk"] else ""))
        righe.append("  --")
        for c in altre:
            righe.append(f"  {'* ' if c['not_null'] else ''}{c['nome']} : {c['tipo'] or '?'}" + (" <<FK>>" if c["fk"] else ""))
        righe.append("}")
        righe.append("")
    for l in M["collegamenti"]:
        figlio = ("|o" if not l["obbligatoria"] else "||") if l["relazione"] == "1:1" else ("}o" if not l["obbligatoria"] else "}|")
        righe.append(f"{ident(l['da'])} {figlio}--|| {ident(l['a'])}")
    righe.append("@enduml")
    return "\n".join(righe) + "\n"


def _html(testo):
    return str(testo).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def come_dot(M):
    righe = ["digraph modello {", "  graph [rankdir=LR, splines=true, nodesep=0.5, ranksep=1.2];",
             '  node [shape=plain, fontname="Helvetica"];', '  edge [color="#1f4e79", arrowhead=crow, arrowtail=tee, dir=both];', ""]
    for t in M["tabelle"]:
        celle = [f'<tr><td bgcolor="#1f4e79" colspan="2"><font color="white"><b>{_html(t["nome"])}</b></font></td></tr>']
        for c in t["colonne"]:
            nome = _html(c["nome"])
            if c["pk"]:
                nome = f"<u>{nome}</u>"
            if c["fk"]:
                nome = f"<i>{nome}</i>"
            celle.append(f'<tr><td align="left" port="{ident(c["nome"])}">{nome}</td>'
                         f'<td align="left" port="{ident(c["nome"])}_d"><font color="#7a8594">{_html((c["tipo"] or "").lower())}</font></td></tr>')
        righe.append(f'  {ident(t["nome"])} [label=<<table border="1" cellborder="0" cellspacing="0" cellpadding="4">'
                     + "".join(celle) + "</table>>];")
    righe.append("")
    for l in M["collegamenti"]:
        stile = "" if l["tipo"] == "dichiarata" else ' [style=dashed, color="#2e7d32"]'
        # dal padre (a sinistra) alla colonna chiave esterna del figlio (a destra): linea corta, zampa di gallina sul lato N
        righe.append(f"  {ident(l['a'])}:{ident(l['colonne_a'][0])}_d:e -> {ident(l['da'])}:{ident(l['colonne_da'][0])}:w{stile};")
    righe.append("}")
    return "\n".join(righe) + "\n"


def come_dbml(M):
    righe = []
    for t in M["tabelle"]:
        nome = t["nome"]
        righe.append(f"Table {nome} {{" if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", nome) else f'Table "{nome}" {{')
        chiave = [c["nome"] for c in t["colonne"] if c["pk"]]
        for c in t["colonne"]:
            opzioni = [k for k, v in (("pk", c["pk"] and len(chiave) == 1), ("not null", c["not_null"] and not c["pk"]),
                                      ("unique", c["unique"] and not c["pk"])) if v]
            righe.append(f'  "{c["nome"]}" {tipo_semplice(c["tipo"])}' + (f" [{', '.join(opzioni)}]" if opzioni else ""))
        if len(chiave) > 1:
            righe += ["  indexes {", f"    ({', '.join(chiave)}) [pk]", "  }"]
        righe += ["}", ""]
    for l in M["collegamenti"]:
        segno = "-" if l["relazione"] == "1:1" else ">"
        da = l["colonne_da"][0] if len(l["colonne_da"]) == 1 else "(" + ", ".join(l["colonne_da"]) + ")"
        a = l["colonne_a"][0] if len(l["colonne_a"]) == 1 else "(" + ", ".join(l["colonne_a"]) + ")"
        righe.append(f"Ref: {l['da']}.{da} {segno} {l['a']}.{a}")
    return "\n".join(righe) + "\n"


def esporta(M, formato):
    """Testo del modello nel formato richiesto (vedi FORMATI)."""
    if formato == "testo":
        return come_testo(M)
    if formato == "md":
        return come_testo(M, markdown=True)
    if formato == "mermaid":
        return come_mermaid(M)
    if formato == "plantuml":
        return come_plantuml(M)
    if formato == "dot":
        return come_dot(M)
    if formato == "dbml":
        return come_dbml(M)
    if formato == "json":
        return json.dumps(M, ensure_ascii=False, indent=2) + "\n"
    raise ValueError(f"Formato sconosciuto: {formato}")


def main():
    parser = argparse.ArgumentParser(prog="python -m sqlfk.modello", description="Esporta il modello relazionale")
    parser.add_argument("cartella", help="cartella con i file .sql")
    parser.add_argument("--formato", default="testo", choices=list(FORMATI))
    parser.add_argument("--dialetto", default="mysql")
    parser.add_argument("--solo-dichiarate", action="store_true", help="solo le chiavi esterne già dichiarate")
    args = parser.parse_args()
    imp = A.Impostazioni(dialetto=args.dialetto)
    df, pk, fk, _ = A.leggi_cartella(args.cartella, imp.dialetto)
    if df.empty:
        print("errore: nessun CREATE TABLE trovato", file=sys.stderr)
        return 2
    R = A.analizza(df, pk, fk_dichiarate=fk, imp=imp)
    _, gruppo_di = A.raggruppa_tabelle(df["tabella"].unique(), imp)
    M = struttura(R, gruppo_di, "iniziale" if args.solo_dichiarate else "collegamenti")
    print(esporta(M, args.formato), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
