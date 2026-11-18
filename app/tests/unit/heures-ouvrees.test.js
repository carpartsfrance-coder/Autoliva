/* Heures ouvrées Autoliva (lun–ven 9–12 / 14–18, Paris, hors fériés). */
const test = require('node:test');
const assert = require('node:assert');
const h = require('../../src/services/heuresOuvrees');

const paris = (d) => new Date(d).toLocaleString('fr-FR', {
  timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

test('une demande doit être traitée dans l’heure OUVRÉE', () => {
  /* Le 16/11/2026 est un lundi (heure d'hiver : Paris = UTC+1). */
  const cas = [
    ['2026-11-16T08:15:00Z', 'lun. 16/11 10:15'], // 9 h 15 → 10 h 15
    ['2026-11-16T10:40:00Z', 'lun. 16/11 14:40'], // 11 h 40 → pause midi → 14 h 40
    ['2026-11-16T12:10:00Z', 'lun. 16/11 15:00'], // 13 h 10 (fermé) → 14 h + 60
    ['2026-11-20T16:45:00Z', 'lun. 23/11 09:45'], // vendredi 17 h 45 → lundi 9 h 45
    ['2026-11-21T09:00:00Z', 'lun. 23/11 10:00'], // samedi → lundi 10 h
    ['2026-11-10T16:30:00Z', 'jeu. 12/11 09:30'], // mardi 17 h 30, mercredi 11/11 férié
  ];
  for (const [recu, attendu] of cas) {
    assert.equal(paris(h.ajouterMinutesOuvrees(new Date(recu), 60)), attendu, recu);
  }
});

test('l’heure d’été est respectée', () => {
  /* 1er juillet 2026 (mercredi), Paris = UTC+2 : 9 h 30 locale = 7 h 30 UTC. */
  assert.equal(paris(h.ajouterMinutesOuvrees(new Date('2026-07-01T07:30:00Z'), 60)), 'mer. 01/07 10:30');
  assert.equal(h.estOuvert(new Date('2026-07-01T07:30:00Z')), true);
  assert.equal(h.estOuvert(new Date('2026-07-01T06:30:00Z')), false); // 8 h 30
});

test('jours fériés français', () => {
  const f = h.feriesAnnee(2026);
  for (const j of ['2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08', '2026-05-14', '2026-05-25',
                   '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-25']) {
    assert.ok(f.has(j), j);
  }
  assert.equal(f.size, 11);
  assert.ok(h.feriesAnnee(2027).has('2027-03-29')); // lundi de Pâques 2027
});

test('jours ouvrés et minutes ouvrées écoulées', () => {
  // vendredi 20/11 11 h + 2 jours ouvrés = mardi 24/11 11 h
  assert.equal(paris(h.ajouterJoursOuvres(new Date('2026-11-20T10:00:00Z'), 2)), 'mar. 24/11 11:00');
  // vendredi 17 h → lundi 10 h 30 : 60 min vendredi + 90 min lundi
  assert.equal(h.minutesOuvreesEntre(new Date('2026-11-20T16:00:00Z'), new Date('2026-11-23T09:30:00Z')), 150);
  assert.equal(h.minutesOuvreesEntre(new Date('2026-11-23T09:30:00Z'), new Date('2026-11-20T16:00:00Z')), 0);
});

test('calcul direct = calcul de référence (Intl), heure d’été comprise', () => {
  /* La version Intl prenait 28 s pour la file réelle ; le calcul direct doit
     donner exactement les mêmes résultats. 5 000 instants sur 3 ans. */
  const { partiesParis } = require('../../src/services/heureParis');
  let graine = 42;
  const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
  for (let k = 0; k < 5000; k += 1) {
    const t = new Date(Date.UTC(2025, 0, 1) + Math.floor(hasard() * 3 * 365 * 86400000));
    const p = partiesParis(t);
    const local = p.heure * 60 + p.minute;
    const cle = `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
    const attendu = p.jourSemaine >= 1 && p.jourSemaine <= 5 && !h.feriesAnnee(p.annee).has(cle)
      && ((local >= 540 && local < 720) || (local >= 840 && local < 1080));
    assert.equal(h.estOuvert(t), attendu, t.toISOString());
  }
});

test('rapide : 3 000 dossiers vieux de plusieurs mois en moins d’une seconde', () => {
  const { computeWork } = require('../../src/services/leadWork');
  const now = new Date('2026-11-18T09:30:00Z');
  const debut = Date.now();
  for (let i = 0; i < 3000; i += 1) {
    const recu = new Date(now.getTime() - ((i % 200) + 1) * 86400000);
    computeWork({ captureSource: 'devis', phone: '0611', abandonedAt: recu, manualStatus: i % 5 ? null : 'contacted', manualStatusAt: recu }, now);
  }
  assert.ok(Date.now() - debut < 1000, `trop lent : ${Date.now() - debut} ms`);
});
