"use strict";
// Diagramma ER in stile DBeaver: ogni tabella è un riquadro con le sue colonne,
// i collegamenti vanno dalla colonna chiave esterna alla colonna puntata.
// Disposizione automatica con dagre; poi si possono trascinare le tabelle, fare zoom e spostarsi.

const DiagrammaER = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const RIGA = 20, TESTA = 28, MARGINE = 10, CARATTERE = 7.3, LARGHEZZA_MIN = 170;
  const COLORI = ["#1f4e79", "#2e7d32", "#8e24aa", "#c25e00", "#00838f", "#ad1457", "#5d4037",
                  "#3949ab", "#558b2f", "#6d4c41", "#00695c", "#7b1fa2", "#b71c1c", "#455a64"];
  const STILE_LINEA = {
    dichiarata: { colore: "#1f4e79", spessore: 1.8, tratteggio: null },
    alta: { colore: "#2e7d32", spessore: 1.6, tratteggio: null },
    media: { colore: "#c25e00", spessore: 1.4, tratteggio: "6 4" },
    // mappa del software letta dall'interfaccia
    confermata: { colore: "#2e7d32", spessore: 2, tratteggio: null },
    mancata: { colore: "#c62828", spessore: 2, tratteggio: null },
    debole: { colore: "#8a94a3", spessore: 1.3, tratteggio: "4 4" },
  };

  const svgEl = (tag, attributi = {}, ...figli) => {
    const nodo = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attributi)) if (v !== null && v !== undefined) nodo.setAttribute(k, v);
    figli.forEach(f => nodo.append(f));
    return nodo;
  };

  function coloreGruppo(gruppo) {
    let h = 0;
    for (const c of String(gruppo)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORI[h % COLORI.length];
  }

  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const sigle = c => [c.pk ? "PK" : null, c.fk ? "FK" : null, !c.pk && c.unique ? "UQ" : null].filter(Boolean);

  function misura(t, conTipi) {
    const testo = Math.max(...t.colonne.map(c => c.nome.length + (conTipi ? c.tipo.length + 2 : 0)), 4);
    t.larghezza = Math.max(LARGHEZZA_MIN, Math.ceil(testo * CARATTERE) + 56, t.nome.length * 8.4 + 24);
    t.altezza = TESTA + t.colonne.length * RIGA + 6;
  }

  /** Dispone un gruppo di tabelle collegate con dagre; restituisce {larghezza, altezza} e imposta x, y relativi. */
  function disponiComponente(tabelle, collegamenti, direzione) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direzione, nodesep: 30, ranksep: direzione === "LR" ? 110 : 70, edgesep: 12, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    tabelle.forEach(t => g.setNode(t.nome, { width: t.larghezza, height: t.altezza }));
    collegamenti.forEach((l, i) => { if (l.a !== l.da) g.setEdge(l.a, l.da, {}, `e${i}`); });
    dagre.layout(g);
    const posizioni = tabelle.map(t => { const n = g.node(t.nome); return { t, x: n.x - t.larghezza / 2, y: n.y - t.altezza / 2 }; });
    const x0 = Math.min(...posizioni.map(p => p.x)), y0 = Math.min(...posizioni.map(p => p.y));
    posizioni.forEach(p => { p.x -= x0; p.y -= y0; });
    return {
      posizioni,
      larghezza: Math.max(...posizioni.map(p => p.x + p.t.larghezza)),
      altezza: Math.max(...posizioni.map(p => p.y + p.t.altezza)),
    };
  }

  /**
   * Disposizione: ogni insieme di tabelle collegate tra loro viene disposto con dagre (i "padri" prima),
   * scegliendo tra orizzontale e verticale la forma più vicina a quella dello schermo; poi gli insiemi
   * vengono affiancati a righe, con le tabelle isolate in fondo.
   */
  function disponi(tabelle, collegamenti, proporzione) {
    // insiemi di tabelle collegate (componenti connesse)
    const padre = Object.fromEntries(tabelle.map(t => [t.nome, t.nome]));
    const radice = n => (padre[n] === n ? n : (padre[n] = radice(padre[n])));
    collegamenti.forEach(l => { padre[radice(l.da)] = radice(l.a); });
    const insiemi = {};
    tabelle.forEach(t => (insiemi[radice(t.nome)] ||= []).push(t));

    const blocchi = Object.values(insiemi).map(membri => {
      if (membri.length === 1) {
        const t = membri[0];
        return { posizioni: [{ t, x: 0, y: 0 }], larghezza: t.larghezza, altezza: t.altezza, singola: true };
      }
      const nomi = new Set(membri.map(t => t.nome));
      const archi = collegamenti.filter(l => nomi.has(l.da) && nomi.has(l.a));
      const prove = ["LR", "TB"].map(d => disponiComponente(membri, archi, d));
      const scarto = b => Math.abs(Math.log((b.larghezza / b.altezza) / proporzione));
      return prove.sort((a, b) => scarto(a) - scarto(b))[0];
    });
    blocchi.sort((a, b) => (a.singola - b.singola) || (b.posizioni.length - a.posizioni.length) || (b.altezza - a.altezza));

    // affianca i blocchi a righe; larghezza delle righe scelta in base all'area totale e alla proporzione dello schermo
    const SPAZIO = 50;
    const area = blocchi.reduce((s, b) => s + (b.larghezza + SPAZIO) * (b.altezza + SPAZIO), 0);
    const massimo = Math.max(Math.sqrt(area * proporzione), ...blocchi.map(b => b.larghezza));
    let x = 0, y = 0, altezzaRiga = 0;
    for (const b of blocchi) {
      if (x > 0 && x + b.larghezza > massimo) { x = 0; y += altezzaRiga + SPAZIO; altezzaRiga = 0; }
      b.posizioni.forEach(p => { p.t.x = x + p.x; p.t.y = y + p.y; });
      x += b.larghezza + SPAZIO;
      altezzaRiga = Math.max(altezzaRiga, b.altezza);
    }
  }

  /**
   * Disposizione per gruppi (o per aree): le tabelle di ogni gruppo si dispongono insieme (come sopra) e i
   * gruppi, ordinati per nome, si affiancano a righe come riquadri separati; le tabelle senza gruppo in fondo.
   */
  const CORNICE = 28, TITOLO_CORNICE = 30, SENZA_GRUPPO = "altre tabelle";
  function disponiPerGruppi(tabelle, collegamenti, chiave, proporzione) {
    const gruppi = new Map();
    for (const t of tabelle) {
      const g = chiave(t) || SENZA_GRUPPO;
      if (!gruppi.has(g)) gruppi.set(g, []);
      gruppi.get(g).push(t);
    }
    const inFondo = g => g === SENZA_GRUPPO || g === "senza collegamenti";
    const nomi = [...gruppi.keys()].sort((a, b) => inFondo(a) - inFondo(b) || a.localeCompare(b, "it", { numeric: true }));
    const blocchi = nomi.map(g => {
      const membri = gruppi.get(g).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
      const insieme = new Set(membri.map(t => t.nome));
      const interni = collegamenti.filter(l => insieme.has(l.da) && insieme.has(l.a));
      disponi(membri, interni, 1.4);              // posizioni relative dentro il gruppo
      const x1 = Math.max(...membri.map(t => t.x + t.larghezza)), y1 = Math.max(...membri.map(t => t.y + t.altezza));
      return { g, membri, larghezza: x1 + 2 * CORNICE, altezza: y1 + 2 * CORNICE + TITOLO_CORNICE };
    });
    // righe nell'ordine dei nomi; la larghezza delle righe si sceglie provandone diverse, per avere
    // la forma più vicina a quella dello schermo (anche con gruppi molto alti, come tabelle con tante colonne)
    const SPAZIO = 40;
    const righe = massimo => {
      let x = 0, y = 0, altezzaRiga = 0, larghezza = 0;
      const posti = blocchi.map(b => {
        if (x > 0 && x + b.larghezza > massimo) { x = 0; y += altezzaRiga + SPAZIO; altezzaRiga = 0; }
        const p = [x, y];
        x += b.larghezza + SPAZIO;
        larghezza = Math.max(larghezza, x - SPAZIO);
        altezzaRiga = Math.max(altezzaRiga, b.altezza);
        return p;
      });
      return { posti, larghezza, altezza: y + altezzaRiga };
    };
    const minimo = Math.max(...blocchi.map(b => b.larghezza));
    const totale = blocchi.reduce((s, b) => s + b.larghezza + SPAZIO, 0);
    let migliore = null;
    for (let i = 0; i <= 40; i++) {
      const prova = righe(minimo * Math.pow(Math.max(1, totale / minimo), i / 40));
      const scarto = Math.abs(Math.log((prova.larghezza / prova.altezza) / proporzione));
      if (!migliore || scarto < migliore.scarto) migliore = { ...prova, scarto };
    }
    blocchi.forEach((b, i) => {
      const [x, y] = migliore.posti[i];
      b.membri.forEach(t => { t.x += x + CORNICE; t.y += y + CORNICE + TITOLO_CORNICE; });
    });
    return nomi;
  }

  /** Punto di aggancio della colonna sul lato sinistro o destro del riquadro. */
  function aggancio(t, colonne, lato) {
    const nomi = new Set(colonne.map(norm));
    let i = t.colonne.findIndex(c => nomi.has(norm(c.nome)));
    const y = i < 0 ? t.y + TESTA / 2 : t.y + TESTA + i * RIGA + RIGA / 2;
    return { x: lato === "destra" ? t.x + t.larghezza : t.x, y };
  }

  function percorso(figlia, padre, l) {
    const centroF = figlia.x + figlia.larghezza / 2, centroP = padre.x + padre.larghezza / 2;
    let latoF, latoP;
    if (figlia === padre) { latoF = latoP = "destra"; }
    else if (padre.x + padre.larghezza < figlia.x) { latoF = "sinistra"; latoP = "destra"; }
    else if (figlia.x + figlia.larghezza < padre.x) { latoF = "destra"; latoP = "sinistra"; }
    else { latoF = latoP = centroP < centroF ? "sinistra" : "destra"; }
    const a = aggancio(figlia, l.colonne_da, latoF), b = aggancio(padre, l.colonne_a, latoP);
    const spinta = Math.max(40, Math.min(160, Math.abs(b.x - a.x) / 2));
    const da = latoF === "destra" ? spinta : -spinta, db = latoP === "destra" ? spinta : -spinta;
    return { d: `M ${a.x} ${a.y} C ${a.x + da} ${a.y}, ${b.x + db} ${b.y}, ${b.x} ${b.y}`, a, b, latoF, latoP };
  }

  function crea(contenitore, dati, opzioni = {}) {
    const conTipi = opzioni.tipi !== false;
    const tabelle = dati.tabelle.map(t => ({ ...t, colonne: t.colonne }));
    tabelle.forEach(t => misura(t, conTipi));
    const perNome = Object.fromEntries(tabelle.map(t => [t.nome, t]));
    const collegamenti = dati.collegamenti.filter(l => perNome[l.da] && perNome[l.a]);
    const riquadro = contenitore.getBoundingClientRect();
    const proporzione = riquadro.width > 0 && riquadro.height > 0 ? riquadro.width / riquadro.height : 1.6;
    const chiaveGruppo = opzioni.raggruppa ? (t => t[opzioni.raggruppa]) : null;
    if (chiaveGruppo) disponiPerGruppi(tabelle, collegamenti, chiaveGruppo, proporzione);
    else disponi(tabelle, collegamenti, proporzione);
    // posizioni salvate (tabelle spostate a mano, anche da un progetto): hanno la precedenza sulla disposizione automatica
    const salvate = opzioni.posizioni || {};
    tabelle.forEach(t => {
      const p = salvate[t.nome];
      if (Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1])) { t.x = p[0]; t.y = p[1]; }
    });

    // ---------------------------------------------------------- struttura SVG
    const svg = svgEl("svg", { class: "er-svg", width: "100%", height: "100%" });
    const mondo = svgEl("g");
    const strCornici = svgEl("g"), strLinee = svgEl("g"), strTabelle = svgEl("g"), strEtichette = svgEl("g");
    mondo.append(strCornici, strLinee, strTabelle, strEtichette);
    svg.append(mondo);
    contenitore.replaceChildren(svg);

    let vista = opzioni.vista ? { ...opzioni.vista } : { x: 0, y: 0, s: 1 };
    const applica = () => mondo.setAttribute("transform", `translate(${vista.x} ${vista.y}) scale(${vista.s})`);

    // ---------------------------------------------------------- tabelle
    for (const t of tabelle) {
      const colore = coloreGruppo(t[opzioni.coloraPer || "gruppo"] || t.gruppo);
      const g = svgEl("g", { class: "er-tabella" + (opzioni.attenuate && opzioni.attenuate.has(t.nome) ? " er-attenuata" : ""), "data-nome": t.nome });
      const scelta = opzioni.selezionata === t.nome;
      g.append(svgEl("rect", { x: 0, y: 0, width: t.larghezza, height: t.altezza, rx: 5, fill: "#ffffff",
                               stroke: scelta ? "#ef6c00" : "#b8c0cc", "stroke-width": scelta ? 3 : 1 }));
      g.append(svgEl("path", { d: `M0 5 Q0 0 5 0 H${t.larghezza - 5} Q${t.larghezza} 0 ${t.larghezza} 5 V${TESTA} H0 Z`, fill: colore }));
      const titolo = svgEl("text", { x: 10, y: 18, fill: "#ffffff", "font-size": 13, "font-weight": 700,
                                     "font-family": "-apple-system, Segoe UI, Roboto, Arial, sans-serif" });
      titolo.textContent = (t.titolo || t.nome) + (t.pk_indovinata ? " (PK non dichiarata)" : "");
      const tooltip = svgEl("title"); tooltip.textContent = `${t.nome}\ngruppo: ${t.gruppo}` +
        (t.area ? `\narea: ${t.area}\ncategoria: ${t.categoria}` : "") + `\n${t.colonne.length} colonne`;
      g.append(titolo, tooltip);
      t.colonne.forEach((c, i) => {
        const y = TESTA + i * RIGA;
        if (i % 2) g.append(svgEl("rect", { x: 1, y, width: t.larghezza - 2, height: RIGA, fill: "#f6f8fa" }));
        // sfondo per le colonne trovate con la ricerca
        const daEvidenziare = opzioni.colonne && norm(opzioni.colonne) && norm(c.nome).includes(norm(opzioni.colonne));
        c.trovata = svgEl("rect", { x: 1, y, width: t.larghezza - 2, height: RIGA, fill: "#ffe58a", visibility: daEvidenziare ? "visible" : "hidden" });
        g.append(c.trovata);
        const s = sigle(c);
        const sigla = svgEl("text", { x: 8, y: y + 14, "font-size": 9.5, "font-weight": 700,
                                      fill: c.pk ? "#b8860b" : c.fk ? "#1f4e79" : "#6b7785",
                                      "font-family": "-apple-system, Segoe UI, Roboto, Arial, sans-serif" });
        sigla.textContent = s.join(" ");
        const nome = svgEl("text", { x: 40, y: y + 14, "font-size": 12, fill: "#1d2330",
                                     "font-weight": c.pk ? 700 : 400, "text-decoration": c.pk ? "underline" : null,
                                     "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" });
        nome.textContent = c.nome;
        g.append(sigla, nome);
        if (conTipi) {
          const tipo = svgEl("text", { x: t.larghezza - 8, y: y + 14, "font-size": 11, fill: "#7a8594", "text-anchor": "end",
                                       "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" });
          tipo.textContent = (c.tipo || "").toLowerCase();
          g.append(tipo);
        }
        const suggerimento = svgEl("title");
        suggerimento.textContent = `${t.nome}.${c.nome}\ntipo: ${c.tipo || "?"}\n${[c.pk ? "chiave primaria" : null, c.fk ? "chiave esterna" : null,
          c.unique ? "UNIQUE" : null, c.not_null ? "NOT NULL" : "può essere NULL"].filter(Boolean).join(", ")}`;
        g.append(svgEl("rect", { x: 0, y, width: t.larghezza, height: RIGA, fill: "transparent" }, suggerimento));
      });
      t.nodo = g;
      strTabelle.append(g);
    }

    // ---------------------------------------------------------- collegamenti
    for (const l of collegamenti) {
      const stile = STILE_LINEA[l.tipo] || STILE_LINEA.alta;
      // nella vista per gruppi le linee tra gruppi diversi sono più leggere (tornano piene al passaggio del mouse)
      const traGruppi = chiaveGruppo && (chiaveGruppo(perNome[l.da]) || SENZA_GRUPPO) !== (chiaveGruppo(perNome[l.a]) || SENZA_GRUPPO);
      l.linea = svgEl("path", { fill: "none", stroke: stile.colore, "stroke-width": stile.spessore,
                                "stroke-dasharray": stile.tratteggio, class: "er-linea" + (traGruppi ? " er-tra-gruppi" : "") });
      const titolo = svgEl("title");
      titolo.textContent = `${l.da}(${l.colonne_da.join(", ")}) → ${l.a}(${l.colonne_a.join(", ")})\n` +
        `relazione ${l.relazione}, ${l.obbligatoria ? "obbligatoria" : "facoltativa"}\n` +
        (l.descrizione || (l.tipo === "dichiarata" ? "chiave esterna dichiarata" : `chiave esterna trovata (affidabilità ${l.tipo})`));
      l.linea.append(titolo);
      l.puntoF = svgEl("circle", { r: 3, fill: stile.colore });
      l.puntoP = svgEl("circle", { r: 3, fill: stile.colore });
      l.cardF = svgEl("text", { "font-size": 10, "font-weight": 700, fill: stile.colore, "font-family": "Arial, sans-serif" });
      l.cardP = svgEl("text", { "font-size": 10, "font-weight": 700, fill: stile.colore, "font-family": "Arial, sans-serif" });
      l.cardF.textContent = l.relazione === "1:1" ? "1" : "N";
      l.cardP.textContent = l.relazione === "N:M" ? "N" : "1";
      strLinee.append(l.linea);
      strEtichette.append(l.puntoF, l.puntoP, l.cardF, l.cardP);
    }

    function aggiornaLinee(solo) {
      for (const l of collegamenti) {
        if (solo && l.da !== solo && l.a !== solo) continue;
        const p = percorso(perNome[l.da], perNome[l.a], l);
        l.linea.setAttribute("d", p.d);
        l.puntoF.setAttribute("cx", p.a.x); l.puntoF.setAttribute("cy", p.a.y);
        l.puntoP.setAttribute("cx", p.b.x); l.puntoP.setAttribute("cy", p.b.y);
        l.cardF.setAttribute("x", p.a.x + (p.latoF === "destra" ? 6 : -14)); l.cardF.setAttribute("y", p.a.y - 4);
        l.cardP.setAttribute("x", p.b.x + (p.latoP === "destra" ? 6 : -12)); l.cardP.setAttribute("y", p.b.y - 4);
      }
    }
    function posiziona(t) { t.nodo.setAttribute("transform", `translate(${t.x} ${t.y})`); }
    tabelle.forEach(posiziona);
    aggiornaLinee();

    // riquadri dei gruppi: calcolati dalle posizioni delle tabelle (seguono gli spostamenti a mano)
    const cornici = new Map();
    if (chiaveGruppo) {
      const membri = new Map();
      tabelle.forEach(t => { const g = chiaveGruppo(t) || SENZA_GRUPPO; if (!membri.has(g)) membri.set(g, []); membri.get(g).push(t); });
      for (const [g, elenco] of membri) {
        const colore = g === SENZA_GRUPPO ? "#8a94a3" : coloreGruppo(g);
        const rett = svgEl("rect", { rx: 10, fill: colore, "fill-opacity": 0.06, stroke: colore, "stroke-width": 1.5, "stroke-opacity": 0.6 });
        const titolo = svgEl("text", { "font-size": 15, "font-weight": 700, fill: colore, "font-family": "-apple-system, Segoe UI, Roboto, Arial, sans-serif" });
        titolo.textContent = `${g}  ·  ${elenco.length} ${elenco.length === 1 ? "tabella" : "tabelle"}`;
        strCornici.append(rett, titolo);
        cornici.set(g, { elenco, rett, titolo });
      }
    }
    function aggiornaCornice(g) {
      const c = cornici.get(g);
      if (!c) return;
      const x0 = Math.min(...c.elenco.map(t => t.x)) - CORNICE, y0 = Math.min(...c.elenco.map(t => t.y)) - CORNICE - TITOLO_CORNICE;
      const x1 = Math.max(...c.elenco.map(t => t.x + t.larghezza)) + CORNICE, y1 = Math.max(...c.elenco.map(t => t.y + t.altezza)) + CORNICE;
      c.rett.setAttribute("x", x0); c.rett.setAttribute("y", y0);
      c.rett.setAttribute("width", x1 - x0); c.rett.setAttribute("height", y1 - y0);
      c.titolo.setAttribute("x", x0 + 14); c.titolo.setAttribute("y", y0 + 22);
    }
    cornici.forEach((_, g) => aggiornaCornice(g));

    // ---------------------------------------------------------- evidenziazione al passaggio del mouse
    function evidenzia(nome) {
      svg.classList.toggle("er-focus", !!nome);
      const vicine = new Set([nome]);
      for (const l of collegamenti) {
        const attiva = !!nome && (l.da === nome || l.a === nome);
        [l.linea, l.puntoF, l.puntoP, l.cardF, l.cardP].forEach(n => n.classList.toggle("er-attiva", attiva));
        if (attiva) { vicine.add(l.da); vicine.add(l.a); }
      }
      tabelle.forEach(t => t.nodo.classList.toggle("er-attiva", !!nome && vicine.has(t.nome)));
    }

    // ---------------------------------------------------------- trascinamento, spostamento, zoom
    let trascina = null;
    const puntoMondo = e => {
      const r = svg.getBoundingClientRect();
      return { x: (e.clientX - r.left - vista.x) / vista.s, y: (e.clientY - r.top - vista.y) / vista.s };
    };
    svg.addEventListener("pointerdown", e => {
      const nodo = e.target.closest(".er-tabella");
      if (nodo) {
        const t = perNome[nodo.dataset.nome];
        const p = puntoMondo(e);
        trascina = { tipo: "tabella", t, dx: p.x - t.x, dy: p.y - t.y, x0: e.clientX, y0: e.clientY };
        strTabelle.append(nodo);                       // in primo piano
      } else {
        trascina = { tipo: "vista", x: e.clientX - vista.x, y: e.clientY - vista.y, x0: e.clientX, y0: e.clientY };
      }
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", e => {
      if (!trascina) {
        const nodo = e.target.closest(".er-tabella");
        evidenzia(nodo ? nodo.dataset.nome : null);
        return;
      }
      if (trascina.tipo === "tabella") {
        const p = puntoMondo(e);
        trascina.t.x = p.x - trascina.dx; trascina.t.y = p.y - trascina.dy;
        posiziona(trascina.t);
        aggiornaLinee(trascina.t.nome);
        if (chiaveGruppo) aggiornaCornice(chiaveGruppo(trascina.t) || SENZA_GRUPPO);
      } else {
        vista.x = e.clientX - trascina.x; vista.y = e.clientY - trascina.y;
        applica();
      }
    });
    const fine = e => {
      const fermo = trascina && e && Math.hypot(e.clientX - trascina.x0, e.clientY - trascina.y0) < 4;
      if (trascina && fermo && opzioni.onClic) {
        opzioni.onClic(trascina.tipo === "tabella" ? trascina.t.nome : null);   // clic senza trascinare
      } else if (trascina && trascina.tipo === "tabella" && opzioni.onSposta) {
        opzioni.onSposta(trascina.t.nome, Math.round(trascina.t.x), Math.round(trascina.t.y));
      }
      if (trascina && trascina.tipo === "vista" && opzioni.onVista) opzioni.onVista({ ...vista });
      trascina = null;
    };
    svg.addEventListener("pointerup", fine);
    svg.addEventListener("pointerleave", () => { fine(null); evidenzia(null); });
    svg.addEventListener("wheel", e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomIn(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      if (opzioni.onVista) opzioni.onVista({ ...vista });
    }, { passive: false });

    function zoomIn(fattore, cx, cy) {
      const r = svg.getBoundingClientRect();
      cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
      const s = Math.min(3, Math.max(0.05, vista.s * fattore));
      vista.x = cx - (cx - vista.x) * (s / vista.s);
      vista.y = cy - (cy - vista.y) * (s / vista.s);
      vista.s = s;
      applica();
    }

    function limiti(elenco = tabelle) {
      const bordo = chiaveGruppo ? CORNICE : 0, sopra = chiaveGruppo ? CORNICE + TITOLO_CORNICE : 0;
      const x0 = Math.min(...elenco.map(t => t.x)) - bordo, y0 = Math.min(...elenco.map(t => t.y)) - sopra;
      const x1 = Math.max(...elenco.map(t => t.x + t.larghezza)) + bordo, y1 = Math.max(...elenco.map(t => t.y + t.altezza)) + bordo;
      return { x0, y0, x1, y1 };
    }

    function adatta(elenco) {
      if (!tabelle.length) return;
      const r = svg.getBoundingClientRect();
      const b = limiti(elenco);
      const s = Math.min(1.2, (r.width - 2 * MARGINE * 4) / (b.x1 - b.x0), (r.height - 2 * MARGINE * 4) / (b.y1 - b.y0));
      vista.s = Math.max(0.05, s);
      vista.x = (r.width - (b.x1 - b.x0) * vista.s) / 2 - b.x0 * vista.s;
      vista.y = (r.height - (b.y1 - b.y0) * vista.s) / 2 - b.y0 * vista.s;
      applica();
    }

    /** Cerca nei nomi delle tabelle e delle colonne (per esempio "name"): evidenzia le tabelle trovate e,
     *  in giallo, le colonne. Restituisce il numero di tabelle; i dettagli con ultimaRicerca(). */
    let ricerca = { tabelle: 0, perNome: 0, colonne: 0 };
    function cerca(testo) {
      const f = norm(testo);
      tabelle.forEach(t => t.colonne.forEach(c => c.trovata.setAttribute("visibility", "hidden")));
      ricerca = { tabelle: 0, perNome: 0, colonne: 0 };
      if (!f) { evidenzia(null); return 0; }
      const trovate = [];
      for (const t of tabelle) {
        const colonne = t.colonne.filter(c => norm(c.nome).includes(f));
        colonne.forEach(c => c.trovata.setAttribute("visibility", "visible"));
        const perNome = norm(t.nome).includes(f);
        if (perNome || colonne.length) trovate.push(t);
        ricerca.perNome += perNome ? 1 : 0;
        ricerca.colonne += colonne.length;
      }
      ricerca.tabelle = trovate.length;
      if (!trovate.length) { evidenzia(null); return 0; }
      if (trovate.length === 1) {
        adatta([trovate[0]]);
        evidenzia(trovate[0].nome);
      } else {
        // più tabelle: si vedono tutte insieme, le altre restano sbiadite
        adatta(trovate);
        const nomi = new Set(trovate.map(t => t.nome));
        svg.classList.add("er-focus");
        collegamenti.forEach(l => [l.linea, l.puntoF, l.puntoP, l.cardF, l.cardP].forEach(n =>
          n.classList.toggle("er-attiva", nomi.has(l.da) && nomi.has(l.a))));
        tabelle.forEach(t => t.nodo.classList.toggle("er-attiva", nomi.has(t.nome)));
      }
      return trovate.length;
    }

    /** SVG da salvare: tutto il diagramma, senza zoom né evidenziazioni. */
    function esporta() {
      const b = limiti();
      const copia = svg.cloneNode(true);
      copia.classList.remove("er-focus");
      copia.querySelectorAll(".er-attiva").forEach(n => n.classList.remove("er-attiva"));
      if (!opzioni.colonne) copia.querySelectorAll('rect[fill="#ffe58a"]').forEach(n => n.setAttribute("visibility", "hidden"));
      copia.querySelector("g").removeAttribute("transform");
      copia.setAttribute("xmlns", NS);
      copia.setAttribute("viewBox", `${b.x0 - 20} ${b.y0 - 20} ${b.x1 - b.x0 + 40} ${b.y1 - b.y0 + 40}`);
      copia.setAttribute("width", b.x1 - b.x0 + 40);
      copia.setAttribute("height", b.y1 - b.y0 + 40);
      copia.insertBefore(svgEl("rect", { x: b.x0 - 20, y: b.y0 - 20, width: b.x1 - b.x0 + 40, height: b.y1 - b.y0 + 40, fill: "#f7f8fa" }), copia.firstChild);
      return new XMLSerializer().serializeToString(copia);
    }

    /** PNG di tutto il diagramma (Blob); scala 2 = doppia risoluzione, ridotta se l'immagine sarebbe troppo grande. */
    async function png(scala = 2) {
      const b = limiti();
      const w = b.x1 - b.x0 + 40, h = b.y1 - b.y0 + 40;
      const s = Math.min(scala, 16000 / Math.max(w, h), Math.sqrt(2.4e8 / (w * h)));
      const url = URL.createObjectURL(new Blob([esporta()], { type: "image/svg+xml" }));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const tela = document.createElement("canvas");
        tela.width = Math.round(w * s);
        tela.height = Math.round(h * s);
        const ctx = tela.getContext("2d");
        ctx.fillStyle = "#f7f8fa";
        ctx.fillRect(0, 0, tela.width, tela.height);
        ctx.drawImage(img, 0, 0, tela.width, tela.height);
        return await new Promise(r => tela.toBlob(r, "image/png"));
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    if (opzioni.vista) applica(); else requestAnimationFrame(() => adatta());
    /** Posizioni attuali di tutte le tabelle: nome -> [x, y]. */
    const posizioni = () => Object.fromEntries(tabelle.map(t => [t.nome, [Math.round(t.x), Math.round(t.y)]]));
    return { adatta: () => adatta(), zoom: f => zoomIn(f), cerca, ultimaRicerca: () => ({ ...ricerca }), esporta, png, posizioni, vista: () => ({ ...vista }),
             numeri: { tabelle: tabelle.length, collegamenti: collegamenti.length, gruppi: cornici.size } };
  }

  return { crea, coloreGruppo };
})();
