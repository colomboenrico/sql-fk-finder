-- Esempi per i controlli di progettazione (integrità, relazioni, normalizzazione, ridondanze)

-- 1:1: ogni cittadino ha una sola tessera sanitaria (id_cittadino è UNIQUE)
CREATE TABLE cittadini (id_cittadino int NOT NULL PRIMARY KEY, cognome varchar(40), nome varchar(40));
CREATE TABLE tessere_sanitarie (
  id_tessera int NOT NULL PRIMARY KEY,
  id_cittadino int NOT NULL UNIQUE,
  scadenza date
);

-- 3NF: ragione_sociale della fattura dipende dal cliente, non dalla fattura
-- 1NF: telefono1/telefono2 sono un gruppo ripetuto, generalita è un campo composto
CREATE TABLE clienti (
  id_cliente int NOT NULL PRIMARY KEY,
  ragione_sociale varchar(80) NOT NULL,
  generalita varchar(120),
  telefono1 varchar(20),
  telefono2 varchar(20)
);
CREATE TABLE fatture (
  numero int NOT NULL PRIMARY KEY,
  data date NOT NULL,
  id_cliente int NOT NULL,
  ragione_sociale varchar(80),
  importo decimal(10,2)
);

-- 2NF: citta dipende solo dal fornitore, cioè da una parte della chiave (id_fornitore, id_articolo)
CREATE TABLE fornitori (id_fornitore int NOT NULL PRIMARY KEY, citta varchar(40));
CREATE TABLE forniture (
  id_fornitore int NOT NULL,
  id_articolo int NOT NULL,
  citta varchar(40),
  qta int,
  PRIMARY KEY (id_fornitore, id_articolo)
);

-- Relazione ridondante: comuni -> regioni c'è già passando da province
CREATE TABLE regioni (id_regione int NOT NULL PRIMARY KEY, regione varchar(40));
CREATE TABLE province (id_provincia int NOT NULL PRIMARY KEY, id_regione int NOT NULL, provincia varchar(40));
CREATE TABLE comuni (id_comune int NOT NULL PRIMARY KEY, id_provincia int NOT NULL, id_regione int, comune varchar(60));

-- Integrità dell'entità: tabella senza chiave primaria
CREATE TABLE log_accessi (utente varchar(40), istante datetime);
