// Tavolo d'Avventura: dati e tabelle del gioco (ricette, stanze, avventure pronte, cataloghi, battute di riserva, dadi).
import { testo } from './tavolo-util.js';
export const COMPAGNI_ANIMALI = { cane: { pf: 13, ca: 12, abilita: 'fiuto, morso' }, lupo: { pf: 11, ca: 13, abilita: 'branco, morso' }, falco: { pf: 1, ca: 13, abilita: 'vista acuta, volo' }, gatto: { pf: 2, ca: 12, abilita: 'furtività' }, cavallo: { pf: 19, ca: 10, abilita: 'cavalcatura, veloce' }, pony: { pf: 11, ca: 10, abilita: 'cavalcatura, robusto' }, mulo: { pf: 11, ca: 10, abilita: 'porta carichi' }, corvo: { pf: 1, ca: 12, abilita: 'imita voci, volo' } };
export const STANZE_BASE = { dormitorio: { nome: 'Dormitorio', prezzo: 150, bonus: 'riposo lungo: tutti recuperano anche 1 dado vita' }, laboratorio: { nome: 'Laboratorio', prezzo: 250, bonus: '+2 ai tiri per creare oggetti' }, stalla: { nome: 'Stalla', prezzo: 150, bonus: 'cavalcature al sicuro, viaggi più veloci' }, cappella: { nome: 'Cappella', prezzo: 300, bonus: 'una benedizione per sessione: vantaggio a un tiro salvezza' }, biblioteca: { nome: 'Biblioteca', prezzo: 300, bonus: 'vantaggio alle prove di conoscenza una volta per sessione' }, armeria: { nome: 'Armeria', prezzo: 400, bonus: 'armi riparate e affilate: +1 ai danni del primo colpo di ogni scontro' } };
export const MESTIERI = { alchimista: 'Alchimista', fabbro: 'Fabbro', cuoco: 'Cuoco', erborista: 'Erborista', arcaio: 'Arcaio' };
export const RICETTE = [
  { nome: 'Pozione di guarigione', risultato: 'Pozione di guarigione', ingredienti: ['Erbe medicinali', 'Fiala'], costo: 10, cd: 12, car: 'sag', mestiere: 'alchimista' },
  { nome: 'Antidoto', risultato: 'Antidoto', ingredienti: ['Erbe medicinali'], costo: 15, cd: 13, car: 'int', mestiere: 'erborista' },
  { nome: 'Frecce (20)', risultato: 'Frecce (20)', ingredienti: ['Legno robusto', 'Piume'], costo: 2, cd: 10, car: 'des', mestiere: 'arcaio' },
  { nome: 'Pugnale', risultato: 'Pugnale', ingredienti: ['Minerale di ferro'], costo: 5, cd: 12, car: 'for', mestiere: 'fabbro' },
  { nome: 'Razioni da viaggio', risultato: 'Razioni (3 giorni)', ingredienti: ['Carne'], costo: 1, cd: 8, car: 'sag', mestiere: 'cuoco' },
  { nome: 'Stufato del cacciatore', risultato: 'Stufato del cacciatore (+5 PF a chi lo mangia)', ingredienti: ['Carne', 'Erbe medicinali'], costo: 2, cd: 11, car: 'sag', mestiere: 'cuoco' }
];
export const RARI = [{ nome: 'Pozione di guarigione superiore', prezzo: 150 }, { nome: 'Mantello elfico', prezzo: 500 }, { nome: 'Corda di seta (15 m)', prezzo: 10 }, { nome: 'Pergamena di Scudo', prezzo: 80 }, { nome: 'Anello di calore', prezzo: 300 }, { nome: 'Pietra della buona sorte', prezzo: 450 }, { nome: 'Fiala di fuoco dell\'alchimista', prezzo: 50 }, { nome: 'Mappa di un tesoro sepolto', prezzo: 120 }, { nome: 'Stivali della leggerezza', prezzo: 350 }, { nome: 'Erbe medicinali', prezzo: 3 }, { nome: 'Minerale di ferro', prezzo: 4 }, { nome: 'Piume', prezzo: 1 }, { nome: 'Fiala', prezzo: 1 }];
export const SEGRETI = ['Sei in cerca di un fratello scomparso: chiedi di lui a ogni PNG importante.', 'Devi una grossa somma a un usuraio: metti da parte 200 monete senza dirlo agli altri.', 'Sei stato cacciato dalla tua gilda: riconquista il loro rispetto con un\'impresa.', 'Hai giurato di proteggere un compagno del gruppo, anche a costo della vita.', 'Colleziona un trofeo da ogni nemico importante sconfitto.', 'Un antico spirito ti parla in sogno: segui i suoi segni.', 'Vuoi diventare famoso: fai in modo che il tuo nome arrivi in ogni città.', 'Cerchi la spada di tuo nonno, perduta in un dungeon della regione.'];
// il testo da leggere ad alta voce: via le indicazioni di regia "*(tono epico)*", asterischi e titoli markdown
export function senzaRegia(t) { return String(t ?? '').replace(/\*?\((?:tono|voce|con tono|musica|pausa|sottofondo)[^)]*\)\*?/gi, '').replace(/[*_#`]+/g, '').replace(/[ \t]{2,}/g, ' ').trim(); }
export const TIPI_EVENTO = ['png_ricordo', 'avventura', 'bottino', 'combattimento', 'compagno', 'condizione', 'cura', 'danno', 'danno_nemico', 'edificio', 'enigma', 'esperienza', 'fazione', 'illustra', 'luogo', 'minaccia', 'minaccia_sventata', 'missione', 'missione_fatta', 'morte', 'negozio', 'nemesi', 'nemesi_fuga', 'nemico', 'oggetto', 'oro', 'png', 'png_nota', 'reputazione', 'reputazione_luogo', 'scelta', 'scena', 'segreto_fatto', 'sfida_persa', 'sfida_vinta', 'sogno', 'suono', 'tempo', 'tiro', 'valuta', 'valuta_pg', 'voto']; // gli eventi che il master AI può usare (quelli di applicaEvento)
export const TATTICHE = { fuoco: /fuoco|fiamm|incendi|brucio|palla di fuoco/i, ghiaccio: /ghiacci|gelo|congel/i, frecce: /frecc|arco|balestr|tiro da lontano/i, furtivita: /furtiv|nascond|di soppiatto|silenzio|alle spalle/i, magia: /incantesim|lancio|magia|dardo incantato/i, mischia: /spad|ascia|martell|carico|colpisco|attacco corpo/i, trappole: /trappol|imbosc/i, parlare: /convinc|persuad|minacci|ingann|tratt/i, fuga: /scapp|fuggo|ritirat|corro via/i };
export const RISERVA = {
  scena: {
    taverna: ['Il fuoco scoppietta nel camino e qualcuno ride a un tavolo lontano.', 'Un boccale cade e rotola sotto il bancone.', 'Dalla cucina arriva odore di stufato e cipolle.', 'Un bardo stanco accorda il liuto in un angolo.'],
    citta: ['La folla si apre per lasciar passare un carro carico di botti.', 'Un banditore grida una notizia che nessuno ascolta.', 'Le campane suonano l\'ora dal campanile.', 'Due guardie discutono a voce alta all\'angolo della strada.'],
    villaggio: ['Un cane abbaia a qualcosa che solo lui vede.', 'Una donna stende i panni e vi guarda di sbieco.', 'Il vento porta odore di fieno e di fumo.', 'Un bambino corre via ridendo con una gallina in braccio.'],
    dungeon: ['Una goccia cade nel buio, e poi un\'altra.', 'In lontananza qualcosa graffia la pietra.', 'La torcia trema come se passasse un soffio d\'aria.', 'Sul pavimento, impronte che non sono vostre.'],
    grotta: ['L\'eco dei vostri passi torna indietro un attimo troppo tardi.', 'Un pipistrello sfreccia sopra le vostre teste.', 'L\'acqua gocciola su una pozza nera.'],
    foresta: ['Un ramo si spezza tra gli alberi, poi silenzio.', 'Gli uccelli smettono di cantare tutti insieme.', 'Tra le foglie vedete per un attimo due occhi gialli.'],
    castello: ['Uno stendardo sbatte nel vento sopra le mura.', 'Passi pesanti di soldati risuonano su una scala.', 'Una porta si chiude da qualche parte, lontano.'],
    porto: ['I gabbiani litigano su un mucchio di reti.', 'Una nave attracca tra grida e cigolii di corde.', 'L\'odore di sale e pesce vi riempie il naso.'],
    interno: ['Le assi del pavimento scricchiolano sotto i vostri piedi.', 'Una candela si spegne da sola.', 'Da dietro una porta arriva un sussurro.'],
    aperto: ['Il vento piega l\'erba alta lungo la strada.', 'In lontananza si alza un filo di fumo.', 'Un corvo si posa su un sasso e vi fissa.', 'Nuvole basse corrono veloci nel cielo.']
  },
  png: ['vi guarda e fa un cenno col capo.', 'si avvicina e chiede se avete bisogno di qualcosa.', 'borbotta qualcosa sul tempo e sulle tasse.', 'sembra voler dire qualcosa, poi ci ripensa.', 'vi saluta come se vi conoscesse da sempre.'],
  invito: ['Cosa fate?', 'Che cosa decidete di fare?', 'Come vi muovete adesso?', 'Chi di voi fa la prima mossa?', 'Ditemi cosa fa ognuno di voi.'],
  silenzio: ['Il momento sembra aspettare una vostra decisione.', 'Qualcosa sta per succedere, se nessuno si muove.', 'Il tempo passa: cosa fate?']
};
export const PROMEMORIA = [['giorno', 86400000], ['ora', 3600000]]; // promemoria il giorno prima e un'ora prima
export function b64url(b) { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// cosa entra nella copia della campagna (non i membri con le loro chiavi, non le immagini)
export const COPIA = /^(pg:|luogo:|note:)|^(campagna|diario|memoria|mondo|png|luoghi|luogoAttuale|segnalini|gruppo|missioni|voto|enigma|nemesi|scelte|minacce|base|serate|riepiloghi|memoriale|relazioni|statistiche|avventura|tattiche|dungeonGiorno|aree|combattimento|negozio|noteMaster|daRiassumere)$/;
export const PER_SPETTATORI = ['reazione', 'stato', 'riepiloghi', 'libro', 'statistiche', 'traduci', 'esci', 'impostazioni', 'rtc', 'suggerimento'];
export const SILENZIO = 4 * 60000; // dopo quanti minuti di silenzio il master AI fa succedere qualcosa
export const REAZIONI = ['👏', '😂', '😱', '🔥', '❤️', '🎲'];
export const LINGUE = { it: 'italiano', en: 'inglese', es: 'spagnolo', fr: 'francese', de: 'tedesco' };
export const SUONI = ['porta', 'colpo', 'magia', 'monete', 'pozione', 'vittoria', 'sconfitta', 'raro', 'ferito', 'successo', 'critico', 'livello', 'tocco', 'tuono'];
export const ATTESA_MASTER = 3500; // ms di silenzio prima che il master AI risponda a quanto detto
export const SCENE_EN = { citta: 'a bustling medieval fantasy city with stone houses, cobblestone streets and market stalls', villaggio: 'a small medieval fantasy village with thatched cottages and dirt roads', porto: 'a medieval fantasy harbor with wooden docks, ships and warehouses', taverna: 'the cozy interior of a medieval fantasy tavern with a roaring fireplace, wooden tables and patrons', dungeon: 'a dark ancient dungeon with stone corridors lit by flickering torches', grotta: 'a vast natural cave with stalagmites, glowing mushrooms and underground pools', castello: 'a mighty medieval castle with towers, banners and a courtyard', foresta: 'a dense ancient forest with towering trees, mist and a winding path', interno: 'the interior of a medieval fantasy building with furniture and candlelight', aperto: 'open medieval fantasy countryside with rolling hills and a dirt road' };
// Compagni della partita in solitaria, interpretati dal master AI
export const COMPAGNI = [
  { id: 'a_mira', nome: 'Mira la ranger', carattere: 'elfa silenziosa e pratica, ottima con l\'arco, diffida delle città', pf: 13, ca: 14 },
  { id: 'a_tobia', nome: 'Fra\' Tobia il chierico', carattere: 'umano chiacchierone e goloso, cura le ferite e cita proverbi', pf: 12, ca: 16 }
];
// Avventure pronte (testi originali)
export const AVVENTURE = {
  miniera: {
    titolo: 'La miniera dei goblin', livelli: '1-3', tipo: 'avventura',
    sinossi: 'Da una settimana la miniera di Pietrarossa è caduta in mano ai goblin del capo Rugnak: i minatori sono fuggiti, uno di loro (Brann, un nano) è prigioniero e il villaggio rischia la fame. La sindaca Gerlinda offre una ricompensa a chi libera la miniera. Avventura per personaggi di livello 1-3, da giocare in una serata.',
    fazioni: [{ nome: 'Goblin di Rugnak', reputazione: -60, descrizione: 'banda di goblin guidata dall\'hobgoblin Rugnak, occupa la miniera di Pietrarossa' }, { nome: 'Villaggio di Pietrarossa', reputazione: 10, descrizione: 'minatori e contadini, spaventati ma ospitali' }],
    segreti: ['Rugnak non è il vero capo: prende ordini da un bugbear, Grumsh, che vuole usare la miniera come covo per razziare la valle.', 'Brann ha scoperto una vena d\'argento: per questo i goblin lo tengono vivo e lo fanno scavare.', 'Il vecchio Ulrico, il fabbro del villaggio, vende di nascosto chiodi e lanterne ai goblin in cambio di argento: se scoperto, chiede di non dirlo alla sindaca.', 'Nel bosco i goblin hanno lasciato un carretto rovesciato con le loro tracce: porta dritto all\'ingresso secondario della miniera, che evita le trappole.'],
    ricompensa: '50 monete d\'oro a testa dalla sindaca Gerlinda, il martello magico di Brann (arma +1) e 300 PX a personaggio; l\'argento della vena, se diviso con il villaggio, rende il gruppo benvoluto per sempre.',
    scene: [
      { id: 'villaggio', luogo: 'Villaggio di Pietrarossa', tipo: 'villaggio', obiettivo: 'Il gruppo arriva al villaggio, sente le voci sui goblin e viene mandato dalla sindaca.', png: 'Gerlinda la sindaca (energica, stanca, onesta); bambini che giocano ai goblin', indizi: 'carri vuoti, botteghe chiuse, i minatori bevono nella taverna invece di lavorare',
        leggi: 'La strada sale tra campi di segale fino a Pietrarossa, un villaggio di case basse con i tetti di ardesia, aggrappato alla montagna. Dovrebbe essere ora di lavoro, eppure i carri dei minatori sono fermi e vuoti, e le botteghe hanno le imposte chiuse. Una bambina vi fissa da dietro un recinto, poi corre via gridando: "Altri forestieri! Forse questi i goblin li ammazzano davvero!"' },
      { id: 'taverna', luogo: 'Taverna del Mulo Stanco', tipo: 'taverna', obiettivo: 'La sindaca offre l\'incarico; i minatori raccontano della miniera, delle trappole all\'ingresso principale e di Brann prigioniero.', png: 'Tobia l\'oste (gentile, pauroso); Gerlinda la sindaca; Hilde, minatrice ferita che conosce la miniera', indizi: 'Hilde disegna una mappa sommaria: ingresso principale con trappole, un ingresso secondario nel Bosco dei Corvi che solo i goblin usano',
        leggi: 'Nella Taverna del Mulo Stanco il fuoco è acceso ma nessuno ride. Una dozzina di minatori fissa i boccali in silenzio. Dietro il bancone, l\'oste Tobia vi saluta con un sorriso che vorrebbe essere allegro. Al tavolo vicino al camino una donna robusta con la fascia da sindaca si alza in piedi: "Se siete qui per lavorare, ho un lavoro da offrirvi. Pagato bene."' },
      { id: 'bosco', luogo: 'Bosco dei Corvi', tipo: 'foresta', obiettivo: 'Seguendo le tracce dei goblin il gruppo trova il carretto rovesciato e due lupi addestrati dai goblin.', png: 'nessuno: corvi che gracchiano', indizi: 'carretto rovesciato con sacchi di grano rubati e impronte piccole che portano all\'ingresso secondario della miniera',
        incontro: [{ nome: 'Lupo', numero: 2, gs: '1/4', pf: 11, ca: 13 }],
        leggi: 'Il Bosco dei Corvi merita il suo nome: centinaia di uccelli neri gracchiano dai rami, e tacciono di colpo al vostro passaggio. Sul sentiero, un carretto è rovesciato su un fianco, i sacchi di grano squarciati. Tutt\'intorno, piccole impronte di piedi nudi. E poi un ringhio basso, tra i cespugli.' },
      { id: 'miniera', luogo: 'Miniera di Pietrarossa', tipo: 'dungeon', obiettivo: 'Il gruppo entra nella miniera (dall\'ingresso principale con le trappole o da quello secondario), affronta le sentinelle goblin e trova Brann incatenato.', png: 'Brann il minatore nano (prigioniero, testardo, grato); goblin sentinelle che litigano tra loro', indizi: 'Brann racconta della vena d\'argento e che Rugnak ha paura di qualcuno più grosso nella sala in fondo',
        incontro: [{ nome: 'Goblin', numero: 4, gs: '1/4', pf: 7, ca: 15 }],
        leggi: 'L\'aria della miniera sa di ferro e di fumo. Le travi di sostegno scricchiolano sopra le vostre teste, e da qualche parte più in basso arriva un rumore regolare di picconi, accompagnato da risate stridule. Una torcia, piantata male nella roccia, illumina quattro figure piccole e verdi che giocano a dadi con delle ossa.' },
      { id: 'boss', luogo: 'Sala profonda della miniera', tipo: 'grotta', obiettivo: 'Scontro finale con Rugnak e il suo padrone, il bugbear Grumsh, vicino alla vena d\'argento. Poi il ritorno al villaggio e la ricompensa.', png: 'Rugnak l\'hobgoblin (arrogante, vigliacco quando perde); Grumsh il bugbear (silenzioso, brutale)', indizi: 'se Rugnak viene risparmiato tradisce Grumsh',
        incontro: [{ nome: 'Rugnak l\'hobgoblin', numero: 1, gs: '1/2', pf: 22, ca: 18 }, { nome: 'Grumsh il bugbear', numero: 1, gs: '1', pf: 27, ca: 16 }],
        tesoro: '150 monete d\'oro, 2 pozioni di guarigione, il martello di Brann (arma +1), un sacco di argento grezzo (200 mo)',
        leggi: 'La galleria si apre in una caverna enorme. Sulle pareti, una lunga vena scintillante riflette la luce di un braciere: argento, tanto argento. Davanti al braciere, un hobgoblin con un elmo troppo grande sbraita ordini. Ma è l\'ombra alle sue spalle a farvi gelare il sangue: qualcosa di grosso, peloso, che si alza lentamente impugnando una mazza chiodata.' }
    ]
  },
  torre: {
    titolo: 'L\'ombra della Torre di Corvonero', livelli: '2-4', tipo: 'seguito', seguito: 'miniera',
    sinossi: 'Seguito de "La miniera dei goblin". Tra le cose di Grumsh il gruppo trova una lettera col sigillo di un corvo nero: qualcuno pagava i goblin per raccogliere argento. Serve alla negromante Morvane, che nelle rovine della Torre di Corvonero forgia una corona d\'argento per comandare i morti della valle. Pietrarossa festeggia i suoi eroi, ma i cani ululano ogni notte e al cimitero mancano tre bare. Per personaggi di livello 2-4, una o due serate.',
    fazioni: [{ nome: 'Seguaci del Corvo', reputazione: -50, descrizione: 'fedeli della negromante Morvane, rubano argento e cadaveri' }, { nome: 'Villaggio di Pietrarossa', reputazione: 30, descrizione: 'grati al gruppo per aver liberato la miniera' }, { nome: 'Pattuglia del Passo', reputazione: 0, descrizione: 'soldati del barone che sorvegliano la strada del passo, sospettosi ma onesti' }],
    segreti: ['Morvane era la guaritrice di Pietrarossa trent\'anni fa: durante una pestilenza il villaggio la accusò di stregoneria e la cacciò. Vuole vendetta, non un regno: può fermarsi se il villaggio ammette la colpa.', 'Il capitano della pattuglia, Edrik, è nipote di Morvane e le porta provviste di nascosto: non è malvagio, ha paura per lei.', 'La corona non è finita: manca l\'argento di Pietrarossa. Se il gruppo l\'ha lasciato al villaggio, i seguaci provano a rubarlo durante la festa.', 'Nella cripta, il sarcofago del fondatore custodisce una spada lunga +1 che brilla vicino ai non morti.', 'La porta d\'argento della cripta si apre solo a chi pronuncia la parola "perdono".'],
    ricompensa: '100 monete d\'oro a testa dal barone, la spada del fondatore, 450 PX a personaggio. Se Morvane viene redenta, torna a Pietrarossa come guaritrice e diventa un\'alleata del gruppo.',
    scene: [
      { id: 'festa', luogo: 'Piazza di Pietrarossa', tipo: 'villaggio', obiettivo: 'Festa per gli eroi della miniera. A notte fonda due seguaci del Corvo provano a rubare l\'argento; inseguendoli il gruppo trova la pista verso il passo.', png: 'Gerlinda la sindaca (fiera del gruppo); Brann il nano (ora amico, brinda troppo); Tobia l\'oste', indizi: 'una piuma nera, terra di cimitero sugli stivali dei ladri, uno grida "la Signora del Corvo vi farà marcire"',
        incontro: [{ nome: 'Seguace del Corvo', numero: 2, gs: '1/8', pf: 11, ca: 12 }],
        leggi: 'Pietrarossa non ha mai fatto una festa così. Lanterne di carta pendono tra le case, Tobia ha portato in piazza tre botti intere e Brann racconta per la decima volta come lo avete liberato, ogni volta con più goblin. A mezzanotte la musica si spegne, le lanterne si spengono una ad una... e dal magazzino dove è chiuso l\'argento arriva un rumore di vetri rotti.' },
      { id: 'passo', luogo: 'Passo dei Corvi', tipo: 'aperto', obiettivo: 'Sulla strada la Pattuglia del Passo ferma il gruppo: il capitano Edrik sconsiglia di salire alla torre. Al tramonto, un agguato di scheletri.', png: 'Capitano Edrik (cortese, nervoso, porta un anello col corvo); soldati annoiati', indizi: 'i soldati raccontano che Edrik porta un carro alla torre ogni settimana "per ordine del barone"',
        incontro: [{ nome: 'Scheletro', numero: 3, gs: '1/4', pf: 13, ca: 13 }],
        leggi: 'La strada del passo sale tra rocce nere e pini storti. Uno stormo di corvi vi segue da lontano, posandosi sempre un po\' più avanti, come se vi aspettasse. Dietro una curva, una barriera di legno e tre soldati con le lance. Il più giovane, un capitano dai capelli rossi, alza la mano: "Fermi. Lassù non c\'è niente per voi. Tornate indietro, finché c\'è luce."' },
      { id: 'rovine', luogo: 'Rovine di Corvonero', tipo: 'castello', obiettivo: 'Il cortile della torre in rovina: zombi tra le macerie, corvi messaggeri. Bisogna trovare l\'ingresso della cripta, nascosto sotto la statua del fondatore.', png: 'Pip, lo spirito di un garzone di stalla (innocuo, curioso, indica l\'ingresso a chi è gentile)', indizi: 'il diario bruciacchiato di Morvane racconta della pestilenza e della cacciata dal villaggio',
        incontro: [{ nome: 'Zombi', numero: 3, gs: '1/4', pf: 22, ca: 8 }],
        leggi: 'Della Torre di Corvonero resta in piedi solo il fusto, nero come un dito puntato verso il cielo. Il cortile è un labirinto di mura crollate e d\'erba alta. Al centro, la statua di un cavaliere senza testa regge una spada spezzata. Dietro di voi, qualcosa si trascina tra le macerie, lentamente, con un rumore di ossa che strusciano sulla pietra.' },
      { id: 'cripta', luogo: 'Cripta del Fondatore', tipo: 'dungeon', obiettivo: 'Corridoio con lame nascoste (Percezione CD 13 per vederle), il sarcofago con la spada del fondatore, la porta d\'argento e due ghoul di guardia.', png: 'nessuno: iscrizioni sulle pareti', indizi: 'sulla porta d\'argento: "Solo chi chiede perdono passa" (è un enigma: la parola è perdono)',
        incontro: [{ nome: 'Ghoul', numero: 2, gs: '1', pf: 22, ca: 12 }],
        leggi: 'Gli scalini scendono a spirale nel buio, consumati da secoli di passi. L\'aria è fredda e sa di terra bagnata e di incenso vecchio. In fondo a un lungo corridoio, una porta d\'argento brilla debolmente, coperta di lettere antiche. E tra voi e la porta, due sagome magre e grigie si voltano insieme, annusando l\'aria.' },
      { id: 'cima', luogo: 'Cima della Torre di Corvonero', tipo: 'castello', obiettivo: 'Sotto la luna Morvane completa la corona. Scontro finale, oppure redenzione se il gruppo le porta le scuse del villaggio o la convince della verità.', png: 'Morvane la negromante (amara, stanca, ancora capace di pietà); Edrik se è venuto con il gruppo', indizi: 'se il gruppo porta le scuse di Pietrarossa (o Gerlinda in persona) Morvane spezza la corona',
        incontro: [{ nome: 'Morvane la negromante', numero: 1, gs: '2', pf: 40, ca: 12 }, { nome: 'Scheletro', numero: 2, gs: '1/4', pf: 13, ca: 13 }],
        tesoro: '120 monete d\'oro, 2 pergamene di Cura ferite, l\'anello del corvo (una volta al giorno parla con un corvo), la corona d\'argento incompiuta (300 mo di argento)',
        leggi: 'In cima alla torre il vento ulula tra i merli spezzati. Al centro di un cerchio di candele nere, una donna con i capelli grigi lavora a un\'incudine: martella una corona d\'argento che brilla di luce fredda. Intorno a lei, ossa che si muovono da sole. Non alza nemmeno lo sguardo: "Vi hanno mandato loro, vero? Come mandarono gli altri, trent\'anni fa."' }
    ]
  },
  lanterna: {
    titolo: 'La notte della lanterna', livelli: '1-2', tipo: 'one-shot',
    sinossi: 'Avventura breve per una serata. In una notte di tempesta il gruppo cerca riparo a Villa Ombrosa, una casa di campagna dove una lanterna resta sempre accesa alla finestra. La vedova Isotta li accoglie volentieri, ma a mezzanotte la casa si sveglia: porte che sbattono, ritratti che piangono e una bambina che chiede di trovare sua madre.',
    fazioni: [],
    segreti: ['La bambina, Lucia, è un fantasma: morì cinquant\'anni fa nell\'incendio della serra e cerca il carillon di sua madre.', 'Isotta non è la padrona ma la vecchia governante: tiene accesa la lanterna per senso di colpa, perché fu lei a lasciarne una nella serra la notte dell\'incendio.', 'Se il carillon suona nella stanza di Lucia, la bambina trova pace e la casa smette di essere infestata.', 'In cantina un\'ombra nata dal rancore dei vecchi servi tiene chiusa la stanza di Lucia.'],
    ricompensa: '40 monete d\'oro a testa da Isotta, la lanterna che non si spegne mai (luce anche sotto la pioggia, senza olio), 150 PX a personaggio.',
    scene: [
      { id: 'arrivo', luogo: 'Villa Ombrosa', tipo: 'interno', obiettivo: 'Tempesta, accoglienza e cena con Isotta, che dà una sola regola: non spegnere mai la lanterna.', png: 'Isotta (gentile, malinconica, evita di parlare della serra)', indizi: 'il ritratto di una donna con una bambina e un carillon in mano; la porta della serra sbarrata con assi',
        leggi: 'La pioggia vi frusta la faccia da ore quando, oltre gli alberi, compare una luce: una lanterna dietro una finestra. Villa Ombrosa è una grande casa di pietra con le persiane scrostate. Ad aprirvi è una vecchia signora con uno scialle nero: "Entrate, entrate, c\'è zuppa calda per tutti. Solo una cosa vi chiedo: quella lanterna non si spegne. Mai."' },
      { id: 'mezzanotte', luogo: 'Corridoi di Villa Ombrosa', tipo: 'interno', obiettivo: 'A mezzanotte la casa si sveglia: spade appese ai muri volano contro il gruppo. Appare Lucia e chiede del carillon della mamma.', png: 'Lucia, la bambina fantasma (dolce, triste, scompare quando ha paura)', indizi: 'nel camino della biblioteca c\'è la chiave della serra',
        incontro: [{ nome: 'Spada volante', numero: 2, gs: '1/4', pf: 17, ca: 17 }],
        leggi: 'Vi sveglia il silenzio: la pioggia si è fermata di colpo. Poi, da qualche parte al piano di sotto, il rintocco di un orologio. Dodici colpi. Le porte delle stanze si spalancano tutte insieme e lungo il corridoio i ritratti hanno gli occhi bagnati di lacrime. In fondo, una bambina in camicia da notte vi guarda: "Avete visto la mia mamma? Ha il mio carillon."' },
      { id: 'serra', luogo: 'Serra bruciata', tipo: 'aperto', obiettivo: 'Tra le rovine annerite della serra bisogna trovare il carillon. Se messa alle strette, Isotta confessa.', png: 'Isotta, se il gruppo la porta con sé', indizi: 'il carillon è sotto il vaso grande, intatto; le ceneri formano impronte di piedi piccoli',
        incontro: [{ nome: 'Ratto gigante', numero: 3, gs: '1/8', pf: 7, ca: 12 }],
        leggi: 'La serra è uno scheletro di ferro e vetri rotti. Le piante sono diventate carbone, ma l\'odore di fumo, dopo cinquant\'anni, è ancora lì. Tra le ceneri qualcosa squittisce. E per un attimo, alla luce della lanterna, vedete sulla cenere impronte di piedi nudi, piccoli, che girano in tondo intorno a un grande vaso.' },
      { id: 'cantina', luogo: 'Cantina di Villa Ombrosa', tipo: 'dungeon', obiettivo: 'L\'ombra dei servi blocca la porta della stanza di Lucia. Dopo lo scontro, far suonare il carillon libera la bambina e la casa.', png: 'Lucia; l\'Ombra (sussurra rancore, odia la luce)', indizi: 'la luce della lanterna indebolisce l\'Ombra',
        incontro: [{ nome: 'Ombra', numero: 1, gs: '1/2', pf: 16, ca: 12 }],
        tesoro: 'il cofanetto dei gioielli della famiglia (80 mo), la lanterna che non si spegne mai',
        leggi: 'Le scale della cantina sono umide e scivolose. In fondo, una porta dipinta di rosa, con un nome scritto in lettere infantili: LUCIA. Davanti alla porta il buio è più fitto, come se fosse fatto di qualcosa. E si muove. Una sagoma senza volto si stacca dal muro, e la fiamma della lanterna trema.' }
    ]
  },
  ponte: {
    titolo: 'Il pedaggio dell\'ogre', livelli: '2-3', tipo: 'one-shot',
    sinossi: 'Avventura breve per una serata, che si può risolvere anche senza combattere. Sul Ponte Vecchio sul fiume Brunello un ogre di nome Brodo pretende un pedaggio da tutti: una pecora a carro. I mercanti di Borgo Guado sono disperati e la fiera d\'autunno è tra tre giorni. Ma Brodo è lì perché qualcuno gli ha rubato qualcosa.',
    fazioni: [{ nome: 'Mercanti di Borgo Guado', reputazione: 10, descrizione: 'mercanti e barcaioli, disperati per il ponte bloccato' }, { nome: 'Banda del Luccio', reputazione: -30, descrizione: 'banditi del fiume che vivono nel canneto' }],
    segreti: ['Brodo è un ogre giovane e poco sveglio: i banditi della Banda del Luccio gli hanno rubato la sua capra Bisa e gli hanno detto che l\'hanno mangiata i mercanti.', 'Il capobanda, Luccio, usa il pedaggio come distrazione: mentre tutti guardano il ponte, fa passare la sua merce di contrabbando sull\'altra riva.', 'Bisa è viva, legata nel covo dei banditi nel canneto.', 'Se Brodo riavrà Bisa diventa amico del gruppo e li aiuta contro i banditi.'],
    ricompensa: '30 monete d\'oro a testa dai mercanti (60 se Brodo resta vivo e il ponte torna libero), una barca a remi, 200 PX a personaggio; Brodo come amico, che una volta può sollevare o spaccare qualsiasi cosa per loro.',
    scene: [
      { id: 'borgo', luogo: 'Borgo Guado', tipo: 'villaggio', obiettivo: 'I mercanti raccontano dell\'ogre e chiedono aiuto. Qualcuno nota che i banditi del canneto sono stranamente ricchi ultimamente.', png: 'Marta la locandiera (schietta, ride forte); mastro Ugo il mercante (avaro, vuole l\'ogre morto)', indizi: 'i banditi pagano da bere con monete nuove; il pedaggio è cominciato il giorno dopo che una capra è sparita dal pascolo del vecchio Tommaso',
        leggi: 'Borgo Guado vive del ponte: carri, barche, mercanti che gridano i prezzi. Ma oggi la piazza è piena di carri fermi e di gente che litiga. Una locandiera grande e grossa vi viene incontro asciugandosi le mani sul grembiule: "Forestieri armati! Finalmente. C\'è un ogre sul ponte che si mangia le nostre pecore, e tra tre giorni c\'è la fiera."' },
      { id: 'ponteVecchio', luogo: 'Ponte Vecchio', tipo: 'aperto', obiettivo: 'Incontro con Brodo: trattativa, inganno o combattimento. Se il gruppo lo ascolta, scopre della capra rubata.', png: 'Brodo l\'ogre (lento, triste, ripete "Bisa... voi mangiato Bisa!")', indizi: 'Brodo ha una corda da capra legata al polso; sull\'altra riva si vedono barche che passano mentre lui è distratto',
        incontro: [{ nome: 'Brodo l\'ogre', numero: 1, gs: '2', pf: 59, ca: 11 }],
        leggi: 'Il Ponte Vecchio è di pietra, stretto e alto sull\'acqua che corre veloce. A metà, seduto di traverso come su una panca, c\'è un ogre. Ha in mano una clava grande come un albero e davanti un mucchio di ossa di pecora. Quando vi vede si alza, e il ponte trema: "Pagare! Una pecora! O... o Brodo arrabbia!" Ma ha gli occhi rossi, come se avesse pianto.' },
      { id: 'canneto', luogo: 'Covo nel canneto', tipo: 'foresta', obiettivo: 'Trovare il covo della Banda del Luccio, liberare Bisa e sconfiggere Luccio e i suoi. Brodo può aiutare se è diventato amico.', png: 'Luccio il capobanda (sbruffone, codardo quando perde); Bisa la capra (testarda, bela fortissimo)', indizi: 'le casse del contrabbando portano il marchio di un mercante di Borgo Guado: mastro Ugo era d\'accordo con i banditi',
        incontro: [{ nome: 'Bandito', numero: 3, gs: '1/8', pf: 11, ca: 12 }, { nome: 'Luccio il capobanda', numero: 1, gs: '1', pf: 32, ca: 15 }],
        tesoro: '90 monete d\'oro di contrabbando, 2 pozioni di guarigione, una mappa del fiume con i nascondigli dei banditi',
        leggi: 'Il canneto è alto più di un uomo e l\'acqua vi arriva alle caviglie. Seguendo le impronte arrivate a una radura: capanne su palafitte, barche cariche di casse e un falò. Intorno al fuoco, uomini che ridono e contano monete. E legata a un palo, una capra bianca che bela disperata.' }
    ]
  }
};
// Trofei della serata: a chi ha il numero più alto in ogni voce (almeno 1)
export const TROFEI = [['critici', 'Mano d\'oro', n => `${n} colpi critici`], ['fallimenti', 'Nato sotto una cattiva stella', n => `${n} fallimenti critici`], ['danniSubiti', 'Muro vivente', n => `${n} danni incassati`], ['cadute', 'Bacio del pavimento', n => n === 1 ? 'a terra una volta' : `a terra ${n} volte`], ['cure', 'Pellaccia', n => `${n} punti ferita recuperati`], ['speso', 'Spendaccione', n => `${n} monete spese`], ['tiri', 'Lanciatore instancabile', n => `${n} dadi tirati`]];
export function trofei(s, nomi) {
  const out = [];
  for (const [campo, titolo, motivo] of TROFEI) {
    const [chi, v] = Object.entries(s || {}).filter(([id]) => id !== 'gruppo').map(([id, o]) => [id, o[campo] || 0]).sort((a, b) => b[1] - a[1])[0] || [];
    if (chi && v > 0) out.push({ titolo, chi: nomi[chi] || chi, motivo: motivo(v) });
  }
  return out;
}
// Cataloghi dei negozi (prezzi dell'SRD 5.1 in monete d'oro, arrotondati)
export const CATALOGHI = {
  emporio: [['Razioni (1 giorno)', 1], ['Corda (15 m)', 1], ['Torcia', 1], ['Zaino', 2], ['Otre', 1], ['Sacco a pelo', 1], ['Lanterna', 5], ['Olio (ampolla)', 1], ['Kit da guaritore', 5], ['Acciarino', 1], ['Chiodi da rocciatore (10)', 1], ['Rampino', 2]],
  fabbro: [['Pugnale', 2], ['Spada corta', 10], ['Spada lunga', 15], ['Ascia da battaglia', 10], ['Mazza', 5], ['Martello da guerra', 15], ['Lancia', 1], ['Arco corto', 25], ['Frecce (20)', 1], ['Scudo', 10], ['Armatura di cuoio', 10], ['Camicia di maglia', 50], ['Cotta di maglia', 75], ['Elmo', 10]],
  alchimista: [['Pozione di guarigione', 50], ['Antidoto', 50], ["Fuoco dell'alchimista", 50], ['Acqua santa', 25], ['Pozione di guarigione superiore', 150], ['Erbe medicinali', 5]],
  magia: [['Pergamena di Dardo incantato', 50], ['Pergamena di Cura ferite', 50], ['Pergamena di Scudo', 50], ['Bacchetta (focus arcano)', 10], ['Simbolo sacro', 5], ['Amuleto', 5], ['Libro degli incantesimi', 50]]
};
for (const k of Object.keys(CATALOGHI)) CATALOGHI[k] = CATALOGHI[k].map(([nome, prezzo]) => ({ nome, prezzo }));
export function tipoNegozio(nome) { const n = String(nome).toLowerCase(); return /fabbr|armaiol|armi|forgia/.test(n) ? 'fabbro' : /alchim|erbor|speziale|pozion|guaritor/.test(n) ? 'alchimista' : /mago|arcan|magic|incant|tempio/.test(n) ? 'magia' : 'emporio'; }
export function prezzoBase(nome) { for (const c of Object.values(CATALOGHI)) { const x = c.find(m => m.nome.toLowerCase() === String(nome).toLowerCase()); if (x) return x.prezzo; } return /pozione|pergamena/i.test(nome) ? 50 : /spada|ascia|martello|arco/i.test(nome) ? 10 : 2; }
// PX per personaggio per livello (facile, media, difficile, mortale) — SRD 5.1
export const SOGLIE_PX = [[25, 50, 75, 100], [50, 100, 150, 200], [75, 150, 225, 400], [125, 250, 375, 500], [250, 500, 750, 1100], [300, 600, 900, 1400], [350, 750, 1100, 1700], [450, 900, 1400, 2100], [550, 1100, 1600, 2400], [600, 1200, 1900, 2800], [800, 1600, 2400, 3600], [1000, 2000, 3000, 4500], [1100, 2200, 3400, 5100], [1250, 2500, 3800, 5700], [1400, 2800, 4300, 6400], [1600, 3200, 4800, 7200], [2000, 3900, 5900, 8800], [2100, 4200, 6300, 9500], [2400, 4900, 7300, 10900], [2800, 5700, 8500, 12700]];
export const BESTIARIO = [['Bandito', '1/8', 25, 11, 12], ['Goblin', '1/4', 50, 7, 15], ['Lupo', '1/4', 50, 11, 13], ['Scheletro', '1/4', 50, 13, 13], ['Zombi', '1/4', 50, 22, 8], ['Orco', '1/2', 100, 15, 13], ['Hobgoblin', '1/2', 100, 11, 18], ['Gnoll', '1/2', 100, 22, 15], ['Bugbear', '1', 200, 27, 16], ['Lupo crudele', '1', 200, 37, 14], ['Ragno gigante', '1', 200, 26, 14], ['Ogre', '2', 450, 59, 11], ['Ghoul', '1', 200, 22, 12], ['Orsogufo', '3', 700, 59, 13], ['Troll', '5', 1800, 84, 15], ['Giovane drago verde', '8', 3900, 136, 18], ['Giovane drago rosso', '10', 5900, 178, 18]];
export function incontroCasuale(budget) {
  const adatti = BESTIARIO.filter(b => b[2] <= budget); const b = adatti.length ? adatti[Math.floor(Math.random() * adatti.length)] : BESTIARIO[0];
  const numero = Math.max(1, Math.min(8, Math.floor(budget / (b[2] * 1.5))));
  return [{ nome: b[0], numero, gs: b[1], pf: b[3], ca: b[4] }];
}
export const d = n => 1 + Math.floor(Math.random() * n);
export function tesoroCasuale(gs) {
  const fascia = gs <= 4 ? 0 : gs <= 10 ? 1 : gs <= 16 ? 2 : 3;
  const oro = [() => (d(6) + d(6)) * 10, () => (d(6) + d(6) + d(6)) * 50, () => (d(6) + d(6) + d(6) + d(6)) * 250, () => (d(6) + d(6) + d(6) + d(6) + d(6)) * 1000][fascia]();
  const gemme = [['Agata', 10], ['Ematite', 10], ['Corniola', 50], ['Onice', 50], ['Ambra', 100], ['Perla nera', 500], ['Smeraldo', 1000], ['Diamante', 5000]];
  const magici = [['Pozione di guarigione', 'comune'], ['Pergamena di Dardo incantato', 'comune'], ['Pozione di arrampicata', 'comune'], ['Pozione di guarigione superiore', 'non comune'], ['Borsa conservante', 'non comune'], ['Arma +1', 'non comune'], ['Mantello di protezione', 'non comune'], ['Anello di protezione', 'raro'], ['Arma +2', 'raro'], ['Bacchetta delle palle di fuoco', 'raro']];
  const oggetti = [];
  for (let i = 0; i < d(2 + fascia); i++) { const g = gemme[Math.min(gemme.length - 1, Math.floor(Math.random() * (3 + fascia * 2)))]; oggetti.push(`${g[0]} (${g[1]} mo)`); }
  for (let i = 0; i < (Math.random() < 0.5 + fascia * 0.15 ? d(1 + fascia) : 0); i++) { const m = magici[Math.min(magici.length - 1, Math.floor(Math.random() * (4 + fascia * 2)))]; oggetti.push(`${m[0]} (${m[1]})`); }
  return { oro, oggetti };
}
export function pngCasuale() {
  const p = a => a[Math.floor(Math.random() * a.length)];
  return { nome: p(['Bruna', 'Aldo', 'Gerlinda', 'Tobia', 'Mirella', 'Corrado', 'Isotta', 'Brenno', 'Fiamma', 'Ulrico']) + ' ' + p(['Ventofreddo', 'Pietrascura', 'dal Molino', 'Mezzaluna', 'Barbagrigia', 'Corvonero']), razza: p(['umana', 'umano', 'nano', 'elfa', 'halfling', 'mezzorco', 'gnoma']), mestiere: p(['locandiere', 'fabbra', 'guardia', 'mercante', 'erborista', 'barcaiolo', 'sacerdotessa', 'cacciatore']), aspetto: p(['cicatrice sul sopracciglio', 'mani macchiate di inchiostro', 'grembiule sempre sporco', 'occhi chiarissimi', 'denti d\'oro']), tratto: p(['parla a voce bassissima', 'ride per niente', 'diffida degli stranieri', 'esagera ogni storia', 'conta sempre le monete']), segreto: p(['deve soldi alla gilda dei ladri', 'è una spia del barone', 'nasconde un fratello ricercato', 'ha visto il mostro della palude', 'è di sangue nobile']), battuta: p(['"Non è un buon momento per fare domande."', '"Se pagate, parlo."', '"Siete nuovi da queste parti, eh?"', '"Ho una storia per voi, ma vi costerà."']) };
}
// "Goblin 2", "goblin arciere" -> "goblin arciere"; umanoidi e orchi usano le figure LPC
export const UMANOIDI = /bandit|brigant|guardi|soldat|cultist|mago|strega|ladro|assassin|cavalier|mercenar|predon|pirat|negromant|sacerdot|capitan|stregon|goblin|orco|orchi|hobgoblin|bugbear|drow|elfo oscuro/;
export function nomeMostro(n) { return testo(n, 40).toLowerCase().replace(/[^a-zà-ù ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
// Eventi stagionali del mondo reale: il master li intreccia nella storia se ha senso
export function stagione() {
  const d = new Date(), m = d.getUTCMonth() + 1, g = d.getUTCDate();
  const ev = (m === 10 && g >= 20) || (m === 11 && g <= 2) ? 'notte delle ombre (Halloween): spiriti, maschere, zucche intagliate' : m === 12 || (m === 1 && g <= 6) ? 'feste d\'inverno (Natale): neve, luci, doni, banchetti' : m === 2 ? 'carnevale: maschere, scherzi, feste in piazza' : m === 8 && g >= 10 && g <= 20 ? 'Ferragosto: fiere d\'estate e caldo torrido' : null;
  return { mese: m, stagione: m <= 2 || m === 12 ? 'inverno' : m <= 5 ? 'primavera' : m <= 8 ? 'estate' : 'autunno', evento: ev };
}

// ---------- dadi ----------
export function tiraFormula(f, modo) {
  f = f.toLowerCase().replace(/\s+/g, '');
  const mt = f.match(/^(\d{0,2})d(4|6|8|10|12|20|100)([+-]\d{1,3})?$/);
  if (!mt) return null;
  const n = Math.min(20, Math.max(1, Number(mt[1] || 1))), facce = Number(mt[2]), mod = Number(mt[3] || 0);
  const lancia = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return 1 + (a[0] % facce); };
  let dadi = Array.from({ length: n }, lancia), scartati = [];
  if (facce === 20 && n === 1 && (modo === 'vantaggio' || modo === 'svantaggio')) {
    const altro = lancia();
    const tieni = modo === 'vantaggio' ? Math.max(dadi[0], altro) : Math.min(dadi[0], altro);
    scartati = [dadi[0] === tieni ? altro : dadi[0]]; dadi = [tieni];
  }
  const totale = dadi.reduce((a, b) => a + b, 0) + mod;
  return { formula: `${n > 1 ? n : ''}d${facce}${mod ? (mod > 0 ? '+' : '') + mod : ''}`, dadi, scartati, mod, totale, modo: scartati.length ? modo : null, critico: facce === 20 && n === 1 && dadi[0] === 20, fallimento: facce === 20 && n === 1 && dadi[0] === 1 };
}
