#!/usr/bin/env node

/**
 * Publication / mise à jour des CGV spécifiques au service de clonage TCU.
 * Idempotent : upsert par slug.
 *
 * URL publique : https://autoliva.com/legal/cgv-service-clonage-tcu
 *
 * Le contenu est stocké en plain text dans le modèle LegalPage. Le service
 * legalPages.renderContentHtml l'échappe et linkifie les URLs avant rendu.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const LegalPage = require('../src/models/LegalPage');

const SLUG = 'cgv-service-clonage-tcu';
const TITLE = 'Conditions Générales du Service de Clonage Mécatronique TCU';
const VERSION = 'v1-2026-05-13';

const CONTENT = `Version ${VERSION} — applicable à compter du 13 mai 2026

Les présentes Conditions Générales (ci-après « CG ») régissent exclusivement le « Service de clonage mécatronique TCU DSG & S-tronic » (ci-après « le Service ») proposé sous la marque Autoliva, marque exploitée par Car Parts France. Elles complètent les Conditions Générales de Vente principales accessibles à l'adresse https://autoliva.com/legal/cgv et prévalent sur celles-ci en cas de contradiction concernant le Service.

1. IDENTIFICATION DU PRESTATAIRE

Le Service est fourni par Car Parts France (exploitant les marques « Autoliva » et « CarParts France »), ci-après désignée « le Prestataire ».

Coordonnées commerciales : carparts.france@gmail.com — site web : https://autoliva.com

Les mentions légales complètes (raison sociale, SIRET, adresse postale, numéro de TVA intracommunautaire, capital social, RCS) sont accessibles à l'adresse https://autoliva.com/legal/mentions-legales et complétées dans l'espace administrateur du site.

2. OBJET DU SERVICE

Le Service consiste exclusivement en un transfert logiciel des données du calculateur de transmission (Transmission Control Unit, ci-après « TCU ») d'une mécatronique source — appartenant au véhicule du Client — vers une mécatronique cible. L'opération est strictement logicielle et n'inclut aucune intervention mécanique, ni de diagnostic mécanique, ni de fourniture de pièce.

Le Service couvre les boîtes de vitesses automatiques à double embrayage du Groupe Volkswagen suivantes : DQ200, DQ250, DQ381, DQ500, DQ400e (DSG transversales), DL501, DL382 (S-tronic longitudinales) et DL800. Toute boîte non listée fera l'objet d'un échange préalable entre le Client et le Prestataire avant prise en charge.

3. TARIF ET MODALITÉS DE PAIEMENT

Le prix du Service est de 199 € TTC, prix unique et forfaitaire applicable à toutes les boîtes éligibles listées à l'article 2, quelle que soit la complexité de l'opération.

Sont compris dans le prix : l'opération de clonage logiciel TCU, un test fonctionnel sur banc post-clonage, l'étiquette d'expédition aller pré-payée permettant au Client d'envoyer ses pièces, et l'étiquette d'expédition retour pré-payée permettant la réexpédition des pièces clonées au Client. Aucun frais d'envoi n'est laissé à la charge du Client, ni à l'aller ni au retour.

Ne sont pas compris dans le prix : tout diagnostic mécanique des pièces, le réglage de base et l'apprentissage des points de patinage des embrayages après remontage (à effectuer par le Client ou son réparateur via outils VCDS, ODIS ou équivalent), toute reprogrammation moteur ou flash de performance, la fourniture d'une mécatronique de remplacement.

Le paiement s'effectue intégralement à la commande, par les moyens de paiement proposés sur le site (carte bancaire, virement, financement Scalapay le cas échéant). La commande n'est confirmée qu'après réception complète du paiement.

4. DESCRIPTION OPÉRATIONNELLE — ÉTAPES DU SERVICE

Étape 1 — Commande en ligne. Le Client commande le Service sur le site, sélectionne le modèle de boîte concernée, accepte les présentes CG et procède au paiement.

Étape 2 — Réception de l'étiquette aller. Le Client reçoit par email, sous 24h ouvrées maximum après confirmation du paiement, une étiquette d'expédition aller pré-payée ainsi qu'une fiche d'instructions d'emballage.

Étape 3 — Expédition par le Client. Le Client emballe les DEUX mécatroniques (ou les deux modules TCU) ensemble dans un colis sécurisé, colle l'étiquette aller pré-payée et confie le colis au transporteur conformément aux instructions reçues. Le Client est seul responsable du conditionnement protégeant les pièces des chocs.

Étape 4 — Réception, clonage et test. À réception du colis dans nos ateliers, le Prestataire procède au clonage logiciel TCU sous 24 heures ouvrées maximum, puis effectue un test fonctionnel sur banc.

Étape 5 — Réexpédition. Les deux mécatroniques (ou TCU) sont réexpédiées au Client en colis suivi avec l'étiquette retour pré-payée incluse dans le Service. Le Client est notifié par email avec le numéro de suivi.

Délai total porte-à-porte estimé : 4 à 6 jours ouvrés (1-2 jours aller + 24h ouvrées atelier + 1-2 jours retour).

5. OBLIGATIONS DU CLIENT

Le Client s'engage à :
- fournir des informations véhicule exactes (notamment le numéro d'identification VIN à 17 caractères) au moment de la commande,
- expédier au Prestataire les deux pièces effectivement issues du véhicule identifié par le VIN renseigné,
- emballer les pièces de manière à les protéger des chocs et de l'humidité durant le transport,
- respecter les instructions d'expédition transmises par email.

Le Client garantit être propriétaire des pièces qu'il expédie ou avoir mandat explicite du propriétaire. Toute pièce signalée volée ou faisant l'objet d'une réserve de propriété sera refusée et conservée en attente d'instructions des autorités compétentes.

6. OBLIGATIONS DU PRESTATAIRE

Le Prestataire s'engage à :
- mettre en œuvre tous les moyens techniques nécessaires à la réalisation du clonage logiciel TCU dans le délai annoncé de 24 heures ouvrées maximum après réception effective du colis dans ses ateliers,
- réaliser un test fonctionnel sur banc post-clonage,
- réexpédier les deux pièces au Client en colis suivi avec étiquette retour pré-payée,
- notifier le Client à chaque étape du processus par email.

La présente obligation est une obligation de moyens et non de résultat concernant le fonctionnement final de la transmission une fois remontée sur le véhicule, ce dernier dépendant de facteurs hors du contrôle du Prestataire (état mécanique de la boîte, qualité du montage par le Client ou son réparateur, état hardware des mécatroniques fournies par le Client).

7. GARANTIE SUR L'OPÉRATION DE CLONAGE

Le Prestataire garantit l'opération de clonage logiciel pendant trente (30) jours calendaires à compter de la date de réexpédition des pièces au Client. Cette garantie couvre exclusivement la qualité du transfert logiciel TCU. Si le clonage logiciel s'avère défaillant durant cette période — par exemple si le calculateur ne reconnaît pas les données transférées ou si les adaptations du véhicule sont corrompues du fait d'une erreur d'opération — le Prestataire procédera à un nouveau clonage à titre gratuit, frais d'envoi aller et retour à sa charge.

La garantie sur l'opération de clonage est strictement limitée à la prestation logicielle. Elle n'inclut pas, et le Client renonce expressément à toute réclamation portant sur :
- l'état hardware (matériel) des mécatroniques avant ou après clonage, y compris en cas de panne survenue postérieurement au clonage et liée au composant lui-même (cartes électroniques défaillantes, défauts physiques, etc.),
- le fonctionnement final de la transmission une fois la mécatronique clonée remontée sur le véhicule, qui dépend de l'état mécanique de la boîte, de la qualité du remontage et des adaptations réalisées par le Client ou son réparateur,
- les éventuels dégâts mécaniques sur la boîte de vitesses survenus avant, pendant ou après l'opération de clonage,
- toute conséquence indirecte (immobilisation du véhicule, frais de location de remplacement, perte d'usage, etc.).

8. LIMITATION DE RESPONSABILITÉ

La responsabilité du Prestataire au titre du Service est limitée, en toute hypothèse, au montant effectivement réglé par le Client pour la prestation concernée (199 € TTC). Le Prestataire ne saurait être tenu responsable de dommages indirects, accessoires ou consécutifs, y compris la perte d'usage du véhicule, la perte de chiffre d'affaires pour un Client professionnel, ou tout autre préjudice immatériel résultant directement ou indirectement de l'utilisation du Service.

9. PRÉVENTION DE LA FRAUDE — IDENTIFICATION

Le numéro VIN du véhicule est obligatoirement renseigné par le Client lors de la commande aux fins de prévention de la fraude et de traçabilité technique. Le Prestataire se réserve la faculté, sans frais pour le Client, de demander la production d'un justificatif (carte grise ou équivalent) en cas de doute sérieux sur la propriété des pièces expédiées.

Le Prestataire conserve les photographies des plaques signalétiques des mécatroniques durant une période de douze (12) mois après la prestation, à des fins de traçabilité et de réponse à toute réquisition légale.

10. DROIT DE RÉTRACTATION — RENONCIATION EXPRESSE

Le Service constitue une prestation de service à distance personnalisée au sens des articles L221-18 et suivants du Code de la consommation, applicable aux Clients ayant la qualité de consommateur.

Conformément à l'article L221-28 1° du Code de la consommation, le Client consommateur reconnaît expressément que l'exécution du Service débute dès la réception effective du colis contenant ses pièces dans les ateliers du Prestataire, étape qui ne peut intervenir qu'après que le Client a sollicité, par sa commande et par l'envoi effectif du colis, le démarrage de la prestation. Le Client consommateur renonce en conséquence à son droit de rétractation dès lors que l'opération de clonage a commencé, étant précisé que la prestation est par nature non-récupérable une fois exécutée.

Avant l'expédition du colis par le Client, ce dernier conserve la faculté d'annuler sa commande sans pénalité par simple email adressé à carparts.france@gmail.com. Le remboursement intégral intervient sous quatorze (14) jours.

11. ÉCHEC DU CLONAGE OU IMPOSSIBILITÉ TECHNIQUE

Si, après diagnostic à réception, le Prestataire constate qu'une des deux mécatroniques fournies présente un défaut hardware empêchant techniquement le clonage (par exemple : carte TCU illisible, mémoire endommagée, composant défaillant), le Prestataire en informe le Client dans les meilleurs délais et lui propose deux options à son choix :

Option A — Restitution des deux pièces en l'état, sans frais supplémentaires, et remboursement de 50 % du prix du Service (98 € TTC), les 50 % restants couvrant le diagnostic effectué et la logistique aller/retour.

Option B — Conservation du colis chez le Prestataire dans l'attente de l'envoi d'une nouvelle pièce de remplacement par le Client, dans la limite de quatorze (14) jours. Au-delà, l'option A s'applique automatiquement.

Si l'échec du clonage résulte d'une erreur exclusive du Prestataire (et non d'un défaut hardware des pièces fournies par le Client), la prestation est intégralement reprise sans frais conformément à l'article 7.

12. RÉCLAMATIONS — MÉDIATION

Toute réclamation doit être adressée par email à carparts.france@gmail.com en précisant le numéro de commande, le motif et les pièces justificatives. Le Prestataire accuse réception sous 5 jours ouvrés et apporte une réponse motivée sous 30 jours maximum.

Conformément à l'article L612-1 du Code de la consommation, le Client consommateur peut recourir gratuitement au service de médiation de la consommation après échec d'une réclamation amiable. Les coordonnées du médiateur compétent sont précisées dans les CGV principales accessibles à l'adresse https://autoliva.com/legal/cgv.

13. DONNÉES PERSONNELLES (RGPD)

Les données collectées dans le cadre du Service (identité, adresse, coordonnées, numéro VIN, photographies des plaques signalétiques, codes défaut transmis le cas échéant) sont traitées par le Prestataire en sa qualité de responsable de traitement, sur la base contractuelle de l'exécution du Service.

Durée de conservation : 10 ans pour les données de facturation (obligation comptable), 12 mois pour les photographies et données VIN (lutte contre la fraude), suppression à l'issue de ces délais sauf obligation légale contraire.

Le Client dispose des droits d'accès, de rectification, d'effacement, de limitation, de portabilité et d'opposition prévus par les articles 15 à 22 du RGPD. Ces droits peuvent être exercés par email à carparts.france@gmail.com. Le Client dispose également du droit d'introduire une réclamation auprès de la CNIL.

La politique de confidentialité complète est accessible à l'adresse https://autoliva.com/legal/confidentialite.

14. MODIFICATION DES PRÉSENTES CONDITIONS

Le Prestataire se réserve le droit de modifier les présentes CG. La version applicable à une commande donnée est celle en vigueur et acceptée par le Client au moment de ladite commande. Les commandes antérieures restent régies par la version des CG acceptée à leur date de passation.

15. LOI APPLICABLE — JURIDICTION COMPÉTENTE

Les présentes CG sont régies par le droit français. À défaut de résolution amiable, tout litige sera soumis aux juridictions françaises territorialement compétentes selon les règles de droit commun, ou, pour les Clients consommateurs, aux juridictions du lieu de leur domicile au choix de ce dernier conformément à l'article R631-3 du Code de la consommation.

16. ACCEPTATION

L'acceptation des présentes CG par le Client est matérialisée par la validation de la commande sur le site et est requise pour la fourniture du Service. Le Client est invité à conserver une copie des présentes CG (consultable à tout moment à l'adresse https://autoliva.com/legal/cgv-service-clonage-tcu).
`;

(async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connecté à MongoDB.');

    const doc = {
      slug: SLUG,
      title: TITLE,
      content: CONTENT,
      isPublished: true,
      sortOrder: 50, // après les CGV principales (10) et CGU (20)
    };

    const existing = await LegalPage.findOne({ slug: SLUG }).lean();
    if (existing) {
      await LegalPage.updateOne({ _id: existing._id }, { $set: doc });
      console.log(`Page légale existante mise à jour : ${SLUG} (id=${existing._id})`);
    } else {
      const created = await LegalPage.create(doc);
      console.log(`Page légale créée : ${SLUG} (id=${created._id})`);
    }

    console.log(`URL publique : https://autoliva.com/legal/${SLUG}`);
    console.log(`Version : ${VERSION}`);
  } catch (err) {
    console.error('Erreur :', err.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
