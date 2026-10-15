/*!40101 SET NAMES utf8 */;
-- dump
CREATE TABLE `anagrafica` (
  `CODANAG` int(11) NOT NULL AUTO_INCREMENT,
  `RAGSOC` varchar(100) DEFAULT NULL COMMENT 'ragione, sociale',
  `descrizione` varchar(50),
  PRIMARY KEY (`CODANAG`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC COMMENT='anag';
CREATE TABLE `articoli` (
  `id_articolo` int NOT NULL,
  `descrizione` varchar(50),
  `COD_CAT` int,
  PRIMARY KEY (`id_articolo`)
) ENGINE=InnoDB;
