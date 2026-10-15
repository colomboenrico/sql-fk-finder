-- Chiavi primarie composte (su più colonne)
CREATE TABLE ordini_righe (
  id_ordine int NOT NULL,
  num_riga int NOT NULL,
  articolo_id int,
  qta decimal(10,2),
  PRIMARY KEY (id_ordine, num_riga)
);
CREATE TABLE spedizioni_righe (
  id_spedizione int NOT NULL PRIMARY KEY,
  id_ordine int,
  num_riga int,
  qta_spedita decimal(10,2)
);
