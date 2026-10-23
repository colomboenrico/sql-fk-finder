"use strict";

// Pagina "Schema E-R": lo schema concettuale ricostruito dal database (il passaggio inverso dal modello logico
// al modello Entità-Relazione). Tabelle ponte -> relazioni N:M, chiavi esterne -> relazioni 1:N e 1:1 con un nome
// proposto, tabelle che condividono la chiave del padre -> gerarchie (ISA), colonne ripetute -> attributi multivalore.
// Il risultato è un modello dell'editor: si modifica qui, si porta nell'Editor del database o nella lavagna.

const Concettuale = (() => {
  const CATEGORIA = (D, t) => (D.tabelle[t] || {}).categoria || "";

  /** Nome proposto per la relazione, letto dalla figlia verso il padre ("fatture appartiene a clienti"). */
  function verbo(figlia, padre, D, isa) {
    if (isa) return "è un";
    if (figlia === padre) return "dipende da";
    const cf = CATEGORIA(D, figlia), cp = CATEGORIA(D, padre);
    const scheda = D.tabelle[figlia] || {};
    const radice = n => n.toLowerCase().replace(/^(tbl|tab|t)_/, "").replace(/[aeios]$/, "");
    // righe di dettaglio: la tabella è il dettaglio proprio di quel padre (ordini_righe -> ordini)
    if (cf === "dettaglio" && (scheda.padre_dal_nome === padre || figlia.toLowerCase().startsWith(radice(padre)))) return "fa parte di";
    // codifiche vere: il padre parla di tipi, categorie, stati, classi
    if (cp === "codifica" && /tip|categor|stat[oiu]|class|gener|famigl|caus/i.test(padre)) return "è di tipo";
    if (cf === "storico") return "registra";
    if (cf === "movimento" && cp === "anagrafica") return "riguarda";
    return "appartiene a";
  }

  /** Colonne ripetute con un numero in sequenza da 1 (telefono1, telefono2...), che non sono chiavi: {radice: [colonne]}. */
  function ripetute(colonne) {
    const gruppi = {};
    for (const c of colonne) {
      const m = /^(.*?[A-Za-z])_?(\d{1,2})$/.exec(c.nome);
      if (m && !c.pk && !c.fk) (gruppi[m[1].toLowerCase()] ||= []).push([Number(m[2]), c.nome]);
    }
    return Object.fromEntries(Object.entries(gruppi)
      .filter(([, v]) => v.length >= 2 && v.map(x => x[0]).sort((x, y) => x - y).every((n, i) => n === i + 1))
      .map(([k, v]) => [k, v.map(x => x[1])]));
  }

  /**
   * Modello dell'editor (entità e relazioni) dal diagramma del database (/api/diagramma) e dalle descrizioni
   * del reverse engineering (/api/reverse). area: solo le tabelle di quell'area. Restituisce {modello, note, numeri}.
   */
  function daDatabase(diag, D, { area = "" } = {}) {
    const tabelle = diag.tabelle.filter(t => !area || t.area === area);
    const nomi = new Set(tabelle.map(t => t.nome));
    // dalle stesse colonne una sola relazione: se una è dichiarata vale quella (le altre sono proposte in conflitto)
    const tutti = diag.collegamenti.filter(l => nomi.has(l.da) && nomi.has(l.a));
    const chiaveColonne = l => `${l.da}|${l.colonne_da.map(c => c.toLowerCase()).sort().join(",")}`;
    const dichiarate = new Set(tutti.filter(l => l.tipo === "dichiarata").map(chiaveColonne));
    const collegamenti = tutti.filter(l => l.tipo === "dichiarata" || !dichiarate.has(chiaveColonne(l)));
    const perNome = Object.fromEntries(tabelle.map(t => [t.nome, t]));
    // tabelle con la stessa chiave che si puntano a vicenda (A -> B e B -> A sulle stesse colonne): non è una gerarchia
    const insieme = cs => cs.map(c => c.toLowerCase()).sort().join(",");
    const reciproco = l => l.da !== l.a && collegamenti.some(x => x.da === l.a && x.a === l.da &&
      insieme(x.colonne_da) === insieme(l.colonne_a) && insieme(x.colonne_a) === insieme(l.colonne_da));
    const uscenti = {};
    collegamenti.forEach(l => (uscenti[l.da] ||= []).push(l));
    const note = [];

    // tabelle ponte: la chiave primaria è fatta dalle chiavi esterne verso esattamente due tabelle diverse
    const ponti = new Map();
    for (const t of tabelle) {
      const pk = t.colonne.filter(c => c.pk).map(c => c.nome.toLowerCase());
      const nellaChiave = (uscenti[t.nome] || []).filter(l => l.da !== l.a && !reciproco(l) && l.colonne_da.every(c => pk.includes(c.toLowerCase())));
      const coperte = new Set(nellaChiave.flatMap(l => l.colonne_da.map(c => c.toLowerCase())));
      const verso = [...new Set(nellaChiave.map(l => l.a))];
      if (pk.length >= 2 && verso.length === 2 && pk.every(c => coperte.has(c))) {
        ponti.set(t.nome, { l1: nellaChiave.find(l => l.a === verso[0]), l2: nellaChiave.find(l => l.a === verso[1]) });
      } else if (pk.length >= 2 && verso.length > 2 && pk.every(c => coperte.has(c))) {
        note.push({ tipo: "relazione tra più entità", testo: `${t.nome} collega ${verso.length} entità (${verso.join(", ")}): resta un'entità, è una relazione ternaria o di grado maggiore.` });
      }
    }

    const M = Editor.nuovoModello();
    const id = () => `n${M.prossimo++}`;
    const idDi = {};
    for (const t of tabelle) {
      if (ponti.has(t.nome)) continue;
      const e = { id: id(), nome: t.nome,
                  attributi: t.colonne.map(c => ({ nome: c.nome, tipo: c.tipo || "INT", pk: !!c.pk, nn: !!c.not_null && !c.pk, uq: !!c.unique && !c.pk })) };
      M.entita.push(e);
      idDi[t.nome] = e.id;
      for (const [radice, colonne] of Object.entries(ripetute(t.colonne))) {
        note.push({ tipo: "attributo multivalore", testo: `${t.nome}: ${colonne.join(", ")} sono un attributo multivalore «${radice}» (nel modello logico andrebbero in una tabella a parte).` });
      }
    }
    const numeri = { entita: M.entita.length, "1:N": 0, "1:1": 0, "N:M": 0, isa: 0, multivalore: note.filter(n => n.tipo === "attributo multivalore").length };

    const coppie = new Set();
    for (const l of collegamenti) {
      if (ponti.has(l.da) || !idDi[l.da] || !idDi[l.a]) continue;
      if (reciproco(l)) {
        // una sola relazione 1:1 per la coppia; la direzione (chi specializza chi) va decisa a mano
        const coppia = [l.da, l.a].sort().join("|");
        if (coppie.has(coppia)) continue;
        coppie.add(coppia);
        M.relazioni.push({ id: id(), da: idDi[l.da], a: idDi[l.a], tipo: "1:1", obbligatoria: false,
                           colonne_da: l.colonne_da, colonne_a: l.colonne_a, verbo: "corrisponde a" });
        numeri["1:1"]++;
        note.push({ tipo: "stessa chiave, direzione da decidere", testo: `${l.da} e ${l.a} hanno la stessa chiave e si puntano a vicenda: ` +
          "descrivono la stessa cosa (1:1). Se una specializza l'altra, apri il rombo e scrivi «è un» nel verso giusto." });
        continue;
      }
      const figlia = perNome[l.da];
      const pk = figlia.colonne.filter(c => c.pk).map(c => c.nome.toLowerCase());
      // gerarchia: la chiave della figlia è tutta e sola la chiave esterna verso il padre
      const isa = l.da !== l.a && pk.length > 0 && pk.length === l.colonne_da.length && l.colonne_da.every(c => pk.includes(c.toLowerCase()));
      const tipo = isa || l.relazione === "1:1" ? "1:1" : "1:N";
      M.relazioni.push({ id: id(), da: idDi[l.da], a: idDi[l.a], tipo, obbligatoria: !!l.obbligatoria || isa,
                         colonne_da: l.colonne_da, colonne_a: l.colonne_a, verbo: verbo(l.da, l.a, D, isa) });
      numeri[tipo]++;
      if (isa) {
        numeri.isa++;
        note.push({ tipo: "gerarchia (ISA)", testo: `${l.da} è una specializzazione di ${l.a}: ha la stessa chiave primaria e la usa per collegarsi (${l.colonne_da.join(", ")}).` });
      }
    }
    for (const [nome, { l1, l2 }] of ponti) {
      if (!idDi[l1.a] || !idDi[l2.a]) continue;
      const chiave = new Set([...l1.colonne_da, ...l2.colonne_da].map(c => c.toLowerCase()));
      const attributi = perNome[nome].colonne.filter(c => !chiave.has(c.nome.toLowerCase()))
        .map(c => ({ nome: c.nome, tipo: c.tipo || "INT", nn: !!c.not_null }));
      M.relazioni.push({ id: id(), da: idDi[l1.a], a: idDi[l2.a], tipo: "N:M", obbligatoria: false, nome, verbo: "",
                         colonne_da: l1.colonne_da, colonne_a: l2.colonne_da, attributi });
      numeri["N:M"]++;
      note.push({ tipo: "relazione N:M", testo: `${nome} è la tabella ponte tra ${l1.a} e ${l2.a}: diventa una relazione N:M` +
        (attributi.length ? ` con gli attributi ${attributi.map(a => a.nome).join(", ")}.` : ".") });
    }
    return { modello: M, note, numeri };
  }

  return { daDatabase };
})();

const STATO_ER = { modello: Editor.nuovoModello(), selezione: null, vista: null, concettuale: true, area: null, note: [], numeri: null };

Object.assign(VISTE, {
  async er() {
    const [R, diag] = await Promise.all([datiReverse(), api("/api/diagramma?tipo=collegamenti")]);
    const aree = [...new Set(diag.tabelle.map(t => t.area).filter(Boolean))].sort();
    const chiave = JSON.stringify([stato.origine, stato.tabelle_analizzate, stato.rimosse]);
    if (STATO_ER.chiave !== chiave) Object.assign(STATO_ER, { chiave, modello: Editor.nuovoModello(), area: null, numeri: null, note: [] });   // altro database
    if (STATO_ER.area === null) {
      // database grandi: un'area alla volta, a partire da quella con più tabelle (non quella delle tabelle isolate)
      const conta = a => diag.tabelle.filter(t => t.area === a).length;
      const grandi = aree.filter(a => a !== "senza collegamenti").sort((x, y) => conta(y) - conta(x));
      STATO_ER.area = diag.tabelle.length > 80 && grandi.length ? grandi[0] : "";
    }
    const E = creaEditor(STATO_ER);
    const riepilogo = el("div");
    function ricostruisci() {
      const X = Concettuale.daDatabase(diag, R.D, { area: STATO_ER.area });
      Object.assign(STATO_ER, { modello: X.modello, note: X.note, numeri: X.numeri });
      E.ricarica();
      disegnaRiepilogo();
    }
    function disegnaRiepilogo() {
      const N = STATO_ER.numeri;
      if (!N) { riepilogo.replaceChildren(); return; }
      const perTipo = {};
      STATO_ER.note.forEach(n => (perTipo[n.tipo] ||= []).push(n.testo));
      riepilogo.replaceChildren(el("div", { class: "pannello" },
        el("p", {}, el("b", {}, `${N.entita} entità`), `, ${N["1:N"]} relazioni 1:N, ${N["1:1"]} relazioni 1:1 (di cui ${N.isa} gerarchie ISA), ` +
          `${N["N:M"]} relazioni N:M, ${N.multivalore} attributi multivalore.`),
        el("p", { class: "tenue" }, "I nomi delle relazioni sono proposte ricavate dalle categorie delle tabelle: clicca un rombo per cambiarli."),
        Object.entries(perTipo).map(([tipo, testi]) => el("details", {},
          el("summary", {}, `${tipo[0].toUpperCase()}${tipo.slice(1)} (${testi.length})`),
          el("ul", {}, testi.map(t => el("li", {}, t)))))));
    }
    const sceltaArea = el("select", { "aria-label": "Area" },
      el("option", { value: "", selected: !STATO_ER.area }, `Tutto il database (${diag.tabelle.length} tabelle)`),
      aree.map(a => el("option", { value: a, selected: a === STATO_ER.area }, `Area ${a} (${diag.tabelle.filter(t => t.area === a).length} tabelle)`)));
    sceltaArea.addEventListener("change", () => { STATO_ER.area = sceltaArea.value; ricostruisci(); });
    const comeRombo = el("input", { type: "checkbox", checked: STATO_ER.concettuale });
    comeRombo.addEventListener("change", () => { STATO_ER.concettuale = comeRombo.checked; E.ridisegna(); });
    const copia = () => JSON.parse(JSON.stringify(STATO_ER.modello));
    if (!STATO_ER.modello.entita.length) setTimeout(ricostruisci, 0);
    else setTimeout(() => { E.ridisegna(); disegnaRiepilogo(); }, 0);
    return [
      el("datalist", { id: "tipi-sql" }, Editor.TIPI.map(t => el("option", { value: t }))),
      intestazioneRichiudibile("er", "Schema E-R",
      el("p", { class: "tenue" }, "Lo schema concettuale ricostruito dal database: le tabelle ponte diventano relazioni N:M, le chiavi esterne relazioni " +
        "1:N e 1:1 con un rombo e un nome proposto, le tabelle che hanno la stessa chiave del padre diventano gerarchie (è un), le colonne ripetute " +
        "attributi multivalore. Si modifica come nell'Editor (clicca entità e rombi, Collega due tabelle) e si porta nell'Editor del database o nella lavagna."),
      el("div", { class: "riga-comandi" },
        sceltaArea,
        el("button", { onclick: () => { if (!STATO_ER.modello.entita.length || confirm("Ricostruire lo schema? Le modifiche fatte qui si perdono.")) ricostruisci(); } }, "Ricostruisci"),
        el("label", { title: "Le relazioni N:M come rombo tra le due entità; senza spunta si vede la tabella ponte" }, comeRombo, "N:M come rombo"),
        E.pulsanteCollega,
        el("button", { onclick: () => E.diagramma && E.diagramma.adatta() }, "Adatta"),
        el("button", { onclick: () => E.diagramma && conAttesa(async () =>
          scaricaBlob(await E.diagramma.png(3), `schema_er${STATO_ER.area ? "_" + STATO_ER.area.replace(/[^\w.-]+/g, "_") : ""}.png`)) }, "Scarica PNG"),
        el("button", { onclick: () => {
          if (modelloEditor.entita.length && !confirm("L'Editor del database contiene già un disegno: sostituirlo con lo schema E-R?")) return;
          E.ridisegna(); modelloEditor = copia(); selezioneEditor = null; vistaEditor = null; mostra("editor");
        } }, "Porta nell'Editor"),
        el("button", { onclick: () => {
          if (STATO_LAVAGNA.modello.entita.length && !confirm("La lavagna contiene già un disegno: sostituirlo con lo schema E-R?")) return;
          E.ridisegna(); STATO_LAVAGNA.modello = copia(); STATO_LAVAGNA.selezione = null; STATO_LAVAGNA.vista = null; mostra("lavagna");
        } }, "Apri nella lavagna")),
        riepilogo),
      E.statoCollega, E.avvisiBox,
      el("div", { class: "editor-griglia" }, E.cornice, E.pannello),
    ];
  },
});
