/**
 * Met à jour la fiche existante 20UM05 (Boxer/Ducato/Jumper 2.8 HDi, sku ASY-0900200335) :
 * prix Eden-30, ajout Citroën Jumper, garantie 2 ans, contenu échange standard enrichi.
 * Ne crée PAS de doublon — met à jour l'existante (préserve l'URL/SEO).
 *
 * DRY-RUN par défaut. --apply pour écrire.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const APPLY = process.argv.includes('--apply');
const SKU = 'ASY-0900200335';
const PRICE = 1490; // prix fixé par Killian (Eden = 1392)

const DESC = "Boîte de vitesses manuelle 5 rapports référence 20UM05 pour Peugeot Boxer, Fiat Ducato et Citroën Jumper 2.8 HDi. "
  + "Recommandée en cas de passages difficiles, de rapport qui saute ou de bruit de roulement en charge. "
  + "Reconstruite à zéro kilomètre : entièrement démontée, roulements, joints et pièces d'usure remplacés par des pièces neuves, puis remontée et contrôlée sur banc. "
  + "Fournie en échange standard : vous recevez une boîte reconstruite à zéro kilomètre et nous organisons la récupération de votre ancienne pièce — transport pris en charge, rien à expédier de votre côté. "
  + "Notre avantage décisif : aucune consigne n'est facturée à l'avance, vous ne bloquez pas de trésorerie. "
  + "Reconditionnée en usine certifiée ISO 9001 (les mêmes qui équipent les concessionnaires) et testée sur banc. Installation par un professionnel. Garantie 2 ans.";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  await mongoose.connect(uri);
  const p = await Product.findOne({ sku: SKU }).lean();
  if (!p) { console.log('Fiche introuvable (sku ' + SKU + ')'); await mongoose.disconnect(); return; }
  console.log('Fiche :', p.name, '| prix actuel', (p.priceCents / 100) + '€', '→', PRICE + '€', APPLY ? '' : '(DRY-RUN)');

  const set = {
    name: 'Boîte de vitesses manuelle Peugeot Boxer, Fiat Ducato & Citroën Jumper 2.8 HDi — 20UM05',
    priceCents: PRICE * 100,
    description: DESC,
    shortDescription: "Boîte manuelle 20UM05 pour Boxer/Ducato/Jumper 2.8 HDi en échange standard, reconstruite à zéro kilomètre (usine ISO 9001), testée sur banc, garantie 2 ans, sans consigne à l'avance.",
    keyPoints: [
      'Référence boîte : 20UM05',
      'Type : boîte manuelle 5 rapports',
      "Reconstruite à zéro kilomètre — pièces d'usure remplacées par des neuves",
      'Reconditionnée en usine certifiée ISO 9001 (fournisseur des concessionnaires)',
      'Échange standard, testée sur banc',
      "Livraison + récupération de l'ancienne pièce incluses",
      "Sans consigne facturée à l'avance",
      'Garantie 2 ans',
    ],
    'badges.condition': 'Reconditionnée · Échange standard',
    'badges.cards': ['Testée sur banc', 'Norme ISO 9001', 'Échange standard', "Sans consigne à l'avance"],
    warranty: { months: 24, text: 'Garantie 2 ans, échange standard.' },
    compatibility: [
      { make: 'Peugeot', model: 'Boxer', years: '', engine: '2.8 HDi', kw: 0, ch: 0 },
      { make: 'Fiat', model: 'Ducato', years: '', engine: '2.8 HDi / JTD', kw: 0, ch: 0 },
      { make: 'Citroën', model: 'Jumper', years: '', engine: '2.8 HDi', kw: 0, ch: 0 },
    ],
    faqs: [
      { question: "Cette boîte 20UM05 est-elle compatible avec mon Boxer / Ducato / Jumper 2.8 ?", answer: "Communiquez-nous votre plaque d'immatriculation ou le code de votre boîte d'origine : nous confirmons la compatibilité avant expédition." },
      { question: "Y a-t-il une consigne à payer ?", answer: "Non, aucune consigne n'est facturée à l'avance — vous restituez simplement l'ancienne boîte après montage, dans le cadre de l'échange standard." },
      { question: "Quelle est la garantie ?", answer: "Cette boîte reconstruite à zéro kilomètre en usine (norme ISO 9001) et testée sur banc est garantie 2 ans." },
    ],
  };

  console.log('\nAperçu des changements :');
  console.log('  nom →', set.name);
  console.log('  prix →', PRICE + '€ (Eden = 1392€)');
  console.log('  compat → Boxer + Ducato + Citroën Jumper (ajouté)');
  console.log('  garantie → 2 ans (24 mois)');

  if (!APPLY) { console.log('\n🟢 DRY-RUN — rien modifié. Relance avec --apply.'); await mongoose.disconnect(); return; }
  await Product.updateOne({ sku: SKU }, { $set: set });
  console.log('\n✅ Fiche 20UM05 mise à jour.');
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
