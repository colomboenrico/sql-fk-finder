"""La parte "Programmazione" dell'Assistente: scrivere, controllare e provare codice (Python, C++, SQL) sul computer.

- controlla(): il controllo della sintassi, senza eseguire niente (Python: compile; C++: il compilatore con -fsyntax-only
  o /Zs). Il modello lo usa da solo dopo aver scritto il codice, e se ci sono errori li corregge.
- esegui(): compila ed esegue un programma, solo quando lo chiede l'utente (pulsante Esegui), in una cartella a parte con
  un tempo massimo. Accanto al programma ci sono il database di prova (prova.sqlite) e il backend C++ generato
  (database.hpp, modelli.hpp, repository.hpp), così il codice può usarli subito.
- api_backend() / crud_python(): il riassunto delle classi del backend da dare al modello, e il codice pronto per le regole.
Niente rete: tutto gira sul computer.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import prova as PR

CARTELLA = PR.CARTELLA / "programmi"
TEMPO_MASSIMO = 20            # secondi per eseguire un programma
USCITA_MASSIMA = 20000

LINGUAGGI = {"python": "python", "py": "python", "python3": "python", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp",
             "c": "cpp", "sql": "sql", "sqlite": "sql", "mysql": "sql", "postgresql": "sql"}


def linguaggio(nome):
    return LINGUAGGI.get(str(nome or "").strip().lower())


def blocchi_di_codice(testo):
    """[(linguaggio, codice)] dei blocchi ``` di un testo (quelli di linguaggi che si sanno controllare)."""
    trovati = []
    for m in re.finditer(r"```([\w+#-]*)[ \t]*\n(.*?)```", testo or "", re.S):
        lg = linguaggio(m.group(1)) or ("cpp" if "#include" in m.group(2) else "python" if re.search(r"^\s*(def |import |print\()", m.group(2), re.M) else None)
        if lg:
            trovati.append((lg, m.group(2).strip("\n")))
    return trovati


def _cartella_nuova():
    CARTELLA.mkdir(parents=True, exist_ok=True)
    vecchie = sorted(CARTELLA.glob("p*"), key=lambda p: p.stat().st_mtime)[:-10]     # si tengono le ultime 10 prove
    for v in vecchie:
        shutil.rmtree(v, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix="p", dir=CARTELLA))


def _prepara(cartella, tabelle):
    """Il database di prova e il backend C++ accanto al programma (se ci sono)."""
    try:                                     # prima il backend: il generatore rifà la cartella
        PR.genera_cpp(tabelle or None, cartella)
        for f in ("main.cpp", "compila.sh", "compila.bat", "LEGGIMI.txt"):
            (cartella / f).unlink(missing_ok=True)
    except Exception:
        cartella.mkdir(parents=True, exist_ok=True)
    if PR.DATABASE.exists():
        shutil.copy2(PR.DATABASE, cartella / "prova.sqlite")


def _ambiente():
    ambiente = {k: v for k, v in os.environ.items() if not k.startswith("SQLFK_")}
    ambiente.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    if os.name == "nt":                      # sqlite3.dll del Python dell'app, per i programmi C++ senza winsqlite3.dll
        ambiente["PATH"] = os.pathsep.join([str(Path(sys.base_prefix) / "DLLs"), sys.base_prefix, ambiente.get("PATH", "")])
    return ambiente


def _compila_cpp(cartella, sorgente, solo_sintassi):
    trovato = PR.compilatore()
    if not trovato:
        return None, "Nessun compilatore C++ su questo computer: il codice si può salvare e compilare altrove."
    genere, cc = trovato
    eseguibile = cartella / ("programma.exe" if os.name == "nt" else "programma")
    if genere == "msvc":
        arch = {"AMD64": "x64", "ARM64": "arm64", "x86": "x86"}.get(os.environ.get("PROCESSOR_ARCHITECTURE", "AMD64"), "x64")
        opzioni = "/Zs" if solo_sintassi else f"/O1 /Fe:{eseguibile.name}"
        (cartella / "compila.bat").write_text(f'@echo off\r\ncall "{cc}" {arch} >nul\r\ncl /nologo /std:c++17 /EHsc /utf-8 {opzioni} {sorgente}\r\n',
                                             encoding="utf-8")
        comando = ["cmd", "/c", "compila.bat"]
    elif solo_sintassi:
        comando = [cc, "-std=c++17", "-fsyntax-only", sorgente]
    elif os.name == "nt":
        comando = [cc, "-std=c++17", "-O1", "-static", "-s", sorgente, "-o", eseguibile.name]
    else:
        comando = [cc, "-std=c++17", "-O1", sorgente, "-lsqlite3", "-o", eseguibile.name]
    try:
        r = subprocess.run(comando, cwd=cartella, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None, "La compilazione ci mette troppo."
    uscita = (r.stdout + r.stderr).decode("utf-8", errors="replace").strip()
    uscita = uscita.replace(str(cartella) + os.sep, "")
    if r.returncode != 0:
        return None, uscita[-6000:] or "Errore di compilazione."
    return eseguibile, uscita


def controlla(lingua, codice, tabelle=None):
    """{"ok", "testo"}: il controllo della sintassi, senza eseguire il programma."""
    lg = linguaggio(lingua)
    if lg == "python":
        try:
            compile(codice, "programma.py", "exec")
            return {"ok": True, "testo": "Python: la sintassi è corretta."}
        except SyntaxError as e:
            riga = (e.text or "").rstrip()
            return {"ok": False, "testo": f"Python, riga {e.lineno}: {e.msg}" + (f"\n    {riga}" if riga else "")}
    if lg == "cpp":
        cartella = _cartella_nuova()
        _prepara(cartella, tabelle)
        (cartella / "programma.cpp").write_text(codice, encoding="utf-8")
        eseguibile, uscita = _compila_cpp(cartella, "programma.cpp", solo_sintassi=True)
        if eseguibile is None and "Nessun compilatore" in uscita:
            return {"ok": True, "testo": uscita, "non_controllato": True}
        return {"ok": eseguibile is not None, "testo": "C++: si compila." if eseguibile is not None else "C++, errori di compilazione:\n" + uscita}
    if lg == "sql":
        return {"ok": True, "testo": "SQL: si controlla con lo strumento sql (sulle tabelle vere)."}
    return {"ok": True, "testo": f"Il linguaggio {lingua} non si controlla qui.", "non_controllato": True}


def esegui(lingua, codice, ingresso="", tabelle=None):
    """Compila ed esegue il programma in una cartella a parte (con prova.sqlite e il backend accanto)."""
    lg = linguaggio(lingua)
    if lg not in ("python", "cpp"):
        return {"ok": False, "uscita": f"Si eseguono programmi Python e C++ (questo è {lingua}).", "codice_uscita": None}
    cartella = _cartella_nuova()
    _prepara(cartella, tabelle)
    passi = []
    if lg == "python":
        (cartella / "programma.py").write_text(codice, encoding="utf-8")
        comando = [sys.executable, "-I", "programma.py"]
    else:
        (cartella / "programma.cpp").write_text(codice, encoding="utf-8")
        eseguibile, uscita = _compila_cpp(cartella, "programma.cpp", solo_sintassi=False)
        if eseguibile is None:
            return {"ok": False, "uscita": uscita, "codice_uscita": None, "fase": "compilazione", "cartella": str(cartella)}
        if uscita:
            passi.append(uscita)
        comando = [str(eseguibile)]
    inizio = time.time()
    try:
        r = subprocess.run(comando, cwd=cartella, input=(ingresso or "").encode("utf-8"), capture_output=True,
                           timeout=TEMPO_MASSIMO, env=_ambiente())
    except subprocess.TimeoutExpired:
        return {"ok": False, "uscita": f"Il programma non è finito entro {TEMPO_MASSIMO} secondi: fermato (forse aspetta un ingresso o ha un ciclo infinito).",
                "codice_uscita": None, "fase": "esecuzione", "cartella": str(cartella)}
    uscita = r.stdout.decode("utf-8", errors="replace")
    errori = r.stderr.decode("utf-8", errors="replace")
    testo = uscita + (("\n" if uscita and not uscita.endswith("\n") else "") + errori if errori else "")
    return {"ok": r.returncode == 0, "uscita": testo[-USCITA_MASSIMA:] or "(nessuna uscita)", "codice_uscita": r.returncode,
            "secondi": round(time.time() - inizio, 2), "fase": "esecuzione", "cartella": str(cartella),
            "avvisi_compilazione": "\n".join(passi)[-3000:]}


def api_backend(tabelle, massimo=12):
    """Il riassunto del backend C++ generato (classi, getter e setter, repository) per il modello."""
    righe = ['Backend C++ generato (pagina Backend): #include "repository.hpp"; Database db("prova.sqlite"); '
             "i getter delle colonne che possono essere NULL restituiscono std::optional, che si stampa direttamente con << "
             "(scrive NULL se manca)."]
    for t in tabelle[:massimo]:
        d = PR._descrivi(t)
        campi = ", ".join(f"get{c['metodo']}()/set{c['metodo']}()" for c in d["colonne"][:8])
        chiave = ", ".join(c["id"] for c in d["chiave"])
        righe.append(f"- class {d['classe']} {{ {campi} }}; {d['classe']}Repository repo(db): inserisci(r) -> id, aggiorna(r), "
                     f"elimina({chiave}), trova({chiave}) -> std::optional<{d['classe']}>, tutti() -> std::vector<{d['classe']}>")
    return "\n".join(righe)


def crud_python(t):
    """Il codice Python (sqlite3) con inserisci, aggiorna, elimina, trova e tutti per una tabella."""
    nome = t["nome"]
    colonne = [c["nome"] for c in t["colonne"]]
    chiave = [c["nome"] for c in sorted(t["colonne"], key=lambda c: c.get("pk") or 0) if c.get("pk")] or colonne[:1]
    altre = [c for c in colonne if c not in chiave]
    dove = " AND ".join(f"{c} = ?" for c in chiave)
    par_chiave = ", ".join(chiave)
    return "\n".join([
        f'"""Accesso alla tabella {nome} con sqlite3 (libreria standard). Generato da SQL FK Finder."""',
        "import sqlite3", "", "",
        "def apri(percorso=\"prova.sqlite\"):",
        "    conn = sqlite3.connect(percorso)",
        "    conn.row_factory = sqlite3.Row",
        "    conn.execute(\"PRAGMA foreign_keys = ON\")",
        "    return conn", "", "",
        f"def inserisci_{nome}(conn, {', '.join(colonne)}):",
        f"    cur = conn.execute(\"INSERT INTO {nome} ({', '.join(colonne)}) VALUES ({', '.join('?' * len(colonne))})\",",
        f"                       ({', '.join(colonne)},))",
        "    conn.commit()",
        "    return cur.lastrowid", "", "",
        *([f"def aggiorna_{nome}(conn, {par_chiave}, {', '.join(altre)}):",
           f"    conn.execute(\"UPDATE {nome} SET {', '.join(f'{c} = ?' for c in altre)} WHERE {dove}\",",
           f"                 ({', '.join(altre)}, {par_chiave},))",
           "    conn.commit()", "", ""] if altre else []),
        f"def elimina_{nome}(conn, {par_chiave}):",
        f"    conn.execute(\"DELETE FROM {nome} WHERE {dove}\", ({par_chiave},))",
        "    conn.commit()", "", "",
        f"def trova_{nome}(conn, {par_chiave}):",
        f"    return conn.execute(\"SELECT * FROM {nome} WHERE {dove}\", ({par_chiave},)).fetchone()", "", "",
        f"def tutti_{nome}(conn, limite=100):",
        f"    return conn.execute(\"SELECT * FROM {nome} LIMIT ?\", (limite,)).fetchall()", "", "",
        'if __name__ == "__main__":',
        "    conn = apri()",
        f"    for riga in tutti_{nome}(conn, 5):",
        "        print(dict(riga))",
    ])


def esempio_cpp_tabella(t):
    """Un programma C++ che usa il backend generato per una tabella: legge ed elenca le righe con i getter."""
    d = PR._descrivi(t)
    cl = d["classe"]
    righe = [f"// Prova del backend generato per la tabella {t['nome']}: la classe {cl} (modelli.hpp, getter e setter)",
             f"// e {cl}Repository (repository.hpp: inserisci, aggiorna, elimina, trova, tutti).",
             '#include "repository.hpp"', "", "#include <iostream>", "#include <optional>", "#include <string>", "",
             "template <typename T> static void stampa(const T& v) { std::cout << v; }",
             'template <typename T> static void stampa(const std::optional<T>& v) { if (v) std::cout << *v; else std::cout << "NULL"; }',
             "", "int main() {", "    try {", '        Database db("prova.sqlite");', f"        {cl}Repository repo(db);", "",
             f"        // tutte le righe (al più 10)", "        int n = 0;", "        for (const auto& r : repo.tutti()) {",
             "            if (n++ == 10) break;"]
    for i, c in enumerate(d["colonne"][:6]):
        righe.append(f'            std::cout << "{", " if i else ""}{c["nome"]}="; stampa(r.get{c["metodo"]}());')
    righe += ["            std::cout << '\\n';", "        }",
              f'        std::cout << n << " righe lette da {t["nome"]}\\n";',
              "    } catch (const std::exception& e) {", '        std::cerr << "Errore: " << e.what() << "\\n";', "        return 1;",
              "    }", "    return 0;", "}"]
    return "\n".join(righe)
