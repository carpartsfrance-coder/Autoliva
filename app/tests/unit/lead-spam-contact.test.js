/**
 * Tests unitaires — filtre anti-spam du formulaire de contact.
 *
 * Lancé par : npm test  (aucune base de données, aucun envoi réel)
 *
 * ── Le problème (09/2026) ───────────────────────────────────────────────────
 * La page « Leads à relancer » se remplissait de faux contacts : 73 sur 191
 * envois du formulaire, soit 38 % de cette source, avec une accélération nette
 * (15 en août, 57 sur les trois premiers jours de septembre).
 *
 * Le champ-piège `website` et le limiteur (12 envois / IP / 10 min) étaient
 * déjà en place. Le robot passait quand même : il ne remplit que les champs
 * qu'il reconnaît, et tourne sur des dizaines d'IP.
 *
 * ── Le point délicat ────────────────────────────────────────────────────────
 * Le signal le plus net (téléphone étranger tout en chiffres) aurait écarté
 * cinq VRAIS prospects en cinq mois — un Italien, un Marocain, un Canadien.
 * D'où l'exigence de DEUX signaux concordants, validée sur les 3 027 leads
 * existants : 72/72 spams détectés, 0 faux positif sur 2 955 leads légitimes.
 *
 * Ces tests figent ce compromis. Un seul signal ne doit JAMAIS suffire.
 */

const test = require('node:test');
const assert = require('node:assert');

const filtre = require('../../src/services/leadSpamFilter');

/* Le gabarit exact du robot observé en production, à l'octet près. */
const ROBOT = {
  firstName: 'Robertdom',
  lastName: 'TerrydomGM',
  phone: '85941819953',
  message: 'Hola, quería saber tu precio..',
  vehicle: '',
  plate: '',
  ref: '',
  hasFormTimestamp: false,
};

test('le robot observé en production est écarté', async (t) => {
  await t.test('son gabarit exact déclenche plusieurs signaux', () => {
    const s = filtre.signaux(ROBOT);
    assert.ok(s.length >= 2, 'signaux trouvés : ' + s.join('+'));
    assert.equal(filtre.estSpam(ROBOT), true);
  });

  await t.test('ses variantes de nom sont couvertes', () => {
    /* Le robot fait tourner le prénom : Robertdom + DennisdomGM,
       JordandomGM, JessedomGM… 72 envois, un seul prénom. */
    for (const nom of ['DennisdomGM', 'JordandomGM', 'CarldomGM', 'Robertdom']) {
      assert.ok(filtre.estSpam({ ...ROBOT, lastName: nom }), nom + ' devrait être écarté');
    }
  });

  await t.test('ses messages, dans n’importe quelle langue, ne changent rien', () => {
    /* Il envoie la même phrase (« je voulais connaître votre prix ») en
       lituanien, islandais, hongrois, galicien, arménien, bulgare… 26 messages
       distincts pour 72 envois. Le filtre ne s'appuie donc PAS sur le texte. */
    const messages = [
      'Sveiki, aš norėjau sužinoti jūsų kainą.',
      'Hæ, ég vildi vita verð þitt.',
      'Ողջույն, ես ուզում էի իմանալ ձեր գինը.',
      'Здравейте, исках да знам цената ви.',
    ];
    for (const m of messages) assert.ok(filtre.estSpam({ ...ROBOT, message: m }));
  });
});

test('un seul signal ne suffit JAMAIS à écarter quelqu’un', async (t) => {
  /* C'est la garantie qui protège les vrais clients. Chaque cas ci-dessous a
     été relevé dans la base de production. */

  await t.test('un client italien au téléphone sans indicatif', () => {
    const italien = {
      firstName: 'Daniela', lastName: 'Di Niquilo', phone: '3462874521',
      vehicle: 'Fiat 500', message: 'Buongiorno, cerco un cambio per la mia Fiat 500 del 2015.',
      hasFormTimestamp: true,
    };
    assert.deepEqual(filtre.signaux(italien), ['telephone_etranger']);
    assert.equal(filtre.estSpam(italien), false);
  });

  await t.test('un client marocain', () => {
    const m = { firstName: 'Melendi', lastName: 'lahoua', phone: '212661600543',
      vehicle: 'Renault Clio', message: 'Bonjour, avez-vous une boîte pour Clio 4 ?', hasFormTimestamp: true };
    assert.equal(filtre.estSpam(m), false);
  });

  await t.test('un client dont le nom finit vraiment par « dom »', () => {
    /* Des patronymes existent : Vandom, Beldom. Sans second signal, on passe. */
    const c = { firstName: 'Pierre', lastName: 'Vandom', phone: '0612345678',
      vehicle: 'Peugeot 308', message: 'Bonjour, je cherche une boîte pour ma 308.', hasFormTimestamp: true };
    assert.deepEqual(filtre.signaux(c), ['nom_suffixe_dom']);
    assert.equal(filtre.estSpam(c), false);
  });

  await t.test('un visiteur qui bloque les cookies', () => {
    /* Pas de cookie d'affichage = un signal, jamais une condamnation. */
    const c = { firstName: 'Didier', lastName: 'Franck', phone: '0784279293',
      vehicle: 'Audi A4', message: 'Bonjour, je cherche une boîte DSG7 pour mon Audi A4 2.0 TDI.',
      hasFormTimestamp: false };
    assert.deepEqual(filtre.signaux(c), ['formulaire_jamais_affiche']);
    assert.equal(filtre.estSpam(c), false);
  });

  await t.test('une demande courte, mais avec le véhicule renseigné', () => {
    /* « demande creuse » exige AUSSI l'absence de véhicule, plaque et réf. */
    const c = { firstName: 'Marc', lastName: 'Petit', phone: '0612345678',
      vehicle: 'BMW X5 E53', message: 'Prix ?', hasFormTimestamp: true };
    assert.equal(filtre.estSpam(c), false);
  });
});

test('un client français typique ne déclenche aucun signal', async (t) => {
  await t.test('cas nominal', () => {
    const c = {
      firstName: 'Didier', lastName: 'Franck', phone: '0784279293', vehicle: 'Audi A4 B8',
      message: 'Bonjour, je cherche une boîte DSG7 pour mon Audi A4 2.0 TDI de 2013, pouvez-vous me faire un devis ?',
      hasFormTimestamp: true,
    };
    assert.deepEqual(filtre.signaux(c), []);
  });

  await t.test('les formats de téléphone français sont tous acceptés', () => {
    for (const tel of ['0784279293', '+33784279293', '33784279293', '0033784279293',
                       '07 84 27 92 93', '07.84.27.92.93']) {
      assert.equal(filtre.telephoneEtranger(tel), false, tel + ' est français');
    }
  });

  await t.test('un formulaire sans message ni téléphone ne déclenche rien', () => {
    /* Certains parcours ne demandent qu'un e-mail (popup de sortie). */
    assert.deepEqual(filtre.signaux({ email: 'a@b.fr', hasFormTimestamp: true }), []);
    assert.deepEqual(filtre.signaux({}), []);
  });
});
