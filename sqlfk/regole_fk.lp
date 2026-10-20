% Scelta delle chiavi esterne con clingo (Answer Set Programming).
%
% Fatti preparati da sqlfk/asp.py (i numeri sono gli identificativi delle tabelle e delle candidate):
%   candidata(I)        una chiave esterna possibile (dichiarata, trovata dall'analisi o vista nell'interfaccia)
%   da(I,T)  a(I,P)     tabella figlia T e tabella padre P
%   chiave(I,K)         K identifica le colonne della figlia: candidate con la stessa K usano le stesse colonne
%   dichiarata(I)       già FOREIGN KEY nei file
%   alta(I)  media(I)   affidabilità data dall'analisi
%   tipi_diversi(I)     i tipi delle colonne non sono compatibili
%   confermata(I)       l'interfaccia del programma la mostra con un indizio forte
%   debole(I)           l'interfaccia la mostra solo con un indizio debole
%   da_interfaccia(I)   vista solo nell'interfaccia (l'analisi non l'aveva trovata)
%   ponte(I)            fa parte della chiave composta di una tabella ponte (relazione N:M)
%   scorciatoia(I)      X -> Z quando tra le candidate ci sono anche X -> Y e Y -> Z (forse ridondante)
%   stessa_chiave(I)    figlia e padre hanno la stessa chiave primaria: tabelle "sorelle", direzione incerta
%   centrale(T)         tabella puntata da moltissime altre (dall'analisi delle aree)

% ---- le scelte
scelta(I) :- candidata(I), dichiarata(I).                  % le chiavi dichiarate restano
{ scelta(I) } :- candidata(I), not dichiarata(I).

% ---- vincoli
% le stesse colonne puntano a una sola tabella
:- scelta(I), scelta(J), I < J, chiave(I,K), chiave(J,K).
% una tabella non punta a se stessa se non è dichiarato (una gerarchia vera è dichiarata o confermata)
:- scelta(I), da(I,T), a(I,T), not dichiarata(I), not confermata(I).

% due tabelle non si puntano a vicenda (a meno che sia dichiarato o confermato)
:- scelta(I), scelta(J), I != J, da(I,X), a(I,Y), da(J,Y), a(J,X), X != Y,
   not dichiarata(I), not confermata(I), not dichiarata(J), not confermata(J).

% ---- relazioni ridondanti: X -> Z quando c'è già X -> Y -> Z
ridondante(I) :- scelta(I), not dichiarata(I), not confermata(I), da(I,X), a(I,Z),
                 scelta(J), J != I, da(J,X), a(J,Y), Y != Z, Y != X,
                 scelta(L), da(L,Y), a(L,Z).

% ---- preferenze (si massimizza la somma dei pesi)
#maximize {
    6,I : scelta(I), confermata(I) ;       % il programma la usa davvero
    % una scorciatoia vale meno di un percorso: se c'è ridondanza si toglie lei, non un pezzo del percorso
    3,I : scelta(I), alta(I), not scorciatoia(I), not stessa_chiave(I) ;
    2,I : scelta(I), alta(I), scorciatoia(I), not stessa_chiave(I) ;
   -1,I : scelta(I), stessa_chiave(I), not confermata(I), not dichiarata(I) ;   % direzione incerta: solo se confermata
    1,I : scelta(I), a(I,P), centrale(P), not dichiarata(I) ;
    1,I : scelta(I), media(I), not scorciatoia(I) ;
    1,I : scelta(I), debole(I) ;
    3,I : scelta(I), da_interfaccia(I) ;
    1,I : scelta(I), ponte(I) ;
   -4,I : ridondante(I) ;
   -3,I : scelta(I), tipi_diversi(I), not dichiarata(I), not confermata(I)
}.

#show scelta/1.
#show ridondante/1.
