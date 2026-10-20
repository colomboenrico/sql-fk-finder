"""Prepara il Python da includere negli eseguibili, con tutte le librerie: l'app finale non va mai in rete.

Si usa solo quando si creano gli eseguibili (crea_eseguibili), sul computer di sviluppo: scarica una volta
il Python per ogni sistema e le librerie già compilate (wheel), e le mette in app/python/<sistema>/.

    python prepara_python.py win-x64 mac-arm64 mac-x64 linux-x64

- Windows: il Python "embeddable" ufficiale di python.org;
- Mac e Linux: le build di python-build-standalone (Python completo, da estrarre e usare così com'è).
Le versioni sono fisse, così le build si ripetono uguali.
"""

import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

QUI = Path(__file__).resolve().parent
CACHE = QUI / ".cache-python"
DESTINAZIONE = QUI / "python"
VERSIONE = "3.12"
STANDALONE = "20261001"                       # python-build-standalone, pubblicata il 2026-10-01
STANDALONE_PY = "3.12.15"
EMBED = "3.12.10"                             # ultimo Python 3.12 per Windows distribuito anche come embeddable

SISTEMI = {
    "win-x64": {"url": f"https://www.python.org/ftp/python/{EMBED}/python-{EMBED}-embed-amd64.zip",
                "piattaforme": ["win_amd64"], "extra": ["comtypes"]},
    "mac-arm64": {"url": f"https://github.com/astral-sh/python-build-standalone/releases/download/{STANDALONE}/"
                         f"cpython-{STANDALONE_PY}+{STANDALONE}-aarch64-apple-darwin-install_only_stripped.tar.gz",
                  "piattaforme": [f"macosx_{v}_0_arm64" for v in (11, 12, 13, 14)], "extra": []},
    "mac-x64": {"url": f"https://github.com/astral-sh/python-build-standalone/releases/download/{STANDALONE}/"
                       f"cpython-{STANDALONE_PY}+{STANDALONE}-x86_64-apple-darwin-install_only_stripped.tar.gz",
                "piattaforme": ["macosx_10_9_x86_64", "macosx_10_13_x86_64", "macosx_11_0_x86_64", "macosx_12_0_x86_64",
                                "macosx_13_0_x86_64", "macosx_14_0_x86_64"], "extra": []},
    "linux-x64": {"url": f"https://github.com/astral-sh/python-build-standalone/releases/download/{STANDALONE}/"
                         f"cpython-{STANDALONE_PY}+{STANDALONE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
                  "piattaforme": ["manylinux2014_x86_64", "manylinux_2_17_x86_64", "manylinux_2_28_x86_64"], "extra": []},
}
REQUISITI = QUI / "requirements-app.txt"
TOGLIERE = ["pandas/tests", "numpy/tests", "numpy/_core/tests", "numpy/f2py/tests", "scipy/*/tests", "scipy/*/*/tests",
            "networkx/*/tests", "networkx/*/*/tests", "IPython/*/tests"]


def scarica(url):
    CACHE.mkdir(exist_ok=True)
    file = CACHE / url.rsplit("/", 1)[1].replace("%2B", "+")
    if not file.exists():
        print(f"  scarico {url}")
        with urllib.request.urlopen(url) as r, open(str(file) + ".parziale", "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(str(file) + ".parziale", file)
    return file


def installa_ruote(cartella_ruote, site_packages):
    """Estrae le librerie (wheel) in site-packages: una wheel è uno zip già pronto da copiare."""
    site_packages.mkdir(parents=True, exist_ok=True)
    for ruota in sorted(cartella_ruote.glob("*.whl")):
        with zipfile.ZipFile(ruota) as z:
            for nome in z.namelist():
                parti = nome.split("/")
                if parti[0].endswith(".data"):
                    if len(parti) > 2 and parti[1] in ("purelib", "platlib"):
                        destinazione = site_packages.joinpath(*parti[2:])
                    else:
                        continue                   # script e header non servono
                else:
                    destinazione = site_packages / nome
                if nome.endswith("/"):
                    continue
                destinazione.parent.mkdir(parents=True, exist_ok=True)
                with z.open(nome) as sorgente, open(destinazione, "wb") as f:
                    shutil.copyfileobj(sorgente, f)
                info = z.getinfo(nome)
                permessi = (info.external_attr >> 16) & 0o777
                if permessi:
                    os.chmod(destinazione, permessi)


def prepara(sistema):
    s = SISTEMI[sistema]
    cartella = DESTINAZIONE / sistema
    print(f"== Python per {sistema}")
    if cartella.exists():
        shutil.rmtree(cartella)
    cartella.mkdir(parents=True)
    archivio = scarica(s["url"])
    if archivio.suffix == ".zip":
        with zipfile.ZipFile(archivio) as z:
            z.extractall(cartella)
        site_packages = cartella / "Lib" / "site-packages"
        # il Python embeddable legge sys.path dal file ._pth: si aggiungono le librerie e la cartella di sqlfk (..)
        pth = next(cartella.glob("python3*._pth"))
        righe = [r for r in pth.read_text().splitlines() if r.strip() and not r.startswith("#")]
        righe += ["Lib\\site-packages", "..", "import site"]
        pth.write_text("\n".join(dict.fromkeys(righe)) + "\n")
    else:
        with tarfile.open(archivio) as t:
            # share/terminfo non serve, e ha nomi che differiscono solo per le maiuscole (problema su Mac e Windows)
            membri = [m for m in t.getmembers() if "/share/terminfo/" not in m.name]
            t.extractall(cartella.parent / f"_{sistema}", members=membri, filter="tar")
        interna = cartella.parent / f"_{sistema}" / "python"
        shutil.rmtree(cartella)
        shutil.move(str(interna), cartella)
        shutil.rmtree(cartella.parent / f"_{sistema}", ignore_errors=True)
        site_packages = cartella / "lib" / f"python{VERSIONE}" / "site-packages"
    ruote = CACHE / f"wheels-{sistema}"
    ruote.mkdir(parents=True, exist_ok=True)
    comando = [sys.executable, "-m", "pip", "download", "--quiet", "--only-binary=:all:", "--python-version", VERSIONE,
               "--implementation", "cp", "-d", str(ruote), "-r", str(REQUISITI), *s["extra"]]
    for p in s["piattaforme"]:
        comando += ["--platform", p]
    print("  librerie:", " ".join(Path(REQUISITI).read_text().split()), *s["extra"])
    subprocess.run(comando, check=True)
    installa_ruote(ruote, site_packages)
    for schema in TOGLIERE:                        # i test delle librerie non servono e pesano
        for d in site_packages.glob(schema):
            shutil.rmtree(d, ignore_errors=True)
    for d in site_packages.rglob("__pycache__"):
        shutil.rmtree(d, ignore_errors=True)
    # parti di Python che l'app non usa: interfacce Tk, IDLE, installatore di pip, test, file per compilare
    lib = site_packages.parent
    for schema in ["test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "pydoc_data", "unittest/test"]:
        shutil.rmtree(lib / schema, ignore_errors=True)
    for schema in ["include", "share", "lib/tcl*", "lib/tk*", "lib/itcl*", "lib/thread*", "lib/libtcl*", "lib/libtk*",
                   "lib/*.a", "tcl", "Lib/test", "Lib/idlelib", "Lib/tkinter"]:
        for x in cartella.glob(schema):
            if x.is_dir():
                shutil.rmtree(x, ignore_errors=True)
            else:
                x.unlink()
    for x in (lib / "lib-dynload").glob("_tkinter*"):
        x.unlink()
    dimensione = sum(f.stat().st_size for f in cartella.rglob("*") if f.is_file())
    print(f"  pronto: {cartella} ({dimensione / 1e6:.0f} MB)")
    # prova, se il Python è di questo computer
    eseguibile = cartella / ("python.exe" if sistema.startswith("win") else "bin/python3")
    corrente = {"darwin": "mac", "linux": "linux", "win32": "win"}.get(sys.platform, "")
    import platform
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine().lower(), "")
    if sistema == f"{corrente}-{arch}":
        r = subprocess.run([str(eseguibile), "-c", "import pandas, scipy, pyvis, openpyxl, networkx, sqlglot; print('librerie ok')"],
                           capture_output=True, text=True)
        print("  prova:", (r.stdout or r.stderr).strip()[-300:])
        if r.returncode:
            raise SystemExit(1)


if __name__ == "__main__":
    scelti = sys.argv[1:] or list(SISTEMI)
    for sistema in scelti:
        if sistema not in SISTEMI:
            raise SystemExit(f"Sistema sconosciuto: {sistema} (usa {', '.join(SISTEMI)})")
        prepara(sistema)
