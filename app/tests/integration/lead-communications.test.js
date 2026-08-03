/**
 * Tests d'intégration — journal des communications d'un lead.
 *
 * Lancé par : npm test
 *
 * Environnement requis :
 *   TEST_MONGODB_URI : connexion à un MongoDB DE TEST.
 *
 * ⚠ Ne retombe PAS sur `MONGODB_URI` : dans ce dépôt, cette variable pointe
 * l'Atlas de PRODUCTION. Nettoyage par identifiants collectés, jamais
 * `dropDatabase`.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_MONGODB_URI || '';

process.env.BREVO_API_KEY = '';
process.env.MAILERSEND_API_KEY = '';

const AbandonedCart = require('../../src/models/AbandonedCart');
const { journaliser, historique, resume } = require('../../src/services/leadCommunications');

const aSupprimer = [];

async function creerLead(champs = {}) {
  const lead = await AbandonedCart.create(Object.assign({
    sessionId: 'test-comm-' + aSupprimer.length + '-' + champs.marqueur,
    email: 'test-comm@example.com',
    isGuest: true,
    status: 'abandoned',
    abandonedAt: new Date(),
    lastActivityAt: new Date(),
  }, champs.doc || {}));
  aSupprimer.push(lead._id);
  return lead;
}

const D = (iso) => new Date(iso);

test('journal des communications', { skip: URI ? false : 'TEST_MONGODB_URI absent' }, async (t) => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000 });
  t.after(async () => {
    await AbandonedCart.deleteMany({ _id: { $in: aSupprimer } });
    await mongoose.disconnect();
  });

  /* ── Écriture ──────────────────────────────────────────────────────────── */

  await t.test('un envoi réussi est enregistré avec son contenu', async () => {
    const lead = await creerLead({ marqueur: 'a' });
    const ok = await journaliser(lead._id, {
      canal: 'sms', corps: 'Bonjour, votre devis vous attend.', par: 'Charles', gabarit: 'relance_1',
    });
    assert.equal(ok, true);

    const relu = await AbandonedCart.findById(lead._id).lean();
    assert.equal(relu.communications.length, 1);
    const c = relu.communications[0];
    assert.equal(c.canal, 'sms');
    assert.equal(c.sens, 'sortant');
    assert.equal(c.statut, 'envoye');
    assert.equal(c.corps, 'Bonjour, votre devis vous attend.');
    assert.equal(c.par, 'Charles');
    assert.equal(c.auto, false);
  });

  await t.test('un échec est enregistré avec son motif', async () => {
    const lead = await creerLead({ marqueur: 'b' });
    await journaliser(lead._id, { canal: 'sms', ok: false, motif: 'credits_epuises', auto: true });

    const relu = await AbandonedCart.findById(lead._id).lean();
    assert.equal(relu.communications[0].statut, 'echec');
    assert.equal(relu.communications[0].motif, 'credits_epuises');
    /* Sans nom d'expéditeur, un envoi automatique s'attribue au système. */
    assert.equal(relu.communications[0].par, 'Système');
  });

  await t.test('un canal inconnu est refusé plutôt qu’écrit de travers', async () => {
    const lead = await creerLead({ marqueur: 'c' });
    assert.equal(await journaliser(lead._id, { canal: 'pigeon', corps: 'x' }), false);
    const relu = await AbandonedCart.findById(lead._id).lean();
    assert.equal(relu.communications.length, 0);
  });

  await t.test('le journal ne lève jamais, même sur un identifiant absurde', async () => {
    /* Un journal qui explose ferait échouer l'envoi qu'il documente. */
    assert.equal(await journaliser('pas-un-id', { canal: 'sms' }), false);
    assert.equal(await journaliser(null, { canal: 'sms' }), false);
    assert.equal(await journaliser(new mongoose.Types.ObjectId(), { canal: 'sms' }), true);
  });

  await t.test('un contenu très long est tronqué, pas rejeté', async () => {
    const lead = await creerLead({ marqueur: 'd' });
    await journaliser(lead._id, { canal: 'email', corps: 'x'.repeat(5000) });
    const relu = await AbandonedCart.findById(lead._id).lean();
    assert.ok(relu.communications[0].corps.length <= 600);
    assert.ok(relu.communications[0].corps.endsWith('…'));
  });

  /* ── Reconstitution du passé ───────────────────────────────────────────── */

  await t.test('les anciens envois manuels sont relus depuis les notes', async () => {
    const lead = await creerLead({
      marqueur: 'e',
      doc: {
        notes: [
          { text: '📧 Email envoyé [relance_1] : "Votre devis Autoliva"', addedByName: 'Charles', addedAt: D('2026-07-01T10:00:00Z') },
          { text: '📱 SMS envoyé : "Bonjour, avez-vous vu notre devis ?"', addedByName: 'Charles', addedAt: D('2026-07-02T10:00:00Z') },
          { text: '📲 WhatsApp ouvert : "Je vous rappelle demain"', addedByName: 'Charles', addedAt: D('2026-07-03T10:00:00Z') },
          { text: 'Client injoignable, à rappeler jeudi', addedByName: 'Charles', addedAt: D('2026-07-04T10:00:00Z') },
        ],
      },
    });
    const lignes = historique(await AbandonedCart.findById(lead._id).lean());

    /* La note purement interne ne doit PAS être comptée comme un message. */
    assert.equal(lignes.length, 3);
    assert.ok(lignes.every((l) => l.reconstitue));
    const parCanal = Object.fromEntries(lignes.map((l) => [l.canal, l]));
    assert.equal(parCanal.email.objet, 'Votre devis Autoliva');
    assert.equal(parCanal.sms.corps, 'Bonjour, avez-vous vu notre devis ?');
    assert.equal(parCanal.whatsapp.corps, 'Je vous rappelle demain');
  });

  await t.test('les devis envoyés et leur SMS remontent, échecs compris', async () => {
    const lead = await creerLead({
      marqueur: 'f',
      doc: {
        captureSource: 'landing_moteurs',
        engineQuote: {
          status: 'quote_sent',
          sentQuotes: [
            { sentAt: D('2026-07-10T09:00:00Z'), version: 1, sellPriceTtc: 2933, sentByName: 'Charles' },
            {
              sentAt: D('2026-07-15T09:00:00Z'), version: 2, sellPriceTtc: 2700, sentByName: 'Charles',
              sms: { status: 'failed', reason: 'credits_epuises', message: 'Crédits SMS épuisés', at: D('2026-07-15T09:00:05Z') },
            },
          ],
          remindersSent: [{ type: 'j7', sentAt: D('2026-07-17T09:00:00Z') }],
        },
      },
    });
    const lignes = historique(await AbandonedCart.findById(lead._id).lean());

    const devis = lignes.filter((l) => l.gabarit === 'devis');
    assert.equal(devis.length, 3, 'deux devis + le SMS du second');
    const revision = devis.find((l) => l.objet === 'Devis (révision 2)');
    assert.ok(revision, 'la révision doit être identifiée comme telle');
    assert.equal(revision.meta.montant, 2700);

    const smsRate = devis.find((l) => l.canal === 'sms');
    assert.equal(smsRate.statut, 'echec');
    assert.equal(smsRate.motif, 'Crédits SMS épuisés');

    const relance = lignes.find((l) => l.gabarit === 'relance_devis_j7');
    assert.equal(relance.objet, 'Relance devis J+7');
    assert.equal(relance.auto, true);
  });

  await t.test('une relance panier apparaît, en disant que son contenu est perdu', async () => {
    const lead = await creerLead({
      marqueur: 'g',
      doc: {
        lastRemindedAt: D('2026-06-01T08:00:00Z'),
        ringoverSmsSentAt: D('2026-06-02T08:00:00Z'),
        repurchaseReminder: { sentAt: D('2026-06-03T08:00:00Z') },
      },
    });
    const lignes = historique(await AbandonedCart.findById(lead._id).lean());
    assert.equal(lignes.length, 3);

    const panier = lignes.find((l) => l.gabarit === 'relance_panier');
    assert.equal(panier.partiel, true, 'doit être signalé comme incomplet');
    assert.match(panier.corps, /Contenu non conservé/);
    assert.ok(lignes.find((l) => l.gabarit === 'ringover_accuse'));
    assert.ok(lignes.find((l) => l.gabarit === 'reachat'));
  });

  /* ── Fusion ────────────────────────────────────────────────────────────── */

  await t.test('un envoi qui écrit note ET journal n’apparaît qu’une fois', async () => {
    /* C'est le cas pendant la transition : le composeur manuel alimente les
       deux. Sans rapprochement, chaque envoi s'afficherait en double. */
    const quand = D('2026-07-20T14:32:07Z');
    const lead = await creerLead({
      marqueur: 'h',
      doc: { notes: [{ text: '📱 SMS envoyé : "Bonjour"', addedByName: 'Charles', addedAt: quand }] },
    });
    await journaliser(lead._id, { canal: 'sms', corps: 'Bonjour', par: 'Charles', at: quand });

    const lignes = historique(await AbandonedCart.findById(lead._id).lean());
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].reconstitue, false, 'la version du journal doit primer');
  });

  await t.test('deux envois espacés restent deux lignes distinctes', async () => {
    const lead = await creerLead({
      marqueur: 'i',
      doc: { notes: [{ text: '📱 SMS envoyé : "Premier"', addedByName: 'Charles', addedAt: D('2026-07-20T14:00:00Z') }] },
    });
    await journaliser(lead._id, { canal: 'sms', corps: 'Second', par: 'Charles', at: D('2026-07-20T16:00:00Z') });
    const lignes = historique(await AbandonedCart.findById(lead._id).lean());
    assert.equal(lignes.length, 2);
  });

  await t.test('l’historique est trié du plus récent au plus ancien', async () => {
    const lead = await creerLead({ marqueur: 'j' });
    await journaliser(lead._id, { canal: 'email', objet: 'vieux', at: D('2026-01-01T00:00:00Z') });
    await journaliser(lead._id, { canal: 'email', objet: 'recent', at: D('2026-07-01T00:00:00Z') });
    await journaliser(lead._id, { canal: 'sms', corps: 'milieu', at: D('2026-04-01T00:00:00Z') });

    const lignes = historique(await AbandonedCart.findById(lead._id).lean());
    assert.deepEqual(lignes.map((l) => l.objet || l.corps), ['recent', 'milieu', 'vieux']);
  });

  await t.test('les réponses du client figurent au même titre que nos envois', async () => {
    const lead = await creerLead({ marqueur: 'k' });
    await journaliser(lead._id, { canal: 'sms', corps: 'Votre devis est prêt', at: D('2026-07-01T09:00:00Z') });
    await journaliser(lead._id, { canal: 'sms', sens: 'entrant', corps: 'Oui je suis intéressé', par: 'Client', at: D('2026-07-01T09:30:00Z') });

    const lignes = historique(await AbandonedCart.findById(lead._id).lean());
    assert.equal(lignes[0].sens, 'entrant');
    assert.equal(lignes[0].corps, 'Oui je suis intéressé');
  });

  await t.test('le résumé compte ce qu’il faut', async () => {
    const lead = await creerLead({ marqueur: 'l' });
    await journaliser(lead._id, { canal: 'email', objet: 'A', par: 'Charles' });
    await journaliser(lead._id, { canal: 'sms', corps: 'B', auto: true });
    await journaliser(lead._id, { canal: 'sms', corps: 'C', auto: true, ok: false, motif: 'x' });

    const r = resume(historique(await AbandonedCart.findById(lead._id).lean()));
    assert.equal(r.total, 3);
    assert.equal(r.email, 1);
    assert.equal(r.sms, 2);
    assert.equal(r.auto, 2);
    assert.equal(r.manuel, 1);
    assert.equal(r.echecs, 1);
  });

  await t.test('un lead sans aucun échange rend une liste vide, pas une erreur', async () => {
    const lead = await creerLead({ marqueur: 'm' });
    assert.deepEqual(historique(await AbandonedCart.findById(lead._id).lean()), []);
    assert.equal(resume([]).total, 0);
    assert.deepEqual(historique(null), []);
    assert.deepEqual(historique({}), []);
  });
});
