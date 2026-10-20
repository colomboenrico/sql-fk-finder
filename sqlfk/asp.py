"""Scelta delle chiavi esterne con clingo (Answer Set Programming), tutto in locale.

L'analisi propone molte candidate; alcune sono in conflitto (le stesse colonne verso tabelle diverse),
altre creano relazioni ridondanti o hanno tipi incompatibili. Qui si descrivono le candidate come fatti
ASP e le regole di sqlfk/regole_fk.lp chiedono a clingo l'insieme di chiavi esterne più coerente:
- le chiavi già dichiarate restano;
- le stesse colonne puntano al massimo a una tabella;
- si preferiscono le candidate ad affidabilità alta e quelle confermate dall'interfaccia del programma
  (pagina Verifica con l'interfaccia), comprese quelle che solo l'interfaccia mostra;
- si penalizzano tipi incompatibili e relazioni ridondanti (X -> Z quando c'è X -> Y -> Z).
Poi si spiega, per ogni candidata, perché è stata scelta o scartata.

Uso da terminale:
    python -m sqlfk.asp cartella_dei_file_sql [--dialetto postgres] [--medie]
"""

import argparse
import time
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

from . import analisi as A

REGOLE = Path(__file__).resolve().parent / "regole_fk.lp"

try:
    import clingo
except ImportError:                        # clingo è tra le librerie dell'app; nel notebook si installa con pip
    clingo = None


def disponibile():
    return clingo is not None


def candidate_da(R, verifica=None, medie=False):
    """Le candidate con gli indizi: dichiarate, trovate dall'analisi, confermate o viste nell'interfaccia."""
    S = R.S
    elenco, indice = [], {}

    def aggiungi(tabella, colonne, padre, colonne_padre, **indizi):
        colonne = [c.strip() for c in str(colonne).split(",")] if isinstance(colonne, str) else list(colonne)
        colonne_padre = [c.strip() for c in str(colonne_padre).split(",")] if isinstance(colonne_padre, str) else list(colonne_padre)
        if tabella not in S.col_per_tab or padre not in S.col_per_tab:
            return None
        k = (tabella, tuple(sorted(A.normalizza(c) for c in colonne)), padre)
        if k in indice:
            c = elenco[indice[k]]
            for nome, valore in indizi.items():
                if valore and not c.get(nome):
                    c[nome] = valore
            return c
        indice[k] = len(elenco)
        c = {"tabella": tabella, "colonne": colonne, "padre": padre, "colonne_padre": colonne_padre, **indizi}
        elenco.append(c)
        return c

    for r in R.fk_dichiarate.to_dict("records"):
        aggiungi(r["tabella"], r["colonna"], r["→ tabella"], r["→ colonna"], dichiarata=True)
    for r in R.fk[~R.fk["già dichiarata"] & (R.fk["→ colonna"] != "?")].to_dict("records"):
        if r["affidabilità"] == "media" and not medie:
            continue
        aggiungi(r["tabella"], r["colonna"], r["→ tabella"], r["→ colonna"], affidabilita=r["affidabilità"],
                 tipi_diversi=not r["tipi ok"], sql=r["sql"])

    if verifica is not None:
        # quello che il programma mostra: conferme e relazioni che l'analisi non aveva trovato
        for r in verifica.previsioni.to_dict("records"):
            if r["esito"] in ("confermata dall'interfaccia", "indizio debole"):
                c = aggiungi(r["tabella"], r["colonna"], r["→ tabella"], r["→ colonna"], affidabilita=r["affidabilità"])
                if c:
                    c["confermata" if r["esito"].startswith("confermata") else "debole"] = True
        for r in verifica.relazioni.to_dict("records"):
            if r["esito"].startswith("mancata") and r["colonna"] != "-" and r["forza"] == "forte":
                pk = S.pk.get(r["→ tabella"], [])
                if len(pk) == 1:
                    aggiungi(r["tabella"], [r["colonna"]], r["→ tabella"], pk, da_interfaccia=True, confermata=True)

    # parti della chiave composta di una tabella ponte (relazione N:M)
    ponti = set(R.qualita.ponti["tabella ponte"]) if len(R.qualita.ponti) else set()
    for c in elenco:
        if c["tabella"] in ponti and {A.normalizza(x) for x in c["colonne"]} <= {A.normalizza(x) for x in S.pk.get(c["tabella"], [])}:
            c["ponte"] = True
    return elenco


def fatti(candidate, R=None):
    """Le candidate come fatti ASP (con numeri al posto dei nomi)."""
    tabelle = {t: i for i, t in enumerate(sorted({c["tabella"] for c in candidate} | {c["padre"] for c in candidate}))}
    verso = defaultdict(set)
    for c in candidate:
        if c["tabella"] != c["padre"]:
            verso[c["tabella"]].add(c["padre"])
    chiavi = {}
    righe = []
    for i, c in enumerate(candidate):
        k = chiavi.setdefault((c["tabella"], tuple(sorted(A.normalizza(x) for x in c["colonne"]))), len(chiavi))
        righe.append(f"candidata({i}). da({i},{tabelle[c['tabella']]}). a({i},{tabelle[c['padre']]}). chiave({i},{k}).")
        for nome, fatto in (("dichiarata", "dichiarata"), ("tipi_diversi", "tipi_diversi"), ("confermata", "confermata"),
                            ("debole", "debole"), ("da_interfaccia", "da_interfaccia"), ("ponte", "ponte")):
            if c.get(nome):
                righe.append(f"{fatto}({i}).")
        if c.get("affidabilita") in ("alta", "media"):
            righe.append(f"{c['affidabilita']}({i}).")
        x, z = c["tabella"], c["padre"]
        if any(z in verso.get(y, ()) for y in verso.get(x, ()) if y not in (x, z)):
            righe.append(f"scorciatoia({i}).")
        if R is not None:
            pk_x = sorted(A.normalizza(v) for v in R.S.pk.get(x, []))
            pk_z = sorted(A.normalizza(v) for v in R.S.pk.get(z, []))
            if pk_x and pk_x == pk_z and sorted(A.normalizza(v) for v in c["colonne"]) == pk_x:
                righe.append(f"stessa_chiave({i}).")
    if R is not None and getattr(R, "aree", None) is not None:
        for t in R.aree.centrali:
            if t in tabelle:
                righe.append(f"centrale({tabelle[t]}).")
    commento = ["% tabelle: " + ", ".join(f"{i}={t}" for t, i in tabelle.items())]
    return "\n".join(commento + righe) + "\n"


def risolvi(R, verifica=None, medie=False, secondi=30):
    """L'insieme di chiavi esterne scelto da clingo, con il motivo di ogni scelta e di ogni scarto."""
    if clingo is None:
        raise RuntimeError("clingo non è installato (pip install clingo): è incluso negli eseguibili dell'app.")
    candidate = candidate_da(R, verifica, medie)
    programma = REGOLE.read_text(encoding="utf-8")
    testo_fatti = fatti(candidate, R)
    inizio = time.time()
    ctl = clingo.Control(["--opt-mode=opt", "--warn=none"])
    ctl.add("base", [], programma + "\n" + testo_fatti)
    ctl.ground([("base", [])])
    migliore = {"scelte": set(), "ridondanti": set(), "costo": None, "ottimo": False, "modelli": 0}

    def su_modello(m):
        migliore["modelli"] += 1
        migliore["scelte"] = {s.arguments[0].number for s in m.symbols(shown=True) if s.name == "scelta"}
        migliore["ridondanti"] = {s.arguments[0].number for s in m.symbols(shown=True) if s.name == "ridondante"}
        migliore["costo"] = list(m.cost)
        migliore["ottimo"] = m.optimality_proven

    with ctl.solve(on_model=su_modello, async_=True) as h:
        finito = h.wait(secondi)
        if not finito:
            h.cancel()
        esito = h.get()
    durata = time.time() - inizio
    ottimo = bool(finito and esito.exhausted) or migliore["ottimo"]

    # ---- spiegazioni
    scelte = migliore["scelte"]
    per_chiave = defaultdict(list)
    for i, c in enumerate(candidate):
        per_chiave[(c["tabella"], tuple(sorted(A.normalizza(x) for x in c["colonne"])))].append(i)
    archi = defaultdict(set)
    for i in scelte:
        archi[candidate[i]["tabella"]].add(candidate[i]["padre"])

    def motivo_scelta(c):
        if c.get("dichiarata"):
            return "già dichiarata nel database"
        parti = []
        if c.get("da_interfaccia"):
            parti.append("vista solo nell'interfaccia del programma")
        elif c.get("confermata"):
            parti.append("confermata dall'interfaccia del programma")
        if c.get("affidabilita"):
            parti.append(f"affidabilità {c['affidabilita']}")
        if c.get("ponte"):
            parti.append("parte di una tabella ponte (N:M)")
        if c.get("debole"):
            parti.append("indizio debole nell'interfaccia")
        if c.get("tipi_diversi"):
            parti.append("ATTENZIONE: tipi diversi")
        return ", ".join(parti) or "nessun conflitto"

    def motivo_scarto(i, c):
        rivali = [j for j in per_chiave[(c["tabella"], tuple(sorted(A.normalizza(x) for x in c["colonne"])))] if j in scelte and j != i]
        if rivali:
            altra = candidate[rivali[0]]
            return f"le stesse colonne puntano già a {altra['padre']} ({motivo_scelta(altra)})"
        intermedie = [y for y in archi[c["tabella"]] if y != c["padre"] and c["padre"] in archi.get(y, set())]
        if intermedie:
            return f"ridondante: c'è già {c['tabella']} → {intermedie[0]} → {c['padre']}"
        if c["tabella"] == c["padre"]:
            return "punta alla stessa tabella: serve una conferma (dichiarata o vista nell'interfaccia)"
        pk_x = sorted(A.normalizza(v) for v in R.S.pk.get(c["tabella"], []))
        if pk_x and pk_x == sorted(A.normalizza(v) for v in R.S.pk.get(c["padre"], [])) and \
                sorted(A.normalizza(v) for v in c["colonne"]) == pk_x:
            return "le due tabelle hanno la stessa chiave primaria: collegamento 1:1 di direzione incerta, da confermare con l'interfaccia"
        if c["padre"] in archi and c["tabella"] in archi[c["padre"]]:
            return f"c'è già {c['padre']} → {c['tabella']}: due tabelle non si puntano a vicenda"
        if c.get("tipi_diversi"):
            return "tipi delle colonne non compatibili"
        # sceglierla renderebbe ridondante un'altra già scelta (o ne servirebbe una scartata)
        x, y = c["tabella"], c["padre"]
        for z in archi.get(y, set()):
            if z in archi.get(x, set()) and z != x:
                return f"renderebbe ridondante {x} → {z}, già scelta (percorso {x} → {y} → {z})"
        if not c.get("affidabilita") or c.get("affidabilita") == "media":
            return "affidabilità media e nessuna conferma: non serve per la coerenza"
        return "non migliora la scelta"

    def sql(c):
        if c.get("sql"):
            return c["sql"]
        if c.get("dichiarata"):
            return ""
        clausola, _ = A.clausola_regole(R.S.imp, all((c["tabella"], x) in R.S.not_null for x in c["colonne"]))
        return (f"ALTER TABLE {c['tabella']} ADD CONSTRAINT {A.nome_vincolo(c['tabella'], c['colonne'], c['padre'])} "
                f"FOREIGN KEY ({', '.join(c['colonne'])}) REFERENCES {c['padre']} ({', '.join(c['colonne_padre'])}){clausola};")

    righe_scelte, righe_scartate = [], []
    for i, c in enumerate(candidate):
        base = {"tabella": c["tabella"], "colonna": ", ".join(c["colonne"]), "→ tabella": c["padre"],
                "→ colonna": ", ".join(c["colonne_padre"])}
        if i in scelte:
            righe_scelte.append({**base, "perché": motivo_scelta(c), "sql": sql(c)})
        else:
            righe_scartate.append({**base, "perché scartata": motivo_scarto(i, c), "indizi": motivo_scelta(c)})
    df_scelte = pd.DataFrame(righe_scelte, columns=["tabella", "colonna", "→ tabella", "→ colonna", "perché", "sql"])
    df_scartate = pd.DataFrame(righe_scartate, columns=["tabella", "colonna", "→ tabella", "→ colonna", "perché scartata", "indizi"])

    # confronto con la scelta automatica senza clingo (dichiarate + la migliore ad affidabilità alta per colonna)
    euristica = set()
    for r in R.fk_dichiarate.to_dict("records"):
        euristica.add((r["tabella"], tuple(sorted(A.normalizza(x) for x in str(r["colonna"]).split(","))), r["→ tabella"]))
    viste = set()
    ridondanti = {(r["tabella"], r["colonna"], r["→ tabella"]) for r in R.qualita.ridondanti.to_dict("records")}
    alte = R.fk[(R.fk["affidabilità"] == "alta") & ~R.fk["già dichiarata"] & (R.fk["→ colonna"] != "?")]
    for r in alte.sort_values("tipi ok", ascending=False).to_dict("records"):
        k = (r["tabella"], r["colonna"])
        if k in viste or (r["tabella"], r["colonna"], r["→ tabella"]) in ridondanti:
            continue
        viste.add(k)
        euristica.add((r["tabella"], tuple(sorted(A.normalizza(x) for x in str(r["colonna"]).split(","))), r["→ tabella"]))
    di_clingo = {(c["tabella"], tuple(sorted(A.normalizza(x) for x in c["colonne"])), c["padre"]) for i, c in enumerate(candidate) if i in scelte}
    differenze = ([{"differenza": "scelta da clingo, non dalla scelta automatica", "tabella": t, "colonna": ", ".join(c), "→ tabella": p}
                   for t, c, p in sorted(di_clingo - euristica)] +
                  [{"differenza": "scelta automatica, scartata da clingo", "tabella": t, "colonna": ", ".join(c), "→ tabella": p}
                   for t, c, p in sorted(euristica - di_clingo)])
    df_diff = pd.DataFrame(differenze, columns=["differenza", "tabella", "colonna", "→ tabella"])

    riepilogo = pd.DataFrame([
        ("Candidate", len(candidate)),
        ("di cui già dichiarate", sum(1 for c in candidate if c.get("dichiarata"))),
        ("di cui confermate o viste nell'interfaccia", sum(1 for c in candidate if c.get("confermata"))),
        ("Scelte da clingo", len(scelte)),
        ("Scartate", len(candidate) - len(scelte)),
        ("Differenze con la scelta automatica", len(df_diff)),
        ("Soluzione", "ottima (dimostrato)" if ottimo else f"la migliore trovata in {secondi} s (ottimo non dimostrato)"),
        ("Valore (pesi)", -migliore["costo"][0] if migliore["costo"] else 0),
        ("Tempo", f"{durata:.2f} s"),
    ], columns=["voce", "valore"])
    return SimpleNamespace(riepilogo=riepilogo, scelte=df_scelte, scartate=df_scartate, differenze=df_diff,
                           programma=programma, fatti=testo_fatti, ottimo=ottimo, secondi=durata,
                           script="-- Chiavi esterne scelte da clingo (da controllare prima di eseguirle)\n" +
                                  "\n".join(s for s in df_scelte["sql"] if s) + "\n")


def main():
    p = argparse.ArgumentParser(description="Sceglie le chiavi esterne più coerenti con clingo (ASP)")
    p.add_argument("cartella", help="cartella (o file) .sql")
    p.add_argument("--dialetto", default="mysql")
    p.add_argument("--medie", action="store_true", help="considera anche le candidate ad affidabilità media")
    p.add_argument("--programma", help="salva programma ASP e fatti in questo file .lp (per usarli con clingo da terminale)")
    args = p.parse_args()
    from . import lettura as L
    imp = A.Impostazioni(dialetto=args.dialetto)
    df, pk, fk, errori = A.leggi_testi(L.leggi_percorsi([args.cartella], args.dialetto, esclusi=A.FILE_GENERATI), args.dialetto)
    R = A.analizza(df, pk, fk_dichiarate=fk, imp=imp)
    X = risolvi(R, medie=args.medie)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_colwidth", 70)
    print(X.riepilogo.to_string(index=False), "\n")
    print(X.scelte.drop(columns="sql").to_string(index=False), "\n")
    if len(X.scartate):
        print(X.scartate.to_string(index=False), "\n")
    if args.programma:
        Path(args.programma).write_text(X.programma + "\n" + X.fatti, encoding="utf-8")
        print("Programma ASP salvato in", args.programma)


if __name__ == "__main__":
    main()
