"use strict";
// Editor del database: entità con attributi e relazioni (1:N, 1:1, N:M), trasformate nello schema logico
// secondo le regole del passaggio dal modello E-R alle tabelle, e generazione delle CREATE TABLE.

const Editor = (() => {
  // i tipi proposti, con una spiegazione (si può scrivere anche un tipo qualsiasi)
  const TIPI_SPIEGATI = [
    ["INT", "numero intero"], ["INT AUTO_INCREMENT", "intero che il database numera da solo (chiave)"], ["BIGINT", "intero molto grande"],
    ["SMALLINT", "intero piccolo"], ["TINYINT", "intero piccolissimo (0-255)"], ["FLOAT", "numero con la virgola (precisione semplice)"],
    ["DOUBLE", "numero con la virgola (precisione doppia), misure"], ["DECIMAL(10,2)", "importo esatto in euro"],
    ["DECIMAL(9,6)", "latitudine o longitudine da sola (6 decimali, circa 10 cm)"],
    ["POINT", "posizione: latitudine e longitudine insieme in un campo"],
    ["VARCHAR(50)", "testo breve"], ["VARCHAR(100)", "testo"], ["VARCHAR(255)", "testo lungo"], ["CHAR(10)", "codice a lunghezza fissa"],
    ["CHAR(36)", "identificativo UUID"], ["TEXT", "testo libero"], ["DATE", "data"], ["TIME", "ora"], ["DATETIME", "data e ora"],
    ["TIMESTAMP", "data e ora (fuso)"], ["BOOLEAN", "sì o no"], ["JSON", "dati JSON"], ["BLOB", "file o dati binari"]];
  const TIPI = TIPI_SPIEGATI.map(([t]) => t);

  /** Il tipo scritto nel dialetto: POINT diventa geography (SQL Server) o SDO_GEOMETRY (Oracle); BOOLEAN e simili restano. */
  function tipoDialetto(tipo, dialetto) {
    const t = String(tipo || "INT");
    if (/^POINT$/i.test(t.trim())) return { tsql: "geography", oracle: "SDO_GEOMETRY" }[dialetto] || t;
    return t;
  }

  const nuovoModello = () => ({ entita: [], relazioni: [], prossimo: 1 });
  const id = M => `n${M.prossimo++}`;

  /** Nome valido per SQL: lettere, numeri e trattino basso. */
  function pulisciNome(nome) {
    return String(nome || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.]/g, "") || "senza_nome";
  }

  /** Tipo da usare in una chiave esterna: quello della chiave puntata, senza AUTO_INCREMENT o SERIAL. */
  function tipoChiaveEsterna(tipo) {
    const t = String(tipo || "INT").toUpperCase().replace(/\s+AUTO_INCREMENT\b/, "").replace(/\bIDENTITY(\(.*?\))?/, "").trim();
    return { SERIAL: "INT", BIGSERIAL: "BIGINT", SMALLSERIAL: "SMALLINT" }[t] || t;
  }

  const entitaDi = (M, eid) => M.entita.find(e => e.id === eid);
  const chiave = e => e.attributi.filter(a => a.pk);

  /** Nome della colonna chiave esterna verso un attributo chiave del padre: id -> id_cliente, id_cliente -> id_cliente. */
  function nomeColonnaFk(padre, attributo) {
    return attributo.nome.toLowerCase() === "id" ? `id_${padre.nome.toLowerCase()}` : attributo.nome;
  }

  // ======================================================================= modifiche

  function aggiungiEntita(M, nome, x, y) {
    const e = { id: id(M), nome: pulisciNome(nome), x, y,
                attributi: [{ nome: `id_${pulisciNome(nome).toLowerCase()}`, tipo: "INT AUTO_INCREMENT", pk: true, nn: true, uq: false }] };
    M.entita.push(e);
    return e;
  }

  /**
   * Relazione tra due entità.
   * 1:N e 1:1: "da" è l'entità figlia (lato N, contiene la chiave esterna), "a" il padre (lato 1).
   * N:M: diventa una tabella ponte con le chiavi delle due entità come chiave primaria.
   */
  function aggiungiRelazione(M, { da, a, tipo, obbligatoria, nome, attributi, verbo }) {
    const figlia = entitaDi(M, da), padre = entitaDi(M, a);
    const r = { id: id(M), da, a, tipo, obbligatoria: !!obbligatoria, verbo: verbo || "" };
    if (tipo === "N:M") {
      r.nome = pulisciNome(nome || `${figlia.nome}_${padre.nome}`);
      r.colonne_da = chiave(figlia).map(k => nomeColonnaFk(figlia, k));
      r.colonne_a = chiave(padre).map(k => nomeColonnaFk(padre, k));
      if (r.colonne_da.some(c => r.colonne_a.includes(c))) {           // stesso nome dalle due parti: distinguo
        r.colonne_a = r.colonne_a.map(c => `${c}_${padre.nome.toLowerCase()}`);
      }
      r.attributi = attributi || [];
    } else {
      // nella figlia: una colonna per ogni attributo della chiave del padre (la riuso se c'è già)
      r.colonne_da = [];
      r.colonne_a = chiave(padre).map(k => k.nome);
      for (const k of chiave(padre)) {
        // con se stessa (gerarchia): una colonna nuova, per esempio id_categoria_padre, non la chiave stessa
        const nomeCol = figlia === padre ? `${k.nome}_padre` : nomeColonnaFk(padre, k);
        let col = figlia.attributi.find(x => x.nome.toLowerCase() === nomeCol.toLowerCase());
        if (!col) {
          col = { nome: nomeCol, tipo: tipoChiaveEsterna(k.tipo), pk: false, nn: !!obbligatoria, uq: false };
          figlia.attributi.push(col);
        }
        if (obbligatoria) col.nn = true;
        if (tipo === "1:1") col.uq = true;
        r.colonne_da.push(col.nome);
      }
    }
    M.relazioni.push(r);
    return r;
  }

  /** Un attributo cambia nome: le relazioni che lo usano (come chiave esterna o come chiave puntata) seguono il nome nuovo. */
  function rinominaAttributo(M, e, vecchio, nuovo) {
    if (!vecchio || vecchio === nuovo) return;
    for (const r of M.relazioni) {
      if (r.tipo === "N:M") continue;                  // le colonne della tabella ponte hanno nomi loro
      if (r.da === e.id) r.colonne_da = r.colonne_da.map(c => c === vecchio ? nuovo : c);
      if (r.a === e.id) r.colonne_a = r.colonne_a.map(c => c === vecchio ? nuovo : c);
    }
  }

  /** Le relazioni che usano un attributo di un'entità (per avvisare prima di eliminarlo). */
  function relazioniDiAttributo(M, e, nome) {
    return M.relazioni.filter(r => r.tipo !== "N:M" && ((r.da === e.id && r.colonne_da.includes(nome)) || (r.a === e.id && r.colonne_a.includes(nome))));
  }

  function eliminaEntita(M, eid) {
    M.entita = M.entita.filter(e => e.id !== eid);
    M.relazioni = M.relazioni.filter(r => r.da !== eid && r.a !== eid);
  }

  // ======================================================================= schema logico

  /** Tabelle e collegamenti (stesso formato del diagramma), più l'elenco degli avvisi del modello.
      concettuale: le relazioni N:M si disegnano come un rombo tra le due entità (schema E-R) invece della tabella ponte. */
  function schemaLogico(M, { concettuale = false } = {}) {
    const tabelle = [], collegamenti = [], avvisi = [];
    for (const e of M.entita) {
      const fk = new Set(M.relazioni.filter(r => r.tipo !== "N:M" && r.da === e.id).flatMap(r => r.colonne_da.map(c => c.toLowerCase())));
      tabelle.push({ nome: e.nome, gruppo: e.nome, pk_indovinata: false, id: e.id, entita: true,
        colonne: e.attributi.map(a => ({ nome: a.nome, tipo: a.tipo, pk: a.pk, fk: fk.has(a.nome.toLowerCase()),
          unique: a.uq, not_null: a.nn || a.pk, verso: [] })) });
      if (!chiave(e).length) avvisi.push(`${e.nome}: manca la chiave primaria (integrità dell'entità)`);
    }
    const perId = Object.fromEntries(M.entita.map(e => [e.id, e]));
    for (const r of M.relazioni) {
      const figlia = perId[r.da], padre = perId[r.a];
      if (!figlia || !padre) continue;
      if (r.tipo === "N:M" && concettuale) {
        collegamenti.push({ da: figlia.nome, colonne_da: chiave(figlia).map(k => k.nome), a: padre.nome, colonne_a: chiave(padre).map(k => k.nome),
                            tipo: "dichiarata", relazione: "N:M", obbligatoria: false, id: r.id, etichetta: r.verbo || r.nome,
                            descrizione: `relazione N:M ${r.nome}` + ((r.attributi || []).length ? ` con ${(r.attributi || []).map(a => a.nome).join(", ")}` : "") });
        if (!chiave(figlia).length || !chiave(padre).length) avvisi.push(`${r.nome}: le due entità devono avere una chiave primaria`);
      } else if (r.tipo === "N:M") {
        const k1 = chiave(figlia), k2 = chiave(padre);
        const colonne = [
          ...k1.map((k, i) => ({ nome: r.colonne_da[i] || nomeColonnaFk(figlia, k), tipo: tipoChiaveEsterna(k.tipo), pk: true, fk: true, unique: false, not_null: true, verso: [figlia.nome] })),
          ...k2.map((k, i) => ({ nome: r.colonne_a[i] || nomeColonnaFk(padre, k), tipo: tipoChiaveEsterna(k.tipo), pk: true, fk: true, unique: false, not_null: true, verso: [padre.nome] })),
          ...(r.attributi || []).map(a => ({ nome: a.nome, tipo: a.tipo, pk: false, fk: false, unique: false, not_null: !!a.nn, verso: [] })),
        ];
        tabelle.push({ nome: r.nome, gruppo: r.nome, pk_indovinata: false, id: r.id, ponte: true, colonne });
        collegamenti.push({ da: r.nome, colonne_da: colonne.slice(0, k1.length).map(c => c.nome), a: figlia.nome,
                            colonne_a: k1.map(k => k.nome), tipo: "dichiarata", relazione: "1:N", obbligatoria: true });
        collegamenti.push({ da: r.nome, colonne_da: colonne.slice(k1.length, k1.length + k2.length).map(c => c.nome), a: padre.nome,
                            colonne_a: k2.map(k => k.nome), tipo: "dichiarata", relazione: "1:N", obbligatoria: true });
        if (!k1.length || !k2.length) avvisi.push(`${r.nome}: le due entità devono avere una chiave primaria`);
      } else {
        const nomiFiglia = new Set(figlia.attributi.map(a => a.nome)), nomiPadre = new Set(padre.attributi.map(a => a.nome));
        const mancano = [...r.colonne_da.filter(c => !nomiFiglia.has(c)).map(c => `${figlia.nome}.${c}`),
                         ...r.colonne_a.filter(c => !nomiPadre.has(c)).map(c => `${padre.nome}.${c}`)];
        if (mancano.length) {                          // relazione rotta: non va nell'SQL (sarebbe un errore), lo si dice
          avvisi.push(`${figlia.nome} → ${padre.nome}: la relazione usa ${mancano.join(", ")}, che non c'è più: ricreala o rimetti la colonna`);
          continue;
        }
        // id ed etichetta: il rombo della relazione (schema E-R) a metà del collegamento
        collegamenti.push({ da: figlia.nome, colonne_da: r.colonne_da, a: padre.nome, colonne_a: r.colonne_a,
                            tipo: "dichiarata", relazione: r.tipo, obbligatoria: r.obbligatoria, id: r.id, etichetta: r.verbo || "" });
        const t = tabelle.find(x => x.nome === figlia.nome);
        t.colonne.forEach(c => { if (r.colonne_da.includes(c.nome)) c.verso.push(padre.nome); });
        if (!chiave(padre).length) avvisi.push(`${figlia.nome} → ${padre.nome}: il padre non ha chiave primaria, la chiave esterna non si può creare`);
      }
    }
    const nomi = tabelle.map(t => t.nome.toLowerCase());
    nomi.forEach((n, i) => { if (nomi.indexOf(n) !== i) avvisi.push(`${tabelle[i].nome}: nome usato due volte`); });
    return { tabelle, collegamenti, avvisi };
  }

  // ======================================================================= SQL

  function sql(M, regole = {}, dialetto = "mysql") {
    const { tabelle, collegamenti } = schemaLogico(M);
    const clausole = [regole.on_delete ? `ON DELETE ${regole.on_delete}` : "", regole.on_update ? `ON UPDATE ${regole.on_update}` : ""]
      .filter(Boolean).join(" ");
    // prima le tabelle a cui puntano le altre
    const dipende = Object.fromEntries(tabelle.map(t => [t.nome, new Set()]));
    collegamenti.forEach(l => { if (l.da !== l.a) dipende[l.da]?.add(l.a); });
    const ordine = [];
    const restanti = new Set(tabelle.map(t => t.nome));
    while (restanti.size) {
      const pronte = [...restanti].filter(n => [...dipende[n]].every(d => !restanti.has(d)));
      const giro = pronte.length ? pronte : [...restanti];          // ciclo: le metto comunque
      giro.sort().forEach(n => { ordine.push(n); restanti.delete(n); });
    }
    const righe = [`-- Database progettato con l'editor di SQL FK Finder (${new Date().toISOString().slice(0, 10)})`, ""];
    if (dialetto === "mysql") righe.push("SET FOREIGN_KEY_CHECKS = 0;", "");
    for (const nome of ordine) {
      const t = tabelle.find(x => x.nome === nome);
      const parti = t.colonne.map(c => `  ${c.nome} ${tipoDialetto(c.tipo, dialetto)}${c.not_null && !c.pk ? " NOT NULL" : ""}${c.pk ? " NOT NULL" : ""}${c.unique && !c.pk ? " UNIQUE" : ""}`
        .replace(" AUTO_INCREMENT NOT NULL", " NOT NULL AUTO_INCREMENT"));
      const pk = t.colonne.filter(c => c.pk).map(c => c.nome);
      if (pk.length) parti.push(`  PRIMARY KEY (${pk.join(", ")})`);
      for (const l of collegamenti.filter(x => x.da === nome)) {
        parti.push(`  CONSTRAINT fk_${nome}_${l.colonne_da.join("_")}_${l.a}`.slice(0, 66) +
                   ` FOREIGN KEY (${l.colonne_da.join(", ")}) REFERENCES ${l.a} (${l.colonne_a.join(", ")})${clausole ? " " + clausole : ""}`);
      }
      righe.push(`CREATE TABLE ${nome} (`, parti.join(",\n"), ");", "");
    }
    if (dialetto === "mysql") righe.push("SET FOREIGN_KEY_CHECKS = 1;");
    const meta = metadati(M);
    if (Object.keys(meta.posizioni).length || meta.relazioni.length) {
      righe.push("", "-- Il disegno per l'editor di SQL FK Finder (posizioni delle tabelle, nomi e cardinalità delle relazioni):",
                 "-- è un commento, non cambia il database; reimportando il file nell'editor il disegno torna com'era.",
                 `-- sqlfk-editor: ${JSON.stringify(meta)}`);
    }
    return righe.join("\n") + "\n";
  }

  // ======================================================================= importazione

  /** Modello dell'editor a partire dal diagramma di un database caricato (stesso formato di /api/diagramma). */
  function daDiagramma(dati, posizioni = {}) {
    const M = nuovoModello();
    const uscenti = {};
    dati.collegamenti.forEach(l => (uscenti[l.da] ||= []).push(l));
    // tabelle ponte pure: chiave fatta solo dalle colonne di due chiavi esterne verso tabelle diverse, nessun altro attributo
    const ponti = new Set(dati.tabelle.filter(t => {
      const u = uscenti[t.nome] || [];
      const fk = new Set(u.flatMap(l => l.colonne_da.map(c => c.toLowerCase())));
      return u.length === 2 && u[0].a !== u[1].a && t.colonne.every(c => c.pk && fk.has(c.nome.toLowerCase()));
    }).map(t => t.nome));
    const idDi = {};
    for (const t of dati.tabelle) {
      if (ponti.has(t.nome)) continue;
      const p = posizioni[t.nome] || [];
      const e = { id: id(M), nome: t.nome, origine: t.nome, x: p[0], y: p[1],
                  attributi: t.colonne.map(c => ({ nome: c.nome, origine: c.nome, tipo: c.tipo || "INT", pk: !!c.pk, nn: !!c.not_null && !c.pk, uq: !!c.unique && !c.pk })) };
      M.entita.push(e);
      idDi[t.nome] = e.id;
    }
    for (const l of dati.collegamenti) {
      if (ponti.has(l.da) || !idDi[l.da] || !idDi[l.a]) continue;
      M.relazioni.push({ id: id(M), da: idDi[l.da], a: idDi[l.a], tipo: l.relazione === "1:1" ? "1:1" : "1:N",
                         obbligatoria: !!l.obbligatoria, colonne_da: l.colonne_da, colonne_a: l.colonne_a });
    }
    for (const nome of ponti) {
      const [l1, l2] = uscenti[nome];
      if (!idDi[l1.a] || !idDi[l2.a]) continue;
      const p = posizioni[nome] || [];
      M.relazioni.push({ id: id(M), da: idDi[l1.a], a: idDi[l2.a], tipo: "N:M", obbligatoria: false, nome, origine: nome,
                         colonne_da: l1.colonne_da, colonne_a: l2.colonne_da, attributi: [], x: p[0], y: p[1] });
    }
    return M;
  }

  /**
   * Copia alcune tabelle di un diagramma (stesso formato di /api/diagramma) nel modello M, con le colonne e i
   * collegamenti tra le tabelle copiate e quelle già presenti. Le tabelle con un nome già presente non si copiano.
   * posizioni: quelle del diagramma di partenza; il gruppo copiato mantiene la sua forma e va a destra del disegno.
   * Restituisce {copiate, saltate, relazioni}.
   */
  function copiaTabelle(M, dati, nomi, posizioni = {}) {
    const presenti = new Map(M.entita.map(e => [e.nome.toLowerCase(), e]));
    const daCopiare = dati.tabelle.filter(t => nomi.includes(t.nome));
    const saltate = daCopiare.filter(t => presenti.has(t.nome.toLowerCase())).map(t => t.nome);
    const nuove = daCopiare.filter(t => !presenti.has(t.nome.toLowerCase()));
    // posizione: a destra di quello che c'è già, mantenendo la disposizione del diagramma di partenza
    const xs = M.entita.filter(e => isFinite(e.x)).map(e => e.x), ys = M.entita.filter(e => isFinite(e.y)).map(e => e.y);
    const origine = nuove.map(t => posizioni[t.nome]).filter(p => Array.isArray(p));
    const minX = origine.length ? Math.min(...origine.map(p => p[0])) : 0, minY = origine.length ? Math.min(...origine.map(p => p[1])) : 0;
    const baseX = xs.length ? Math.max(...xs) + 420 : 40, baseY = ys.length ? Math.min(...ys) : 40;
    nuove.forEach((t, i) => {
      const p = posizioni[t.nome];
      const e = { id: id(M), nome: t.nome, origine: t.nome,
                  x: p ? baseX + p[0] - minX : baseX + (i % 4) * 360, y: p ? baseY + p[1] - minY : baseY + Math.floor(i / 4) * 300,
                  attributi: t.colonne.filter(c => !String(c.nome).startsWith("… "))
                    .map(c => ({ nome: c.nome, origine: c.nome, tipo: c.tipo || "INT", pk: !!c.pk, nn: !!c.not_null && !c.pk, uq: !!c.unique && !c.pk })) };
      M.entita.push(e);
      presenti.set(e.nome.toLowerCase(), e);
    });
    // collegamenti con almeno una tabella appena copiata e l'altra presente nel disegno
    const nuoviNomi = new Set(nuove.map(t => t.nome.toLowerCase()));
    let relazioni = 0;
    for (const l of dati.collegamenti) {
      const figlia = presenti.get(l.da.toLowerCase()), padre = presenti.get(l.a.toLowerCase());
      if (!figlia || !padre || !(nuoviNomi.has(l.da.toLowerCase()) || nuoviNomi.has(l.a.toLowerCase()))) continue;
      const doppia = M.relazioni.some(r => r.da === figlia.id && r.a === padre.id && String(r.colonne_da) === String(l.colonne_da));
      if (doppia) continue;
      M.relazioni.push({ id: id(M), da: figlia.id, a: padre.id, tipo: l.relazione === "1:1" ? "1:1" : "1:N",
                         obbligatoria: !!l.obbligatoria, colonne_da: l.colonne_da, colonne_a: l.colonne_a });
      relazioni++;
    }
    return { copiate: nuove.map(t => t.nome), saltate, relazioni };
  }

  /**
   * Da dove prendere i dati di ogni tabella dell'editor che viene dal database caricato: tabella e colonne di origine,
   * anche se nell'editor sono state rinominate. Le colonne nuove non hanno origine (restano vuote), quelle tolte non ci sono.
   * [{tabella, origine, colonne: [[nome nell'editor, colonna di origine]]}]
   */
  function mappaDati(M) {
    const { tabelle } = schemaLogico(M);
    const nomi = new Set(tabelle.map(t => t.nome));
    const mappa = M.entita.filter(e => e.origine && nomi.has(e.nome)).map(e => ({
      tabella: e.nome, origine: e.origine,
      colonne: e.attributi.filter(a => a.origine).map(a => [a.nome, a.origine]),
    }));
    for (const r of M.relazioni.filter(r => r.tipo === "N:M" && r.origine && nomi.has(r.nome))) {
      mappa.push({ tabella: r.nome, origine: r.origine, colonne: [...r.colonne_da, ...r.colonne_a].map(c => [c, c]) });
    }
    return mappa.filter(m => m.colonne.length);
  }

  // ======================================================================= il disegno salvato con l'SQL

  /** Quello che l'SQL non dice: posizioni delle tabelle, nomi (verbi) e cardinalità delle relazioni. */
  function metadati(M) {
    const posizioni = {}, relazioni = [];
    for (const e of M.entita) if (isFinite(e.x) && isFinite(e.y)) posizioni[e.nome] = [Math.round(e.x), Math.round(e.y)];
    for (const r of M.relazioni) {
      const A = entitaDi(M, r.da), B = entitaDi(M, r.a);
      if (!A || !B) continue;
      if (r.tipo === "N:M") {
        if (isFinite(r.x) && isFinite(r.y)) posizioni[r.nome] = [Math.round(r.x), Math.round(r.y)];
        relazioni.push({ ponte: r.nome, da: A.nome, a: B.nome, tipo: "N:M", verbo: r.verbo || "" });
      } else {
        relazioni.push({ da: A.nome, a: B.nome, colonne: r.colonne_da, tipo: r.tipo, obbligatoria: !!r.obbligatoria, verbo: r.verbo || "" });
      }
    }
    return { versione: 1, posizioni, relazioni };
  }

  /** Rimette nel modello i nomi e le cardinalità delle relazioni salvati con l'SQL (dopo un'importazione). */
  function applicaMetadati(M, meta) {
    if (!meta || !Array.isArray(meta.relazioni)) return 0;
    const perNome = new Map(M.entita.map(e => [e.nome.toLowerCase(), e]));
    let fatte = 0;
    for (const m of meta.relazioni) {
      const A = perNome.get(String(m.da).toLowerCase()), B = perNome.get(String(m.a).toLowerCase());
      if (!A || !B) continue;
      const r = m.tipo === "N:M"
        ? M.relazioni.find(x => x.tipo === "N:M" && x.nome.toLowerCase() === String(m.ponte).toLowerCase())
        : M.relazioni.find(x => x.da === A.id && x.a === B.id && String(x.colonne_da) === String(m.colonne));
      if (!r) continue;
      r.verbo = m.verbo || r.verbo || "";
      if (m.tipo !== "N:M") {
        r.tipo = m.tipo === "1:1" ? "1:1" : "1:N";
        r.obbligatoria = !!m.obbligatoria;
      }
      fatte++;
    }
    return fatte;
  }

  // ======================================================================= copia e incolla

  /** Gli appunti con alcune entità (per id) e le relazioni tra loro (anche N:M), da incollare in questo o in un altro disegno. */
  function copia(M, ids) {
    const scelti = new Set(ids);
    const entita = M.entita.filter(e => scelti.has(e.id));
    const relazioni = M.relazioni.filter(r => scelti.has(r.da) && scelti.has(r.a));
    return JSON.parse(JSON.stringify({ formato: "sqlfk-tabelle", versione: 1, entita, relazioni }));
  }

  /**
   * Incolla gli appunti nel modello: entità con id nuovi (le relazioni seguono), nomi già presenti con _copia, posizioni
   * spostate un po' se si incolla nello stesso disegno (o a destra del disegno se viene da un altro). Restituisce
   * {ids, rinominate: [[vecchio, nuovo]]}.
   */
  function incolla(M, appunti) {
    if (!appunti || appunti.formato !== "sqlfk-tabelle" || !Array.isArray(appunti.entita)) throw new Error("Negli appunti non ci sono tabelle dell'editor.");
    const usati = new Set([...M.entita.map(e => e.nome.toLowerCase()), ...M.relazioni.filter(r => r.tipo === "N:M").map(r => r.nome.toLowerCase())]);
    const libero = nome => {
      let n = nome, k = 1;
      while (usati.has(n.toLowerCase())) n = k++ === 1 ? `${nome}_copia` : `${nome}_copia${k - 1}`;
      usati.add(n.toLowerCase());
      return n;
    };
    const stessoDisegno = appunti.entita.some(e => M.entita.some(x => x.nome.toLowerCase() === e.nome.toLowerCase()));
    const xs = M.entita.filter(e => isFinite(e.x)).map(e => e.x), ys = M.entita.filter(e => isFinite(e.y)).map(e => e.y);
    const ox = appunti.entita.filter(e => isFinite(e.x)).map(e => e.x), oy = appunti.entita.filter(e => isFinite(e.y)).map(e => e.y);
    const [dx, dy] = stessoDisegno || !xs.length || !ox.length ? [60, 60]
      : [Math.max(...xs) + 420 - Math.min(...ox), Math.min(...ys) - Math.min(...oy)];
    const nuovoId = {}, rinominate = [];
    for (const e of appunti.entita) {
      const copiaE = JSON.parse(JSON.stringify(e));
      copiaE.id = id(M);
      copiaE.nome = libero(e.nome);
      if (copiaE.nome !== e.nome) rinominate.push([e.nome, copiaE.nome]);
      if (isFinite(e.x)) { copiaE.x = e.x + dx; copiaE.y = e.y + dy; }
      nuovoId[e.id] = copiaE.id;
      M.entita.push(copiaE);
    }
    for (const r of appunti.relazioni || []) {
      if (!nuovoId[r.da] || !nuovoId[r.a]) continue;
      const copiaR = JSON.parse(JSON.stringify(r));
      copiaR.id = id(M);
      copiaR.da = nuovoId[r.da];
      copiaR.a = nuovoId[r.a];
      if (copiaR.tipo === "N:M") {
        copiaR.nome = libero(r.nome);
        if (isFinite(r.x)) { copiaR.x = r.x + dx; copiaR.y = r.y + dy; }
      }
      M.relazioni.push(copiaR);
    }
    return { ids: Object.values(nuovoId), rinominate };
  }

  return { TIPI, TIPI_SPIEGATI, nuovoModello, pulisciNome, aggiungiEntita, aggiungiRelazione, eliminaEntita, schemaLogico, sql, daDiagramma, copiaTabelle, entitaDi, mappaDati,
           copia, incolla, rinominaAttributo, relazioniDiAttributo, metadati, applicaMetadati };
})();
