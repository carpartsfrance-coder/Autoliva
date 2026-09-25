/**
 * Délais de livraison : les textes GÉNÉRAUX du site disent ce que disent les
 * CGV, qui font foi (article 7.2) :
 *   - pièces standards, mécatroniques, calculateurs : expédition sous 24 à
 *     72 heures ouvrées, livraison sous 24 à 72 heures ;
 *   - moteurs, boîtes de vitesses, ponts, boîtes de transfert, ensembles
 *     lourds : expédition sous 3 à 6 jours ouvrés, livraison sous 1 à 4 jours
 *     ouvrés ;
 *   - « sauf indication différente sur la fiche produit ».
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 : la FAQ (et son JSON-LD FAQPage) promettait « 24 à
 * 48 h » pour toute pièce, l'accueil « expédition le jour même » et une
 * « livraison express en 48/72h », le filtre du catalogue « En stock
 * (Expédition 24h) ». Les délais propres à une fiche (shippingDelayText) et
 * les pages d'arrivée Ads ne sont pas concernés : Killian en décide.
 */

const test = require('node:test');
const assert = require('node:assert');

const { getFaqItems } = require('../../src/services/faqContent');

const fr = require('../../src/locales/fr.json');
const de = require('../../src/locales/de.json');

const PROMESSE_EXPRESS = /jour même|selben Tag|24 ?\/ ?48|48 ?\/ ?72|24 à 48|Expédition 24 ?h|Versand in 24/i;

test('FAQ : les délais de l’article 7.2 des CGV, dans la page ET dans le JSON-LD', () => {
  const item = getFaqItems({ phone: '04 00 00 00 00' }).find((q) => /délais de livraison/.test(q.question));
  assert.ok(item, 'la question sur les délais doit rester');
  for (const texte of [item.answer, item.answerPlain]) {
    assert.doesNotMatch(texte, PROMESSE_EXPRESS);
    assert.match(texte, /Sauf délai différent indiqué sur la fiche produit/);
    assert.match(texte, /expédiés sous 24 à 72 heures ouvrées, puis livrés sous 24 à 72 heures/);
    assert.match(texte, /expédiés sous 3 à 6 jours ouvrés, puis livrés sous 1 à 4 jours ouvrés/);
  }
  assert.doesNotMatch(item.answerPlain, /</, 'le JSON-LD reçoit du texte, pas du HTML');
});

test('accueil, catalogue et panier : plus d’expédition le jour même ni en 24 h', async () => {
  for (const [langue, t] of [['fr', fr], ['de', de]]) {
    for (const cle of ['home.expressTitle', 'home.expressDesc', 'listing.inStock', 'cart.shipping24']) {
      assert.doesNotMatch(t[cle], PROMESSE_EXPRESS, `${langue} ${cle} : ${t[cle]}`);
    }
  }
  assert.match(fr['home.expressDesc'], /24 à 72 h ouvrées, 3 à 6 jours ouvrés pour les moteurs, boîtes et ponts/);

  /* Les diapositives d'accueil par défaut sont celles que sert la production
     (aucune n'est en base) ; l'allemande ne passe jamais par la base. */
  const siteSettings = require('../../src/services/siteSettings');
  const diapositives = [...siteSettings.getDefaultHeroSlides(), ...(await siteSettings.getHeroSlidesForDisplay('de'))];
  assert.equal(diapositives.length, 6);
  for (const slide of diapositives) {
    assert.doesNotMatch(slide.description, PROMESSE_EXPRESS, slide.description);
  }
});
