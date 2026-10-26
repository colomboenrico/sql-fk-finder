"""Gestionale ordini di prova: un piccolo programma con finestre e tasti che usa MySQL, per provare "Ascolta il database".

Ogni tasto manda a MySQL le sue query (con il client "mysql", sul socket della demo: nessuna rete). Alcune chiavi esterne
non sono dichiarate nel database, come nei programmi veri: l'ascolto le ritrova dalle query.
Si avvia con avvia.sh; "python gestionale.py --prepara dump.sql mysqldump" crea il database e scrive il dump.
"""
import datetime
import os
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox, ttk

MYSQL = os.environ.get("DEMO_MYSQL", "mysql")
SOCKET = os.environ.get("DEMO_SOCKET", f"/tmp/sqlfk-demo-{os.environ.get('USER', 'utente')}.sock")
DATABASE = "negozio"
STATI = {"A": "aperto", "S": "spedito"}

SCHEMA = """
CREATE DATABASE negozio;
USE negozio;
CREATE TABLE categorie (id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(40) NOT NULL);
CREATE TABLE clienti (id INT AUTO_INCREMENT PRIMARY KEY, ragione_sociale VARCHAR(80) NOT NULL, citta VARCHAR(40),
                      piva VARCHAR(11), email VARCHAR(80));
CREATE TABLE prodotti (codice VARCHAR(10) PRIMARY KEY, descrizione VARCHAR(80) NOT NULL, prezzo DECIMAL(10,2) NOT NULL,
                       categoria INT);
CREATE TABLE magazzino (prodotto VARCHAR(10) PRIMARY KEY, giacenza INT NOT NULL DEFAULT 0, scorta_minima INT NOT NULL DEFAULT 0);
CREATE TABLE ordini (id INT AUTO_INCREMENT PRIMARY KEY, cliente INT NOT NULL, data_ordine DATE NOT NULL,
                     stato CHAR(1) NOT NULL DEFAULT 'A', totale DECIMAL(10,2),
                     CONSTRAINT fk_ordini_clienti FOREIGN KEY (cliente) REFERENCES clienti (id));
CREATE TABLE ordini_righe (ordine INT NOT NULL, riga INT NOT NULL, prodotto VARCHAR(10) NOT NULL, qta INT NOT NULL,
                           prezzo DECIMAL(10,2) NOT NULL, PRIMARY KEY (ordine, riga));
CREATE TABLE movimenti (id INT AUTO_INCREMENT PRIMARY KEY, prodotto VARCHAR(10) NOT NULL, quantita INT NOT NULL,
                        causale VARCHAR(20) NOT NULL, data_mov DATETIME NOT NULL);
CREATE TABLE notifiche (id INT AUTO_INCREMENT PRIMARY KEY, testo VARCHAR(120) NOT NULL, letta TINYINT NOT NULL DEFAULT 0,
                        creata DATETIME DEFAULT CURRENT_TIMESTAMP);
INSERT INTO categorie (nome) VALUES ('Viteria'), ('Utensili'), ('Ferramenta');
INSERT INTO clienti (ragione_sociale, citta, piva, email) VALUES
  ('Rossi srl', 'Torino', '01234567890', 'ordini@rossi.example'),
  ('Bianchi spa', 'Milano', '09876543210', 'acquisti@bianchi.example'),
  ('Verdi snc', 'Alba', '11223344556', 'info@verdi.example'),
  ('Neri e figli', 'Cuneo', '66554433221', 'neri@neri.example'),
  ('Gialli costruzioni', 'Asti', '99887766554', 'ufficio@gialli.example');
INSERT INTO prodotti VALUES ('P01', 'Vite 4 mm', 0.10, 1), ('P02', 'Bullone 8 mm', 0.35, 1), ('P03', 'Rondella', 0.05, 1),
  ('U01', 'Cacciavite a croce', 6.50, 2), ('U02', 'Chiave inglese', 12.90, 2), ('F01', 'Cerniera in acciaio', 3.20, 3);
INSERT INTO magazzino VALUES ('P01', 1000, 200), ('P02', 500, 100), ('P03', 2000, 300), ('U01', 25, 10), ('U02', 8, 10), ('F01', 60, 20);
INSERT INTO ordini (cliente, data_ordine, stato, totale) VALUES (1, '2026-10-20', 'S', 41.50), (3, '2026-10-24', 'A', 25.80);
INSERT INTO ordini_righe VALUES (1, 1, 'P01', 300, 0.10), (1, 2, 'U01', 2, 6.50), (1, 3, 'P02', 20, 0.35),
  (2, 1, 'U02', 2, 12.90);
INSERT INTO notifiche (testo, letta) VALUES ('Ordine 1 spedito', 1);
"""


class ErroreDb(Exception):
    pass


def sql(testo, database=DATABASE):
    """Esegue una o più istruzioni in una connessione sola; righe dell'ultimo risultato (senza intestazione)."""
    comando = [MYSQL, f"--socket={SOCKET}", "-uroot", "--batch", "--raw", "--skip-column-names", "--default-character-set=utf8mb4"]
    if database:
        comando.append(database)
    r = subprocess.run(comando, input=testo, capture_output=True, text=True)
    if r.returncode:
        raise ErroreDb(r.stderr.strip() or "errore di MySQL")
    return [riga.split("\t") for riga in r.stdout.splitlines()]


def s(valore):
    """Valore come letterale SQL."""
    if valore is None or valore == "":
        return "NULL"
    if isinstance(valore, (int, float)):
        return str(valore)
    return "'" + str(valore).replace("\\", "\\\\").replace("'", "''") + "'"


def prepara(dump, mysqldump):
    if not sql("SHOW DATABASES LIKE 'negozio'", database=None):
        sql(SCHEMA, database=None)
        print("Database 'negozio' creato con i dati di prova.")
    with open(dump, "w", encoding="utf-8") as f:
        subprocess.run([mysqldump, f"--socket={SOCKET}", "-uroot", DATABASE], stdout=f, stderr=subprocess.DEVNULL, check=True)
    log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "query.log")
    if os.path.exists(log):
        open(log, "w").close()            # il log ricomincia: dentro restano solo le query del gestionale


# ------------------------------------------------------------------------------------------------ finestre di aiuto
class Modulo(tk.Toplevel):
    """Finestra con dei campi: risultato = {campo: valore} oppure None."""
    def __init__(self, padre, titolo, campi, valori=None):
        super().__init__(padre)
        self.title(titolo)
        self.transient(padre)
        self.resizable(False, False)
        self.risultato, self.voci = None, {}
        corpo = ttk.Frame(self, padding=14)
        corpo.pack(fill="both")
        for i, (chiave, etichetta, scelte) in enumerate(campi):
            ttk.Label(corpo, text=etichetta).grid(row=i, column=0, sticky="w", pady=3, padx=(0, 10))
            var = tk.StringVar(value=(valori or {}).get(chiave, ""))
            campo = ttk.Combobox(corpo, textvariable=var, values=scelte, width=34, state="readonly") if scelte else \
                ttk.Entry(corpo, textvariable=var, width=36)
            campo.grid(row=i, column=1, pady=3)
            self.voci[chiave] = var
        tasti = ttk.Frame(corpo)
        tasti.grid(row=len(campi), column=0, columnspan=2, pady=(12, 0), sticky="e")
        ttk.Button(tasti, text="Annulla", command=self.destroy).pack(side="right", padx=4)
        ttk.Button(tasti, text="Salva", command=self.salva).pack(side="right")
        self.bind("<Return>", lambda e: self.salva())
        self.grab_set()
        self.wait_window()

    def salva(self):
        self.risultato = {k: v.get().strip() for k, v in self.voci.items()}
        self.destroy()


def elenco(padre, titolo, colonne, righe, larghezze=None):
    """Finestra con una tabella di sola lettura."""
    w = tk.Toplevel(padre)
    w.title(titolo)
    w.transient(padre)
    cornice = ttk.Frame(w, padding=10)
    cornice.pack(fill="both", expand=True)
    ttk.Label(cornice, text=titolo, font=("TkDefaultFont", 13, "bold")).pack(anchor="w", pady=(0, 6))
    t = tabella(cornice, colonne, larghezze)
    t.pack(fill="both", expand=True)
    for r in righe:
        t.insert("", "end", values=r)
    ttk.Button(cornice, text="Chiudi", command=w.destroy).pack(anchor="e", pady=(8, 0))


def tabella(padre, colonne, larghezze=None):
    t = ttk.Treeview(padre, columns=colonne, show="headings", height=12, selectmode="browse")
    for i, c in enumerate(colonne):
        t.heading(c, text=c)
        t.column(c, width=(larghezze or [120] * len(colonne))[i], anchor="w")
    return t


def scelta(t):
    sel = t.selection()
    return t.item(sel[0], "values") if sel else None


# ------------------------------------------------------------------------------------------------ il gestionale
class Gestionale(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Gestionale Ordini (demo per SQL FK Finder)")
        self.geometry("900x560")
        self.schede = ttk.Notebook(self)
        self.schede.pack(fill="both", expand=True, padx=8, pady=8)
        self.scheda_clienti()
        self.scheda_ordini()
        self.scheda_magazzino()
        barra = ttk.Frame(self, padding=(10, 4))
        barra.pack(fill="x")
        self.notifiche = ttk.Label(barra, text="")
        self.notifiche.pack(side="left")
        ttk.Button(barra, text="Leggi le notifiche", command=self.leggi_notifiche).pack(side="left", padx=8)
        ttk.Label(barra, text=f"MySQL: {SOCKET}", foreground="#777").pack(side="right")
        self.schede.bind("<<NotebookTabChanged>>", lambda e: self.aggiorna_scheda())
        self.controlla_notifiche()

    def esegui(self, testo):
        try:
            return sql(testo)
        except ErroreDb as e:
            messagebox.showerror("Errore del database", str(e), parent=self)
            return None

    def aggiorna_scheda(self):
        [self.carica_clienti, self.carica_ordini, self.carica_magazzino][self.schede.index("current")]()

    # ---- timer: il programma controlla le notifiche da solo (è il "rumore" per l'ascolto)
    def controlla_notifiche(self):
        r = self.esegui("SELECT COUNT(*) FROM notifiche WHERE letta = 0")
        if r:
            n = int(r[0][0])
            self.notifiche.config(text=f"Notifiche da leggere: {n}" if n else "Nessuna notifica")
        self.after(3000, self.controlla_notifiche)

    def leggi_notifiche(self):
        r = self.esegui("SELECT id, testo, creata FROM notifiche WHERE letta = 0 ORDER BY creata")
        if r is None:
            return
        if r:
            self.esegui("UPDATE notifiche SET letta = 1 WHERE letta = 0")
        elenco(self, "Notifiche", ["n.", "testo", "creata"], r, [50, 380, 160])

    # ---- clienti
    def scheda_clienti(self):
        f = ttk.Frame(self.schede, padding=10)
        self.schede.add(f, text="Clienti")
        sopra = ttk.Frame(f)
        sopra.pack(fill="x", pady=(0, 6))
        self.cerca = tk.StringVar()
        ttk.Label(sopra, text="Cerca:").pack(side="left")
        campo = ttk.Entry(sopra, textvariable=self.cerca, width=28)
        campo.pack(side="left", padx=6)
        campo.bind("<Return>", lambda e: self.carica_clienti())
        ttk.Button(sopra, text="Cerca", command=self.carica_clienti).pack(side="left")
        self.t_clienti = tabella(f, ["n.", "ragione sociale", "città", "partita IVA", "email"], [50, 220, 120, 120, 240])
        self.t_clienti.pack(fill="both", expand=True)
        tasti = ttk.Frame(f)
        tasti.pack(fill="x", pady=(8, 0))
        for testo, comando in [("Nuovo cliente", self.nuovo_cliente), ("Modifica", self.modifica_cliente),
                               ("Elimina", self.elimina_cliente), ("Ordini del cliente", self.ordini_cliente)]:
            ttk.Button(tasti, text=testo, command=comando).pack(side="left", padx=(0, 6))

    def carica_clienti(self):
        filtro = self.cerca.get().strip()
        q = "SELECT id, ragione_sociale, citta, piva, email FROM clienti"
        if filtro:
            q += f" WHERE ragione_sociale LIKE {s('%' + filtro + '%')} OR citta LIKE {s('%' + filtro + '%')}"
        r = self.esegui(q + " ORDER BY ragione_sociale")
        self.t_clienti.delete(*self.t_clienti.get_children())
        for riga in r or []:
            self.t_clienti.insert("", "end", values=riga)

    CAMPI_CLIENTE = [("ragione_sociale", "Ragione sociale", None), ("citta", "Città", None),
                     ("piva", "Partita IVA", None), ("email", "Email", None)]

    def nuovo_cliente(self):
        d = Modulo(self, "Nuovo cliente", self.CAMPI_CLIENTE).risultato
        if d and d["ragione_sociale"]:
            self.esegui(f"INSERT INTO clienti (ragione_sociale, citta, piva, email) VALUES "
                        f"({s(d['ragione_sociale'])}, {s(d['citta'])}, {s(d['piva'])}, {s(d['email'])})")
            self.carica_clienti()

    def modifica_cliente(self):
        c = scelta(self.t_clienti)
        if not c:
            return messagebox.showinfo("Clienti", "Scegli un cliente.", parent=self)
        r = self.esegui(f"SELECT ragione_sociale, citta, piva, email FROM clienti WHERE id = {int(c[0])}")
        if not r:
            return
        valori = dict(zip(["ragione_sociale", "citta", "piva", "email"], [v if v != "NULL" else "" for v in r[0]]))
        d = Modulo(self, f"Modifica cliente {c[0]}", self.CAMPI_CLIENTE, valori).risultato
        if d:
            self.esegui(f"UPDATE clienti SET ragione_sociale = {s(d['ragione_sociale'])}, citta = {s(d['citta'])}, "
                        f"piva = {s(d['piva'])}, email = {s(d['email'])} WHERE id = {int(c[0])}")
            self.carica_clienti()

    def elimina_cliente(self):
        c = scelta(self.t_clienti)
        if not c:
            return messagebox.showinfo("Clienti", "Scegli un cliente.", parent=self)
        r = self.esegui(f"SELECT COUNT(*) FROM ordini WHERE cliente = {int(c[0])}")
        if r and int(r[0][0]):
            return messagebox.showwarning("Clienti", f"{c[1]} ha {r[0][0]} ordini: non si può eliminare.", parent=self)
        if r is not None and messagebox.askyesno("Clienti", f"Eliminare {c[1]}?", parent=self):
            self.esegui(f"DELETE FROM clienti WHERE id = {int(c[0])}")
            self.carica_clienti()

    def ordini_cliente(self):
        c = scelta(self.t_clienti)
        if not c:
            return messagebox.showinfo("Clienti", "Scegli un cliente.", parent=self)
        r = self.esegui(f"SELECT o.id, o.data_ordine, o.stato, o.totale FROM ordini o WHERE o.cliente = {int(c[0])} "
                        "ORDER BY o.data_ordine DESC")
        if r is not None:
            elenco(self, f"Ordini di {c[1]}", ["ordine", "data", "stato", "totale"],
                   [(a, b, STATI.get(st, st), t) for a, b, st, t in r], [70, 110, 90, 90])

    # ---- ordini
    def scheda_ordini(self):
        f = ttk.Frame(self.schede, padding=10)
        self.schede.add(f, text="Ordini")
        sopra = ttk.Frame(f)
        sopra.pack(fill="x", pady=(0, 6))
        ttk.Label(sopra, text="Mostra:").pack(side="left")
        self.filtro_stato = ttk.Combobox(sopra, values=["tutti", "aperti", "spediti"], state="readonly", width=10)
        self.filtro_stato.set("tutti")
        self.filtro_stato.pack(side="left", padx=6)
        self.filtro_stato.bind("<<ComboboxSelected>>", lambda e: self.carica_ordini())
        self.t_ordini = tabella(f, ["ordine", "data", "cliente", "stato", "totale"], [70, 110, 260, 100, 100])
        self.t_ordini.pack(fill="both", expand=True)
        self.t_ordini.bind("<Double-1>", lambda e: self.dettaglio_ordine())
        tasti = ttk.Frame(f)
        tasti.pack(fill="x", pady=(8, 0))
        for testo, comando in [("Nuovo ordine", self.nuovo_ordine), ("Dettaglio", self.dettaglio_ordine),
                               ("Spedisci", self.spedisci), ("Annulla ordine", self.annulla_ordine)]:
            ttk.Button(tasti, text=testo, command=comando).pack(side="left", padx=(0, 6))

    def carica_ordini(self):
        q = ("SELECT o.id, o.data_ordine, c.ragione_sociale, o.stato, o.totale FROM ordini o "
             "JOIN clienti c ON c.id = o.cliente")
        stato = {"aperti": "A", "spediti": "S"}.get(self.filtro_stato.get())
        if stato:
            q += f" WHERE o.stato = {s(stato)}"
        r = self.esegui(q + " ORDER BY o.id DESC")
        self.t_ordini.delete(*self.t_ordini.get_children())
        for a, b, c, st, t in r or []:
            self.t_ordini.insert("", "end", values=(a, b, c, STATI.get(st, st), t))

    def ordine_scelto(self):
        o = scelta(self.t_ordini)
        if not o:
            messagebox.showinfo("Ordini", "Scegli un ordine.", parent=self)
        return o

    def dettaglio_ordine(self):
        o = self.ordine_scelto()
        if not o:
            return
        r = self.esegui(f"SELECT r.riga, r.prodotto, p.descrizione, r.qta, r.prezzo, r.qta * r.prezzo FROM ordini_righe r "
                        f"JOIN prodotti p ON p.codice = r.prodotto WHERE r.ordine = {int(o[0])} ORDER BY r.riga")
        if r is not None:
            elenco(self, f"Ordine {o[0]} di {o[2]} ({o[1]}, {o[3]})", ["riga", "prodotto", "descrizione", "qtà", "prezzo", "importo"],
                   r, [50, 80, 200, 60, 80, 90])

    def nuovo_ordine(self):
        clienti = self.esegui("SELECT id, ragione_sociale FROM clienti ORDER BY ragione_sociale")
        prodotti = self.esegui("SELECT p.codice, p.descrizione, p.prezzo, m.giacenza FROM prodotti p "
                               "JOIN magazzino m ON m.prodotto = p.codice ORDER BY p.descrizione")
        if not clienti or not prodotti:
            return
        FinestraOrdine(self, clienti, prodotti)

    def salva_ordine(self, cliente, righe):
        """righe: [(codice, qta, prezzo)]. Controlla le giacenze, poi tutto in una transazione."""
        for codice, qta, _ in righe:
            r = self.esegui(f"SELECT giacenza FROM magazzino WHERE prodotto = {s(codice)}")
            if r is None:
                return False
            if int(r[0][0]) < qta:
                messagebox.showwarning("Nuovo ordine", f"{codice}: in magazzino ce ne sono solo {r[0][0]}.", parent=self)
                return False
        totale = round(sum(q * p for _, q, p in righe), 2)
        oggi = datetime.date.today().isoformat()
        testo = ["START TRANSACTION;",
                 f"INSERT INTO ordini (cliente, data_ordine, stato, totale) VALUES ({int(cliente)}, {s(oggi)}, 'A', {totale});"]
        for i, (codice, qta, prezzo) in enumerate(righe, 1):
            testo.append(f"INSERT INTO ordini_righe (ordine, riga, prodotto, qta, prezzo) "
                         f"VALUES (LAST_INSERT_ID(), {i}, {s(codice)}, {qta}, {prezzo});")
        for codice, qta, _ in righe:
            testo.append(f"UPDATE magazzino SET giacenza = giacenza - {qta} WHERE prodotto = {s(codice)};")
            testo.append(f"INSERT INTO movimenti (prodotto, quantita, causale, data_mov) VALUES ({s(codice)}, {-qta}, 'VENDITA', NOW());")
        testo.append("COMMIT;")
        if self.esegui("\n".join(testo)) is None:
            return False
        self.carica_ordini()
        return True

    def spedisci(self):
        o = self.ordine_scelto()
        if not o:
            return
        if o[3] == STATI["S"]:
            return messagebox.showinfo("Ordini", f"L'ordine {o[0]} è già spedito.", parent=self)
        self.esegui(f"UPDATE ordini SET stato = 'S' WHERE id = {int(o[0])};\n"
                    f"INSERT INTO notifiche (testo) VALUES ({s(f'Ordine {o[0]} spedito a {o[2]}')});")
        self.carica_ordini()

    def annulla_ordine(self):
        o = self.ordine_scelto()
        if not o:
            return
        if o[3] == STATI["S"]:
            return messagebox.showwarning("Ordini", "Un ordine spedito non si può annullare.", parent=self)
        if not messagebox.askyesno("Ordini", f"Annullare l'ordine {o[0]} di {o[2]}? La merce torna in magazzino.", parent=self):
            return
        righe = self.esegui(f"SELECT prodotto, qta FROM ordini_righe WHERE ordine = {int(o[0])}")
        if righe is None:
            return
        testo = ["START TRANSACTION;"]
        for codice, qta in righe:
            testo.append(f"UPDATE magazzino SET giacenza = giacenza + {int(qta)} WHERE prodotto = {s(codice)};")
            testo.append(f"INSERT INTO movimenti (prodotto, quantita, causale, data_mov) VALUES ({s(codice)}, {int(qta)}, 'RESO', NOW());")
        testo += [f"DELETE FROM ordini_righe WHERE ordine = {int(o[0])};", f"DELETE FROM ordini WHERE id = {int(o[0])};", "COMMIT;"]
        self.esegui("\n".join(testo))
        self.carica_ordini()

    # ---- magazzino
    def scheda_magazzino(self):
        f = ttk.Frame(self.schede, padding=10)
        self.schede.add(f, text="Magazzino")
        self.t_magazzino = tabella(f, ["prodotto", "descrizione", "categoria", "prezzo", "giacenza", "scorta minima"],
                                   [80, 220, 120, 80, 90, 110])
        self.t_magazzino.pack(fill="both", expand=True)
        tasti = ttk.Frame(f)
        tasti.pack(fill="x", pady=(8, 0))
        for testo, comando in [("Carico merce", self.carico), ("Sotto scorta", self.sotto_scorta), ("Movimenti", self.movimenti)]:
            ttk.Button(tasti, text=testo, command=comando).pack(side="left", padx=(0, 6))

    def carica_magazzino(self):
        r = self.esegui("SELECT m.prodotto, p.descrizione, c.nome, p.prezzo, m.giacenza, m.scorta_minima FROM magazzino m "
                        "JOIN prodotti p ON p.codice = m.prodotto LEFT JOIN categorie c ON c.id = p.categoria ORDER BY p.descrizione")
        self.t_magazzino.delete(*self.t_magazzino.get_children())
        for riga in r or []:
            self.t_magazzino.insert("", "end", values=riga)

    def carico(self):
        p = scelta(self.t_magazzino)
        if not p:
            return messagebox.showinfo("Magazzino", "Scegli un prodotto.", parent=self)
        d = Modulo(self, f"Carico di {p[1]}", [("qta", "Quantità arrivata", None)]).risultato
        if d and d["qta"].isdigit() and int(d["qta"]) > 0:
            q = int(d["qta"])
            self.esegui(f"UPDATE magazzino SET giacenza = giacenza + {q} WHERE prodotto = {s(p[0])};\n"
                        f"INSERT INTO movimenti (prodotto, quantita, causale, data_mov) VALUES ({s(p[0])}, {q}, 'CARICO', NOW());")
            self.carica_magazzino()

    def sotto_scorta(self):
        r = self.esegui("SELECT m.prodotto, p.descrizione, m.giacenza, m.scorta_minima FROM magazzino m "
                        "JOIN prodotti p ON p.codice = m.prodotto WHERE m.giacenza < m.scorta_minima")
        if r is not None:
            elenco(self, "Prodotti sotto scorta", ["prodotto", "descrizione", "giacenza", "scorta minima"], r, [80, 220, 90, 110])

    def movimenti(self):
        p = scelta(self.t_magazzino)
        q = "SELECT id, prodotto, quantita, causale, data_mov FROM movimenti"
        if p:
            q += f" WHERE prodotto = {s(p[0])}"
        r = self.esegui(q + " ORDER BY data_mov DESC LIMIT 100")
        if r is not None:
            elenco(self, "Movimenti di magazzino" + (f" di {p[1]}" if p else ""),
                   ["n.", "prodotto", "quantità", "causale", "data"], r, [50, 80, 80, 100, 160])


class FinestraOrdine(tk.Toplevel):
    """Nuovo ordine: cliente e righe (prodotto, quantità). Le righe si aggiungono senza query; Salva fa tutto insieme."""
    def __init__(self, gestionale, clienti, prodotti):
        super().__init__(gestionale)
        self.g = gestionale
        self.title("Nuovo ordine")
        self.transient(gestionale)
        self.clienti = {f"{nome} ({i})": i for i, nome in clienti}
        self.prodotti = {f"{c} - {d} ({p} €, in magazzino {g})": (c, float(p)) for c, d, p, g in prodotti}
        self.righe = []
        f = ttk.Frame(self, padding=14)
        f.pack(fill="both", expand=True)
        ttk.Label(f, text="Cliente").grid(row=0, column=0, sticky="w")
        self.cliente = ttk.Combobox(f, values=list(self.clienti), state="readonly", width=44)
        self.cliente.grid(row=0, column=1, columnspan=3, sticky="w", pady=4)
        ttk.Label(f, text="Prodotto").grid(row=1, column=0, sticky="w")
        self.prodotto = ttk.Combobox(f, values=list(self.prodotti), state="readonly", width=44)
        self.prodotto.grid(row=1, column=1, sticky="w", pady=4)
        ttk.Label(f, text="Qtà").grid(row=1, column=2, padx=(10, 4))
        self.qta = ttk.Spinbox(f, from_=1, to=10000, width=7)
        self.qta.set(1)
        self.qta.grid(row=1, column=3)
        ttk.Button(f, text="Aggiungi riga", command=self.aggiungi).grid(row=1, column=4, padx=(8, 0))
        self.t = tabella(f, ["prodotto", "qtà", "prezzo", "importo"], [90, 70, 80, 90])
        self.t.configure(height=6)
        self.t.grid(row=2, column=0, columnspan=5, sticky="nsew", pady=8)
        self.totale = ttk.Label(f, text="Totale: 0.00 €", font=("TkDefaultFont", 12, "bold"))
        self.totale.grid(row=3, column=0, columnspan=2, sticky="w")
        ttk.Button(f, text="Annulla", command=self.destroy).grid(row=3, column=3, sticky="e")
        ttk.Button(f, text="Salva ordine", command=self.salva).grid(row=3, column=4, sticky="e")
        self.grab_set()

    def aggiungi(self):
        if not self.prodotto.get() or not self.qta.get().isdigit():
            return
        codice, prezzo = self.prodotti[self.prodotto.get()]
        qta = int(self.qta.get())
        self.righe.append((codice, qta, prezzo))
        self.t.insert("", "end", values=(codice, qta, f"{prezzo:.2f}", f"{qta * prezzo:.2f}"))
        self.totale.config(text=f"Totale: {sum(q * p for _, q, p in self.righe):.2f} €")

    def salva(self):
        if not self.cliente.get() or not self.righe:
            return messagebox.showinfo("Nuovo ordine", "Scegli il cliente e aggiungi almeno una riga.", parent=self)
        if self.g.salva_ordine(self.clienti[self.cliente.get()], self.righe):
            self.destroy()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--prepara":
        prepara(sys.argv[2], sys.argv[3])
    else:
        app = Gestionale()
        app.carica_clienti()
        app.mainloop()
