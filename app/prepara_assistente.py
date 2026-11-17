"""Prepara l'Assistente (il modello di linguaggio locale) senza comandi a mano: lo usano avvia_app e crea_eseguibili.

    python prepara_assistente.py --libreria            installa llama-cpp-python in questo Python, se manca
    python prepara_assistente.py --modello CARTELLA    scarica il modello consigliato in CARTELLA, se non ce n'è già uno
                                 [--ram GB] [--si] [--cache CARTELLA]

Serve internet solo qui, una volta: dopo l'app gira senza rete. Se qualcosa non va, l'app funziona lo stesso e
l'Assistente risponde con le regole: per questo lo script non fallisce mai (esce sempre con 0).
"""
import argparse
import ctypes
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

INDICE = "https://abetlen.github.io/llama-cpp-python/whl/"
# per Mac la 0.3.36 pubblicata ha un file rovinato: si usa la 0.3.19, provata
VERSIONE_MAC = "0.3.19"
MODELLI = [  # (RAM minima del computer in GB, nome del file, GB da scaricare)
    (14, "qwen2.5-coder-7b-instruct-q4_k_m.gguf", 4.7, "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF"),
    (0, "qwen2.5-coder-3b-instruct-q4_k_m.gguf", 2.1, "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF"),
]


def ram_gb():
    try:
        if sys.platform == "win32":
            class Stato(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            s = Stato()
            s.dwLength = ctypes.sizeof(Stato)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return s.ullTotalPhys / 2 ** 30
        if sys.platform == "darwin":
            return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) / 2 ** 30
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2 ** 30
    except Exception:
        return 8


def libreria():
    try:
        import llama_cpp  # noqa: F401
        print(f"[ OK ] llama-cpp-python {llama_cpp.__version__} c'è già")
        return
    except Exception:
        pass
    if sys.platform == "darwin" and platform.machine() == "arm64":
        indice, pacchetto = INDICE + "metal", f"llama-cpp-python=={VERSIONE_MAC}"
    else:
        indice, pacchetto = INDICE + "cpu", "llama-cpp-python"
    print(f"== Assistente: installo {pacchetto} (già compilata, qualche MB; serve internet solo adesso)")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--only-binary=llama-cpp-python",
                        "--extra-index-url", indice, pacchetto])
    if r.returncode == 0:
        print("[ OK ] llama-cpp-python installata")
    else:
        print("[ !! ] llama-cpp-python non installata: l'Assistente risponderà con le regole (l'app funziona lo stesso)")


def scarica(url, file, gb):
    parziale = file.with_name(file.name + ".parziale")
    inizio = time.time()
    with urllib.request.urlopen(url) as r, open(parziale, "wb") as f:
        totale = int(r.headers.get("Content-Length") or gb * 1e9)
        fatto, ultimo = 0, 0
        while True:
            pezzo = r.read(4 << 20)
            if not pezzo:
                break
            f.write(pezzo)
            fatto += len(pezzo)
            if time.time() - ultimo > 1:
                ultimo = time.time()
                velocita = fatto / max(1, ultimo - inizio) / 1e6
                print(f"\r     {fatto / 1e9:4.1f} / {totale / 1e9:.1f} GB  ({fatto * 100 // totale}%, {velocita:.0f} MB/s)   ", end="", flush=True)
    print()
    if fatto < totale * 0.99:
        raise OSError("download incompleto")
    os.replace(parziale, file)


def modello(cartella, ram=None, si=False, cache=None):
    cartella = Path(cartella).expanduser()
    cartella.mkdir(parents=True, exist_ok=True)
    gia = sorted(cartella.glob("*.gguf"))
    if gia:
        print(f"[ OK ] modello già presente: {gia[0].name}")
        return
    ram = ram or ram_gb()
    soglia, nome, gb, repo = next(m for m in MODELLI if ram >= m[0])
    if cache:
        nella_cache = Path(cache) / nome
        if nella_cache.is_file():
            shutil.copy2(nella_cache, cartella / nome)
            print(f"[ OK ] modello copiato: {cartella / nome}")
            return
    no = cartella / ".non_scaricare"
    if no.exists() and not si:
        print(f"[ -- ] modello non scaricato (scelta precedente; per scaricarlo cancella {no})")
        return
    print(f"== Assistente: il modello consigliato per {ram:.0f} GB di RAM è {nome} ({gb} GB, da huggingface.co/{repo}).")
    print("   Si scarica una volta sola; poi l'Assistente gira senza internet.")
    if not si:
        try:
            risposta = input("   Lo scarico adesso? [S/n] ").strip().lower()
        except EOFError:
            risposta = "n"
        if risposta.startswith("n"):
            no.write_text("Il modello non è stato scaricato. Cancella questo file per farlo chiedere di nuovo.\n", encoding="utf-8")
            print("[ -- ] non scaricato: l'Assistente risponde con le regole. Puoi scaricarlo più avanti.")
            return
    destinazione = Path(cache) / nome if cache else cartella / nome
    destinazione.parent.mkdir(parents=True, exist_ok=True)
    try:
        scarica(f"https://huggingface.co/{repo}/resolve/main/{nome}", destinazione, gb)
        if cache:
            shutil.copy2(destinazione, cartella / nome)
        print(f"[ OK ] modello pronto: {cartella / nome}")
    except Exception as e:
        print(f"\n[ !! ] modello non scaricato ({e}): l'Assistente risponde con le regole. Riprova più avanti.")


if __name__ == "__main__":
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--libreria", action="store_true")
    a.add_argument("--modello", metavar="CARTELLA")
    a.add_argument("--ram", type=float, help="RAM del computer dove girerà l'app (per scegliere il modello)")
    a.add_argument("--si", action="store_true", help="scarica senza chiedere")
    a.add_argument("--cache", help="cartella dove tenere il modello scaricato (per non riscaricarlo)")
    x = a.parse_args()
    try:
        if x.libreria:
            libreria()
        if x.modello:
            modello(x.modello, x.ram, x.si, x.cache)
    except KeyboardInterrupt:
        print("\n[ -- ] interrotto: l'app funziona lo stesso")
    sys.exit(0)
