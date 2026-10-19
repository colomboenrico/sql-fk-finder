"""Controlla uno schema SQL come un compilatore: stampa errori, avvisi e info con file e riga.

Uso:
    python -m sqlfk.verifica esempi                  # una cartella di file .sql
    python -m sqlfk.verifica dump1.sql dump2.sql     # uno o più file
    python -m sqlfk.verifica esempi --senza-info     # solo errori e avvisi
    python -m sqlfk.verifica esempi --werror         # gli avvisi contano come errori
    python -m sqlfk.verifica esempi --togli piatto   # toglie un'entità dall'analisi

Codice di uscita: 0 se non ci sono errori, 1 se ce ne sono (con --werror anche per gli avvisi),
2 se i file non si possono leggere.
"""
import argparse
import sys
from pathlib import Path

from . import analisi as A


def main():
    parser = argparse.ArgumentParser(prog="python -m sqlfk.verifica",
                                     description="Controlla uno schema SQL come un compilatore.")
    parser.add_argument("percorsi", nargs="+", help="cartelle o file .sql")
    parser.add_argument("--dialetto", default="mysql", help="mysql, tsql, oracle, postgres... (predefinito: mysql)")
    parser.add_argument("--senza-info", action="store_true", help="non mostra i messaggi di tipo info")
    parser.add_argument("--werror", action="store_true", help="gli avvisi contano come errori")
    parser.add_argument("--togli", nargs="*", default=[], metavar="ENTITÀ", help="entità da togliere, es. piatto")
    parser.add_argument("--sinonimi", nargs="*", default=[], metavar="GRUPPO",
                        help='gruppi di sinonimi, es. "comune=citta=paese" "cliente=customer"')
    parser.add_argument("--on-delete", default="RESTRICT", help="regola ON DELETE delle chiavi esterne proposte")
    parser.add_argument("--on-update", default="CASCADE", help="regola ON UPDATE delle chiavi esterne proposte")
    args = parser.parse_args()

    file_sql = []
    for percorso in map(Path, args.percorsi):
        if percorso.is_dir():
            file_sql += [(f.name, f.read_text(encoding="utf-8", errors="replace")) for f in sorted(percorso.glob("*.sql"))]
        elif percorso.is_file():
            file_sql.append((percorso.name, percorso.read_text(encoding="utf-8", errors="replace")))
        else:
            print(f"{percorso}: errore: file o cartella inesistente", file=sys.stderr)
            return 2
    if not file_sql:
        print("errore: nessun file .sql da controllare", file=sys.stderr)
        return 2

    imp = A.Impostazioni(dialetto=args.dialetto, on_delete=args.on_delete.upper(), on_update=args.on_update.upper(),
                         sinonimi=args.sinonimi)
    df, pk, fk, errori = A.leggi_testi(file_sql, imp.dialetto)
    if df.empty:
        print("errore: nei file non c'è nessun CREATE TABLE", file=sys.stderr)
        return 2
    rimosse = set()
    for parola in args.togli:
        rimosse |= set(A.tabelle_entita(df["tabella"].unique(), parola, imp.sinonimi))
    gruppi, _ = A.raggruppa_tabelle(df["tabella"].unique(), imp)
    R = A.analizza(df, pk, rimosse, fk_dichiarate=fk, gruppi=gruppi, imp=imp,
                   errori=errori, originali=A.create_originali(file_sql, imp.dialetto))

    print(A.testo_diagnostica(R.diagnostica, con_info=not args.senza_info), end="")
    n = A.conteggi_diagnostica(R.diagnostica)
    return 1 if n["errore"] or (args.werror and n["avviso"]) else 0


if __name__ == "__main__":
    sys.exit(main())
