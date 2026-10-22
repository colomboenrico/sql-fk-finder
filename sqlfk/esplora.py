"""I file della cartella caricata: elenco, ricerca nel contenuto e lettura a pagine (anche file molto grandi).

Lavora solo sul disco, in sola lettura: niente rete e nessun file modificato. I percorsi chiesti
dall'interfaccia sono sempre relativi alla cartella scelta e non possono uscirne.
"""
import codecs
import fnmatch
import os
from pathlib import Path

# cartelle che non servono a capire il database e rallentano l'elenco
SALTATE = {".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".ipynb_checkpoints"}
LIMITE_ELENCO = 50_000                    # file al massimo nell'elenco
PAGINA = 512 * 1024                       # byte letti per volta per l'anteprima
LIMITE_XML = 64 * 1024 * 1024             # un file XML si legge tutto, fino a questa dimensione
LIMITE_CERCA = 32 * 1024 * 1024           # nella ricerca nel contenuto si saltano i file più grandi
ESTENSIONI_XML = {".xml", ".xsd", ".xsl", ".xslt", ".wsdl", ".config", ".xaml", ".resx", ".xmi", ".hbm", ".edmx",
                  ".dbml", ".csproj", ".vbproj", ".plist", ".manifest", ".rdf", ".owl", ".svg", ".xhtml", ".pom"}


class FuoriCartella(ValueError):
    """Percorso che esce dalla cartella scelta (o che non esiste)."""


def radice_di(origine):
    """La cartella da esplorare a partire da quella caricata: la cartella stessa, o quella del file .sql."""
    if not origine:
        return None
    p = Path(str(origine)).expanduser()
    if p.is_dir():
        return p.resolve()
    if p.is_file():
        return p.resolve().parent
    return None


def dentro(radice, relativo):
    """Il percorso assoluto di un file della cartella; errore se esce dalla cartella."""
    radice = Path(radice).resolve()
    file = (radice / str(relativo or "")).resolve()
    if file != radice and radice not in file.parents:
        raise FuoriCartella(f"Il percorso è fuori dalla cartella: {relativo}")
    if not file.exists():
        raise FuoriCartella(f"Il file non esiste: {relativo}")
    return file


def e_xml(nome):
    return Path(nome).suffix.lower() in ESTENSIONI_XML


def elenco(radice, limite=LIMITE_ELENCO):
    """Tutti i file sotto la cartella (sottocartelle comprese), in ordine di percorso."""
    radice = Path(radice).resolve()
    file, troncato = [], False
    for cartella, sottocartelle, nomi in os.walk(radice):
        sottocartelle[:] = sorted(d for d in sottocartelle if d not in SALTATE)
        rel = Path(cartella).relative_to(radice).as_posix()
        rel = "" if rel == "." else rel
        for nome in sorted(nomi):
            if nome == ".DS_Store":
                continue
            if len(file) >= limite:
                troncato = True
                break
            try:
                dimensione = os.stat(os.path.join(cartella, nome)).st_size
            except OSError:
                continue
            file.append({"percorso": f"{rel}/{nome}" if rel else nome, "nome": nome, "cartella": rel,
                         "dimensione": dimensione, "estensione": Path(nome).suffix.lower().lstrip("."),
                         "xml": e_xml(nome)})
        if troncato:
            break
    return {"radice": str(radice), "nome": radice.name, "file": file, "troncato": troncato}


def corrisponde(nome, cerca):
    """Il nome del file corrisponde alla ricerca? Con * e ? è un modello (*.sql), altrimenti basta che lo contenga."""
    nome, cerca = nome.lower(), cerca.lower().strip()
    if not cerca:
        return True
    if any(c in cerca for c in "*?["):
        return fnmatch.fnmatch(nome, cerca)
    return cerca in nome


def codifica_di(inizio):
    """(codifica, byte del BOM) guardando i primi byte del file."""
    for bom, nome in ((codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF16_LE, "utf-16-le"), (codecs.BOM_UTF16_BE, "utf-16-be")):
        if inizio.startswith(bom):
            return nome, len(bom)
    # UTF-16 senza BOM (capita con i file XML di Windows): uno zero ogni due byte
    if len(inizio) >= 4 and inizio[1:2] == b"\0" and inizio[3:4] == b"\0" and inizio[0:1] != b"\0":
        return "utf-16-le", 0
    if len(inizio) >= 4 and inizio[0:1] == b"\0" and inizio[2:3] == b"\0" and inizio[1:2] != b"\0":
        return "utf-16-be", 0
    try:
        inizio.decode("utf-8")
        return "utf-8", 0
    except UnicodeDecodeError as e:
        # l'errore può essere solo l'ultimo carattere tagliato a metà
        return ("utf-8", 0) if e.start >= len(inizio) - 3 else ("cp1252", 0)


def binario(inizio, codifica):
    return not codifica.startswith("utf-16") and b"\0" in inizio[:8192]


def leggi(radice, relativo, inizio=0, quanti=PAGINA):
    """Un pezzo del file come testo: da inizio (byte) per circa quanti byte, tagliato a fine riga."""
    file = dentro(radice, relativo)
    if file.is_dir():
        raise FuoriCartella(f"È una cartella: {relativo}")
    dimensione = file.stat().st_size
    with open(file, "rb") as f:
        testa = f.read(8192)
        codifica, bom = codifica_di(testa)
        if binario(testa, codifica):
            return {"percorso": relativo, "dimensione": dimensione, "binario": True, "testo": "",
                    "inizio": 0, "fine": 0, "altro": False, "codifica": None}
        inizio = max(int(inizio), bom)
        if codifica.startswith("utf-16"):
            inizio -= (inizio - bom) % 2
        f.seek(inizio)
        dati = f.read(int(quanti))
        fine = inizio + len(dati)
        if fine < dimensione:
            # si finisce all'ultimo a capo, così la pagina dopo ricomincia da una riga intera
            a_capo = b"\n\0" if codifica == "utf-16-le" else b"\0\n" if codifica == "utf-16-be" else b"\n"
            ultimo = dati.rfind(a_capo)
            if codifica.startswith("utf-16") and ultimo >= 0 and ultimo % 2:
                ultimo = -1
            if ultimo > 0:
                dati = dati[:ultimo + len(a_capo)]
                fine = inizio + len(dati)
    testo = dati.decode(codifica.replace("-sig", ""), errors="replace")
    return {"percorso": relativo, "dimensione": dimensione, "binario": False, "testo": testo, "inizio": inizio,
            "fine": fine, "altro": fine < dimensione, "codifica": codifica.replace("-sig", "")}


def leggi_xml(radice, relativo):
    """Tutto il testo di un file XML (per l'albero), fino a LIMITE_XML."""
    file = dentro(radice, relativo)
    dimensione = file.stat().st_size
    if dimensione > LIMITE_XML:
        raise FuoriCartella(f"Il file XML è troppo grande per l'albero ({dimensione // 1_000_000} MB, "
                            f"limite {LIMITE_XML // 1_000_000} MB): aprilo nella scheda File per leggerlo a pagine.")
    return leggi(radice, relativo, 0, dimensione + 16)


def cerca_testo(radice, parola, solo_nomi=None, limite_file=300, limite_righe=20):
    """I file che contengono la parola (senza distinguere maiuscole), con le prime righe trovate."""
    parola = str(parola or "").strip()
    if len(parola) < 2:
        return {"parola": parola, "risultati": [], "saltati": 0}
    cerca = parola.lower()
    risultati, saltati = [], 0
    for voce in elenco(radice)["file"]:
        if solo_nomi and not corrisponde(voce["nome"], solo_nomi):
            continue
        if voce["dimensione"] > LIMITE_CERCA:
            saltati += 1
            continue
        try:
            with open(Path(radice) / voce["percorso"], "rb") as f:
                dati = f.read()
        except OSError:
            continue
        codifica, bom = codifica_di(dati[:8192])
        if binario(dati[:8192], codifica):
            continue
        testo = dati[bom:].decode(codifica.replace("-sig", ""), errors="replace")
        if cerca not in testo.lower():
            continue
        righe, quante = [], 0
        for n, riga in enumerate(testo.splitlines(), 1):
            if cerca in riga.lower():
                quante += 1
                if len(righe) < limite_righe:
                    righe.append([n, riga.strip()[:300]])
        risultati.append({**voce, "volte": quante, "righe": righe})
        if len(risultati) >= limite_file:
            break
    return {"parola": parola, "risultati": risultati, "saltati": saltati}
