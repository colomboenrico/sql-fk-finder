"""Schemi grafici interattivi (pyvis): il database prima dell'analisi e i collegamenti trovati."""
import re
from pathlib import Path

from pyvis.network import Network

from .analisi import normalizza


def _rete():
    net = Network(height="850px", width="100%", directed=True, cdn_resources="in_line")
    net.barnes_hut(gravity=-6000, spring_length=150)
    return net


def _salva(net, file_html):
    """Restituisce l'HTML; se file_html è dato lo scrive anche su disco."""
    html = net.generate_html()
    # tutto in locale: via i riferimenti a internet (Bootstrap da un CDN, che pyvis aggiunge sempre ma qui non serve)
    html = re.sub(r'<link[^>]+href="https?://[^"]*"[^>]*>', "", html)
    html = re.sub(r'<script[^>]+src="https?://[^"]*"[^>]*>\s*</script>', "", html)
    if file_html:
        Path(file_html).write_text(html, encoding="utf-8")
    return html


def schema_iniziale(df_schema, pk_dichiarate, fk_dichiarate, gruppo_di, file_html=None):
    """Tabelle colorate per gruppo, linee grigie tra tabelle dello stesso gruppo,
    frecce blu per le chiavi esterne già dichiarate."""
    net = _rete()
    col_per_tab = df_schema.groupby("tabella")["colonna"].apply(list).to_dict()
    tipi = {(r.tabella, r.colonna): r.tipo for r in df_schema.itertuples()}
    for t, colonne_t in col_per_tab.items():
        chiave = {normalizza(c) for c in pk_dichiarate.get(t, [])}
        elenco = "\n".join(f"{'[PK] ' if normalizza(c) in chiave else ''}{c}  {tipi.get((t, c)) or ''}"
                           for c in colonne_t)
        gruppo = gruppo_di.get(t, t)
        net.add_node(t, label=t, title=f"{t}\ngruppo: {gruppo}\n\n{elenco}", shape="box", group=gruppo)

    # tabelle dello stesso gruppo: linee grigie verso la tabella col nome più corto
    per_gruppo = {}
    for t in col_per_tab:
        per_gruppo.setdefault(gruppo_di.get(t, t), []).append(t)
    for gruppo, membri in per_gruppo.items():
        centro = min(membri, key=lambda t: (len(t), t))
        for t in membri:
            if t != centro:
                net.add_edge(centro, t, color="#bbbbbb", dashes=True, width=1,
                             arrows={"to": {"enabled": False}}, title=f"stesso gruppo: {gruppo}")

    # chiavi esterne già dichiarate
    for r in fk_dichiarate.to_dict("records"):
        if r["tabella"] in col_per_tab and r["→ tabella"] in col_per_tab:
            net.add_edge(r["tabella"], r["→ tabella"], color="#1f4e79", width=3, label=r["colonna"],
                         title=f'FK dichiarata: {r["tabella"]}.{r["colonna"]} → {r["→ tabella"]}.{r["→ colonna"]}')
    return _salva(net, file_html)


def schema_collegamenti(R, file_html=None):
    """Tabelle analizzate e chiavi esterne candidate: verde = alta, arancione tratteggiata = media,
    caselle grigie = tabelle isolate."""
    S = R.S
    net = _rete()
    for t, colonne_t in S.col_per_tab.items():
        elenco = "\n".join(
            f"{'[PK] ' if c in S.pk.get(t, []) else ''}{c}  {S.tipi.get((t, c)) or ''}"
            for c in colonne_t
        )
        net.add_node(t, label=t, title=f"{t}\n\n{elenco}", shape="box",
                     color="#e0e0e0" if t in R.isolate else "#97c2fc")

    colori = {"alta": "#2e7d32", "media": "#ef6c00"}
    for _, r in R.fk.iterrows():
        net.add_edge(r["tabella"], r["→ tabella"],
                     label=r["colonna"],
                     title=f'{r["tabella"]}.{r["colonna"]} → {r["→ tabella"]}.{r["→ colonna"]}'
                           f'\nrelazione {r.get("relazione", "")}'
                           + (" obbligatoria" if r.get("obbligatoria") else " facoltativa")
                           + f'\naffidabilità: {r["affidabilità"]}'
                           + ("" if r["tipi ok"] else "\nATTENZIONE: tipi diversi"),
                     color=colori[r["affidabilità"]],
                     dashes=r["affidabilità"] == "media")
    return _salva(net, file_html)
