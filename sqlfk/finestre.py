"""Lettura delle finestre di un programma Windows, tutto in locale (nessuna rete).

Si usa UI Automation, la stessa tecnologia dei lettori di schermo: per la finestra scelta si legge l'albero
dei controlli (etichette, caselle di testo, menu a tendina con le voci, griglie con intestazioni e righe,
schede, alberi). Funziona con quasi tutti i programmi Windows (Win32, WinForms, WPF, Qt, Electron, Java con
Java Access Bridge attivo).

"Leggi tutte le schede" passa da solo tra le schede (tab) e le voci degli alberi di navigazione,
selezionandole come farebbe una persona: non preme mai pulsanti, non usa i menu dei comandi, non scrive
niente nei campi. Apre e richiude i menu a tendina solo per leggerne le voci.

L'albero letto diventa una "fotografia" con lo stesso formato usato dall'analisi (sqlfk.interfaccia):
moduli con i campi, tabelle, schede etichetta: valore. Questa conversione non dipende da Windows (si prova
anche con alberi simulati: vedi Nodo).
"""

import os
import sys
import threading
import time
from dataclasses import dataclass, field

SU_WINDOWS = sys.platform == "win32"
MAX_NODI = 6000
MAX_PROFONDITA = 40
MAX_RIGHE = 40
MAX_OPZIONI = 300

# tipi di controllo di UI Automation (UIA_*ControlTypeId)
TIPI = {50000: "pulsante", 50001: "calendario", 50002: "casella", 50003: "menu", 50004: "testo modificabile",
        50005: "link", 50006: "immagine", 50007: "voce elenco", 50008: "elenco", 50009: "menu comandi",
        50010: "barra menu", 50011: "voce menu", 50012: "barra avanzamento", 50013: "scelta", 50014: "barra scorrimento",
        50015: "cursore", 50016: "numero", 50017: "barra stato", 50018: "schede", 50019: "scheda", 50020: "testo",
        50021: "barra strumenti", 50022: "suggerimento", 50023: "albero", 50024: "voce albero", 50025: "personalizzato",
        50026: "gruppo", 50027: "maniglia", 50028: "griglia", 50029: "riga", 50030: "documento", 50031: "pulsante menu",
        50032: "finestra", 50033: "riquadro", 50034: "intestazione", 50035: "voce intestazione", 50036: "tabella",
        50037: "barra titolo", 50038: "separatore", 50039: "intestazione semantica", 50040: "testo", 50041: "voce"}
CAMPI = {"testo modificabile", "menu", "casella", "scelta", "numero", "calendario", "cursore"}
GRIGLIE = {"griglia", "tabella", "elenco"}
CONTENITORI = {"finestra", "gruppo", "riquadro", "scheda", "documento", "personalizzato"}
DA_SALTARE = {"barra titolo", "barra scorrimento", "barra strumenti", "barra menu", "menu comandi", "suggerimento",
              "maniglia", "separatore", "barra stato", "immagine", "barra avanzamento"}


@dataclass
class Nodo:
    """Un controllo della finestra (anche simulato, per le prove)."""
    tipo: str
    nome: str = ""
    id: str = ""
    classe: str = ""
    valore: str = ""
    etichetta: str = ""                       # dal controllo che fa da etichetta (LabeledBy)
    obbligatorio: bool = False
    selezionato: bool = False
    password: bool = False
    opzioni: list = field(default_factory=list)          # voci di un menu a tendina
    intestazioni: list = field(default_factory=list)     # colonne di una griglia
    righe: list = field(default_factory=list)            # valori delle righe di una griglia
    figli: list = field(default_factory=list)


# ====================================================================== dall'albero alla fotografia

def _testo(n):
    return (n.nome or n.valore or "").strip()


def fotografia(finestra, percorso=(), processo=""):
    """L'albero di una finestra -> fotografia (formato di sqlfk.interfaccia). percorso: schede selezionate."""
    moduli, tabelle, dettagli = [], [], []
    intestazioni = [x for x in [finestra.nome, *percorso] if x]

    def griglia(n, titolo):
        intest = list(n.intestazioni)
        righe = [list(r) for r in n.righe]
        if not intest:
            h = next((f for f in n.figli if f.tipo == "intestazione"), None)
            if h:
                intest = [_testo(x) for x in h.figli if x.tipo == "voce intestazione"]
        if not righe:
            for r in n.figli:
                if r.tipo in ("riga", "voce elenco", "voce"):
                    celle = [_testo(c) for c in r.figli if c.tipo not in DA_SALTARE] or [_testo(r)]
                    righe.append(celle)
        if n.tipo == "elenco" and not intest:
            # un elenco semplice (una colonna): utile solo se ha un titolo da usare come intestazione
            if not titolo or not righe:
                return
            intest = [titolo]
        if intest or righe:
            tabelle.append({"titolo": n.nome or titolo, "intestazioni": intest[:60],
                            "righe": [r[:60] for r in righe[:MAX_RIGHE]], "link": []})

    def visita(n, titolo, profondita=0):
        if profondita > MAX_PROFONDITA or n.tipo in DA_SALTARE:
            return
        if n.tipo == "schede":
            # solo la scheda selezionata è visibile: le altre si leggono con Leggi tutte le schede
            scelte = [f for f in n.figli if f.tipo == "scheda" and f.selezionato] or [f for f in n.figli if f.tipo == "scheda"][:1]
            for f in scelte:
                visita(f, f.nome or titolo, profondita + 1)
            return
        if n.tipo in GRIGLIE and (n.intestazioni or n.righe or any(f.tipo in ("riga", "voce elenco", "intestazione") for f in n.figli)):
            griglia(n, n.nome or titolo)
            return
        if n.tipo in CONTENITORI and n is not finestra:
            nuovo = n.nome if n.tipo in ("gruppo", "scheda") and n.nome else titolo
            raccogli(n, nuovo, profondita)
            return
        for f in n.figli:
            visita(f, titolo, profondita + 1)

    def raccogli(contenitore, titolo, profondita):
        """Campi e coppie etichetta: valore tra i figli diretti, poi i figli più in profondità."""
        campi, coppie = [], []
        figli = contenitore.figli
        for i, f in enumerate(figli):
            if f.tipo in CAMPI:
                etichetta = f.etichetta or ""
                if not etichetta:
                    # l'etichetta è il testo subito prima (Win32/WinForms), o il nome del campo
                    precedente = next((figli[j] for j in range(i - 1, max(-1, i - 3), -1) if figli[j].tipo == "testo"), None)
                    etichetta = _testo(precedente).rstrip(":") if precedente else ""
                etichetta = etichetta or (f.nome if f.tipo != "testo modificabile" or f.nome != f.valore else "") or f.id
                if f.tipo == "scelta":
                    # i pulsanti di scelta dello stesso gruppo sono un solo campo
                    gia = next((c for c in campi if c["tipo"] == "scelta" and c["etichetta"] == titolo), None)
                    if gia:
                        gia["opzioni"].append({"valore": f.nome, "testo": f.nome})
                        continue
                    campi.append({"etichetta": titolo or f.nome, "nome": f.id, "tipo": "scelta", "obbligatorio": False,
                                  "valore": f.nome if f.selezionato else "", "opzioni": [{"valore": f.nome, "testo": f.nome}]})
                    continue
                campi.append({"etichetta": etichetta[:120], "nome": f.id or f.nome, "tipo": "menu" if f.tipo == "menu" else
                              ("checkbox" if f.tipo == "casella" else "text"), "obbligatorio": f.obbligatorio,
                              "valore": "" if f.password else (f.valore or "")[:80],
                              "opzioni": [{"valore": o, "testo": o} for o in f.opzioni[:MAX_OPZIONI]]})
            elif f.tipo == "testo" and i + 1 < len(figli) and figli[i + 1].tipo == "testo":
                # due testi di seguito: "Cliente:" "Rossi" è una coppia etichetta: valore
                e, v = _testo(f), _testo(figli[i + 1])
                if e.endswith(":") or (len(e) < 40 and v and e != v):
                    coppie.append({"etichetta": e.rstrip(":")[:80], "valore": v[:120], "link": []})
        if campi:
            moduli.append({"titolo": titolo, "campi": campi})
        if len(coppie) >= 2:
            dettagli.append({"titolo": titolo, "coppie": coppie})
        for f in figli:
            if f.tipo not in CAMPI and f.tipo != "testo":
                visita(f, titolo, profondita + 1)

    raccogli(finestra, " / ".join(percorso) or finestra.nome, 0)
    pulisci = lambda s: (s or "").replace("/", "-").strip() or "senza nome"
    url = "finestra://" + pulisci(processo or "programma") + "/" + "/".join(pulisci(x) for x in [finestra.nome, *percorso])
    firma = "#".join([url, ",".join(str(len(m["campi"])) for m in moduli),
                      ";".join(",".join(t["intestazioni"]) + ":" + str(len(t["righe"])) for t in tabelle), str(len(dettagli))])
    return {"url": url, "titolo": finestra.nome, "intestazioni": intestazioni, "moduli": moduli, "tabelle": tabelle,
            "dettagli": dettagli, "link": [], "firma": firma, "quando": time.strftime("%Y-%m-%dT%H:%M:%S")}


# ====================================================================== UI Automation (solo Windows)

class NonDisponibile(Exception):
    """La lettura delle finestre funziona solo su Windows."""


class Lettore:
    """Legge le finestre aperte con UI Automation."""

    def __init__(self):
        if not SU_WINDOWS:
            raise NonDisponibile("La lettura delle finestre dei programmi funziona su Windows (UI Automation).")
        try:
            import comtypes
            import comtypes.client
        except ImportError:
            raise NonDisponibile("Manca la libreria comtypes (pip install comtypes).")
        comtypes.CoInitialize()
        comtypes.client.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as U
        self.U = U
        self.auto = comtypes.client.CreateObject(U.CUIAutomation, interface=U.IUIAutomation)
        self.walker = self.auto.ControlViewWalker
        self.escludi_pid = {os.getpid()}
        if os.environ.get("SQLFK_PID_APP", "").isdigit():
            self.escludi_pid.add(int(os.environ["SQLFK_PID_APP"]))

    # ------------------------------------------------------------ piccoli aiuti
    def _figli(self, el):
        figli = []
        try:
            c = self.walker.GetFirstChildElement(el)
        except Exception:
            return figli
        while c:
            figli.append(c)
            try:
                c = self.walker.GetNextSiblingElement(c)
            except Exception:
                break
        return figli

    def _schema(self, el, codice, interfaccia):
        try:
            p = el.GetCurrentPattern(codice)
            return p.QueryInterface(interfaccia) if p else None
        except Exception:
            return None

    def _valore(self, el):
        p = self._schema(el, 10002, self.U.IUIAutomationValuePattern)
        try:
            return (p.CurrentValue or "") if p else ""
        except Exception:
            return ""

    def _processo(self, pid):
        import ctypes
        from ctypes import wintypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            n = wintypes.DWORD(1024)
            if ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                return os.path.basename(buf.value)
            return ""
        finally:
            ctypes.windll.kernel32.CloseHandle(h)

    # ------------------------------------------------------------ finestre aperte
    def finestre(self):
        """Le finestre principali aperte: [{id, titolo, programma, pid}]."""
        risultato = []
        for el in self._figli(self.auto.GetRootElement()):
            try:
                pid, titolo, hwnd = el.CurrentProcessId, el.CurrentName or "", el.CurrentNativeWindowHandle
            except Exception:
                continue
            if not titolo or not hwnd or pid in self.escludi_pid:
                continue
            risultato.append({"id": int(hwnd), "titolo": titolo, "programma": self._processo(pid), "pid": int(pid)})
        return sorted(risultato, key=lambda x: (x["programma"].lower(), x["titolo"].lower()))

    def finestre_del_programma(self, pid):
        return [f for f in self.finestre() if f["pid"] == pid]

    def elemento(self, hwnd):
        return self.auto.ElementFromHandle(hwnd)

    # ------------------------------------------------------------ lettura dell'albero
    def albero(self, el, apri_menu=True, scadenza=None):
        """L'albero dei controlli sotto el come Nodo (con limiti di nodi, profondità e tempo)."""
        conta = [0]
        scadenza = scadenza or time.time() + 25

        def leggi(e, profondita):
            conta[0] += 1
            try:
                tipo = TIPI.get(e.CurrentControlType, "altro")
                n = Nodo(tipo=tipo, nome=(e.CurrentName or "").strip(), id=e.CurrentAutomationId or "", classe=e.CurrentClassName or "")
                if e.CurrentIsOffscreen and tipo not in ("scheda", "voce albero"):
                    return None
            except Exception:
                return None
            if tipo in DA_SALTARE:
                return n
            try:
                n.password = bool(e.CurrentIsPassword)
                n.obbligatorio = bool(e.CurrentIsRequiredForForm)
                etich = e.CurrentLabeledBy
                n.etichetta = (etich.CurrentName or "").strip() if etich else ""
            except Exception:
                pass
            if tipo in CAMPI or tipo in ("testo", "voce", "voce elenco"):
                if not n.password:
                    n.valore = self._valore(e)[:200]
            if tipo in ("scheda", "voce albero", "voce elenco", "riga", "scelta"):
                s = self._schema(e, 10010, self.U.IUIAutomationSelectionItemPattern)
                try:
                    n.selezionato = bool(s.CurrentIsSelected) if s else False
                except Exception:
                    pass
            if tipo == "menu":
                n.opzioni = self._voci_menu(e, apri_menu)
            if tipo in ("griglia", "tabella") or (tipo == "elenco" and self._schema(e, 10006, self.U.IUIAutomationGridPattern)):
                self._griglia(e, n)
                if n.intestazioni or n.righe:
                    return n
            if profondita < MAX_PROFONDITA and conta[0] < MAX_NODI and time.time() < scadenza:
                for c in self._figli(e):
                    f = leggi(c, profondita + 1)
                    if f is not None:
                        n.figli.append(f)
            return n

        return leggi(el, 0)

    def _voci_menu(self, el, apri):
        def voci_presenti():
            voci = []
            for c in self._figli(el):
                for d in [c] + self._figli(c):          # le voci stanno nel menu o in un elenco dentro il menu
                    try:
                        if TIPI.get(d.CurrentControlType) == "voce elenco" and d.CurrentName:
                            voci.append(d.CurrentName.strip())
                    except Exception:
                        pass
            return voci
        voci = voci_presenti()
        if voci or not apri:
            return voci[:MAX_OPZIONI]
        # le voci si vedono solo con il menu aperto: si apre, si leggono, si richiude (senza scegliere niente)
        p = self._schema(el, 10005, self.U.IUIAutomationExpandCollapsePattern)
        if not p:
            return []
        try:
            p.Expand()
            time.sleep(0.3)
            voci = voci_presenti()
        except Exception:
            voci = []
        finally:
            try:
                p.Collapse()
            except Exception:
                pass
        return voci[:MAX_OPZIONI]

    def _griglia(self, el, n):
        t = self._schema(el, 10012, self.U.IUIAutomationTablePattern)
        g = self._schema(el, 10006, self.U.IUIAutomationGridPattern)
        try:
            if t:
                h = t.GetCurrentColumnHeaders()
                n.intestazioni = [(h.GetElement(i).CurrentName or "").strip() for i in range(h.Length)]
            if g:
                righe, colonne = min(g.CurrentRowCount, MAX_RIGHE), min(g.CurrentColumnCount, 60)
                for r in range(righe):
                    riga = []
                    for c in range(colonne):
                        try:
                            cella = g.GetItem(r, c)
                            riga.append((self._valore(cella) or cella.CurrentName or "").strip()[:80])
                        except Exception:
                            riga.append("")
                    n.righe.append(riga)
        except Exception:
            pass

    # ------------------------------------------------------------ navigazione sicura
    def schede_e_alberi(self, el):
        """I controlli che servono a navigare: schede (tab) e voci degli alberi."""
        trovati = []

        def cerca(e, profondita):
            if profondita > 25 or len(trovati) > 400:
                return
            for c in self._figli(e):
                try:
                    tipo = TIPI.get(c.CurrentControlType)
                except Exception:
                    continue
                if tipo in ("scheda", "voce albero"):
                    trovati.append(c)
                if tipo not in DA_SALTARE and tipo not in ("griglia", "tabella"):
                    cerca(c, profondita + 1)
        cerca(el, 0)
        return trovati

    def seleziona(self, el):
        """Seleziona una scheda o una voce di un albero (come un clic per spostarsi, non un comando)."""
        s = self._schema(el, 10010, self.U.IUIAutomationSelectionItemPattern)
        if s:
            s.Select()
            return True
        return False


# ====================================================================== lettura per l'app

class Sessione:
    """Lettura delle finestre di un programma per il server dell'app: scelta, lettura, registrazione."""

    def __init__(self, ricevi):
        self.ricevi = ricevi                        # funzione che riceve ogni fotografia
        self._locale = threading.local()            # UI Automation (COM): un lettore per ogni thread
        self.registra = False
        self.stato = {"in_corso": False, "messaggio": "", "lette": 0}
        self._filo = None

    def _lettore(self):
        if getattr(self._locale, "lettore", None) is None:
            self._locale.lettore = Lettore()
        return self._locale.lettore

    def finestre(self):
        return self._lettore().finestre()

    def _fotografa(self, hwnd, percorso=(), apri_menu=True):
        L = self._lettore()
        el = L.elemento(hwnd)
        info = next((f for f in L.finestre() if f["id"] == hwnd), {"programma": ""})
        foto = fotografia(L.albero(el, apri_menu), percorso, info["programma"])
        self.ricevi(foto)
        self.stato["lette"] += 1
        return foto

    def leggi(self, hwnd):
        """Legge la finestra così com'è adesso."""
        return self._fotografa(hwnd)

    def leggi_tutto(self, hwnd, massimo=150):
        """Passa da solo tra le schede e le voci degli alberi di navigazione, e legge ogni volta la finestra."""
        if self.stato["in_corso"]:
            return
        self.stato.update(in_corso=True, messaggio="lettura di tutte le schede")

        def lavoro():
            import comtypes
            comtypes.CoInitialize()
            L = Lettore()
            try:
                el = L.elemento(hwnd)
                self._fotografa(hwnd)
                visti, lette = set(), 1
                while lette < massimo and self.stato["in_corso"]:
                    da_fare = None
                    for c in L.schede_e_alberi(el):
                        try:
                            chiave = (TIPI.get(c.CurrentControlType), c.CurrentName, c.CurrentAutomationId)
                        except Exception:
                            continue
                        if chiave not in visti:
                            da_fare = (c, chiave)
                            break
                    if not da_fare:
                        break
                    c, chiave = da_fare
                    visti.add(chiave)
                    try:
                        if not L.seleziona(c):
                            continue
                    except Exception:
                        continue
                    time.sleep(0.8)                 # il programma aggiorna la finestra
                    self._fotografa(hwnd, (chiave[1] or "",))
                    lette += 1
                    self.stato["messaggio"] = f"lette {lette} schede"
                self.stato["messaggio"] = f"lettura finita: {lette} schede"
            except Exception as e:
                self.stato["messaggio"] = f"lettura interrotta: {e}"
            finally:
                self.stato["in_corso"] = False
        self._filo = threading.Thread(target=lavoro, daemon=True)
        self._filo.start()

    def avvia_registrazione(self, hwnd):
        """Mentre navighi nel programma, legge la finestra ogni 2 secondi (e le altre finestre dello stesso programma)."""
        if self.registra:
            return
        self.registra = True
        self.stato["messaggio"] = "registrazione: naviga nel programma, ogni schermata viene letta"

        def lavoro():
            import comtypes
            comtypes.CoInitialize()
            L = Lettore()
            pid = next((f["pid"] for f in L.finestre() if f["id"] == hwnd), None)
            while self.registra:
                try:
                    for f in (L.finestre_del_programma(pid) if pid else [{"id": hwnd, "programma": ""}]):
                        foto = fotografia(L.albero(L.elemento(f["id"]), apri_menu=False), (), f.get("programma", ""))
                        self.ricevi(foto)
                except Exception:
                    pass
                time.sleep(2)
        threading.Thread(target=lavoro, daemon=True).start()

    def ferma(self):
        self.registra = False
        self.stato["in_corso"] = False
        self.stato["messaggio"] = "fermato"
