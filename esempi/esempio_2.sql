CREATE TABLE IF NOT EXISTS `ordini` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `CODANAG` int(11),
  `articolo_id` int,
  `CodArticolo` bigint,
  `id_magazzino` int,
  KEY `idx` (`CODANAG`)
) ENGINE=InnoDB PARTITION BY HASH(id) PARTITIONS 4;
CREATE TABLE categorie (CODCAT int primary key, nome varchar(20));
CREATE TABLE righe (riga int, CODANAG int, id_ordine int);
