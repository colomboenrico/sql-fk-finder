"""Database di prova del database disegnato nell'editor, e backend C++ per provarlo.

- Il database di prova è un file SQLite creato dallo schema dell'editor (con i dati delle tabelle importate, se si vuole):
  le tabelle si popolano dall'interfaccia, si interrogano con le query e si cerca come arrivare da un dato a un altro
  seguendo le chiavi esterne.
- Il backend C++ si genera dalle tabelle del database di prova: una classe per tabella con getter e setter, un repository
  per tabella con inserisci, aggiorna, elimina, trova e tutti (con l'API C di SQLite), e un programma a riga di comando
  che l'interfaccia usa per provare le operazioni. Si compila con il compilatore del computer (clang++ o g++), se c'è.
Tutto resta sul computer: niente rete.
"""
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import zipfile
from collections import deque
from pathlib import Path

from . import query as QY

CARTELLA = QY.CARTELLA_CACHE.parent / "prova"
DATABASE = CARTELLA / "prova.sqlite"
CARTELLA_CPP = CARTELLA / "backend_cpp"
NULL = "\\N"                           # il valore che vuol dire NULL quando si passa al programma C++


class ErroreProva(Exception):
    pass


def q(nome):
    return QY.q(nome)


def connetti():
    if not DATABASE.exists():
        raise ErroreProva("Prima crea il database di prova (pulsante Crea il database di prova).")
    conn = sqlite3.connect(DATABASE)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def crea(contenuto):
    """Sostituisce il database di prova con un file SQLite (bytes)."""
    CARTELLA.mkdir(parents=True, exist_ok=True)
    provvisorio = DATABASE.with_suffix(".nuovo")
    provvisorio.write_bytes(contenuto)
    provvisorio.replace(DATABASE)
    with connetti() as conn:                 # indici sulle chiavi esterne: query e percorsi veloci anche con molti dati
        indicizza(conn, [fk for t in _tabelle(conn) for fk in _chiavi_esterne(conn, t)])
    return struttura()


# ====================================================================== struttura, righe, query

def _tabelle(conn):
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _colonne(conn, t):
    return [{"nome": r[1], "tipo": r[2] or "", "notnull": bool(r[3]), "pk": r[5]} for r in conn.execute(f"PRAGMA table_info({q(t)})")]


def _chiavi_esterne(conn, t):
    gruppi = {}
    for r in conn.execute(f"PRAGMA foreign_key_list({q(t)})"):
        g = gruppi.setdefault(r[0], {"da": t, "a": r[2], "colonne_da": [], "colonne_a": []})
        g["colonne_da"].append(r[3])
        g["colonne_a"].append(r[4])
    return list(gruppi.values())


def struttura():
    """Le tabelle del database di prova con colonne, chiavi e numero di righe."""
    if not DATABASE.exists():
        return {"esiste": False, "tabelle": []}
    with connetti() as conn:
        tabelle = []
        for t in _tabelle(conn):
            colonne = _colonne(conn, t)
            tabelle.append({"nome": t, "colonne": colonne, "chiave": [c["nome"] for c in sorted(colonne, key=lambda c: c["pk"]) if c["pk"]],
                            "fk": _chiavi_esterne(conn, t), "righe": conn.execute(f"SELECT COUNT(*) FROM {q(t)}").fetchone()[0]})
    return {"esiste": True, "tabelle": tabelle, "file": str(DATABASE)}


def righe(tabella, da=0, quanti=200, cerca=""):
    """Le righe di una tabella a pagine, con una ricerca in tutte le colonne."""
    with connetti() as conn:
        if tabella not in _tabelle(conn):
            raise ErroreProva(f"Tabella non trovata nel database di prova: {tabella}")
        nomi = [c["nome"] for c in _colonne(conn, tabella)]
        dove, valori = "", []
        if cerca:
            dove = " WHERE " + " OR ".join(f"CAST({q(n)} AS TEXT) LIKE ?" for n in nomi)
            valori = [f"%{cerca}%"] * len(nomi)
        totale = conn.execute(f"SELECT COUNT(*) FROM {q(tabella)}{dove}", valori).fetchone()[0]
        cur = conn.execute(f"SELECT * FROM {q(tabella)}{dove} LIMIT ? OFFSET ?", valori + [int(quanti), int(da)])
        return {"tabella": tabella, "colonne": [d[0] for d in cur.description], "righe": [list(r) for r in cur.fetchall()],
                "da": int(da), "totale": totale}


def _valore(v):
    """Valore scritto nell'interfaccia: vuoto = NULL, numeri come numeri."""
    if v is None:
        return None
    v = str(v)
    if v == "" or v == NULL:
        return None
    if re.fullmatch(r"-?\d{1,18}", v):
        return int(v)
    if re.fullmatch(r"-?\d+\.\d+", v):
        return float(v)
    return v


def riga(azione, tabella, valori=None, chiave=None):
    """Inserisce, modifica o elimina una riga della tabella (dall'interfaccia). chiave: {colonna: valore} della riga."""
    valori = {k: _valore(v) for k, v in (valori or {}).items()}
    chiave = {k: _valore(v) for k, v in (chiave or {}).items()}
    with connetti() as conn:
        nomi = {c["nome"] for c in _colonne(conn, tabella)} if tabella in _tabelle(conn) else set()
        if not nomi:
            raise ErroreProva(f"Tabella non trovata nel database di prova: {tabella}")
        if any(k not in nomi for k in [*valori, *chiave]):
            raise ErroreProva("Colonna sconosciuta.")
        dove = " AND ".join(f"{q(k)} IS ?" for k in chiave)
        try:
            if azione == "inserisci":
                usati = {k: v for k, v in valori.items() if v is not None}
                cur = conn.execute(f"INSERT INTO {q(tabella)} ({', '.join(q(k) for k in usati)}) VALUES ({', '.join('?' * len(usati))})"
                                   if usati else f"INSERT INTO {q(tabella)} DEFAULT VALUES", list(usati.values()))
                return {"fatto": f"Riga inserita in {tabella}.", "rowid": cur.lastrowid}
            if not chiave:
                raise ErroreProva("Manca la riga da modificare o eliminare.")
            if azione == "modifica":
                cur = conn.execute(f"UPDATE {q(tabella)} SET {', '.join(f'{q(k)} = ?' for k in valori)} WHERE {dove}",
                                   [*valori.values(), *chiave.values()])
                return {"fatto": f"{cur.rowcount} righe modificate in {tabella}."}
            if azione == "elimina":
                cur = conn.execute(f"DELETE FROM {q(tabella)} WHERE {dove}", list(chiave.values()))
                return {"fatto": f"{cur.rowcount} righe eliminate da {tabella}."}
        except sqlite3.Error as e:
            raise ErroreProva(f"SQLite: {e}")
    raise ErroreProva(f"Azione sconosciuta: {azione}")


def query(sql, limite=1000):
    """Esegue una o più istruzioni sul database di prova; il risultato è quello dell'ultima che restituisce righe."""
    istruzioni = [x for x in (s.strip() for s in sqlite3_dividi(sql)) if x]
    if not istruzioni:
        raise ErroreProva("Scrivi una query.")
    risultato = {"colonne": [], "righe": [], "modificate": 0, "istruzioni": len(istruzioni)}
    with connetti() as conn:
        for s in istruzioni:
            try:
                cur = conn.execute(s)
            except sqlite3.Error as e:
                raise ErroreProva(f"SQLite: {e}\n{s[:300]}")
            if cur.description:
                risultato["colonne"] = [d[0] for d in cur.description]
                risultato["righe"] = [list(r) for r in cur.fetchmany(limite)]
            elif cur.rowcount > 0:
                risultato["modificate"] += cur.rowcount
    return risultato


def sqlite3_dividi(sql):
    """Divide sulle ";" fuori dalle stringhe e dai commenti (sqlite3.complete_statement dice quando un'istruzione è finita)."""
    pezzo, fuori = "", []
    for parte in re.split(r"(;)", sql):
        pezzo += parte
        if parte == ";" and sqlite3.complete_statement(pezzo):
            fuori.append(pezzo)
            pezzo = ""
    if pezzo.strip():
        fuori.append(pezzo)
    return fuori


# ====================================================================== da un dato a un altro

def indicizza(conn, passi, nome_db=lambda t: t):
    """Indici sulle colonne delle JOIN (se mancano): con tabelle grandi una JOIN senza indice è lentissima."""
    for p in passi:
        for t, colonne in ((p["da"], p["colonne_da"]), (p["a"], p["colonne_a"])):
            vero = nome_db(t)
            nome = "sqlfk_ix_" + re.sub(r"\W+", "_", f"{vero}_{'_'.join(colonne)}")[:60]
            try:
                conn.execute(f"CREATE INDEX IF NOT EXISTS {q(nome)} ON {q(vero)} ({', '.join(q(c) for c in colonne)})")
            except sqlite3.Error:
                pass


def cerca_percorso(collegamenti, da_tabella, a_tabella, evita=()):
    """Il percorso più breve tra due tabelle seguendo i collegamenti [{da, colonne_da, a, colonne_a, tipo}] in tutte e
    due le direzioni (breadth-first). None se non c'è. evita: collegamenti da non usare (per i percorsi alternativi)."""
    archi = {}
    for k, l in enumerate(collegamenti):
        if k in evita:
            continue
        archi.setdefault(l["da"], []).append((l["a"], l["colonne_da"], l["colonne_a"], "→", l.get("tipo", ""), k))
        archi.setdefault(l["a"], []).append((l["da"], l["colonne_a"], l["colonne_da"], "←", l.get("tipo", ""), k))
    precedente = {da_tabella: None}
    coda = deque([da_tabella])
    while coda and a_tabella not in precedente:
        t = coda.popleft()
        for altra, c1, c2, verso, tipo, k in archi.get(t, []):
            if altra not in precedente:
                precedente[altra] = (t, c1, c2, verso, tipo, k)
                coda.append(altra)
    if a_tabella not in precedente:
        return None
    passi, t = [], a_tabella
    while precedente[t]:
        prima, c1, c2, verso, tipo, k = precedente[t]
        passi.append({"da": prima, "colonne_da": c1, "a": t, "colonne_a": c2, "verso": verso, "tipo": tipo, "indice": k})
        t = prima
    return passi[::-1]


def percorso_su(conn, collegamenti, da_tabella, da_colonna, valore, a_tabella, nome_db=lambda t: t, limite=200, alternative=2):
    """Percorso, query con le JOIN e righe trovate su un database qualsiasi (nome_db: il nome della tabella nel database).
    Si cercano anche fino a 'alternative' percorsi diversi (senza un collegamento del primo)."""
    passi = cerca_percorso(collegamenti, da_tabella, a_tabella)
    if passi is None:
        return {"trovato": False, "passi": [], "spiegazione": f"Da {da_tabella} non si arriva a {a_tabella}: nessuna catena di chiavi "
                                                             "esterne le collega."}
    altri, visti = [], {tuple(p["indice"] for p in passi)}
    for p in passi:
        if len(altri) >= alternative:
            break
        a = cerca_percorso(collegamenti, da_tabella, a_tabella, evita={p["indice"]})
        if a and tuple(x["indice"] for x in a) not in visti:
            visti.add(tuple(x["indice"] for x in a))
            altri.append(a)
    indicizza(conn, passi + [{"da": da_tabella, "colonne_da": [da_colonna], "a": da_tabella, "colonne_a": [da_colonna]}], nome_db)
    alias = {da_tabella: "t0"}
    join = []
    for i, p in enumerate(passi, 1):
        alias[p["a"]] = f"t{i}"
        uguali = " AND ".join(f"t{i}.{q(y)} = {alias[p['da']]}.{q(x)}" for x, y in zip(p["colonne_da"], p["colonne_a"]))
        join.append(f"JOIN {q(nome_db(p['a']))} AS t{i} ON {uguali}")
    finale = alias[a_tabella]
    sql = (f"SELECT DISTINCT {finale}.*\nFROM {q(nome_db(da_tabella))} AS t0\n" + "".join(f"{j}\n" for j in join) +
           f"WHERE t0.{q(da_colonna)} = ?")
    v = _valore(valore)
    cur = conn.execute(sql + f"\nLIMIT {int(limite)}", (v,))
    colonne = [d[0] for d in cur.description]
    risultato = [list(r) for r in cur.fetchall()]
    frase = lambda p: (f"{p['da']}.{', '.join(p['colonne_da'])} {'punta a' if p['verso'] == '→' else 'è usata da'} "
                       f"{p['a']}.{', '.join(p['colonne_a'])}" + (f" ({p['tipo']})" if p.get("tipo") else ""))
    leggibile = sql.replace("= ?", f"= {v}" if isinstance(v, (int, float)) else f"= '{str(valore).replace(chr(39), chr(39) * 2)}'")
    return {"trovato": True, "passi": passi, "frasi": [frase(p) for p in passi], "sql": leggibile, "colonne": colonne, "righe": risultato,
            "limite": limite, "alternative": [[frase(p) for p in a] for a in altri],
            "spiegazione": (f"Da {da_tabella}.{da_colonna} = {valore} si arriva a {a_tabella} in {len(passi)} passi."
                            if passi else f"È la stessa tabella: le righe di {a_tabella} con {da_colonna} = {valore}.")}


def percorso(da_tabella, da_colonna, valore, a_tabella, limite=200):
    """Il percorso sul database di prova, con le sue chiavi esterne."""
    with connetti() as conn:
        tabelle = _tabelle(conn)
        for t in (da_tabella, a_tabella):
            if t not in tabelle:
                raise ErroreProva(f"Tabella non trovata nel database di prova: {t}")
        collegamenti = [{**fk, "tipo": ""} for t in tabelle for fk in _chiavi_esterne(conn, t) if fk["a"] in tabelle]
        return percorso_su(conn, collegamenti, da_tabella, da_colonna, valore, a_tabella, limite=limite)


# ====================================================================== backend C++

PAROLE_CPP = {"class", "struct", "int", "double", "float", "long", "short", "char", "bool", "auto", "default", "delete", "new",
              "operator", "private", "public", "protected", "return", "this", "template", "typename", "namespace", "union",
              "switch", "case", "for", "while", "do", "if", "else", "const", "static", "volatile", "register", "signed",
              "unsigned", "void", "enum", "goto", "break", "continue", "sizeof", "friend", "virtual", "explicit", "inline"}


def identificatore(nome):
    """Nome valido per il C++."""
    n = re.sub(r"\W+", "_", str(nome), flags=re.A).strip("_") or "x"
    if n[0].isdigit():
        n = "_" + n
    return n + "_" if n.lower() in PAROLE_CPP else n


def pascal(nome):
    parti = [p for p in re.split(r"[\W_]+", str(nome), flags=re.A) if p]
    n = "".join(p[:1].upper() + p[1:] for p in parti) or "Tabella"
    return "_" + n if n[0].isdigit() else n


def tipo_cpp(tipo_sql):
    t = (tipo_sql or "").upper()
    if "INT" in t or "BOOL" in t:
        return "std::int64_t", "intero"
    if any(x in t for x in ("REAL", "FLOA", "DOUB", "DEC", "NUM", "MONEY")):
        return "double", "reale"
    return "std::string", "testo"


def _descrivi(t):
    colonne = []
    for c in t["colonne"]:
        base, genere = tipo_cpp(c["tipo"])
        nullabile = not c["notnull"] and not c["pk"]
        colonne.append({**c, "id": identificatore(c["nome"]), "metodo": pascal(c["nome"]), "base": base, "genere": genere,
                        "nullabile": nullabile, "cpp": f"std::optional<{base}>" if nullabile else base})
    chiave = [c for c in colonne if c["pk"]]
    chiave.sort(key=lambda c: c["pk"])
    auto = len(chiave) == 1 and chiave[0]["genere"] == "intero"
    return {"nome": t["nome"], "classe": pascal(t["nome"]), "colonne": colonne, "chiave": chiave, "auto": auto}


def _modelli(T):
    righe = ["// Generato da SQL FK Finder: una classe per tabella del database, con getter e setter.",
             "#pragma once", "", "#include <cstdint>", "#include <optional>", "#include <string>", ""]
    for t in T:
        righe += [f"// Tabella {t['nome']}" + (f" (chiave: {', '.join(c['nome'] for c in t['chiave'])})" if t["chiave"] else " (senza chiave primaria)"),
                  f"class {t['classe']} {{", "public:"]
        for c in t["colonne"]:
            ritorno = f"const {c['cpp']}&" if c["genere"] == "testo" or c["nullabile"] else c["cpp"]
            righe += [f"    // {c['nome']} {c['tipo'] or ''}" + (", chiave primaria" if c["pk"] else "") + (", può essere NULL" if c["nullabile"] else ""),
                      f"    {ritorno} get{c['metodo']}() const {{ return {c['id']}_; }}",
                      f"    void set{c['metodo']}({c['cpp']} valore) {{ {c['id']}_ = std::move(valore); }}"]
        righe += ["", "private:"]
        for c in t["colonne"]:
            iniziale = "" if c["nullabile"] or c["genere"] == "testo" else (" = 0" if c["genere"] == "intero" else " = 0.0")
            righe.append(f"    {c['cpp']} {c['id']}_{iniziale};")
        righe += ["};", ""]
    return "\n".join(righe)


DATABASE_HPP = r'''// Generato da SQL FK Finder: collegamento a SQLite e funzioni per leggere e scrivere i valori.
#pragma once

#include <sqlite3.h>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

class Database {
public:
    explicit Database(const std::string& percorso) {
        if (sqlite3_open(percorso.c_str(), &db_) != SQLITE_OK) throw std::runtime_error(errore());
        esegui("PRAGMA foreign_keys = ON");
    }
    ~Database() { sqlite3_close(db_); }
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    void esegui(const std::string& sql) {
        char* messaggio = nullptr;
        if (sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &messaggio) != SQLITE_OK) {
            std::string testo = messaggio ? messaggio : "errore";
            sqlite3_free(messaggio);
            throw std::runtime_error(testo);
        }
    }
    sqlite3_stmt* prepara(const std::string& sql) {
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) throw std::runtime_error(errore() + "\n" + sql);
        return st;
    }
    std::int64_t ultimoId() const { return sqlite3_last_insert_rowid(db_); }
    int modificate() const { return sqlite3_changes(db_); }
    std::string errore() const { return sqlite3_errmsg(db_); }

private:
    sqlite3* db_ = nullptr;
};

// Un'istruzione preparata che si chiude da sola.
class Istruzione {
public:
    Istruzione(Database& db, const std::string& sql) : db_(db), st_(db.prepara(sql)) {}
    ~Istruzione() { sqlite3_finalize(st_); }
    Istruzione(const Istruzione&) = delete;
    Istruzione& operator=(const Istruzione&) = delete;

    void lega(int i, std::int64_t v) { sqlite3_bind_int64(st_, i, v); }
    void lega(int i, double v) { sqlite3_bind_double(st_, i, v); }
    void lega(int i, const std::string& v) { sqlite3_bind_text(st_, i, v.c_str(), -1, SQLITE_TRANSIENT); }
    template <typename T> void lega(int i, const std::optional<T>& v) { if (v) lega(i, *v); else sqlite3_bind_null(st_, i); }

    bool passo() {
        int r = sqlite3_step(st_);
        if (r == SQLITE_ROW) return true;
        if (r == SQLITE_DONE) return false;
        throw std::runtime_error(db_.errore());
    }
    bool nullo(int i) const { return sqlite3_column_type(st_, i) == SQLITE_NULL; }
    std::int64_t intero(int i) const { return sqlite3_column_int64(st_, i); }
    double reale(int i) const { return sqlite3_column_double(st_, i); }
    std::string testo(int i) const {
        const unsigned char* t = sqlite3_column_text(st_, i);
        return t ? reinterpret_cast<const char*>(t) : "";
    }

private:
    Database& db_;
    sqlite3_stmt* st_;
};
'''


def _repository(T):
    r = ["// Generato da SQL FK Finder: per ogni tabella le operazioni inserisci, aggiorna, elimina, trova e tutti.",
         "#pragma once", "", '#include "database.hpp"', '#include "modelli.hpp"', "", "#include <optional>", "#include <vector>", ""]
    for t in T:
        cl, nome = t["classe"], q(t["nome"])
        tutte = ", ".join(q(c["nome"]) for c in t["colonne"])
        leggi = []
        for i, c in enumerate(t["colonne"]):
            lettura = {"intero": f"st.intero({i})", "reale": f"st.reale({i})", "testo": f"st.testo({i})"}[c["genere"]]
            if c["nullabile"]:
                leggi.append(f"        if (!st.nullo({i})) r.set{c['metodo']}({lettura});")
            else:
                leggi.append(f"        r.set{c['metodo']}({lettura});")
        parametri = ", ".join(f"{c['base'] if c['genere'] != 'testo' else 'const std::string&'} {c['id']}" for c in t["chiave"])
        dove = " AND ".join(f"{q(c['nome'])} = ?" for c in t["chiave"])
        r += [f"class {cl}Repository {{", "public:", f"    explicit {cl}Repository(Database& db) : db_(db) {{}}", ""]
        # inserisci
        senza_auto = [c for c in t["colonne"] if not (t["auto"] and c["pk"])]
        r += [f"    // INSERT: con una chiave intera a 0 la sceglie il database (AUTOINCREMENT); restituisce l'id della riga",
              f"    std::int64_t inserisci(const {cl}& r) {{"]
        if t["auto"]:
            k = t["chiave"][0]
            con = ", ".join(q(c["nome"]) for c in t["colonne"])
            r += [f"        if (r.get{k['metodo']}() != 0) {{",
                  f"            Istruzione st(db_, \"INSERT INTO {_c(nome)} ({_c(con)}) VALUES ({', '.join('?' * len(t['colonne']))})\");"]
            r += [f"            st.lega({i + 1}, r.get{c['metodo']}());" for i, c in enumerate(t["colonne"])]
            r += ["            st.passo();", "            return db_.ultimoId();", "        }"]
        con = ", ".join(q(c["nome"]) for c in senza_auto)
        if senza_auto:
            r += [f"        Istruzione st(db_, \"INSERT INTO {_c(nome)} ({_c(con)}) VALUES ({', '.join('?' * len(senza_auto))})\");"]
            r += [f"        st.lega({i + 1}, r.get{c['metodo']}());" for i, c in enumerate(senza_auto)]
        else:
            r += [f"        Istruzione st(db_, \"INSERT INTO {_c(nome)} DEFAULT VALUES\");"]
        r += ["        st.passo();", "        return db_.ultimoId();", "    }", ""]
        if t["chiave"]:
            altre = [c for c in t["colonne"] if not c["pk"]]
            if altre:
                r += [f"    // UPDATE di tutte le colonne della riga con la stessa chiave; true se l'ha trovata",
                      f"    bool aggiorna(const {cl}& r) {{",
                      f"        Istruzione st(db_, \"UPDATE {_c(nome)} SET {_c(', '.join(q(c['nome']) + ' = ?' for c in altre))} WHERE {_c(dove)}\");"]
                r += [f"        st.lega({i + 1}, r.get{c['metodo']}());" for i, c in enumerate(altre)]
                r += [f"        st.lega({len(altre) + i + 1}, r.get{c['metodo']}());" for i, c in enumerate(t["chiave"])]
                r += ["        st.passo();", "        return db_.modificate() > 0;", "    }", ""]
            r += [f"    // DELETE della riga con questa chiave; true se l'ha trovata", f"    bool elimina({parametri}) {{",
                  f"        Istruzione st(db_, \"DELETE FROM {_c(nome)} WHERE {_c(dove)}\");"]
            r += [f"        st.lega({i + 1}, {c['id']});" for i, c in enumerate(t["chiave"])]
            r += ["        st.passo();", "        return db_.modificate() > 0;", "    }", "",
                  f"    // SELECT di una riga per chiave", f"    std::optional<{cl}> trova({parametri}) {{",
                  f"        Istruzione st(db_, \"SELECT {_c(tutte)} FROM {_c(nome)} WHERE {_c(dove)}\");"]
            r += [f"        st.lega({i + 1}, {c['id']});" for i, c in enumerate(t["chiave"])]
            r += ["        if (!st.passo()) return std::nullopt;", "        return leggi(st);", "    }", ""]
        r += [f"    // SELECT di tutte le righe", f"    std::vector<{cl}> tutti() {{", f"        std::vector<{cl}> righe;",
              f"        Istruzione st(db_, \"SELECT {_c(tutte)} FROM {_c(nome)}\");", "        while (st.passo()) righe.push_back(leggi(st));",
              "        return righe;", "    }", "", "private:", f"    static {cl} leggi(Istruzione& st) {{", f"        {cl} r;", *leggi,
              "        return r;", "    }", "    Database& db_;", "};", ""]
    return "\n".join(r)


def _c(testo):
    """Testo dentro una stringa C++."""
    return testo.replace("\\", "\\\\").replace('"', '\\"')


def _main(T):
    r = ["// Generato da SQL FK Finder: programma per provare il backend dalla riga di comando (lo usa anche l'app).",
         "//   backend <database.sqlite> <operazione> <tabella> [colonna=valore ...]",
         "//   operazioni: tutti, trova, inserisci, aggiorna, elimina. Il valore \\N vuol dire NULL.",
         "// Risponde con una riga JSON: {\"ok\": true/false, \"messaggio\": ..., \"righe\": [...]}.",
         '#include "repository.hpp"', "", "#include <iostream>", "#include <map>", "#include <sstream>", "",
         "using Valori = std::map<std::string, std::string>;", "",
         "static std::string json(const std::string& s) {",
         "    std::ostringstream o; o << '\"';",
         "    for (unsigned char c : s) {",
         "        if (c == '\"' || c == '\\\\') o << '\\\\' << c;",
         "        else if (c == '\\n') o << \"\\\\n\";",
         "        else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, \"\\\\u%04x\", c); o << b; }",
         "        else o << c;",
         "    }",
         "    o << '\"'; return o.str();", "}",
         "static std::string json(std::int64_t v) { return std::to_string(v); }",
         "static std::string json(double v) { std::ostringstream o; o << v; return o.str(); }",
         "template <typename T> static std::string json(const std::optional<T>& v) { return v ? json(*v) : \"null\"; }", "",
         "static bool c_e(const Valori& v, const std::string& k) { return v.count(k) > 0; }",
         "static bool nullo(const Valori& v, const std::string& k) { return v.at(k) == \"\\\\N\"; }",
         "static std::int64_t a_intero(const std::string& s) { return std::stoll(s); }",
         "static double a_reale(const std::string& s) { return std::stod(s); }", ""]
    for t in T:
        cl = t["classe"]
        campi = " + \",\" + ".join(f"\"{_c(json_chiave(c['nome']))}:\" + json(r.get{c['metodo']}())" for c in t["colonne"]) or '""'
        r += [f"static std::string json(const {cl}& r) {{ return std::string(\"{{\") + {campi} + \"}}\"; }}", "",
              f"// imposta con i setter le colonne date sulla riga di comando",
              f"static void imposta({cl}& r, const Valori& v) {{"]
        for c in t["colonne"]:
            conv = {"intero": "a_intero(v.at(k))", "reale": "a_reale(v.at(k))", "testo": "v.at(k)"}[c["genere"]]
            k = _c(c["nome"])
            if c["nullabile"]:
                r.append(f"    {{ const std::string k = \"{k}\"; if (c_e(v, k)) {{ if (nullo(v, k)) r.set{c['metodo']}(std::nullopt); "
                         f"else r.set{c['metodo']}({conv}); }} }}")
            else:
                r.append(f"    {{ const std::string k = \"{k}\"; if (c_e(v, k) && !nullo(v, k)) r.set{c['metodo']}({conv}); }}")
        r.append("}")
        chiave_da = ", ".join({"intero": f"a_intero(v.at(\"{_c(c['nome'])}\"))", "reale": f"a_reale(v.at(\"{_c(c['nome'])}\"))",
                               "testo": f"v.at(\"{_c(c['nome'])}\")"}[c["genere"]] for c in t["chiave"])
        manca = " || ".join(f"!c_e(v, \"{_c(c['nome'])}\")" for c in t["chiave"])
        r += [f"static std::string esegui_{identificatore(t['nome'])}(Database& db, const std::string& op, const Valori& v) {{",
              f"    {cl}Repository repo(db);",
              "    if (op == \"tutti\") {", "        std::string righe;",
              "        for (const auto& r : repo.tutti()) righe += (righe.empty() ? \"\" : \",\") + json(r);",
              "        return \"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"tutti()\\\",\\\"righe\\\":[\" + righe + \"]}\";", "    }",
              "    if (op == \"inserisci\") {", f"        {cl} r;", "        imposta(r, v);", "        std::int64_t id = repo.inserisci(r);",
              "        return \"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"inserisci(): riga \" + std::to_string(id) + \"\\\",\\\"righe\\\":[]}\";", "    }"]
        if t["chiave"]:
            r += [f"    if ({manca}) return \"{{\\\"ok\\\":false,\\\"messaggio\\\":\\\"serve la chiave: {_c(', '.join(c['nome'] for c in t['chiave']))}\\\"}}\";",
                  "    if (op == \"trova\") {", f"        auto r = repo.trova({chiave_da});",
                  "        return r ? \"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"trova(): trovata\\\",\\\"righe\\\":[\" + json(*r) + \"]}\"",
                  "                 : std::string(\"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"trova(): nessuna riga con questa chiave\\\",\\\"righe\\\":[]}\");", "    }"]
            if any(not c["pk"] for c in t["colonne"]):
                r += ["    if (op == \"aggiorna\") {", f"        auto r = repo.trova({chiave_da});",
                      "        if (!r) return \"{\\\"ok\\\":false,\\\"messaggio\\\":\\\"aggiorna(): nessuna riga con questa chiave\\\"}\";",
                      "        imposta(*r, v);           // i setter cambiano solo le colonne date",
                      "        bool fatto = repo.aggiorna(*r);",
                      "        return \"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"aggiorna(): \" + std::string(fatto ? \"aggiornata\" : \"non aggiornata\") + \"\\\",\\\"righe\\\":[\" + json(*r) + \"]}\";",
                      "    }"]
            r += ["    if (op == \"elimina\") {", f"        bool fatto = repo.elimina({chiave_da});",
                  "        return \"{\\\"ok\\\":true,\\\"messaggio\\\":\\\"elimina(): \" + std::string(fatto ? \"eliminata\" : \"nessuna riga con questa chiave\") + \"\\\",\\\"righe\\\":[]}\";",
                  "    }"]
        r += ["    return \"{\\\"ok\\\":false,\\\"messaggio\\\":\\\"operazione non disponibile per questa tabella\\\"}\";", "}", ""]
    r += ["int main(int argc, char** argv) {",
          "    if (argc < 4) { std::cout << \"{\\\"ok\\\":false,\\\"messaggio\\\":\\\"uso: backend database.sqlite operazione tabella [colonna=valore ...]\\\"}\" << std::endl; return 2; }",
          "    Valori v;",
          "    for (int i = 4; i < argc; ++i) { std::string a = argv[i]; auto p = a.find('='); if (p != std::string::npos) v[a.substr(0, p)] = a.substr(p + 1); }",
          "    const std::string op = argv[2], tabella = argv[3];",
          "    try {", "        Database db(argv[1]);"]
    for t in T:
        r.append(f"        if (tabella == \"{_c(t['nome'])}\") {{ std::cout << esegui_{identificatore(t['nome'])}(db, op, v) << std::endl; return 0; }}")
    r += ["        std::cout << \"{\\\"ok\\\":false,\\\"messaggio\\\":\\\"tabella sconosciuta\\\"}\" << std::endl; return 1;",
          "    } catch (const std::exception& e) {",
          "        std::cout << \"{\\\"ok\\\":false,\\\"messaggio\\\":\" << json(std::string(e.what())) << \"}\" << std::endl; return 1;",
          "    }", "}", ""]
    return "\n".join(r)


def json_chiave(nome):
    return json.dumps(str(nome))


def genera_cpp():
    """Scrive il codice C++ delle tabelle del database di prova; restituisce i file e i loro testi."""
    S = struttura()
    if not S["esiste"] or not S["tabelle"]:
        raise ErroreProva("Prima crea il database di prova: il codice C++ si genera dalle sue tabelle.")
    T = [_descrivi(t) for t in S["tabelle"]]
    file = {"modelli.hpp": _modelli(T), "database.hpp": DATABASE_HPP, "repository.hpp": _repository(T), "main.cpp": _main(T),
            "compila.sh": "#!/bin/sh\n# compila il backend (serve un compilatore C++17 e la libreria sqlite3)\n"
                          "c++ -std=c++17 -O1 main.cpp -lsqlite3 -o backend\n",
            "LEGGIMI.txt": "Backend C++ generato da SQL FK Finder dal database di prova.\n\n"
                           "modelli.hpp     una classe per tabella con getter e setter\n"
                           "repository.hpp  per ogni tabella: inserisci, aggiorna, elimina, trova, tutti (SQLite)\n"
                           "database.hpp    collegamento a SQLite\n"
                           "main.cpp        programma di prova: ./backend prova.sqlite tutti clienti\n\n"
                           "Compilare: sh compila.sh  (Mac: Xcode Command Line Tools; Linux: g++ e libsqlite3-dev;\n"
                           "Windows: MSYS2 con mingw-w64 e sqlite3)\n"}
    if CARTELLA_CPP.exists():
        shutil.rmtree(CARTELLA_CPP)
    CARTELLA_CPP.mkdir(parents=True)
    for nome, testo in file.items():
        (CARTELLA_CPP / nome).write_text(testo, encoding="utf-8")
    return {"file": file, "cartella": str(CARTELLA_CPP), "tabelle": len(T)}


def compilatore():
    for nome in ("c++", "clang++", "g++"):
        trovato = shutil.which(nome)
        if trovato:
            return trovato
    return None


def compila():
    if not (CARTELLA_CPP / "main.cpp").exists():
        genera_cpp()
    cc = compilatore()
    if not cc:
        return {"ok": False, "uscita": "Nessun compilatore C++ trovato (c++, clang++ o g++). Sul Mac: xcode-select --install; "
                                      "su Linux: il pacchetto g++ e libsqlite3-dev. Il codice si può comunque scaricare."}
    eseguibile = CARTELLA_CPP / ("backend.exe" if os.name == "nt" else "backend")
    comando = [cc, "-std=c++17", "-O1", "main.cpp", "-lsqlite3", "-o", eseguibile.name]
    try:
        r = subprocess.run(comando, cwd=CARTELLA_CPP, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"ok": False, "uscita": "La compilazione ci mette troppo (più di 3 minuti)."}
    return {"ok": r.returncode == 0, "comando": " ".join(str(x) for x in comando), "uscita": (r.stdout + r.stderr).strip()[-8000:]}


def esegui(operazione, tabella, valori=None):
    """Esegue il backend C++ su una tabella del database di prova (getter, setter e repository)."""
    eseguibile = CARTELLA_CPP / ("backend.exe" if os.name == "nt" else "backend")
    if not eseguibile.exists():
        raise ErroreProva("Prima compila il backend C++.")
    argomenti = [str(eseguibile), str(DATABASE), str(operazione), str(tabella)]
    # solo i campi scritti: con aggiorna gli altri restano come sono; \N vuol dire NULL
    argomenti += [f"{k}={v}" for k, v in (valori or {}).items() if v is not None and str(v) != ""]
    try:
        r = subprocess.run(argomenti, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ErroreProva("Il backend non risponde (più di 30 secondi).")
    uscita = r.stdout.strip().splitlines()
    try:
        risposta = json.loads(uscita[-1]) if uscita else {"ok": False, "messaggio": r.stderr.strip() or "nessuna risposta"}
    except json.JSONDecodeError:
        risposta = {"ok": False, "messaggio": r.stdout.strip()[-2000:] or r.stderr.strip()[-2000:]}
    risposta["comando"] = " ".join(["./backend", "prova.sqlite", *argomenti[2:]])
    return risposta


def zip_cpp():
    if not (CARTELLA_CPP / "main.cpp").exists():
        genera_cpp()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(CARTELLA_CPP.iterdir()):
            if f.suffix in (".hpp", ".cpp", ".sh", ".txt"):
                z.write(f, f"backend_cpp/{f.name}")
        if DATABASE.exists():
            z.write(DATABASE, "backend_cpp/prova.sqlite")
    return buffer.getvalue()
