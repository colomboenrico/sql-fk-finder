"""L'assistente: una chat sul database caricato, con un modello di linguaggio che gira sul computer (niente rete).

- Il modello è un file .gguf (per esempio Qwen2.5-Coder 7B o 14B) letto da llama-cpp-python dentro questo processo:
  nessun server, nessuna porta, nessuna connessione. Se la libreria o il modello mancano, l'assistente risponde lo stesso
  con le regole (percorsi, tabelle, problemi, conteggi), usando gli stessi strumenti.
- Il modello non inventa: riceve il contesto del database (le tabelle che c'entrano con la domanda, chiavi, collegamenti,
  descrizioni) e può chiedere all'app di eseguire degli strumenti (una query in sola lettura sui dati, la scheda di una
  tabella, il percorso tra due tabelle, i suggerimenti); i risultati veri tornano al modello, che risponde in italiano.
  Nella chat si vedono i passi fatti, con le query e le righe.
"""
import ctypes
import json
import os
import platform
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

# niente rete: le librerie dei modelli non devono cercare aggiornamenti o file su internet
for _v in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
    os.environ.setdefault(_v, "1")

MODELLI_CONSIGLIATI = [
    {"nome": "Qwen2.5-Coder-7B-Instruct, Q4_K_M", "file": "qwen2.5-coder-7b-instruct-q4_k_m.gguf", "gb": 4.7, "ram": 7,
     "per": "16-32 GB di RAM: il consigliato, veloce anche senza scheda grafica",
     "pagina": "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF"},
    {"nome": "Qwen2.5-Coder-14B-Instruct, Q4_K_M", "file": "qwen2.5-coder-14b-instruct-q4_k_m.gguf", "gb": 9.0, "ram": 12,
     "per": "32 GB di RAM: più preciso nei ragionamenti, più lento su CPU",
     "pagina": "https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF"},
    {"nome": "Qwen2.5-Coder-3B-Instruct, Q4_K_M", "file": "qwen2.5-coder-3b-instruct-q4_k_m.gguf", "gb": 2.1, "ram": 3.5,
     "per": "8 GB di RAM: risposte più semplici",
     "pagina": "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF"},
]

PASSI_MASSIMI = 4               # strumenti usati al più per una domanda
CONTESTO_CARATTERI = 11000      # quanto contesto del database si dà al modello (circa 3.000 token)


def cartelle_modelli():
    cartelle = []
    if os.environ.get("SQLFK_MODELLI"):
        cartelle.append(Path(os.environ["SQLFK_MODELLI"]).expanduser())
    cartelle += [Path.home() / "Documents" / "SQL FK Finder" / "modelli", Path.home() / "Documenti" / "SQL FK Finder" / "modelli",
                 Path.home() / ".sqlfk" / "modelli"]
    return cartelle


def modelli_trovati():
    """I file .gguf nelle cartelle dei modelli (dei modelli divisi in più parti si mostra la prima)."""
    trovati, visti = [], set()
    for c in cartelle_modelli():
        if not c.is_dir():
            continue
        for f in sorted(c.glob("*.gguf")):
            m = re.search(r"-(\d{5})-of-(\d{5})\.gguf$", f.name)
            if m and m.group(1) != "00001":
                continue
            if f.resolve() in visti:
                continue
            visti.add(f.resolve())
            parti = sorted(c.glob(f.name.replace("-00001-of-", "-*-of-"))) if m else [f]
            trovati.append({"percorso": str(f), "nome": f.name, "gb": round(sum(p.stat().st_size for p in parti) / 1e9, 1)})
    return trovati


def ram_totale_gb():
    try:
        if os.name == "nt":
            class Stato(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            s = Stato()
            s.dwLength = ctypes.sizeof(Stato)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return round(s.ullTotalPhys / 2**30, 1)
        if platform.system() == "Darwin":
            return round(int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) / 2**30, 1)
        with open("/proc/meminfo") as f:
            return round(int(f.readline().split()[1]) / 2**20, 1)
    except Exception:
        return None


def libreria():
    try:
        import llama_cpp
        return getattr(llama_cpp, "__version__", "?")
    except Exception:
        return None


# ====================================================================== il modello

class Modello:
    """Il modello caricato (uno alla volta), con il suo lucchetto: una generazione alla volta."""

    def __init__(self):
        self.llm, self.percorso, self.errore, self.caricando = None, None, None, False
        self.lock = threading.Lock()

    def stato(self):
        return {"libreria": libreria(), "caricato": self.percorso if self.llm else None, "caricando": self.caricando,
                "errore": self.errore, "modelli": modelli_trovati(), "cartelle": [str(c) for c in cartelle_modelli()[:2]],
                "consigliati": MODELLI_CONSIGLIATI, "ram_gb": ram_totale_gb(), "processori": os.cpu_count(),
                "sistema": f"{platform.system()} {platform.machine()}"}

    def carica(self, percorso):
        """Carica in background (pochi secondi per un 7B dal disco)."""
        percorso = str(Path(str(percorso or "")).expanduser())
        if not Path(percorso).is_file():
            raise FileNotFoundError(f"Il file del modello non esiste: {percorso}")
        if not libreria():
            raise RuntimeError("Manca la libreria llama-cpp-python: negli eseguibili si include con crea_eseguibili; "
                               "dai sorgenti: pip install llama-cpp-python")
        self.caricando, self.errore = True, None

        def lavoro():
            try:
                from llama_cpp import Llama
                gpu = -1 if platform.system() == "Darwin" else int(os.environ.get("SQLFK_LLM_GPU", "0"))
                llm = Llama(model_path=percorso, n_ctx=int(os.environ.get("SQLFK_LLM_CONTESTO", "8192")),
                            n_threads=max(1, (os.cpu_count() or 4) - 1), n_gpu_layers=gpu, verbose=False)
                with self.lock:
                    self.llm, self.percorso = llm, percorso
            except Exception as e:
                self.errore = f"{type(e).__name__}: {e}"
            finally:
                self.caricando = False
        threading.Thread(target=lavoro, daemon=True).start()
        return self.stato()

    def scarica_dalla_memoria(self):
        with self.lock:
            self.llm, self.percorso = None, None

    def genera(self, messaggi, al_pezzo, fermo, max_token=1600):
        """Risposta del modello, un pezzo alla volta (al_pezzo(testo)); si ferma su "RISULTATO:" o se fermo() è vero."""
        with self.lock:
            if not self.llm:
                raise RuntimeError("Nessun modello caricato.")
            testo = ""
            for parte in self.llm.create_chat_completion(messages=messaggi, max_tokens=max_token, temperature=0.2, top_p=0.9,
                                                         stream=True, stop=["RISULTATO:", "<|im_end|>"]):
                delta = parte["choices"][0].get("delta", {}).get("content") or ""
                testo += delta
                al_pezzo(testo)
                if fermo() or re.search(r"^AZIONE:\s*\{.*\}\s*$", testo, re.M):
                    break                        # un'azione completa: la si esegue subito
            return testo


SISTEMA = """Sei l'assistente di SQL FK Finder: un esperto di database relazionali (modello E-R, normalizzazione, chiavi
primarie ed esterne, indici, SQL) e un architetto del software che sa far comunicare applicativi diversi (API REST, eventi
con tabella outbox, code di messaggi, viste in sola lettura, scambio di file con tabelle di appoggio, sincronizzazione).
Rispondi in italiano come un collega esperto: chiaro, concreto, con i passi da fare e il codice quando serve.

Hai davanti il database dell'utente (descritto sotto): spesso è quello che sta costruendo nell'editor, quindi aiutalo a
progettarlo: cosa manca, come collegare le entità, che tipi usare, come organizzare il lavoro e i prossimi passi.
Se chiede come far comunicare il database con un altro applicativo, scegli il modo migliore per il suo caso, spiega perché
in poche righe e scrivi il necessario (tabelle, trigger, viste, endpoint, codice del backend) usando le sue tabelle vere.
Regole da rispettare: ogni dato ha un solo proprietario, niente due programmi che scrivono nelle stesse tabelle, chiavi
stabili per lo scambio, operazioni ripetibili senza danni, versione del formato.
Usa SOLO tabelle e colonne che esistono davvero: se ne proponi di nuove dillo chiaramente. Se non sai, dillo.
Tutto gira su un computer senza internet: non proporre servizi cloud se l'utente non li chiede.

Puoi usare uno strumento alla volta, scrivendo una sola riga che comincia con AZIONE: e un JSON:
AZIONE: {"strumento": "sql", "query": "SELECT ... LIMIT 20"}       una SELECT in sola lettura sui dati (SQLite)
AZIONE: {"strumento": "tabella", "nome": "clienti"}                colonne, chiavi, collegamenti ed esempi di una tabella
AZIONE: {"strumento": "percorso", "da": "clienti", "colonna": "nome", "valore": "Mirco", "a": "prodotti"}
                                                                   come si arriva da un dato alle righe di un'altra tabella
AZIONE: {"strumento": "suggerimenti"}                              i problemi trovati nello schema (controlli automatici)
AZIONE: {"strumento": "integrazione", "tabelle": ["ordini"], "descrizione": "il sito deve ricevere gli ordini subito"}
                                                                   uno schema di partenza per far comunicare due applicativi
Dopo l'azione riceverai RISULTATO: con i dati veri; poi continua. Quando hai la risposta scrivila senza AZIONE.
Metti SQL in blocchi ```sql e il codice in blocchi con il linguaggio. Non inventare dati: usa i risultati degli strumenti."""


# ====================================================================== la conversazione

class Conversazione:
    """Una risposta in corso: testo parziale, passi (strumenti usati) e stato; la pagina la segue a intervalli."""

    def __init__(self, domanda):
        self.id = uuid.uuid4().hex[:12]
        self.domanda = domanda
        self.testo, self.passi, self.finito, self.errore, self.modo = "", [], False, None, ""
        self.fermato = False
        self.inizio = time.time()

    def dati(self):
        return {"id": self.id, "testo": pulisci(self.testo), "passi": self.passi, "finito": self.finito, "errore": self.errore,
                "modo": self.modo, "secondi": round(time.time() - self.inizio, 1)}


def pulisci(testo):
    """Il testo da mostrare: senza le righe AZIONE (i passi si vedono a parte)."""
    return re.sub(r"^AZIONE:.*$", "", testo or "", flags=re.M).strip()


def leggi_azione(testo):
    m = re.search(r"^AZIONE:\s*(\{.*\})\s*$", testo, re.M)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return {"strumento": "?", "errore": "JSON non valido"}


def rispondi_con_modello(conv, modello, contesto, storia, strumenti):
    """Il ciclo: il modello scrive; se chiede uno strumento lo si esegue e gli si dà il risultato (al più PASSI_MASSIMI)."""
    conv.modo = "modello"
    messaggi = [{"role": "system", "content": SISTEMA + "\n\nIL DATABASE\n" + contesto}]
    for m in (storia or [])[-6:]:                       # le ultime domande e risposte, per il filo del discorso
        if m.get("ruolo") in ("utente", "assistente") and m.get("testo"):
            messaggi.append({"role": "user" if m["ruolo"] == "utente" else "assistant", "content": str(m["testo"])[:2000]})
    messaggi.append({"role": "user", "content": conv.domanda})
    fatto = ""
    for passo in range(PASSI_MASSIMI + 1):
        testo = modello.genera(messaggi, lambda t: setattr(conv, "testo", fatto + t), lambda: conv.fermato)
        azione = leggi_azione(testo)
        if conv.fermato:
            conv.testo = fatto + testo + "\n\n(interrotto)"
            return
        if not azione or passo == PASSI_MASSIMI:
            conv.testo = fatto + testo
            return
        risultato = esegui_strumento(azione, strumenti)
        conv.passi.append(risultato)
        fatto = pulisci(fatto + testo) + ("\n\n" if pulisci(fatto + testo) else "")
        messaggi.append({"role": "assistant", "content": testo.strip()})
        messaggi.append({"role": "user", "content": "RISULTATO: " + risultato["per_il_modello"]})
        conv.testo = fatto


def esegui_strumento(azione, strumenti):
    nome = str(azione.get("strumento", ""))
    passo = {"strumento": nome, "richiesta": {k: v for k, v in azione.items() if k != "strumento"}}
    try:
        if nome not in strumenti:
            raise ValueError(f"strumento sconosciuto: {nome}")
        risultato = strumenti[nome](**{k: v for k, v in azione.items() if k != "strumento"})
        passo.update(risultato)
        passo["ok"] = True
    except Exception as e:
        passo.update({"ok": False, "testo": str(e), "per_il_modello": f"errore: {e}"})
    passo.setdefault("per_il_modello", passo.get("testo", ""))
    passo["per_il_modello"] = str(passo["per_il_modello"])[:3500]
    return passo


# ====================================================================== senza modello: le regole

def trova_tabelle(testo, nomi):
    """Le tabelle nominate nel testo (anche al singolare o al plurale), nell'ordine in cui compaiono."""
    t = " " + re.sub(r"[^\w]+", " ", testo.lower()) + " "
    trovate = []
    for n in nomi:
        radice = n.lower()
        varianti = {radice, radice.rstrip("aeio"), radice[:-1] + "o" if len(radice) > 3 else radice,
                    radice[:-1] + "a" if len(radice) > 3 else radice, radice[:-1] + "e" if len(radice) > 3 else radice}
        posti = [t.find(f" {v}") for v in varianti if len(v) > 2 and re.search(rf" {re.escape(v)}\w{{0,2}} ", t)]
        if posti:
            trovate.append((min(p for p in posti if p >= 0), n))
    ordinate = [n for _, n in sorted(trovate)]
    # parole che nelle domande sono parole e non tabelle (quante righe ha...): contano solo se non c'è altro
    altre = [n for n in ordinate if n.lower() not in PAROLE_COMUNI]
    return altre or ordinate


PAROLE_COMUNI = {"riga", "righe", "record", "dati", "dato", "tabella", "tabelle", "valori", "valore", "database", "colonne", "colonna"}

RE_INTEGRAZIONE = r"(comunic|integr|applicativ|sincronizz|altr[oa] (programma|sistema|software|servizio|app)|\bapi\b|webhook|scambi|" \
                  r"interfacci|gestionale|erp|crm|e-?commerce|sito|programma|software|report|power ?bi|dashboard|esterno)"
RE_PROGETTO = r"(progett|come (faccio|fare|devo|posso|lo faccio|procedo)|struttur|organizz|da dove (parto|comincio|inizio)|" \
              r"prossimi passi|cosa (devo|dovrei) fare|roadmap|consigli sul|architettur|è fatto bene|va bene così)"


def tabelle_centrali(col_per_tab, collegamenti, quante=4):
    """Le tabelle con più collegamenti: quelle che un altro applicativo di solito vuole leggere o scrivere."""
    conta = {t: 0 for t in col_per_tab}
    for l in collegamenti:
        for t in (l["da"], l["a"]):
            if t in conta:
                conta[t] += 1
    return [t for t, _ in sorted(conta.items(), key=lambda x: (-x[1], x[0]))[:quante]]


def _chiave(S, t):
    return S.pk.get(t) or [S.col_per_tab[t][0]]


def _tabella_outbox(dialetto):
    if dialetto == "postgres":
        return ("CREATE TABLE eventi_uscita (\n  id BIGSERIAL PRIMARY KEY,\n  tabella VARCHAR(64) NOT NULL,\n  chiave VARCHAR(200) NOT NULL,\n"
                "  operazione VARCHAR(10) NOT NULL,          -- INSERT, UPDATE, DELETE\n  dati JSONB,\n"
                "  creato TIMESTAMP NOT NULL DEFAULT now(),\n  inviato TIMESTAMP NULL                    -- NULL = ancora da mandare\n);\n"
                "CREATE INDEX ix_eventi_da_inviare ON eventi_uscita (inviato, id);")
    if dialetto == "tsql":
        return ("CREATE TABLE eventi_uscita (\n  id BIGINT IDENTITY PRIMARY KEY,\n  tabella NVARCHAR(64) NOT NULL,\n  chiave NVARCHAR(200) NOT NULL,\n"
                "  operazione NVARCHAR(10) NOT NULL,\n  dati NVARCHAR(MAX),\n  creato DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),\n"
                "  inviato DATETIME2 NULL\n);\nCREATE INDEX ix_eventi_da_inviare ON eventi_uscita (inviato, id);")
    return ("CREATE TABLE eventi_uscita (\n  id BIGINT AUTO_INCREMENT PRIMARY KEY,\n  tabella VARCHAR(64) NOT NULL,\n  chiave VARCHAR(200) NOT NULL,\n"
            "  operazione VARCHAR(10) NOT NULL,          -- INSERT, UPDATE, DELETE\n  dati JSON,\n"
            "  creato DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  inviato DATETIME NULL,                   -- NULL = ancora da mandare\n"
            "  INDEX ix_eventi_da_inviare (inviato, id)\n);")


def _trigger_outbox(S, t, dialetto):
    k = _chiave(S, t)
    colonne = S.col_per_tab[t][:8]
    if dialetto == "postgres":
        return (f"CREATE FUNCTION evento_{t}() RETURNS trigger AS $$\nBEGIN\n"
                f"  INSERT INTO eventi_uscita (tabella, chiave, operazione, dati)\n"
                f"  VALUES ('{t}', NEW.{k[0]}::text, TG_OP, to_jsonb(NEW));\n  RETURN NEW;\nEND $$ LANGUAGE plpgsql;\n"
                f"CREATE TRIGGER tr_{t}_evento AFTER INSERT OR UPDATE ON {t}\n  FOR EACH ROW EXECUTE FUNCTION evento_{t}();")
    if dialetto == "mysql":
        coppie = ", ".join(f"'{c}', NEW.{c}" for c in colonne)
        return (f"CREATE TRIGGER tr_{t}_inserito AFTER INSERT ON {t} FOR EACH ROW\n"
                f"  INSERT INTO eventi_uscita (tabella, chiave, operazione, dati)\n"
                f"  VALUES ('{t}', NEW.{k[0]}, 'INSERT', JSON_OBJECT({coppie}));\n"
                f"-- uguale con AFTER UPDATE ('UPDATE') e AFTER DELETE (OLD.{k[0]}, 'DELETE')")
    return (f"-- un trigger AFTER INSERT/UPDATE/DELETE su {t} che scrive una riga in eventi_uscita\n"
            f"-- (tabella = '{t}', chiave = {k[0]}, operazione, dati in JSON), oppure lo fa il backend nella stessa transazione")


def guida_integrazione(descrizione, tabelle, S, dialetto):
    """Come far comunicare il database con un altro applicativo: il modo consigliato per il caso descritto, le alternative
    e il codice di partenza (tabelle, trigger, endpoint) per le tabelle del database. Regole, non un modello."""
    d = (descrizione or "").lower()
    tempo_reale = re.search(r"(subito|appena|tempo reale|real.?time|immediat|evento|notific|quando (cambia|arriva|si crea|inserisco))", d)
    file_ = re.search(r"(file|csv|excel|xml|ftp|notte|batch|giornalier|ogni (sera|giorno|ora)|export|import)", d)
    lettura = re.search(r"(report|statistic|\bbi\b|power ?bi|dashboard|solo legge|legg(e|ere) (i dati|soltanto)|consult)", d)
    web = re.search(r"(web|sito|app|mobile|rest|http|api|e-?commerce|portale|frontend)", d)
    if tempo_reale:
        scelta = ("eventi", "Eventi con una tabella di uscita (outbox): ogni cambiamento scrive un evento nella stessa transazione e un "
                  "piccolo servizio lo manda all'altro applicativo (chiamata HTTP, coda come RabbitMQ/MQTT nella rete locale, o file). "
                  "Nessun evento si perde, anche se l'altro sistema è spento: si rimanda quando torna.")
    elif lettura:
        scelta = ("lettura", "Accesso in sola lettura: viste dedicate e un utente del database con solo SELECT su quelle viste (o una "
                  "copia del database aggiornata a intervalli). L'altro applicativo legge senza poter rompere nulla, e se le tabelle "
                  "cambiano basta aggiornare le viste.")
    elif file_:
        scelta = ("file", "Scambio di file a intervalli (CSV o JSON) con tabelle di appoggio (staging): si esporta ciò che è cambiato "
                  "dall'ultima volta, l'altro lato importa nelle sue tabelle di appoggio, controlla e poi copia. Semplice, senza "
                  "connessioni sempre aperte, adatto a scambi giornalieri.")
    else:
        scelta = ("api", "Un'API (REST/JSON) davanti al database: solo il backend di questo database scrive nelle tabelle; l'altro "
                  "applicativo chiama gli endpoint. Le regole (chiavi, controlli, transazioni) stanno in un posto solo e il database "
                  "si può cambiare senza rompere l'altro programma.")
    righe = [f"**Il modo che consiglio: {scelta[1].split(':')[0]}**", scelta[1],
             "**Perché non far scrivere l'altro applicativo direttamente nelle tabelle**",
             "Due programmi che scrivono nelle stesse tabelle si rompono a vicenda: vincoli aggirati, regole duplicate, nessuno sa chi "
             "ha cambiato cosa, e ogni modifica dello schema obbliga a cambiare tutti e due. Ogni dato deve avere un solo proprietario.",
             "**Le alternative, e quando usarle**",
             "- API REST: l'altro programma chiede e scrive quando vuole (web, app, gestionali moderni).\n"
             "- Eventi / outbox: l'altro deve sapere subito che qualcosa è cambiato (ordini, magazzino, notifiche).\n"
             "- Viste in sola lettura: report, BI, statistiche, consultazione.\n"
             "- File a intervalli con tabelle di appoggio: sistemi vecchi, scambi notturni, nessuna connessione diretta.\n"
             "- Database condiviso in scrittura: da evitare, salvo un solo programma proprietario e gli altri in lettura."]
    if tabelle:
        righe.append(f"**Per questo database** (tabelle più collegate: {', '.join(tabelle)})")
        t0 = tabelle[0]
        if scelta[0] == "api" or web:
            endpoint = []
            for t in tabelle:
                k = "/".join("{" + c + "}" for c in _chiave(S, t))
                endpoint.append(f"GET    /api/{t}?pagina=1&cerca=...    elenco\nGET    /api/{t}/{k}    una riga\n"
                                f"POST   /api/{t}    nuova riga (JSON)\nPUT    /api/{t}/{k}    modifica\nDELETE /api/{t}/{k}    cancella")
            righe.append("Gli endpoint di partenza:\n```http\n" + "\n\n".join(endpoint) + "\n```")
            righe.append("Il codice che legge e scrive queste tabelle (insert, update, delete, get) lo genera la pagina **Backend**: "
                         "l'API chiama quelle funzioni.")
        if scelta[0] == "eventi":
            righe.append("La tabella degli eventi e un trigger di esempio:\n```sql\n" + _tabella_outbox(dialetto) + "\n\n"
                         + _trigger_outbox(S, t0, dialetto) + "\n```")
            righe.append("Il servizio che invia: ogni pochi secondi legge `SELECT * FROM eventi_uscita WHERE inviato IS NULL ORDER BY id "
                         "LIMIT 100`, manda gli eventi e mette `inviato = adesso` solo se l'altro ha risposto ok. Chi riceve deve "
                         "ignorare gli eventi già visti (usa id come chiave): così un invio ripetuto non fa danni.")
        if scelta[0] == "lettura":
            viste = []
            for t in tabelle[:3]:
                viste.append(f"CREATE VIEW v_{t} AS\n  SELECT {', '.join(S.col_per_tab[t][:10])}\n  FROM {t};")
            utente = ("CREATE USER 'lettore'@'%' IDENTIFIED BY '...';\n" + "\n".join(f"GRANT SELECT ON v_{t} TO 'lettore'@'%';" for t in tabelle[:3])
                      if dialetto == "mysql" else "-- un ruolo con solo SELECT sulle viste:\n" + "\n".join(f"GRANT SELECT ON v_{t} TO lettore;" for t in tabelle[:3]))
            righe.append("Viste e utente in sola lettura:\n```sql\n" + "\n\n".join(viste) + "\n\n" + utente + "\n```")
        if scelta[0] == "file":
            k = _chiave(S, t0)
            righe.append("Tabella di appoggio per importare (stessa forma, senza vincoli, con lo stato della riga):\n```sql\n"
                         f"CREATE TABLE appoggio_{t0} AS SELECT * FROM {t0} WHERE 1 = 0;\n"
                         f"ALTER TABLE appoggio_{t0} ADD COLUMN esito VARCHAR(20) NULL;   -- ok, scartata, errore\n```\n"
                         f"Per esportare solo ciò che è cambiato serve una colonna `modificato` (data e ora) in {t0}: "
                         f"`SELECT * FROM {t0} WHERE modificato > :ultima_esportazione`. L'importazione aggiorna per chiave ({', '.join(k)}).")
    righe += ["**Regole che valgono sempre**",
              "- Un solo proprietario per ogni dato; gli altri lo leggono o lo chiedono.\n"
              "- Per lo scambio usa chiavi stabili (un codice o un UUID), non gli id interni che cambiano tra un database e l'altro.\n"
              "- Ogni messaggio o chiamata deve poter essere ripetuto senza danni (idempotenza).\n"
              "- Tieni un registro di cosa è stato mandato e ricevuto, con l'esito.\n"
              "- Dai una versione al formato (es. /api/v1/...): cambiarlo non rompe l'altro applicativo.",
              "Se mi dici cosa fa l'altro applicativo (legge, scrive, quanto spesso, se deve sapere subito) affino il consiglio."]
    return "\n\n".join(righe)


def guida_progetto(S, collegamenti, suggerimenti, progetto):
    """I prossimi passi per il database che si sta costruendo, letti dalla struttura e dai suggerimenti."""
    tabelle = list(S.col_per_tab)
    senza_pk = [t for t in tabelle if not S.pk.get(t)]
    collegate = {l["da"] for l in collegamenti} | {l["a"] for l in collegamenti}
    isolate = [t for t in tabelle if t not in collegate]
    centrali = tabelle_centrali(S.col_per_tab, collegamenti, 3)
    righe = [f"**Com'è adesso**", f"{len(tabelle)} tabelle, {len(collegamenti)} collegamenti. "
             + (f"Le tabelle centrali sono {', '.join(centrali)}. " if collegamenti else "")
             + (f"Senza chiave primaria: {', '.join(senza_pk[:8])}. " if senza_pk else "Tutte hanno la chiave primaria. ")
             + (f"Non collegate a nulla: {', '.join(isolate[:8])}." if isolate and len(tabelle) > 1 else "")]
    passi = []
    if senza_pk:
        passi.append(f"Dai una chiave primaria a {', '.join(senza_pk[:5])} (un id intero autoincrementale, o la chiave naturale se è stabile).")
    if isolate and len(tabelle) > 1:
        passi.append(f"Decidi come si collegano {', '.join(isolate[:5])}: nell'editor trascina dalla maniglia di un'entità all'altra e "
                     "scegli 1:N, 1:1 o N:M (la N:M diventa una tabella ponte).")
    passi.append("Correggi i problemi dei suggerimenti qui sotto (tipi, NOT NULL, UNIQUE, nomi).")
    passi.append("Crea il database di prova e riempilo nella pagina **Popola e verifica**: controlla che le chiavi esterne rifiutino "
                 "i figli senza padre e che la cancellazione di un padre faccia quello che ti aspetti.")
    passi.append("Prova le domande vere del progetto (quali dati servono e da dove): pagina **Prova** → Chiedi un dato, o chiedimelo qui.")
    passi.append("Genera il codice di accesso ai dati nella pagina **Backend** e la **Documentazione** da dare a chi lavora con te.")
    passi.append("Se il database deve parlare con altri applicativi, dimmi quali e come: ti propongo il modo (API, eventi, viste, file).")
    righe += ["**I prossimi passi**", "\n".join(f"{i}. {p}" for i, p in enumerate(passi, 1))]
    if suggerimenti:
        righe += ["**Cosa migliorare per primo**", suggerimenti]
    if not progetto:
        righe.append("Scrivi nel riquadro «Il progetto» a cosa serve il database e con quali programmi lavora: i consigli diventano più precisi.")
    return "\n\n".join(righe)


def rispondi_con_regole(conv, nomi, strumenti, F=None, progetto=""):
    """Capisce le domande frequenti e usa gli strumenti; per il resto spiega cosa sa fare."""
    conv.modo = "regole"
    d = conv.domanda.strip()
    basso = d.lower()
    tabelle = trova_tabelle(d, nomi)

    def usa(azione, frase):
        p = esegui_strumento(azione, strumenti)
        conv.passi.append(p)
        conv.testo = frase + "\n\n" + p.get("testo", "")
        return p

    if re.match(r"^\s*(select|with)\b", basso):
        return usa({"strumento": "sql", "query": d}, "Ho eseguito la query:")
    valore = re.search(r"(?:=|uguale a|si chiama|vale|è)\s*['\"«]?([^'\"»?]+?)['\"»]?\s*(?:\?|$|,| a | verso )", d)
    colonna = re.search(r"\b(?:con|dove|il cui|la cui)\s+(\w+)\s*(?:=|uguale|si chiama|vale|è)", basso)
    if len(tabelle) >= 2 and re.search(r"(arriv|collega|passa|percorso|join|unisc|legat|da .* a )", basso):
        if valore and colonna:
            return usa({"strumento": "percorso", "da": tabelle[0], "colonna": colonna.group(1), "valore": valore.group(1).strip(), "a": tabelle[1]},
                       f"Da {tabelle[0]}.{colonna.group(1)} = {valore.group(1).strip()} a {tabelle[1]}:")
        return usa({"strumento": "percorso", "da": tabelle[0], "a": tabelle[1]}, f"Come si collegano {tabelle[0]} e {tabelle[1]}:")
    if re.search(RE_INTEGRAZIONE, basso):
        return usa({"strumento": "integrazione", "tabelle": tabelle, "descrizione": d + " " + progetto}, "")
    if F is not None and re.search(RE_PROGETTO, basso) and not (tabelle and re.search(r"(tabella|colonn)", basso)):
        p = esegui_strumento({"strumento": "suggerimenti"}, strumenti)
        conv.passi.append(p)
        conv.testo = guida_progetto(F["R"].S, F["collegamenti"], p.get("testo", "") if p.get("ok") else "", progetto)
        return
    if re.search(r"(cosa non va|problem|miglior|suggeriment|errori|sbagli|consigli)", basso):
        return usa({"strumento": "suggerimenti"}, "Ecco cosa migliorerei:")
    if tabelle and re.search(r"(quant[ei]|numero di|conta)", basso) and re.search(r"(righ|record|ce ne|sono|ha)", basso):
        return usa({"strumento": "sql", "query": f'SELECT COUNT(*) AS righe FROM "{tabelle[0]}"'}, f"Righe di {tabelle[0]}:")
    if tabelle:
        return usa({"strumento": "tabella", "nome": tabelle[0]}, f"La tabella {tabelle[0]}:")
    conv.testo = ("Senza il modello di linguaggio rispondo alle domande frequenti, per esempio:\n"
                  "- «come procedo con il progetto?», «il database è fatto bene?»\n"
                  "- «il gestionale deve mandare gli ordini al sito: qual è il modo migliore?»\n"
                  "- «come arrivo da clienti a prodotti?» o «da clienti con nome = Mirco a prodotti»\n"
                  "- «parlami della tabella ordini», «quante righe ha fatture?»\n"
                  "- «cosa non va nel database?», una query che comincia con SELECT\n\n"
                  "Con il modello locale (pannello qui accanto) capisco domande libere, ragiono sul progetto e scrivo il codice.")
