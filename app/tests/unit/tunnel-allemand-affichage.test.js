/**
 * Tests unitaires — ce que le tunnel allemand AFFICHE (revue du 17/09/2026).
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Les rendus complets sont couverts par tests/integration/
 * tunnel-allemand-commande.test.js. Ici, les règles elles-mêmes :
 *   - la consigne NON encaissée rappelée avant la commande (§ 312j BGB) ;
 *   - le délai de livraison choisi selon le PAYS, partagé tunnel / commande ;
 *   - le pays d'une adresse affiché en allemand, la valeur stockée intacte ;
 *   - la raison d'un code promo refusé dans la langue du visiteur ;
 *   - une redirection /de → français qui ne coûte pas la langue (revue 2) ;
 *   - le menu déroulant du header traduit et pointant sur les URL /de ;
 *   - un n° de TVA UE reconnu sur son format réel, pas sur « 2 lettres + … » ;
 *   - la typographie du résumé d'options (« Label: valeur » en allemand) ;
 *   - la bannière de suggestion de langue, réservée au navigateur qui la demande ;
 *   - les deux fichiers de langue : mêmes clés, mêmes paramètres.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ejs = require('ejs');

/** Le contenu du <script> d'une vue qui contient `marqueur` (le code réellement servi). */
function fsScript(fichier, marqueur) {
  const blocs = fs.readFileSync(fichier, 'utf8').match(/<script>[\s\S]*?<\/script>/g) || [];
  const bloc = blocs.find((b) => b.includes(marqueur));
  assert.ok(bloc, `aucun <script> contenant « ${marqueur} » dans ${path.basename(fichier)}`);
  return bloc.replace(/^<script>/, '').replace(/<\/script>$/, '');
}

const pricing = require('../../src/services/pricing');
const { cleDelaiLivraison } = require('../../src/services/shippingPricing');
const { countryLabelFor } = require('../../src/config/shippingZones');
const { promoReasonMessage } = require('../../src/services/promoCodes');
const productOptions = require('../../src/services/productOptions');
const { t, redirectionFrGardantLaLangue } = require('../../src/services/i18n');
const { estFormatTvaUe } = require('../../src/services/viesValidator');
const { intituleNumeroEntreprise } = require('../../src/services/invoicePdf');
const { buildSuggestPayload } = require('../../src/services/search');
const fr = require('../../src/locales/fr.json');
const de = require('../../src/locales/de.json');

const produit = (consigne, extra = {}) => ({ name: 'Mechatronik DQ250', consigne, ...extra });

test('consigne conditionnelle : les lignes à rappeler avant la commande', async (t2) => {
  await t2.test('seules les consignes actives NON encaissées sont listées, au montant × quantité', () => {
    const lignes = pricing.listConditionalConsigneLines([
      { product: produit({ enabled: true, amountCents: 15000, delayDays: 15, chargeUpfront: false }), quantity: 2 },
      { product: produit({ enabled: true, amountCents: 9900, delayDays: 30, chargeUpfront: true }), quantity: 1 },
      { product: produit({ enabled: false, amountCents: 40000, delayDays: 30 }), quantity: 1 },
      { product: produit({ enabled: true, amountCents: 0, delayDays: 30 }), quantity: 1 },
      { product: produit(undefined), quantity: 1 },
      null,
    ]);
    assert.deepEqual(lignes, [{ name: 'Mechatronik DQ250', quantity: 2, amountCents: 30000, delayDays: 15 }]);
  });

  await t2.test('un délai absent ou nul vaut 30 jours, comme sur la fiche', () => {
    const [ligne] = pricing.listConditionalConsigneLines([{ product: produit({ enabled: true, amountCents: 100, delayDays: 0 }), quantity: 1 }]);
    assert.equal(ligne.delayDays, 30);
  });

  await t2.test('le partial affiche le texte traduit, le nom seulement s’il y a plusieurs lignes', async () => {
    const fichier = path.join(__dirname, '../../src/views/partials/consigne-conditionnelle.ejs');
    const une = await ejs.renderFile(fichier, {
      lignes: [{ name: 'Mechatronik', quantity: 1, amountCents: 15000, delayDays: 15 }],
      t: (cle, params) => t('de', cle, params),
    });
    assert.match(une, /Altteilrückgabe innerhalb von 15 Tagen nach Erhalt erforderlich – sonst berechnen wir 150,00 €/);
    assert.doesNotMatch(une, /<strong>Mechatronik<\/strong>/);
    const deux = await ejs.renderFile(fichier, {
      lignes: [{ name: 'A', quantity: 1, amountCents: 100, delayDays: 15 }, { name: 'B', quantity: 1, amountCents: 200, delayDays: 30 }],
      t: (cle, params) => t('fr', cle, params),
    });
    assert.match(deux, /<strong>B<\/strong> — Retour de l’ancienne pièce obligatoire sous 30 jours après réception – sinon 2,00 € vous seront facturés/);
    assert.equal((await ejs.renderFile(fichier, { lignes: [], t })).trim(), '');
  });
});

test('délai de livraison : selon le pays de destination', () => {
  /* Le bandeau « expédiée » suivait la LANGUE : un client autrichien lisait
     4-6 jours au paiement puis 2–4 jours une fois la commande partie. */
  assert.equal(cleDelaiLivraison({ country: 'France', postalCode: '75001' }), 'shipping.homeDesc');
  assert.equal(cleDelaiLivraison({ country: 'Allemagne', postalCode: '10115' }), 'shipping.homeDescGermany');
  assert.equal(cleDelaiLivraison({ country: 'DE' }), 'shipping.homeDescGermany');
  assert.equal(cleDelaiLivraison({ country: 'Autriche', postalCode: '1010' }), 'shipping.homeDescEurope');
  assert.equal(cleDelaiLivraison({ country: 'France', postalCode: '20000' }), 'shipping.homeDescEurope');
  assert.equal(cleDelaiLivraison(undefined), 'shipping.homeDesc');
  /* Le tunnel ne connaît pas le délai d'expédition de la pièce : il ne promet
     que le transport. */
  assert.equal(t('de', 'shipping.homeDescGermany'), 'Zustellung 2–4 Werktage nach Versand');
  assert.equal(t('fr', 'shipping.homeDescGermany'), 'Livraison en 2 à 4 jours ouvrés après expédition');
});

test('pays d’une adresse : affiché en allemand, jamais modifié pour le français', () => {
  assert.equal(countryLabelFor('Allemagne', 'de'), 'Deutschland');
  assert.equal(countryLabelFor('Autriche', 'de'), 'Österreich');
  assert.equal(countryLabelFor('France', 'de'), 'Frankreich');
  assert.equal(countryLabelFor('DE', 'de'), 'Deutschland');
  assert.equal(countryLabelFor('allemagne', 'de'), 'Deutschland');
  assert.equal(countryLabelFor('Narnia', 'de'), 'Narnia');
  assert.equal(countryLabelFor('Allemagne', 'fr'), 'Allemagne');
  assert.equal(countryLabelFor('', 'de'), '');
});

test('code promo refusé : la raison dans la langue du visiteur', () => {
  assert.equal(promoReasonMessage({ ok: false, reason: 'Code promo introuvable.', reasonKey: 'promo.errNotFound' }, 'de'), 'Dieser Gutscheincode existiert nicht.');
  assert.equal(promoReasonMessage({ ok: false, reason: 'Code promo introuvable.', reasonKey: 'promo.errNotFound' }, 'fr'), 'Code promo introuvable.');
  assert.equal(
    promoReasonMessage({ ok: false, reasonKey: 'promo.errMinSubtotal', reasonParams: { amount: '50,00' } }, 'de'),
    'Mindestbestellwert: 50,00 €'
  );
  /* Raison sans clé (appelant ancien) : la phrase telle quelle, jamais vide. */
  assert.equal(promoReasonMessage({ ok: false, reason: 'Autre refus' }, 'de'), 'Autre refus');
  assert.equal(promoReasonMessage({ ok: false }, 'de'), 'Ungültiger Gutscheincode.');
});

test('option manquante : erreur structurée pour la reformuler dans la langue du visiteur', () => {
  const r = productOptions.buildSelectionFromBody({}, [
    { key: 'prog', label: 'Programmation', type: 'choice', required: true, choices: [{ key: 'oui', label: 'Oui' }] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0], 'Merci de choisir : Programmation', 'le message français existant ne change pas');
  assert.deepEqual(r.errorDetails, [{ kind: 'choice', key: 'prog', label: 'Programmation' }]);
});

test('fichiers de langue : mêmes clés, mêmes paramètres', () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(fr).sort(), 'clés différentes entre fr.json et de.json');
  const params = (v) => (String(v).match(/%[a-zA-Z]+%/g) || []).sort().join(',');
  const ecarts = Object.keys(fr).filter((k) => params(fr[k]) !== params(de[k]));
  /* Écarts antérieurs à cette revue, volontaires (formulation sans montant) : on
     ne vérifie que les clés du tunnel allemand. */
  const cles = Object.keys(fr).filter((k) => /^(checkout\.(err|core|login)|promo\.|cart\.(err|save|productFallback)|account\.(reset|err|dashboard|tracking)|product\.(faqA2|exStep4|plusDeposit|priceInfoDe))/.test(k));
  assert.deepEqual(ecarts.filter((k) => cles.includes(k)), [], 'paramètres %…% différents entre les deux langues');
  /* Le délai de retour de l'étape 4 est celui de la fiche. */
  assert.match(fr['product.exStep4Text'], /%days%/);
  assert.match(de['product.exStep4Text'], /%days%/);
});

const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

test('redirection /de → page française : la langue survit au 301', async (t2) => {
  const req = (ua) => ({ headers: { 'user-agent': ua } });

  await t2.test('un visiteur garde l’allemand (?lang=de, que le middleware sait lire)', () => {
    assert.equal(redirectionFrGardantLaLangue(req(UA_CHROME), '/moteurs'), '/moteurs?lang=de');
    assert.equal(redirectionFrGardantLaLangue(req(UA_CHROME), '/legal/cgv'), '/legal/cgv?lang=de');
  });

  await t2.test('une cible qui a déjà des paramètres reste valide', () => {
    assert.equal(redirectionFrGardantLaLangue(req(UA_CHROME), '/produits?q=dq200'), '/produits?q=dq200&lang=de');
  });

  await t2.test('un robot suit l’URL française NUE (rien de nouveau à explorer)', () => {
    assert.equal(redirectionFrGardantLaLangue(req(UA_GOOGLEBOT), '/moteurs'), '/moteurs');
    assert.equal(redirectionFrGardantLaLangue({ headers: {} }, '/moteurs'), '/moteurs');
  });
});

test('menu déroulant du header : traduit et pointant sur les URL allemandes', async (t2) => {
  const fiche = {
    _id: '6500000000000000000000aa',
    name: 'Mécatronique DSG7 DQ200',
    slug: 'mecatronique-dsg7-dq200',
    sku: '0AM325025',
    brand: 'VAG',
    priceCents: 129000,
    category: 'Mécatroniques & calculateurs',
    localizations: { de: { name: 'Mechatronik DSG7 DQ200', slug: 'mechatronik-dsg7-dq200', translatedAt: new Date() } },
  };
  const ranked = [{ product: fiche, score: 10 }];

  await t2.test('en allemand : nom traduit, fiche /de, sections et facettes /de', () => {
    const p = buildSuggestPayload([], 'dq200', { ranked, lang: 'de' });
    assert.equal(p.sections[0].title, 'Produkte');
    assert.equal(p.sections[0].items[0].name, 'Mechatronik DSG7 DQ200');
    assert.equal(p.sections[0].items[0].publicPath, '/de/produits/mechatronik-dsg7-dq200-6500000000000000000000aa');
    const categories = p.sections.find((x) => x.type === 'categories');
    assert.equal(categories.title, 'Kategorien');
    assert.match(categories.items[0].href, /^\/de\/produits\?/);
    /* La VALEUR du filtre reste le nom français stocké sur la fiche. */
    assert.match(categories.items[0].href, /mainCategory=M%C3%A9catroniques/);
  });

  await t2.test('en français : rien ne bouge', () => {
    const p = buildSuggestPayload([], 'dq200', { ranked });
    assert.equal(p.sections[0].title, 'Produits');
    assert.equal(p.sections[0].items[0].name, 'Mécatronique DSG7 DQ200');
    assert.equal(p.sections[0].items[0].publicPath, '/product/mecatronique-dsg7-dq200/');
    assert.match(p.sections.find((x) => x.type === 'categories').items[0].href, /^\/produits\?/);
  });
});

test('n° de TVA intracommunautaire : reconnu sur le format RÉEL du pays', async (t2) => {
  await t2.test('de vrais numéros sont acceptés, espaces et points compris', () => {
    for (const n of ['DE123456789', 'DE 123.456-789', 'ATU12345678', 'NL123456789B01', 'FR12345678901']) {
      assert.equal(estFormatTvaUe(n), true, n);
    }
  });

  await t2.test('un numéro de registre du commerce allemand n’en est PAS un', () => {
    /* « HRB 123456 » : le motif « 2 lettres + 2 à 12 caractères » y voyait un
       n° croate (préfixe HR). Le numéro partait dans vatNumberEu, `siret` était
       vidé, et la facture — qui ne lit que `siret` — n'imprimait plus rien. */
    assert.equal(estFormatTvaUe('HRB 123456'), false);
    assert.equal(estFormatTvaUe('HRA 98765'), false);
    /* Un vrai n° croate fait 11 chiffres. */
    assert.equal(estFormatTvaUe('HR12345678901'), true);
  });

  await t2.test('un SIRET français n’en est pas un non plus', () => {
    assert.equal(estFormatTvaUe('123 456 789 00012'), false);
    assert.equal(estFormatTvaUe(''), false);
  });

  await t2.test('la facture choisit l’intitulé, elle n’exige plus que `siret` soit vidé', () => {
    /* Vider `siret` faisait disparaître le numéro de la facture (c'est le seul
       champ qu'elle lit) et bloquait /compte/profil, qui l'exige pour un compte
       pro — y compris pour un pro FRANÇAIS ayant tapé son n° de TVA. */
    assert.equal(intituleNumeroEntreprise('FR32123456789'), 'N° TVA');
    assert.equal(intituleNumeroEntreprise('DE 123 456 789'), 'N° TVA');
    assert.equal(intituleNumeroEntreprise('80012345600015'), 'SIRET');
    assert.equal(intituleNumeroEntreprise('HRB 123456'), 'SIRET');
    assert.equal(intituleNumeroEntreprise(''), 'SIRET');
  });
});

test('bannière de suggestion de langue : proposée au seul navigateur qui la demande', async (t2) => {
  const gabarit = path.join(__dirname, '..', '..', 'src', 'views', 'partials', 'lang-suggest.ejs');
  const rendre = (lang, pref) => ejs.renderFile(gabarit, {
    lang,
    browserLangPref: pref,
    langSuggestHidden: false,
    hreflangTags: [{ lang: 'fr', href: '/product/piece/' }, { lang: 'de', href: '/de/produits/teil-1' }],
  });

  await t2.test('page allemande : rien pour un navigateur anglais, néerlandais ou polonais', async () => {
    /* « tout sauf de » plaçait un bandeau FRANÇAIS — et un bouton qui fait
       basculer session, paiement, Order.lang et e-mails — au-dessus du prix,
       pour un visiteur qui n'a jamais demandé le français. */
    for (const pref of ['en', 'nl', 'pl', 'tr', '']) {
      assert.equal((await rendre('de', pref)).includes('lang-suggest'), false, `bandeau affiché pour « ${pref} »`);
    }
  });

  await t2.test('page allemande : proposée au navigateur francophone', async () => {
    const html = await rendre('de', 'fr');
    assert.ok(html.includes('Cette page est aussi disponible en français.'));
    assert.ok(html.includes('href="/product/piece/"'));
  });

  await t2.test('page française : l’allemand reste proposé au navigateur allemand', async () => {
    assert.ok((await rendre('fr', 'de')).includes('Diese Seite ist auch auf Deutsch verfügbar.'));
    assert.equal((await rendre('fr', 'en')).includes('lang-suggest'), false);
  });
});

test('résumé d’options : la typographie suit la langue', async (t2) => {
  const options = [{ key: 'prog', label: 'Programmierung', type: 'choice', choices: [{ key: 'avec', label: 'Mit Programmierung' }] }];

  await t2.test('allemand : pas d’espace avant les deux-points', () => {
    const d = productOptions.buildOptionsDisplay(options, { prog: 'avec' }, 'de');
    assert.equal(d.optionsSummary, 'Programmierung: Mit Programmierung');
  });

  await t2.test('français : la règle française ne change pas', () => {
    const d = productOptions.buildOptionsDisplay(
      [{ key: 'prog', label: 'Programmation', type: 'choice', choices: [{ key: 'avec', label: 'Avec programmation' }] }],
      { prog: 'avec' }
    );
    assert.equal(d.optionsSummary, 'Programmation : Avec programmation');
  });
});

test('auto-complétion « code postal → ville » : réservée à la France', async (t2) => {
  /* geo.api.gouv.fr ne connaît que les communes FRANÇAISES, mais le script se
     déclenchait sur toute saisie de 5 chiffres — le format d'une PLZ. La ville
     tapée par l'acheteur allemand était écrasée en silence : 38100
     Braunschweig → « Grenoble » (652 des 10 813 PLZ allemandes entrent en
     collision avec un code postal français). On exécute ici le script
     réellement servi par la vue, dans un DOM minimal. */
  const source = fsScript(path.join(__dirname, '../../src/views/checkout/shipping.ejs'), 'geo.api.gouv.fr');

  const element = (attrs = {}) => {
    const el = {
      attributs: { ...attrs },
      ecouteurs: {},
      value: '',
      getAttribute: (n) => (Object.prototype.hasOwnProperty.call(el.attributs, n) ? el.attributs[n] : null),
      setAttribute: (n, v) => { el.attributs[n] = String(v); },
      removeAttribute: (n) => { delete el.attributs[n]; },
      addEventListener: (type, fn) => { (el.ecouteurs[type] = el.ecouteurs[type] || []).push(fn); },
      declencher: (type) => { (el.ecouteurs[type] || []).forEach((fn) => fn()); },
    };
    return el;
  };

  /* Un formulaire d'adresse : code postal + ville + (éventuel) sélecteur pays. */
  const monter = (pays) => {
    const cp = element({ maxlength: pays === null || pays === 'France' ? '5' : undefined });
    if (cp.attributs.maxlength === undefined) delete cp.attributs.maxlength;
    const ville = element();
    const select = pays === null ? null : Object.assign(element(), { value: pays });
    const form = {
      querySelector: (sel) => {
        if (sel === '[data-autocomplete-city]') return ville;
        if (sel === 'select[name="country"]') return select;
        return null;
      },
    };
    cp.closest = () => form;

    const appels = [];
    const contexte = {
      document: { querySelectorAll: () => [cp] },
      fetch: (url) => {
        appels.push(String(url));
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ nom: 'Grenoble' }]) });
      },
    };
    vm.runInNewContext(source, contexte);
    return { cp, ville, select, appels };
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  await t2.test('adresse allemande : aucun appel à l’API française, la ville reste celle saisie', async () => {
    const { cp, ville, appels } = monter('Allemagne');
    ville.value = 'Braunschweig';
    cp.value = '38100';
    cp.declencher('input');
    await tick();
    assert.deepEqual(appels, [], 'appel à geo.api.gouv.fr depuis une adresse allemande');
    assert.equal(ville.value, 'Braunschweig');
    assert.equal(cp.getAttribute('maxlength'), null, 'maxlength français imposé hors France');
  });

  await t2.test('adresse française : le comportement d’origine est intact', async () => {
    const { cp, ville, appels } = monter('France');
    cp.value = '38100';
    cp.declencher('input');
    await tick();
    assert.deepEqual(appels, ['https://geo.api.gouv.fr/communes?codePostal=38100&fields=nom&limit=5']);
    assert.equal(ville.value, 'Grenoble');
    assert.equal(cp.getAttribute('maxlength'), '5');
  });

  await t2.test('changement de pays : le garde-fou suit sans recharger la page', async () => {
    const { cp, ville, select, appels } = monter('France');
    select.value = 'Allemagne';
    select.declencher('change');
    assert.equal(cp.getAttribute('maxlength'), null);
    ville.value = 'Trier';
    cp.value = '54290';
    cp.declencher('input');
    await tick();
    assert.deepEqual(appels, [], 'appel maintenu après bascule vers l’Allemagne');
    assert.equal(ville.value, 'Trier');

    select.value = 'France';
    select.declencher('change');
    assert.equal(cp.getAttribute('maxlength'), '5');
    cp.value = '54290';
    cp.declencher('input');
    await tick();
    assert.equal(appels.length, 1, 'retour en France : l’auto-complétion ne repart pas');
    assert.equal(ville.value, 'Grenoble');
  });

  await t2.test('formulaire sans sélecteur de pays : comportement français historique', async () => {
    const { cp, ville, appels } = monter(null);
    cp.value = '75001';
    cp.declencher('input');
    await tick();
    assert.equal(appels.length, 1);
    assert.equal(ville.value, 'Grenoble');
  });
});

test('typographie allemande : aucune espace avant une ponctuation double', () => {
  /* La règle « espace avant : ; ! ? » est FRANÇAISE. productOptions l'applique
     déjà par langue ; il restait `checkout.compatCheckText`, rendu « Erforderlich :
     Wir prüfen… » juste au-dessus du champ FIN de la page de paiement. */
  const fautifs = Object.entries(de).filter(([, v]) => typeof v === 'string' && /[   ][:;!?]/.test(v));
  assert.deepEqual(fautifs, [], `espace avant une ponctuation double en allemand : ${JSON.stringify(fautifs)}`);
  assert.ok(de['checkout.compatCheckText'].startsWith(': Wir prüfen'));
  /* Le français, lui, garde sa propre règle. */
  assert.ok(fr['checkout.compatCheckText'].startsWith(' : nous vérifions'));
});

test('libellés de l’autocomplétion de recherche : plus rien en dur dans le JS', () => {
  const js = fs.readFileSync(path.join(__dirname, '../../public/js/search-autocomplete.js'), 'utf8');
  /* Le français subsiste UNIQUEMENT en repli de `tr(clé, repli)` : on retire ces
     appels, puis on vérifie qu'il ne reste plus un seul libellé en dur. */
  const sansReplis = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/tr\('[\w.]+', '[^']*'\)/g, 'tr()');
  for (const enDur of ['Réf', 'Produit', 'Marque véhicule', 'Catégorie', 'résultat', 'Voir tous les résultats', 'Voir le catalogue']) {
    assert.ok(!sansReplis.includes(enDur), `libellé français encore en dur : « ${enDur} »`);
  }
  /* Et chaque repli reproduit exactement le texte français d'avant. */
  for (const [cle, repli] of [['ref', 'Réf:'], ['product', 'Produit'], ['vehicleMake', 'Marque véhicule'],
    ['category', 'Catégorie'], ['countResult', '%count% résultat'], ['countResults', '%count% résultats'],
    ['allResultsFor', 'Voir tous les résultats pour "%q%"']]) {
    assert.ok(js.includes(`tr('${cle}', '${repli}')`), `repli français absent ou modifié pour « ${cle} »`);
  }
  /* Les clés lues par le script existent dans les DEUX langues. */
  for (const cle of ['cart.ref', 'cart.productFallback', 'listing.vehicleMake', 'listing.category',
    'search.countResult', 'search.countResults', 'search.allResultsFor']) {
    assert.ok(fr[cle] && de[cle], `clé manquante : ${cle}`);
  }
  assert.ok(fr['search.countResults'].includes('%count%') && de['search.countResults'].includes('%count%'));
  assert.ok(fr['search.allResultsFor'].includes('%q%') && de['search.allResultsFor'].includes('%q%'));
  /* Le lien « tout voir » n'est plus réécrit en « /produits » : le script
     repart du href rendu par EJS, qui porte le préfixe de langue. */
  assert.ok(!js.includes("('/produits?q='"), 'lien « tout voir » encore forcé sur le catalogue français');
});
