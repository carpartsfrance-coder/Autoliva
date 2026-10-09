'use strict';

/**
 * Signature d'e-mail — la même que celle de la messagerie d'Autoliva.
 *
 * À quoi elle sert ICI : un e-mail de demande d'avis doit ressembler à un
 * message écrit par quelqu'un, pas à une campagne. Le gabarit marketing
 * (logo en bandeau d'en-tête, gros bouton, pied de page) est précisément ce
 * que l'onglet Promotions de Gmail attrape. Une signature en bas de lettre,
 * elle, est ce que fait tout professionnel — et ne déclenche rien.
 *
 * Deux règles tenues ici :
 *  - LISIBLE SANS IMAGES. La plupart des clients de messagerie bloquent les
 *    images par défaut. Le logo porte donc un `alt`, et rien d'important
 *    n'est dans l'image : le nom, le téléphone et l'adresse sont du texte.
 *  - TIRÉE DE brand.js. Le téléphone et l'adresse affichés ne peuvent pas
 *    diverger de ceux réellement utilisés par le site.
 */

const brand = require('../config/brand');

/* Ce que brand.js ne porte pas : horaires et accroches commerciales. Repris
   mot pour mot de la signature de la messagerie, pour que les deux disent la
   même chose. */
const HORAIRES = 'Lundi – Vendredi, 08:00 – 18:00';
const METIER = "Pièces automobiles d'occasion & reconditionnées";
const SPECIALITES = 'Moteurs, boîtes de vitesses, différentiels, mécatroniques et pièces automobiles contrôlées.';
const ENGAGEMENTS = 'Livraison France & Europe · Paiement sécurisé · Assistance avant et après commande';

function echapper(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function siteAffiche() {
  return String(brand.SITE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Téléphone utilisable dans un href tel:. */
function telBrut() {
  return String(brand.PHONE || '').replace(/[^\d+]/g, '');
}

/**
 * Signature HTML, à coller en bas d'une lettre.
 * Pas de <table> de mise en page : c'est une signature, pas un gabarit.
 */
function signatureHtml() {
  const logo = brand.SITE_URL + brand.LOGO_URL;
  const site = siteAffiche();
  const ligne = (label, valeur) =>
    `<div style="margin-top:2px;"><strong style="color:#0f172a;">${echapper(label)} :</strong> ${valeur}</div>`;

  return `
<div style="margin-top:28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#334155;">
  <div>Cordialement,</div>
  <div style="margin-top:10px;color:#94a3b8;">--</div>
  <div style="margin-top:14px;">
    <img src="${echapper(logo)}" alt="${echapper(brand.NAME)}" width="180"
         style="display:block;width:180px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;" />
  </div>
  <div style="margin-top:18px;font-size:16px;font-weight:bold;color:#0f172a;">Service Client ${echapper(brand.NAME)}</div>
  <div style="margin-top:2px;color:#64748b;">${echapper(METIER)}</div>
  <div style="margin-top:14px;">
    ${ligne('Téléphone', `<a href="tel:${echapper(telBrut())}" style="color:#334155;text-decoration:none;">${echapper(brand.PHONE)}</a>`)}
    ${ligne('Horaires', echapper(HORAIRES))}
    ${ligne('Email', `<a href="mailto:${echapper(brand.EMAIL_CONTACT)}" style="color:#334155;text-decoration:none;">${echapper(brand.EMAIL_CONTACT)}</a>`)}
    ${ligne('Site', `<a href="${echapper(brand.SITE_URL)}" style="color:#1d4ed8;text-decoration:none;">${echapper(site)}</a>`)}
  </div>
  <div style="margin-top:16px;color:#334155;">${echapper(SPECIALITES)}</div>
  <div style="margin-top:10px;font-size:13px;color:#64748b;">${echapper(ENGAGEMENTS)}</div>
</div>`;
}

/** La même, en texte brut — pour la partie text/plain du multipart. */
function signatureTexte() {
  return [
    'Cordialement,',
    '--',
    '',
    `Service Client ${brand.NAME}`,
    METIER,
    '',
    `Téléphone : ${brand.PHONE}`,
    `Horaires : ${HORAIRES}`,
    `Email : ${brand.EMAIL_CONTACT}`,
    `Site : ${siteAffiche()}`,
    '',
    SPECIALITES,
    ENGAGEMENTS,
  ].join('\n');
}

module.exports = { signatureHtml, signatureTexte, HORAIRES, METIER, SPECIALITES, ENGAGEMENTS };
