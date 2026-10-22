"""Extensions for sql-fk-finder: ORM generation, data profiling, ETL scaffolding, AST CRUD analysis
and foreign keys checked against the data.

This module is a plug-in on top of the core engine: it only reads the structures built by
analisi.analizza (schema, primary keys, foreign keys, normalization diagnostics) and the SQLite
database built by query.py, and never changes them.

- generate_sqlalchemy_models(R)          -> Python source with SQLAlchemy declarative classes
- profile_data(db, R)                    -> DataFrame with row/null/distinct counts and suggestions
- generate_migration_script(R, dialect)  -> SQL draft that fixes 1NF, 2NF and 3NF violations
- analyze_crud(sql_text, dialect)        -> DataFrame mapping views/routines to tables and CRUD operations
- check_inclusion(db, R)                 -> DataFrame: how many values of each candidate foreign key exist in the parent
- find_value_links(db, R)                -> DataFrame: columns whose values are all in a key of another table
"""
import keyword
import re

import pandas as pd

from . import analisi as A
from . import query as QY

try:
    import sqlglot
    from sqlglot import exp
except ImportError:                       # the CRUD analyzer falls back to regular expressions
    sqlglot = None


# ====================================================================== shared helpers

def _py_name(name, used, reserved=()):
    """A valid, unique Python identifier for a SQL name: "Order Date" -> order_date."""
    base = re.sub(r"\W+", "_", A.senza_accenti(str(name))).strip("_").lower() or "col"
    if base[0].isdigit():
        base = "_" + base
    if keyword.iskeyword(base) or base in reserved:
        base += "_"
    candidate, n = base, 2
    while candidate in used:
        candidate, n = f"{base}_{n}", n + 1
    used.add(candidate)
    return candidate


def _class_name(table, used):
    """sales.order_lines -> SalesOrderLines (unique among the generated classes)."""
    parts = re.split(r"[^0-9A-Za-z]+", A.senza_accenti(table))
    base = "".join(p[:1].upper() + p[1:] for p in parts if p) or "Table"
    if base[0].isdigit():
        base = "T" + base
    candidate, n = base, 2
    while candidate in used:
        candidate, n = f"{base}{n}", n + 1
    used.add(candidate)
    return candidate


def _split_schema(table):
    """("sales", "orders") for sales.orders, (None, "orders") for orders."""
    schema, _, name = table.rpartition(".")
    return (schema or None), name


def _fk_links(R):
    """Foreign keys used by the generators: the declared ones and, for each column not already covered,
    the high-reliability candidates with compatible types.
    List of dicts {table, columns, target, target_columns, source}."""
    S = R.S
    links, seen = [], set()

    def add(row, source):
        table, target = row["tabella"], row["→ tabella"]
        columns = [c.strip() for c in str(row["colonna"]).split(",")]
        target_columns = [c.strip() for c in str(row["→ colonna"]).split(",")]
        if (table not in S.col_per_tab or target not in S.col_per_tab or len(columns) != len(target_columns)
                or "?" in target_columns or (table, tuple(columns)) in seen
                or not set(columns) <= set(S.col_per_tab[table])
                or not set(target_columns) <= set(S.col_per_tab[target])):
            return
        seen.add((table, tuple(columns)))
        links.append({"table": table, "columns": columns, "target": target, "target_columns": target_columns,
                      "source": source})

    if R.fk_dichiarate is not None:
        for row in R.fk_dichiarate.to_dict("records"):
            add(row, "declared")
    reliable = R.fk[(R.fk["affidabilità"] == "alta") & R.fk["tipi ok"]]
    for row in reliable.sort_values(["tabella", "colonna", "→ tabella"]).to_dict("records"):
        add(row, "declared" if row["già dichiarata"] else "inferred")
    return links


# ====================================================================== 1. ORM model generator

# SQL base type (as returned by analisi.tipo_base) -> SQLAlchemy type
SQLALCHEMY_TYPES = {
    "INT": "Integer", "BIGINT": "BigInteger", "SMALLINT": "SmallInteger", "TINYINT": "SmallInteger",
    "VARCHAR": "String", "CHAR": "String", "UUID": "String", "UNIQUEIDENTIFIER": "String",
    "TEXT": "Text", "TINYTEXT": "Text", "MEDIUMTEXT": "Text", "LONGTEXT": "Text", "NTEXT": "Text", "CLOB": "Text",
    "DECIMAL": "Numeric", "MONEY": "Numeric", "FLOAT": "Float", "DOUBLE": "Float",
    "DATE": "Date", "TIMESTAMP": "DateTime", "TIME": "Time",
    "BOOLEAN": "Boolean", "BIT": "Boolean",
    "BLOB": "LargeBinary", "TINYBLOB": "LargeBinary", "MEDIUMBLOB": "LargeBinary", "LONGBLOB": "LargeBinary",
    "BYTEA": "LargeBinary", "BINARY": "LargeBinary", "VARBINARY": "LargeBinary", "IMAGE": "LargeBinary",
    "JSON": "JSON", "JSONB": "JSON", "ENUM": "Enum",
}
# attributes that SQLAlchemy declarative classes reserve for themselves
RESERVED_ATTRIBUTES = {"metadata", "registry", "query", "query_class"}


def _sqlalchemy_type(sql_type, table, column):
    """(type expression, type name to import): VARCHAR(80) -> ("String(80)", "String").
    Unknown types become String (the caller notes the original type in a comment)."""
    base = A.tipo_base(sql_type)
    type_name = SQLALCHEMY_TYPES.get(base, "String")
    match = re.search(r"\((.*)\)", str(sql_type or ""))
    arguments = match.group(1).strip() if match else ""
    numbers = [a.strip() for a in arguments.split(",") if a.strip().isdigit()]
    if base == "TINYINT" and arguments == "1":           # MySQL boolean
        return "Boolean", "Boolean"
    if type_name == "String" and base in ("UUID", "UNIQUEIDENTIFIER"):
        return "String(36)", type_name
    if type_name == "String" and base in SQLALCHEMY_TYPES and numbers:
        return f"String({numbers[0]})", type_name
    if type_name == "Numeric" and numbers:
        return f"Numeric({', '.join(numbers[:2])})", type_name
    if type_name == "Enum":
        values = [v.replace("''", "'") for v in re.findall(r"'((?:[^']|'')*)'", arguments)]
        enum_name = re.sub(r"\W+", "_", f"{table}_{column}_enum".lower())
        return f"Enum({', '.join(repr(v) for v in values)}, name={enum_name!r})", type_name
    return type_name, type_name


def generate_sqlalchemy_models(R):
    """Python source with the SQLAlchemy declarative classes of the analyzed schema (R from analisi.analizza).

    Declared foreign keys and high-reliability candidates become ForeignKey (ForeignKeyConstraint for
    composite keys) plus a many-to-one relationship(). Tables without any primary key cannot be mapped to
    a class and become plain Table objects.
    """
    S = R.S
    tables = sorted(S.col_per_tab)
    links_of = {}
    for link in _fk_links(R):
        links_of.setdefault(link["table"], []).append(link)

    # first pass: class and attribute names of every table, needed by the relationships pointing to it
    classes, attributes, used_classes = {}, {}, set()
    for table in tables:
        if S.pk.get(table):
            classes[table] = _class_name(table, used_classes)
        used = set()
        attributes[table] = {c: _py_name(c, used, RESERVED_ATTRIBUTES) for c in S.col_per_tab[table]}

    imports = {"Column"}
    body = []
    for table in tables:
        schema, name = _split_schema(table)
        pk = S.pk.get(table, [])
        single_fks = {l["columns"][0]: l for l in links_of.get(table, []) if len(l["columns"]) == 1}
        composite_fks = [l for l in links_of.get(table, []) if len(l["columns"]) > 1]

        columns = []                         # (column, Column() arguments, trailing comment)
        for column in S.col_per_tab[table]:
            sql_type = S.tipi.get((table, column))
            type_expr, type_name = _sqlalchemy_type(sql_type, table, column)
            imports.add(type_name)
            args = [repr(column), type_expr]
            comment = ""
            if column in single_fks:
                link = single_fks[column]
                args.append(f"ForeignKey({link['target'] + '.' + link['target_columns'][0]!r})")
                imports.add("ForeignKey")
                if link["source"] == "inferred":
                    comment = "  # inferred foreign key (high reliability), not declared in the DDL"
            if column in pk:
                args.append("primary_key=True")
            elif (table, column) in S.not_null:
                args.append("nullable=False")
            if (table, column) in S.unique and pk != [column]:
                args.append("unique=True")
            if sql_type and A.tipo_base(sql_type) not in SQLALCHEMY_TYPES:
                comment = comment or f"  # original type: {sql_type}"
            columns.append((column, args, comment))

        constraints = []
        for link in composite_fks:
            targets = [f"{link['target']}.{c}" for c in link["target_columns"]]
            constraints.append(f"ForeignKeyConstraint({link['columns']!r}, {targets!r})")
            imports.add("ForeignKeyConstraint")

        if table not in classes:
            # no primary key: SQLAlchemy cannot map a class, so the table is described with Table()
            imports.add("Table")
            variable = _py_name("t_" + table, set(classes.values()))
            body.append(f"# {table}: no primary key, mapped as a Table (add a primary key to get an ORM class)")
            body.append(f"{variable} = Table(")
            body.append(f"    {name!r},")
            body.append("    Base.metadata,")
            body.extend(f"    Column({', '.join(args)}),{comment}" for _, args, comment in columns)
            body.extend(f"    {c}," for c in constraints)
            if schema:
                body.append(f"    schema={schema!r},")
            body += [")", "", ""]
            continue

        body.append(f"class {classes[table]}(Base):")
        body.append(f"    __tablename__ = {name!r}")
        table_args = constraints + ([f"{{'schema': {schema!r}}}"] if schema else [])
        if schema and not constraints:
            body.append(f"    __table_args__ = {table_args[0]}")
        elif table_args:
            body.append("    __table_args__ = (")
            body.extend(f"        {a}," for a in table_args)
            body.append("    )")
        if table in S.pk_indovinata:
            body.append("    # primary key inferred from the column names, not declared in the DDL")
        body.append("")
        for column, args, comment in columns:
            attribute = attributes[table][column]
            if attribute == column:
                args = args[1:]              # the SQL name is the attribute name: no need to repeat it
            body.append(f"    {attribute} = Column({', '.join(args)}){comment}")

        # many-to-one relationships towards the referenced classes
        relationships = []
        used = set(attributes[table].values()) | RESERVED_ATTRIBUTES
        for link in links_of.get(table, []):
            target = link["target"]
            if target not in classes:
                continue
            stem = ""
            if len(link["columns"]) == 1:
                stem = re.sub(r"^(?:id|fk|cod|code)_?|_?(?:id|fk|cod|code)$", "", link["columns"][0], flags=re.I)
            rel_name = _py_name(stem or _split_schema(target)[1], used)
            keys = ", ".join(attributes[table][c] for c in link["columns"])
            args = [repr(classes[target]), f"foreign_keys=[{keys}]"]
            if target == table:              # self reference: the parent row is the remote side
                args.append(f"remote_side=[{', '.join(attributes[table][c] for c in link['target_columns'])}]")
            relationships.append(f"    {rel_name} = relationship({', '.join(args)})")
        if relationships:
            body.append("")
            body.extend(relationships)
        body += ["", ""]

    ordered_imports = ["Column"] + sorted(imports - {"Column"})
    orm_imports = "declarative_base, relationship" if any("relationship(" in line for line in body) \
        else "declarative_base"
    header = [
        '"""SQLAlchemy models generated by sql-fk-finder.',
        "",
        "Review before use: inferred foreign keys and primary keys are marked with a comment.",
        '"""',
        f"from sqlalchemy import {', '.join(ordered_imports)}",
        f"from sqlalchemy.orm import {orm_imports}",
        "",
        "Base = declarative_base()",
        "",
        "",
    ]
    return "\n".join(header + body).rstrip() + "\n"


# ====================================================================== 2. Statistical data profiler

PROFILE_COLUMNS = ["table", "column", "declared type", "rows", "nulls", "null %", "distinct", "distinct %",
                   "classification", "suggestion"]
MIN_VALUES = 20               # fewer non-null values are too few for ENUM or natural key suggestions
ENUM_MAX_DISTINCT = 10        # at most this many distinct values -> ENUM / lookup candidate
SPARSE_NULL_RATIO = 0.9       # columns that are almost always empty
COLUMNS_PER_QUERY = 200       # SQLite returns at most 2000 columns per row


def _classify(rows, nulls, distinct, is_key):
    """(classification, suggestion) of a column from its counts."""
    values = rows - nulls
    if rows == 0:
        return "NO_DATA", "The table has no rows in the loaded data: nothing to profile."
    if values == 0:
        return "DEPRECATION_CANDIDATE", "Always NULL: candidate for removal."
    if nulls / rows >= SPARSE_NULL_RATIO:
        return "SPARSE", "Mostly NULL: consider moving it to an optional 1:1 table."
    if distinct == 1 and rows > 1:
        return "CONSTANT", "Always the same value: consider a DEFAULT or removing the column."
    if distinct == values and nulls == 0 and values >= MIN_VALUES and not is_key:
        return "NATURAL_KEY_CANDIDATE", "Unique and never NULL: candidate natural key (UNIQUE constraint)."
    if distinct <= ENUM_MAX_DISTINCT and values >= MIN_VALUES and not is_key:
        return "ENUM_CANDIDATE", f"Only {distinct} distinct values: candidate ENUM, CHECK constraint or lookup table."
    return "", ""


def profile_data(db, R=None, tables=None, progress=None):
    """Row count, NULL count and cardinality of every column of the query database (query.Database),
    with a classification and a refactoring suggestion.

    R (analisi.analizza) is optional: it gives the declared types and tells which columns are primary or
    foreign keys, which are never reported as ENUM or natural key candidates. tables limits the profile
    to some tables. One aggregation query per table (per COLUMNS_PER_QUERY columns).
    progress(done, total, table) is called before each table (it may raise to stop)."""
    keys = set()
    if R is not None:
        for table, columns in R.S.pk.items():
            keys.update((table, c) for c in columns)
        for link in _fk_links(R):
            keys.update((link["table"], c) for c in link["columns"])
    results = []
    names = [t for t in db.nomi_tabelle_db() if tables is None or t in tables]
    for done, table in enumerate(names):
        if progress:
            progress(done, len(names), table)
        columns = [(r[1], r[2]) for r in db.conn.execute(f"PRAGMA table_info({QY.q(table)})")]
        rows = db.conn.execute(f"SELECT COUNT(*) FROM {QY.q(table)}").fetchone()[0]
        counts = {}
        for i in range(0, len(columns), COLUMNS_PER_QUERY):
            chunk = [c for c, _ in columns[i:i + COLUMNS_PER_QUERY]]
            if rows:
                aggregates = ", ".join(f"COUNT({QY.q(c)}), COUNT(DISTINCT {QY.q(c)})" for c in chunk)
                values = db.conn.execute(f"SELECT {aggregates} FROM {QY.q(table)}").fetchone()
            else:
                values = [0] * (2 * len(chunk))
            for k, column in enumerate(chunk):
                counts[column] = (values[2 * k], values[2 * k + 1])
        for column, sqlite_type in columns:
            non_null, distinct = counts[column]
            nulls = rows - non_null
            classification, suggestion = _classify(rows, nulls, distinct, (table, column) in keys)
            declared = R.S.tipi.get((table, column)) if R is not None else None
            results.append({
                "table": table, "column": column, "declared type": declared or sqlite_type,
                "rows": rows, "nulls": nulls, "null %": round(100 * nulls / rows, 1) if rows else None,
                "distinct": distinct, "distinct %": round(100 * distinct / non_null, 1) if non_null else None,
                "classification": classification, "suggestion": suggestion,
            })
    return pd.DataFrame(results, columns=PROFILE_COLUMNS)


# ====================================================================== 3. ETL migration scaffolder

def _add_column(table, column, sql_type, dialect):
    if dialect == "tsql":
        return f"ALTER TABLE {table} ADD {column} {sql_type};"
    if dialect == "oracle":
        return f"ALTER TABLE {table} ADD ({column} {sql_type});"
    return f"ALTER TABLE {table} ADD COLUMN {column} {sql_type};"


def _split_first_word(column, dialect):
    """(first word, rest) SQL expressions that split a composite text field at the first space."""
    if dialect in ("mysql", "mariadb"):
        return (f"SUBSTRING_INDEX({column}, ' ', 1)",
                f"NULLIF(TRIM(SUBSTRING({column}, LENGTH(SUBSTRING_INDEX({column}, ' ', 1)) + 2)), '')")
    if dialect in ("postgres", "postgresql"):
        return (f"SPLIT_PART({column}, ' ', 1)",
                f"CASE WHEN POSITION(' ' IN {column}) > 0 THEN TRIM(SUBSTRING({column} FROM POSITION(' ' IN {column}) + 1)) END")
    if dialect == "tsql":
        return (f"CASE WHEN CHARINDEX(' ', {column}) > 0 THEN LEFT({column}, CHARINDEX(' ', {column}) - 1) ELSE {column} END",
                f"CASE WHEN CHARINDEX(' ', {column}) > 0 THEN LTRIM(SUBSTRING({column}, CHARINDEX(' ', {column}) + 1, LEN({column}))) END")
    return (f"CASE WHEN INSTR({column}, ' ') > 0 THEN SUBSTR({column}, 1, INSTR({column}, ' ') - 1) ELSE {column} END",
            f"CASE WHEN INSTR({column}, ' ') > 0 THEN TRIM(SUBSTR({column}, INSTR({column}, ' ') + 1)) END")


def _key_definitions(S, table):
    """Definitions of the primary key columns of a table, to copy them into a child table."""
    return [f"{c} {S.tipi.get((table, c)) or 'INT'} NOT NULL" for c in S.pk.get(table, [])]


def _composite_field(S, table, column, dialect):
    sql_type = S.tipi.get((table, column)) or "VARCHAR(255)"
    first, rest = _split_first_word(column, dialect)
    return [
        f"-- 1NF  {table}.{column}: composite field, split into atomic columns",
        "-- Rename the two new columns (e.g. last_name / first_name) and check values with more than two words.",
        _add_column(table, f"{column}_part1", sql_type, dialect),
        _add_column(table, f"{column}_part2", sql_type, dialect),
        f"UPDATE {table} SET",
        f"    {column}_part1 = {first},",
        f"    {column}_part2 = {rest}",
        f"WHERE {column} IS NOT NULL;",
        f"-- ALTER TABLE {table} DROP COLUMN {column};   -- after checking the result",
    ]


def _repeating_group(S, table, columns, dialect):
    match = re.fullmatch(r"(.*?[A-Za-z])_?(\d+)", columns[0])
    stem = match.group(1) if match else columns[0]
    child = f"{table}_{stem}"
    pk = S.pk.get(table, [])
    lines = [f"-- 1NF  {table}.({', '.join(columns)}): repeating group, moved to one row per value in {child}"]
    if not pk:
        return lines + [f"-- TODO: {table} has no primary key: add one before moving the values."]
    value = stem if stem.lower() not in {c.lower() for c in pk} else f"{stem}_value"
    sql_type = S.tipi.get((table, columns[0])) or "VARCHAR(255)"
    keys = ", ".join(pk)
    lines.append(f"CREATE TABLE {child} (")
    lines += [f"    {d}," for d in _key_definitions(S, table)]
    lines += ["    position INT NOT NULL,",
              f"    {value} {sql_type} NOT NULL,",
              f"    PRIMARY KEY ({keys}, position),",
              f"    FOREIGN KEY ({keys}) REFERENCES {table} ({keys})",
              ");",
              f"INSERT INTO {child} ({keys}, position, {value})"]
    selects = []
    for i, column in enumerate(columns, 1):
        number = re.search(r"(\d+)$", column)
        selects.append(f"SELECT {keys}, {number.group(1) if number else i}, {column} "
                       f"FROM {table} WHERE {column} IS NOT NULL")
    lines.append("\nUNION ALL\n".join(selects) + ";")
    lines += [f"-- ALTER TABLE {table} DROP COLUMN {c};" for c in columns]
    return lines


def _multivalued(S, table, column, dialect):
    base = A.tipo_base(S.tipi.get((table, column)))
    child = f"{table}_{column}"
    pk = S.pk.get(table, [])
    lines = [f"-- 1NF  {table}.{column}: {base} column with several values, moved to one row per value in {child}"]
    if not pk:
        return lines + [f"-- TODO: {table} has no primary key: add one before moving the values."]
    value = f"{column}_value"
    keys = ", ".join(pk)
    source_keys = ", ".join(f"src.{k}" for k in pk)
    lines.append(f"CREATE TABLE {child} (")
    lines += [f"    {d}," for d in _key_definitions(S, table)]
    lines += [f"    {value} VARCHAR(255) NOT NULL,",
              f"    PRIMARY KEY ({keys}, {value}),",
              f"    FOREIGN KEY ({keys}) REFERENCES {table} ({keys})",
              ");"]
    insert = f"INSERT INTO {child} ({keys}, {value})"
    if dialect in ("postgres", "postgresql") and base == "ARRAY":
        lines += [insert, f"SELECT {source_keys}, UNNEST(src.{column}) FROM {table} src WHERE src.{column} IS NOT NULL;"]
    elif dialect in ("postgres", "postgresql"):
        lines += [insert,
                  f"SELECT {source_keys}, v.value FROM {table} src, jsonb_array_elements_text(src.{column}::jsonb) AS v(value)",
                  f"WHERE jsonb_typeof(src.{column}::jsonb) = 'array';"]
    elif dialect in ("mysql", "mariadb") and base == "JSON":
        lines += [insert,
                  f"SELECT {source_keys}, j.v FROM {table} src,",
                  f"     JSON_TABLE(src.{column}, '$[*]' COLUMNS (v VARCHAR(255) PATH '$')) j;"]
    elif dialect in ("mysql", "mariadb"):          # SET: comma separated values
        lines += [insert,
                  f"WITH RECURSIVE parts ({keys}, v, rest) AS (",
                  f"    SELECT {keys}, SUBSTRING_INDEX({column}, ',', 1),",
                  f"           IF(LOCATE(',', {column}) > 0, SUBSTRING({column}, LOCATE(',', {column}) + 1), NULL)",
                  f"    FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''",
                  "    UNION ALL",
                  f"    SELECT {keys}, SUBSTRING_INDEX(rest, ',', 1),",
                  "           IF(LOCATE(',', rest) > 0, SUBSTRING(rest, LOCATE(',', rest) + 1), NULL)",
                  "    FROM parts WHERE rest IS NOT NULL",
                  ")",
                  f"SELECT {keys}, v FROM parts;"]
    else:
        lines.append(f"-- TODO: fill {child} with one row per value of {table}.{column} "
                     f"(no generic SQL for {base} in {dialect}).")
    lines.append(f"-- ALTER TABLE {table} DROP COLUMN {column};   -- after checking the result")
    return lines


def _redundant_copy(S, links, table, column, normal_form):
    """2NF / 3NF: the column is a copy of a column of a referenced table."""
    key = A.normalizza(column)
    link = next((l for l in links if l["table"] == table and l["target"] != table
                 and key in S.colonne_norm.get(l["target"], {})), None)
    kind = "partial dependency" if normal_form == "2NF" else "transitive dependency"
    if link is None:
        return [f"-- {normal_form}  {table}.{column}: {kind}",
                f"-- TODO: no usable foreign key found from {table}: find the table that owns {column}."]
    target = link["target"]
    target_column = S.colonne_norm[target][key]
    pairs = list(zip(link["columns"], link["target_columns"]))
    join = " AND ".join(f"src.{a} = ref.{b}" for a, b in pairs)
    correlated = " AND ".join(f"src.{a} = {target}.{b}" for a, b in pairs)
    row_key = S.pk.get(table) or link["columns"]
    return [
        f"-- {normal_form}  {table}.{column}: {kind} through {table}({', '.join(link['columns'])}) -> {target}.{target_column}",
        f"-- Step 1: rows where the copy in {table} disagrees with {target} (fix them before dropping the column)",
        f"SELECT {', '.join('src.' + k for k in row_key)}, src.{column} AS source_value, ref.{target_column} AS target_value",
        f"FROM {table} src JOIN {target} ref ON {join}",
        f"WHERE src.{column} <> ref.{target_column}"
        f" OR (src.{column} IS NULL AND ref.{target_column} IS NOT NULL)"
        f" OR (src.{column} IS NOT NULL AND ref.{target_column} IS NULL);",
        f"-- Step 2: fill {target}.{target_column} where it is still empty, using the values stored in {table}",
        f"UPDATE {target} SET {target_column} = (",
        f"    SELECT MAX(src.{column}) FROM {table} src WHERE {correlated}",
        f") WHERE {target_column} IS NULL;",
        f"-- Step 3: read {column} through a JOIN with {target}, then drop the copy",
        f"-- ALTER TABLE {table} DROP COLUMN {column};",
    ]


def generate_migration_script(R, dialect="mysql"):
    """Draft SQL script that fixes the normalization problems found by the core engine
    (R.qualita.normalizzazione): composite fields, multi-valued columns and repeating groups (1NF),
    partial (2NF) and transitive (3NF) dependencies. Destructive steps (DROP COLUMN) are commented out."""
    S = R.S
    diagnostics = R.qualita.normalizzazione
    links = _fk_links(R)
    lines = [
        "-- ETL migration draft generated by sql-fk-finder",
        f"-- Dialect: {dialect}. Review every statement and run it on a copy of the database first.",
        "-- DROP COLUMN statements are commented out: run them only after checking the migrated data.",
        "",
    ]
    if diagnostics.empty:
        return "\n".join(lines + ["-- No normalization problems found."]) + "\n"
    order = {"1NF": 0, "2NF": 1, "3NF": 2}
    for row in sorted(diagnostics.to_dict("records"), key=lambda r: (order.get(r["forma normale"], 9), r["tabella"])):
        table, normal_form = row["tabella"], row["forma normale"]
        columns = [c.strip() for c in str(row["colonna"]).split(",")]
        if normal_form == "1NF" and len(columns) > 1:
            block = _repeating_group(S, table, columns, dialect)
        elif normal_form == "1NF" and A.tipo_base(S.tipi.get((table, columns[0]))) in A.TIPI_NON_ATOMICI:
            block = _multivalued(S, table, columns[0], dialect)
        elif normal_form == "1NF":
            block = _composite_field(S, table, columns[0], dialect)
        else:
            block = _redundant_copy(S, links, table, columns[0], normal_form)
        lines += block + [""]
    return "\n".join(lines)


# ====================================================================== 4. AST CRUD analyzer

CRUD_COLUMNS = ["object", "object type", "table", "operation", "statement", "in schema", "method", "file", "line"]
NAME = r"(?:`[^`]+`|\"[^\"]+\"|\[[^\]]+\]|[\w$#@]+)(?:\s*\.\s*(?:`[^`]+`|\"[^\"]+\"|\[[^\]]+\]|[\w$#@]+))*"
RE_OBJECT = re.compile(
    r"\b(?:CREATE(?:\s+OR\s+(?:REPLACE|ALTER))?|ALTER)\s+"
    r"(?:(?:ALGORITHM\s*=\s*\w+|DEFINER\s*=\s*\S+|SQL\s+SECURITY\s+\w+|TEMP(?:ORARY)?"
    r"|MATERIALIZED|RECURSIVE|NO\s+FORCE|FORCE|EDITIONABLE|NONEDITIONABLE|CONSTRAINT)\s+)*"
    rf"(?P<kind>VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>{NAME})", re.I)
RE_DELIMITER = re.compile(r"^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*$", re.I | re.M)
RE_BEGIN = re.compile(r"\bBEGIN\b(?!\s+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED)\b)", re.I)
RE_BLOCK_WORD = re.compile(r"\b(?:BEGIN(?!\s+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED)\b)|CASE|END)\b"
                           r"(?:\s+(?:IF|LOOP|WHILE|REPEAT|FOR|CASE)\b)?", re.I)
RE_DOLLAR = re.compile(r"\$(?:[A-Za-z_]\w*)?\$")
RE_TRIGGER_BODY = re.compile(r"\bFOR\s+EACH\s+(?:ROW|STATEMENT)\b|\bAS\b", re.I)
RE_GO = re.compile(r"^[ \t]*GO[ \t]*$", re.I | re.M)
RE_SLASH = re.compile(r"^[ \t]*/[ \t]*$", re.M)
RE_STATEMENT_START = re.compile(r"\b(?:WITH|SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE)\b", re.I)
# keywords before INSERT/UPDATE/DELETE that do not start a statement (FOR UPDATE, ON DELETE, AFTER INSERT ...)
RE_NOT_A_START = re.compile(r"\b(?:FOR|KEY|DO|ON|OF|AFTER|BEFORE|OR)\s*$", re.I)
MAX_PARSE_ATTEMPTS = 6
# regular-expression fallback for SQL that sqlglot cannot parse: (pattern, operation, statement)
FALLBACK = [
    (re.compile(rf"\bINSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?(?P<name>{NAME})", re.I), "CREATE", "INSERT"),
    (re.compile(rf"\bREPLACE\s+INTO\s+(?P<name>{NAME})", re.I), "CREATE", "REPLACE"),
    (re.compile(rf"\bUPDATE\s+(?P<name>{NAME})(?:\s+(?:AS\s+)?\w+)?\s+SET\b", re.I), "UPDATE", "UPDATE"),
    (re.compile(rf"\bDELETE\s+(?:FROM\s+)?(?P<name>{NAME})", re.I), "DELETE", "DELETE"),
    (re.compile(rf"\bTRUNCATE\s+(?:TABLE\s+)?(?P<name>{NAME})", re.I), "DELETE", "TRUNCATE"),
    (re.compile(rf"\bMERGE\s+(?:INTO\s+)?(?P<name>{NAME})", re.I), "UPDATE", "MERGE"),
]
RE_READ = re.compile(rf"\b(?:FROM|JOIN)\s+(?P<name>{NAME})", re.I)
NOT_TABLES = {"select", "dual", "lateral", "unnest", "table", "only", "from", "where", "set", "values"}


def _blank(text):
    return re.sub(r"[^\n]", " ", text)


def _clean_and_mask(text, dialect):
    """(clean, masked): clean has the comments and DELIMITER lines replaced by spaces; masked also has the
    content of string literals replaced by spaces. Both keep the positions of the original text."""
    string = r"'(?:[^'\\]|\\.|'')*'" if dialect in ("mysql", "mariadb") else r"'(?:[^']|'')*'"
    comments = r"--[^\n]*|/\*.*?\*/" + (r"|#[^\n]*" if dialect in ("mysql", "mariadb") else "")
    clean, masked, pos = [], [], 0
    for match in re.finditer(f"{string}|{comments}", text, re.S):
        before = text[pos:match.start()]
        token = match.group()
        if token.startswith("'"):
            clean += [before, token]
            masked += [before, "'" + _blank(token[1:-1]) + "'"]
        else:
            clean += [before, _blank(token)]
            masked += [before, _blank(token)]
        pos = match.end()
    clean, masked = "".join(clean) + text[pos:], "".join(masked) + text[pos:]
    # MySQL client directive: DELIMITER $$ ... END$$ DELIMITER ;
    for match in RE_DELIMITER.finditer(masked):
        clean = clean[:match.start()] + _blank(match.group()) + clean[match.end():]
    return clean, RE_DELIMITER.sub(lambda m: _blank(m.group()), masked)


def _terminators(text, dialect):
    """Regular expression of the statement terminators: ";", custom MySQL delimiters, GO, "/"."""
    custom = {d for d in RE_DELIMITER.findall(text) if d != ";"}
    parts = [";"] + [re.escape(d) for d in sorted(custom, key=len, reverse=True)]
    if dialect == "tsql":
        parts.append(RE_GO.pattern)
    if dialect == "oracle":
        parts.append(RE_SLASH.pattern)
    return re.compile("|".join(parts), re.I | re.M)


def _block_end(masked, begin):
    """Position just after the END that closes the BEGIN at position begin (None if it is never closed).
    CASE ... END and END CASE are counted; END IF, END LOOP, END WHILE ... close blocks not counted."""
    depth = 0
    for match in RE_BLOCK_WORD.finditer(masked, begin):
        words = match.group().upper().split()
        if words[0] in ("BEGIN", "CASE"):
            depth += 1
        elif len(words) == 1 or words[1] == "CASE":
            depth -= 1
            if depth == 0:
                return match.end()
    return None


def _objects(text, clean, masked, dialect):
    """Views and routines of the text: [(object type, name, header position, body start, body end)]."""
    terminator = _terminators(text, dialect)
    headers = list(RE_OBJECT.finditer(masked))
    objects = []
    for i, header in enumerate(headers):
        kind = {"PROC": "PROCEDURE"}.get(header.group("kind").upper(), header.group("kind").upper())
        name = A.nome_qualificato(clean[header.start("name"):header.end("name")])
        start = header.end()
        limit = headers[i + 1].start() if i + 1 < len(headers) else len(masked)
        end_match = terminator.search(masked, start, limit)
        statement_end = end_match.start() if end_match else limit
        if kind == "VIEW":
            objects.append((kind, name, header.start(), start, statement_end))
            continue
        # the routine body is $$ ... $$, BEGIN ... END, or a single statement
        search_end = limit if dialect == "oracle" else statement_end     # Oracle declares variables before BEGIN
        dollar = RE_DOLLAR.search(masked, start, search_end)
        begin = RE_BEGIN.search(masked, start, search_end)
        if dollar and (not begin or dollar.start() < begin.start()):
            closing = masked.find(dollar.group(), dollar.end())
            objects.append((kind, name, header.start(), dollar.end(), closing if closing >= 0 else limit))
        elif begin:
            objects.append((kind, name, header.start(), begin.start(), _block_end(masked, begin.start()) or limit))
        else:
            body = start
            if kind == "TRIGGER":            # skip the event (AFTER INSERT ON t): it is not done by the trigger
                event_end = RE_TRIGGER_BODY.search(masked, start, limit)
                body = event_end.end() if event_end else start
            if dialect in ("tsql", "oracle"):
                end_match = (RE_GO if dialect == "tsql" else RE_SLASH).search(masked, body, limit)
            else:
                end_match = terminator.search(masked, body, limit)
            objects.append((kind, name, header.start(), body, end_match.start() if end_match else limit))
    return objects


def _balanced_end(masked, start, end):
    """Where masked[start:end] must be cut so that it does not close a parenthesis opened before start."""
    depth = 0
    for i in range(start, end):
        if masked[i] == "(":
            depth += 1
        elif masked[i] == ")":
            depth -= 1
            if depth < 0:
                return i
    return end


def _table_name(table):
    parts = [table.args[k].name for k in ("catalog", "db") if table.args.get(k)] + [table.name]
    return A.nome_qualificato(".".join(parts))


def _ast_operations(table):
    """[(operation, statement)] done on a Table node, found from its parent nodes ([] for DDL)."""
    child, node = table, table.parent
    while node is not None:
        target = child.arg_key == "this"
        if isinstance(node, exp.Insert):
            if not target:
                return [("READ", "SELECT")]
            return [("CREATE", "INSERT")] + ([("UPDATE", "INSERT")] if node.args.get("conflict") else [])
        if isinstance(node, exp.Update):
            return [("UPDATE", "UPDATE")] if target else [("READ", "SELECT")]
        if isinstance(node, exp.Delete):
            return [("DELETE", "DELETE")] if target or child.arg_key == "tables" else [("READ", "SELECT")]
        if isinstance(node, exp.Merge):
            return [("CREATE", "MERGE"), ("UPDATE", "MERGE")] if target else [("READ", "SELECT")]
        if type(node).__name__ == "TruncateTable":
            return [("DELETE", "TRUNCATE")]
        if isinstance(node, (exp.Select, exp.Union, exp.Intersect, exp.Except)):
            return [("READ", "SELECT")]
        if isinstance(node, (exp.Create, exp.Drop, exp.Alter, exp.Command)):
            return []
        child, node = node, node.parent
    return [("READ", "SELECT")]


def _parse(sql, dialect):
    """Statements parsed by sqlglot.parse, or None if sqlglot does not understand the text as plain SQL."""
    if sqlglot is None or not sql.strip():
        return None
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except Exception:
        return None
    if not statements or any(isinstance(s, exp.Command) for s in statements):
        return None
    return statements


def _ast_tables(statements):
    """[(table, operation, statement, "ast")] of parsed statements (CTE names are not tables)."""
    found = []
    for statement in statements:
        ctes = {c.alias_or_name.lower() for c in statement.find_all(exp.CTE)}
        # T-SQL style UPDATE x SET ... FROM dbo.items x: the target is written with the alias of a FROM table
        aliases = {t.alias.lower(): _table_name(t) for t in statement.find_all(exp.Table) if t.alias}
        for table in statement.find_all(exp.Table):
            name = _table_name(table)
            if not table.name or name.startswith("@") or (name.lower() in ctes and not table.args.get("db")):
                continue
            if not table.alias and not table.args.get("db") and name.lower() in aliases:
                name = aliases[name.lower()]
            if isinstance(table.parent, exp.Into):
                # SELECT ... INTO x: a new table (T-SQL), or a variable in a routine body (dropped by analyze_crud)
                found.append((name, "CREATE", "SELECT INTO", "ast"))
                continue
            found += [(name, operation, verb, "ast") for operation, verb in _ast_operations(table)]
    return found


def _regex_tables(clean, masked, start, end):
    """[(table, operation, statement, "regex")] found with regular expressions in clean[start:end]."""
    found, writes = [], []
    for pattern, operation, verb in FALLBACK:
        for match in pattern.finditer(masked, start, end):
            writes.append((match.start(), match.end()))
            found.append((A.nome_qualificato(clean[match.start("name"):match.end("name")]), operation, verb, "regex"))
    for match in RE_READ.finditer(masked, start, end):
        if not any(a <= match.start() < b for a, b in writes):      # the FROM of DELETE FROM is not a read
            found.append((A.nome_qualificato(clean[match.start("name"):match.end("name")]), "READ", "SELECT", "regex"))
    return [f for f in found if f[0] and f[0].lower() not in NOT_TABLES and not f[0].startswith("@")
            and not f[0][0].isdigit()]


def _statement_tables(clean, masked, start, end, dialect):
    """Tables used by one statement of a body (clean[start:end]), with their operations.

    Each WITH/SELECT/INSERT/UPDATE/DELETE/MERGE keyword is a possible start of plain SQL: the longest text
    from there that sqlglot can parse is analyzed on the AST; what it cannot parse (procedural code around
    the SQL, vendor syntax) is scanned with regular expressions."""
    starts = [m.start() for m in RE_STATEMENT_START.finditer(masked, start, end)
              if not RE_NOT_A_START.search(masked[max(start, m.start() - 12):m.start()])]
    found, covered = [], start
    for i, position in enumerate(starts):
        if position < covered:
            continue
        later = starts[i + 1:]
        ends = [end] + list(reversed(later))[:MAX_PARSE_ATTEMPTS - 1]
        for candidate_end in ends:
            candidate_end = _balanced_end(masked, position, candidate_end)
            statements = _parse(clean[position:candidate_end], dialect)
            if statements:
                found += _ast_tables(statements)
                covered = candidate_end
                break
        else:
            covered = later[0] if later else end
            found += _regex_tables(clean, masked, position, _balanced_end(masked, position, covered))
    return found


def analyze_crud(sql_text, dialect="mysql", known_tables=None, file_name="", line_map=None):
    """CRUD matrix of the views, stored procedures, functions and triggers in a SQL text.

    Returns a deduplicated DataFrame (CRUD_COLUMNS) with one row per business object, target table and
    operation (CREATE / READ / UPDATE / DELETE), the SQL statement doing it, and whether it was found on
    the sqlglot AST or by the regular-expression fallback. With known_tables (the schema tables) names are
    matched to the schema, and tables found only by the fallback and unknown to the schema are dropped.
    line_map is the line map of a reduced text (lettura.TestoSql of a large file)."""
    sqlglot_dialect = QY.DIALETTI_SQLGLOT.get(dialect, dialect)
    text = str(sql_text)
    clean, masked = _clean_and_mask(text, dialect)
    line_of = A.Righe(masked, line_map)
    schema_tables = {}
    for table in known_tables or []:
        schema_tables.setdefault(table.lower(), table)
        schema_tables.setdefault(table.split(".")[-1].lower(), table)
    rows = []
    for kind, name, header, start, end in _objects(text, clean, masked, dialect):
        bounds = [start] + [m.end() for m in re.compile(";").finditer(masked, start, end)] + [end]
        for a, b in zip(bounds, bounds[1:]):
            for table, operation, verb, method in _statement_tables(clean, masked, a, b, sqlglot_dialect):
                actual = schema_tables.get(table.lower()) or schema_tables.get(table.split(".")[-1].lower())
                if known_tables is not None and not actual and (method == "regex" or verb == "SELECT INTO"):
                    continue
                rows.append({"object": name, "object type": kind, "table": actual or table,
                             "operation": operation, "statement": verb, "in schema": bool(actual),
                             "method": method, "file": file_name, "line": line_of(header)})
    df = pd.DataFrame(rows, columns=CRUD_COLUMNS)
    if df.empty:
        return df
    df = df.sort_values(["method", "line"], kind="stable")          # "ast" before "regex"
    df = df.drop_duplicates(["file", "object", "object type", "table", "operation", "statement"])
    return df.sort_values(["file", "line", "object", "table", "operation"]).reset_index(drop=True)


def analyze_crud_files(file_sql, dialect="mysql", known_tables=None):
    """analyze_crud on every loaded file [(name, text)], with the line numbers of the original files."""
    parts = [analyze_crud(text, dialect, known_tables, name, getattr(text, "mappa", None))
             for name, text in file_sql]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame(columns=CRUD_COLUMNS)
    return pd.concat(parts, ignore_index=True)


def crud_matrix(df):
    """Pivot of analyze_crud: one row per object and table, with columns C, R, U, D marked "X"."""
    columns = ["object type", "object", "table", "C", "R", "U", "D"]
    if df.empty:
        return pd.DataFrame(columns=columns)
    letters = df.assign(op=df["operation"].str[0])
    matrix = pd.crosstab([letters["object type"], letters["object"], letters["table"]], letters["op"])
    matrix = matrix.reindex(columns=["C", "R", "U", "D"], fill_value=0) > 0
    matrix = matrix.replace({True: "X", False: ""}).reset_index()[columns]
    matrix.columns.name = None
    return matrix


# ====================================================================== 5. Foreign keys checked against the data

INCLUSION_COLUMNS = ["table", "column", "→ table", "→ column", "source", "child rows", "values", "orphans",
                     "distinct values", "orphan values", "match %", "verdict", "orphan examples"]
CONFIRMED, ALMOST, DOUBTFUL, WRONG, NO_DATA = "confirmed", "orphans", "doubtful", "probably wrong", "no data"
VALUE_LINK_COLUMNS = ["table", "column", "→ table", "→ column", "type", "distinct values", "parent values",
                      "coverage %", "same name root", "strength"]
MIN_VALUE_LINK_DISTINCT = 10      # fewer distinct values fit any key by chance
MAX_DISTINCT_LOADED = 200_000     # columns with more distinct values are not compared in memory


def _candidate_links(R, medium=True):
    """Every link worth checking: declared foreign keys and candidates (high and, if medium, medium reliability).
    [{table, columns, target, target_columns, source}] without duplicates."""
    S = R.S
    links, seen = [], set()

    def add(row, source):
        table, target = row["tabella"], row["→ tabella"]
        columns = [c.strip() for c in str(row["colonna"]).split(",")]
        target_columns = [c.strip() for c in str(row["→ colonna"]).split(",")]
        key = (table, tuple(columns), target, tuple(target_columns))
        if (key in seen or table not in S.col_per_tab or target not in S.col_per_tab
                or len(columns) != len(target_columns) or "?" in target_columns
                or not set(columns) <= set(S.col_per_tab[table])
                or not set(target_columns) <= set(S.col_per_tab[target])):
            return
        seen.add(key)
        links.append({"table": table, "columns": columns, "target": target, "target_columns": target_columns,
                      "source": source})

    if R.fk_dichiarate is not None:
        for row in R.fk_dichiarate.to_dict("records"):
            add(row, "declared")
    levels = ["alta", "media"] if medium else ["alta"]
    for row in R.fk[R.fk["affidabilità"].isin(levels)].to_dict("records"):
        add(row, "declared" if row["già dichiarata"] else f"candidate ({row['affidabilità']})")
    return links


def _verdict(values, orphans):
    if values == 0:
        return NO_DATA
    share = 1 - orphans / values
    if orphans == 0:
        return CONFIRMED
    if share >= 0.95:
        return ALMOST
    if share >= 0.5:
        return DOUBTFUL
    return WRONG


def check_inclusion(db, R, medium=True, examples=5, progress=None):
    """For every declared or candidate foreign key A.x -> B.y: how many non-NULL values of A.x exist in B.y
    and how many do not (orphans), counted on the rows and on the distinct values, with a verdict:
    confirmed (no orphans), orphans (at least 95% found), doubtful (at least half), probably wrong, no data.
    Composite keys are checked on all their columns together. Read-only queries on the query database."""
    rows = []
    links = _candidate_links(R, medium)
    for done, link in enumerate(links):
        if progress:
            progress(done, len(links), f"{link['table']} -> {link['target']}")
        child, parent = db.tabella_di(link["table"]), db.tabella_di(link["target"])
        if not child or not parent:
            continue
        a = [f"a.{QY.q(c)}" for c in link["columns"]]
        b = [f"b.{QY.q(c)}" for c in link["target_columns"]]
        filled = " AND ".join(f"{c} IS NOT NULL" for c in a)
        def missing(alias="a"):              # the child value has no parent row
            pairs = " AND ".join(f"{y} = {alias}.{QY.q(x)}" for x, y in zip(link["columns"], b))
            return f"NOT EXISTS (SELECT 1 FROM {QY.q(parent)} b WHERE {pairs})"
        c = db.conn
        total = c.execute(f"SELECT COUNT(*) FROM {QY.q(child)}").fetchone()[0]
        values, orphans = c.execute(
            f"SELECT COUNT(*), COALESCE(SUM({missing()}), 0) FROM {QY.q(child)} a WHERE {filled}").fetchone()
        distinct, orphan_distinct = c.execute(
            f"SELECT COUNT(*), COALESCE(SUM({missing('d')}), 0) FROM "
            f"(SELECT DISTINCT {', '.join(a)} FROM {QY.q(child)} a WHERE {filled}) d").fetchone() if values else (0, 0)
        sample = []
        if orphans:
            sample = [r[0] if len(r) == 1 else "(" + ", ".join(map(str, r)) + ")" for r in c.execute(
                f"SELECT DISTINCT {', '.join(a)} FROM {QY.q(child)} a WHERE {filled} AND {missing()} LIMIT {int(examples)}")]
        rows.append({"table": link["table"], "column": ", ".join(link["columns"]), "→ table": link["target"],
                     "→ column": ", ".join(link["target_columns"]), "source": link["source"], "child rows": total,
                     "values": values, "orphans": orphans, "distinct values": distinct, "orphan values": orphan_distinct,
                     "match %": round(100 * (1 - orphans / values), 1) if values else None,
                     "verdict": _verdict(values, orphans), "orphan examples": ", ".join(map(str, sample))})
    order = {CONFIRMED: 0, ALMOST: 1, DOUBTFUL: 2, WRONG: 3, NO_DATA: 4}
    df = pd.DataFrame(rows, columns=INCLUSION_COLUMNS)
    return df.sort_values(["verdict", "table", "column"], key=lambda s: s.map(order) if s.name == "verdict" else s,
                          kind="stable").reset_index(drop=True)


def _family(sql_type):
    base = A.tipo_base(sql_type)
    if base in A.FAMIGLIE_TIPI["intero"]:
        return "integer"
    if base in A.FAMIGLIE_TIPI["testo"] or base in ("UUID", "UNIQUEIDENTIFIER"):
        return "text"
    return None


def _distinct_values(db, table, column, limit=MAX_DISTINCT_LOADED):
    """Set of the distinct non-NULL values of a column, or None if there are more than limit."""
    values = [r[0] for r in db.conn.execute(
        f"SELECT DISTINCT {QY.q(column)} FROM {QY.q(table)} WHERE {QY.q(column)} IS NOT NULL LIMIT {limit + 1}")]
    return None if len(values) > limit else set(values)


def find_value_links(db, R, min_distinct=MIN_VALUE_LINK_DISTINCT, progress=None):
    """Links that the names do not reveal: a column whose distinct values all exist in the single-column
    primary key (or UNIQUE column) of another table, with the same type family (integers or text).

    Columns already linked (declared or candidate foreign keys) and single-column primary keys are skipped:
    two counters 1, 2, 3 ... always fit each other. strength: "strong" with many distinct values that are not
    a short run of small integers, for the key the column covers best; "weak" otherwise (could be a coincidence)."""
    S = R.S
    linked = {(l["table"], c) for l in _candidate_links(R) for c in l["columns"]}
    parents = {}                                   # (table, column) -> set of values
    for table, columns in S.col_per_tab.items():
        keys = [S.pk[table]] if len(S.pk.get(table, [])) == 1 else []
        keys += [[c] for c in columns if (table, c) in S.unique and [c] != S.pk.get(table)]
        for (column,) in keys:
            actual = db.tabella_di(table)
            if actual and _family(S.tipi.get((table, column))):
                values = _distinct_values(db, actual, column)
                if values and len(values) >= min_distinct:
                    parents[(table, column)] = values
    rows = []
    for done, (table, columns) in enumerate(S.col_per_tab.items()):
        if progress:
            progress(done, len(S.col_per_tab), table)
        actual = db.tabella_di(table)
        if not actual:
            continue
        own_key = S.pk.get(table) if len(S.pk.get(table, [])) == 1 else []
        for column in columns:
            family = _family(S.tipi.get((table, column)))
            if not family or (table, column) in linked or [column] == own_key:
                continue
            candidates = [(t, c) for (t, c) in parents if t != table and _family(S.tipi.get((t, c))) == family]
            if not candidates:
                continue
            values = _distinct_values(db, actual, column)
            if not values or len(values) < min_distinct:
                continue
            for target, target_column in candidates:
                parent_values = parents[(target, target_column)]
                if not values <= parent_values:
                    continue
                small_run = family == "integer" and all(isinstance(v, int) for v in values) and max(values) <= 2 * len(values) + 10
                strong = len(values) >= 10 and not small_run
                rows.append({"table": table, "column": column, "→ table": target, "→ column": target_column,
                             "type": family, "distinct values": len(values), "parent values": len(parent_values),
                             "coverage %": round(100 * len(values) / len(parent_values), 1),
                             "same name root": A.radice(column) == A.radice(target_column)
                                               or A.radice(target) in A.radice(column),
                             "strength": "strong" if strong else "weak"})
    df = pd.DataFrame(rows, columns=VALUE_LINK_COLUMNS)
    if df.empty:
        return df
    # a column that fits several keys: only the key it covers best can be strong (5001..5300 also fit 1..200000)
    best = df.groupby(["table", "column"])["coverage %"].transform("max")
    df.loc[df["coverage %"] < best, "strength"] = "weak"
    return df.sort_values(["strength", "table", "column", "coverage %"], ascending=[True, True, True, False]).reset_index(drop=True)
