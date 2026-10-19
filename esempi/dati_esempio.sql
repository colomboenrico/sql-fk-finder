-- Dati di prova per la pagina Query: solo INSERT, nessun CREATE TABLE (l'analisi delle chiavi non cambia).
INSERT INTO regioni (id_regione, regione) VALUES (1, 'Piemonte'), (2, 'Lombardia'), (3, 'Valle d\'Aosta');
INSERT INTO province VALUES (1, 1, 'Torino'), (2, 1, 'Cuneo'), (3, 2, 'Milano'), (4, 3, 'Aosta');
INSERT INTO comuni (id_comune, id_provincia, id_regione, comune) VALUES
  (1, 1, 1, 'Torino'), (2, 1, 1, 'Moncalieri'), (3, 2, 1, 'Alba'), (4, 3, 2, 'Milano'), (5, 4, 3, 'Aosta');
INSERT INTO `categorie` VALUES (10, 'Bevande'), (20, 'Dolci');
INSERT INTO piatti VALUES (1, 'Tiramisù'), (2, 'Bagna cauda');
INSERT INTO ingredienti VALUES (1, 'Mascarpone'), (2, 'Caffè'), (3, 'Aglio'), (4, 'Acciughe');
INSERT INTO piatto_ingredienti VALUES (1, 1, 250), (1, 2, 50), (2, 3, 100), (2, 4, 80);
INSERT INTO fornitori VALUES (1, 'Torino'), (2, 'Alba');
