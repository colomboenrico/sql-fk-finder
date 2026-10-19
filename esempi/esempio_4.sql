-- Chiave primaria composta su tre colonne (codice, id, nome)
CREATE TABLE codici (codice varchar(10) PRIMARY KEY, descrizione varchar(50));
CREATE TABLE listini (
  codice varchar(10) NOT NULL,
  id int NOT NULL,
  nome varchar(30) NOT NULL,
  prezzo decimal(10,2),
  PRIMARY KEY (codice, id, nome)
);

-- Entità "piatto": si può togliere dall'analisi scrivendo "piatto"
CREATE TABLE piatti (id_piatto int PRIMARY KEY, nome varchar(50));
CREATE TABLE piatto_ingredienti (
  id_piatto int NOT NULL,
  id_ingrediente int NOT NULL,
  grammi int,
  PRIMARY KEY (id_piatto, id_ingrediente)
);
CREATE TABLE ingredienti (id_ingrediente int PRIMARY KEY, nome varchar(50));

-- Una chiave esterna già dichiarata: compare nello schema iniziale
ALTER TABLE piatto_ingredienti ADD CONSTRAINT fk_piatto_ingredienti_piatti
  FOREIGN KEY (id_piatto) REFERENCES piatti (id_piatto);
