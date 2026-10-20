# 7. Riga di comando

[Indice](README.md) · Precedente: [Architettura](06-architettura.md) · Successivo: [Domande frequenti](08-domande-frequenti.md)

Tutte le funzioni principali si usano anche dal terminale, nella cartella del progetto, con un Python che abbia le librerie (`pip install -r requirements.txt`). I comandi accettano una cartella di file `.sql` (o un file) e l'opzione `--dialetto` (`mysql` predefinito, `postgres`, `tsql`, `oracle`, `sqlite`).

## Diagnostica: `sqlfk.verifica`

Controlla il database come un compilatore.

```bash
python -m sqlfk.verifica esempi
python -m sqlfk.verifica --dialetto postgres percorso/del/dump
python -m sqlfk.verifica --spiega E010
```

| Opzione | Effetto |
|---|---|
| `--regole` | sotto ogni problema mostra la regola violata |
| `--senza-info` | non mostra i messaggi di tipo info |
| `--werror` | gli avvisi contano come errori |
| `--togli ENTITÀ ...` | toglie entità dall'analisi, es. `--togli piatto` |
| `--sinonimi GRUPPO ...` | gruppi di sinonimi, es. `"comune=citta=paese"` |
| `--on-delete`, `--on-update` | regole delle chiavi esterne proposte (`RESTRICT`, `CASCADE`, `SET NULL`...) |
| `--spiega CODICE` | spiega la regola di un codice e termina |

Codice di uscita: **0** nessun errore, **1** errori (o avvisi con `--werror`), **2** file illeggibili. Utile in uno script o in una pipeline.

## Query sui dati: `sqlfk.query`

```bash
python -m sqlfk.query esempi                                  # tabelle e numero di righe
python -m sqlfk.query esempi "SELECT * FROM comuni"
python -m sqlfk.query --dialetto postgres dump "SELECT nome FROM public.autori WHERE nome ILIKE 'c%'"
python -m sqlfk.query esempi --modifiche "DELETE FROM comuni WHERE id_comune = 1"
```

| Opzione | Effetto |
|---|---|
| `--modifiche` | permette `INSERT`, `UPDATE`, `DELETE`... (cambiano solo il database SQLite, mai i file) |
| `--svuota-cache` | cancella i database su disco costruiti in precedenza |

Con file grandi mostra l'avanzamento della lettura; il database su disco si riusa le volte dopo.

## Scelta con clingo: `sqlfk.asp`

```bash
python -m sqlfk.asp esempi
python -m sqlfk.asp esempi --medie --programma scelta.lp
python -m clingo scelta.lp --opt-mode=opt
```

| Opzione | Effetto |
|---|---|
| `--medie` | considera anche le candidate ad affidabilità media |
| `--programma FILE` | salva regole e fatti ASP in un file `.lp`, risolvibile con clingo da terminale |

Mostra il riepilogo (candidate, scelte, scartate, ottimo), le chiavi scelte e le scartate con il motivo.

## Modello relazionale: `sqlfk.modello`

```bash
python -m sqlfk.modello esempi
python -m sqlfk.modello esempi --formato mermaid > modello.mmd
```

| Opzione | Effetto |
|---|---|
| `--formato` | `testo` (predefinito), `md`, `mermaid`, `plantuml`, `dot`, `dbml`, `json` |
| `--solo-dichiarate` | solo le chiavi esterne già dichiarate |

## Ontologia: `sqlfk.ontologia`

```bash
python -m sqlfk.ontologia esempi --base http://example.org/negozio/ --uscita risultati
```

Scrive `ontologia.ttl` (OWL in Turtle) e `mapping_r2rml.ttl` nella cartella `--uscita`.

## Interfaccia nel browser: `sqlfk.server`

```bash
python -m sqlfk.server --apri
python -m sqlfk.server --porta 9000 --cartella esempi
```

| Opzione | Effetto |
|---|---|
| `--apri` | apre l'interfaccia nel browser |
| `--porta` | porta su `127.0.0.1` (predefinita 8765; 0 = libera) |
| `--cartella` | carica subito una cartella di file `.sql` |

## Motore per l'app: `sqlfk.ponte`

`python -m sqlfk.ponte` è il motore che l'app avvia e con cui parla attraverso le pipe (vedi [Architettura](06-architettura.md)). Non si usa a mano.

## Eseguibili

```bash
./crea_eseguibili.sh                 # tutti quelli possibili da questo computer
./crea_eseguibili.sh mac             # solo Mac (solo da un Mac)
./crea_eseguibili.sh win linux       # Windows e Linux
python app/prepara_python.py win-x64 # solo il Python da includere per Windows
```

## Variabili d'ambiente

| Variabile | Effetto |
|---|---|
| `SQLFK_PYTHON` | il Python da usare per l'app avviata dai sorgenti |
| `SQLFK_CACHE` | la cartella dei database delle query su disco (predefinita `~/.sqlfk/cache`) |
| `SQLFK_AUTOVERIFICA=1` | l'app fa il controllo, lo scrive in `sqlfk_autoverifica.txt` (cartella temporanea) e si chiude |
