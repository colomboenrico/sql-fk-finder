"""Collegamento tra l'app (Electron) e Python senza nessuna rete: niente porte, niente socket.

L'app avvia "python -m sqlfk.ponte" e gli parla con le pipe del processo:

- ogni richiesta è una riga JSON sullo standard input:
  {"id": 7, "metodo": "GET" | "POST", "percorso": "/api/stato?x=1", "corpo": "<base64>", "salva_in": "<file>"}
- la risposta torna sullo standard output, a righe JSON con lo stesso id:
  {"id": 7, "pezzo": "<base64>"} ... poi {"id": 7, "fine": true, "stato": 200, "intestazioni": {...}}
  Con salva_in i dati non passano dalla pipe: Python li scrive direttamente in quel file (download grandi).

Le richieste si servono con lo stesso codice del server (sqlfk.server.Gestore), come se arrivassero via HTTP.
Quando l'app si chiude (anche in modo brusco) lo standard input finisce e il processo esce.
"""

import base64
import io
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from . import server as SV

PEZZO = 512 * 1024                           # byte per riga di risposta


class Uscita:
    """Le righe di risposta sullo standard output vero (gli altri print vanno sullo standard error)."""

    def __init__(self, canale):
        self.canale = canale
        self.lock = threading.Lock()

    def scrivi(self, messaggio):
        riga = json.dumps(messaggio, ensure_ascii=False) + "\n"
        with self.lock:
            self.canale.write(riga)
            self.canale.flush()


class Scrittore(io.RawIOBase):
    """Il wfile del gestore: manda i dati a pezzi all'app, o li scrive nel file scelto per il download."""

    def __init__(self, uscita, id_, file=None):
        self.uscita, self.id, self.file = uscita, id_, file
        self.buffer, self.scritti = bytearray(), 0

    def writable(self):
        return True

    def write(self, dati):
        dati = bytes(dati)
        self.scritti += len(dati)
        if self.file:
            self.file.write(dati)
            return len(dati)
        self.buffer += dati
        while len(self.buffer) >= PEZZO:
            self.svuota(PEZZO)
        return len(dati)

    def svuota(self, quanti=None):
        parte = bytes(self.buffer[:quanti]) if quanti else bytes(self.buffer)
        del self.buffer[:len(parte)]
        if parte:
            self.uscita.scrivi({"id": self.id, "pezzo": base64.b64encode(parte).decode("ascii")})

    def flush(self):
        pass


class GestorePonte(SV.Gestore):
    """Il gestore HTTP del server, ma senza socket: legge la richiesta dal messaggio e scrive nello Scrittore."""

    def __init__(self, messaggio, uscita, file=None):            # niente BaseHTTPRequestHandler.__init__
        self.command = messaggio.get("metodo", "GET").upper()
        self.path = messaggio.get("percorso", "/")
        corpo = base64.b64decode(messaggio["corpo"]) if messaggio.get("corpo") else b""
        self.headers = {"Content-Length": str(len(corpo)), "Content-Type": "application/json"}
        self.rfile = io.BytesIO(corpo)
        self.wfile = Scrittore(uscita, messaggio.get("id"), file)
        self.stato, self.intestazioni = 200, {}
        self.request_version = "HTTP/1.0"

    def send_response(self, codice, messaggio=None):
        self.stato = codice

    def send_header(self, chiave, valore):
        self.intestazioni[chiave] = valore

    def end_headers(self):
        # stato e intestazioni prima dei dati: l'app può cominciare subito a passare la risposta (download a flusso)
        if not getattr(self, "_testa", False):
            self._testa = True
            self.wfile.uscita.scrivi({"id": self.wfile.id, "testa": True, "stato": self.stato, "intestazioni": self.intestazioni})


def servi(messaggio, uscita):
    id_ = messaggio.get("id")
    destinazione = messaggio.get("salva_in")
    file = None
    try:
        if destinazione:
            file = open(destinazione, "wb")
        g = GestorePonte(messaggio, uscita, file)
        if g.command == "POST":
            g.do_POST()
        else:
            g.do_GET()
        g.wfile.svuota()
        fine = {"id": id_, "fine": True, "stato": g.stato, "intestazioni": g.intestazioni}
        if file:
            fine["salvato"], fine["byte"] = destinazione, g.wfile.scritti
        uscita.scrivi(fine)
    except Exception as e:
        uscita.scrivi({"id": id_, "fine": True, "stato": 500, "intestazioni": {"Content-Type": "application/json"},
                       "errore": f"{type(e).__name__}: {e}"})
    finally:
        if file:
            file.close()


def main():
    # lo standard output vero è solo per le risposte: tutto il resto (print, librerie) va sullo standard error
    canale = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    uscita = Uscita(canale)
    uscita.scrivi({"pronto": True})
    lavori = ThreadPoolExecutor(max_workers=16)
    for riga in sys.stdin:
        riga = riga.strip()
        if not riga:
            continue
        try:
            messaggio = json.loads(riga)
        except ValueError:
            continue
        lavori.submit(servi, messaggio, uscita)
    os._exit(0)                                # l'app si è chiusa


if __name__ == "__main__":
    main()
