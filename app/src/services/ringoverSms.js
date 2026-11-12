'use strict';

/**
 * Envoi de SMS via Ringover.
 *
 * POURQUOI RINGOVER ET PAS BREVO — Brevo envoie depuis un expéditeur
 * alphanumérique (« AUTOLIVA ») : le client NE PEUT PAS répondre, et les
 * opérateurs français jettent les SMS contenant un lien. Ringover envoie depuis
 * un vrai numéro mobile, donc la réponse arrive — dans le fil de conversation
 * que le standardiste a déjà sous les yeux.
 *
 * ENDPOINT — `POST /push/sms` (et surtout PAS `/push/sms/v1`, qui est un
 * « one-way SMS » dont la documentation dit explicitement : « Recipients cannot
 * reply ». Tout l'intérêt ici est justement la réponse).
 * Permission requise : `Conversations W`.
 *
 * INERTE PAR DÉFAUT : sans `RINGOVER_API_KEY` ni `RINGOVER_SMS_FROM`, rien
 * n'est envoyé et rien n'échoue. C'est voulu — un canal sortant automatique ne
 * doit jamais s'activer par accident.
 */

const API = 'https://public-api.ringover.com/v2/push/sms';
const API_RACINE = 'https://public-api.ringover.com/v2';

/* Messages calibrés pour UN segment : aucun accent hors GSM-7, aucun lien
   (les opérateurs français filtrent les liens venant d'un expéditeur inconnu).
   Tous surchargeables par variable d'environnement, sans déploiement.

   PRINCIPE : ne jamais poser une question dont on connaît la réponse. Quand la
   personne a un dossier en cours, on le lui PROPOSE — c'est la différence entre
   un formulaire et quelqu'un qui la reconnaît. Sur 942 numéros connus, 82 % ont
   un dossier ouvert : la version générique reste minoritaire. */
const TEXTE_DEFAUT = "Bonjour, nous n'avons pas pu prendre votre appel. "
  + "Dites-nous en deux mots ce qu'il vous faut, on vous rappelle. Autoliva";

const TEXTES = {
  /* {piece} vaut « moteur », « boite » ou « piece » selon la landing d'origine.
     Le sous-document s'appelle `engineQuote` par héritage, mais il porte les
     trois familles : dire « devis moteur » à quelqu'un qui a demandé un pont
     serait faux, et se verrait immédiatement. */
  devis:    "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet du devis pour votre {piece} ? "
            + "Repondez a ce message, on revient vers vous. Autoliva",
  commande: "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet de votre commande ? "
            + "Repondez a ce message, on revient vers vous. Autoliva",
  sav:      "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet de votre dossier SAV ? "
            + "Repondez a ce message, on vous rappelle. Autoliva",
};

/**
 * Choisit le message selon ce qu'on sait du client.
 * @param {string} sujet   'devis' | 'commande' | 'sav' | '' (inconnu)
 * @param {string} prenom  prénom si connu, sinon message impersonnel
 */
function texteSelonContexte(sujet, prenom, piece) {
  const perso = String(process.env['RINGOVER_SMS_TEXT_' + String(sujet || '').toUpperCase()] || '').trim();
  const modele = perso || TEXTES[sujet];
  if (!modele) return String(process.env.RINGOVER_SMS_TEXT || '').trim() || TEXTE_DEFAUT;
  /* Le prénom est optionnel : sans lui la phrase commence par une majuscule et
     reste correcte, plutôt que « Bonjour , nous n'avons… ». */
  const p = String(prenom || '').trim();
  /* Sans accent dans le SMS : « boîte » ferait basculer le message en UCS-2 et
     doublerait son coût. Le lexique renvoie l'accent, on le retire ici. */
  const pi = String(piece || 'piece').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return modele
    .replace('{prenom}', p ? p + ', ' : 'Bonjour, ')
    .replace('{piece}', pi);
}

/* ── Qui peut réellement recevoir ce SMS ────────────────────────────────────
 *
 * Mesuré sur 1 320 envois antérieurs au 25/09/2026 : SEULS les mobiles de
 * France métropolitaine (+336, +337) ont abouti — 738 fois. Toutes les autres
 * destinations ont échoué, 100 % du temps et sans une seule exception :
 * lignes fixes françaises (+331 à +335, +339), DOM (+262 Réunion, +590
 * Guadeloupe, +594 Guyane, +596 Martinique), Belgique, Suisse, Espagne,
 * Allemagne, Luxembourg, Maghreb. 470 appels d'API pour 470 refus.
 *
 * Les appeler quand même avait deux coûts : une requête inutile à chaque appel
 * manqué, et surtout un journal noyé sous des centaines d'échecs attendus —
 * c'est précisément ce bruit qui a rendu INVISIBLE la vraie panne du 25/09,
 * quand les mobiles français se sont mis à échouer eux aussi.
 *
 * Réglable sans déploiement : si une nouvelle clé API ouvre l'international,
 * il suffit d'élargir RINGOVER_SMS_PREFIXES.
 */
const PREFIXES_DEFAUT = '+336,+337';

function prefixesAutorises() {
  const brut = String(process.env.RINGOVER_SMS_PREFIXES || '').trim() || PREFIXES_DEFAUT;
  return brut.split(',').map((p) => p.trim()).filter((p) => /^\+\d{2,6}$/.test(p));
}

/** Ce numéro peut-il recevoir le SMS, vu de notre compte Ringover ? */
function peutRecevoir(dest) {
  const liste = prefixesAutorises();
  if (!liste.length) return true;
  return liste.some((p) => String(dest || '').startsWith(p));
}

function conf() {
  const cle = String(process.env.RINGOVER_API_KEY || '').trim();
  const from = String(process.env.RINGOVER_SMS_FROM || '').trim();
  const texte = String(process.env.RINGOVER_SMS_TEXT || '').trim() || TEXTE_DEFAUT;
  return { cle, from, texte, actif: !!(cle && from) };
}

function estActif() { return conf().actif; }

/**
 * Envoie un SMS. Ne lève jamais : un échec d'envoi ne doit pas faire perdre la
 * capture de l'appel, qui est le vrai enjeu.
 *
 * @returns {Promise<{ ok:boolean, raison?:string, messageId?:number, convId?:number }>}
 */
async function envoyer({ to, content, sujet, prenom, piece } = {}) {
  const { cle, from, texte, actif } = conf();
  if (!actif) return { ok: false, raison: 'non_configure' };

  const dest = String(to || '').trim();
  if (!/^\+\d{8,15}$/.test(dest)) return { ok: false, raison: 'destinataire_invalide' };
  /* Ne jamais s'écrire à soi-même : un renvoi interne ou une erreur de
     configuration produirait une boucle. */
  if (dest === from) return { ok: false, raison: 'destinataire_est_expediteur' };
  /* Hors périmètre : on ne tente pas. L'appelant le journalise, pour que le
     commercial voie « pas de SMS possible » sur la fiche et rappelle. */
  if (!peutRecevoir(dest)) return { ok: false, raison: 'destinataire_hors_perimetre' };

  const message = String(content || '').trim()
    || (sujet ? texteSelonContexte(sujet, prenom, piece) : texte);
  const corps = JSON.stringify({
    from_number: from,
    to_number: dest,
    content: message.slice(0, 600),
  });

  try {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(API, {
      method: 'POST',
      headers: { Authorization: cle, 'Content-Type': 'application/json' },
      body: corps,
      signal: ctl.signal,
    });
    clearTimeout(minuteur);

    /* 202 = accepté et mis en file. 402 = crédits SMS épuisés : à remonter
       clairement, c'est la panne silencieuse la plus probable en production. */
    if (r.status === 402) {
      console.error('[ringover-sms] CRÉDITS SMS ÉPUISÉS — aucun SMS ne partira');
      return { ok: false, raison: 'credits_epuises' };
    }
    if (r.status !== 202 && r.status !== 200) {
      const t = await r.text().catch(() => '');
      console.error('[ringover-sms] échec', r.status, t.slice(0, 200));
      return { ok: false, raison: 'http_' + r.status };
    }
    const d = await r.json().catch(() => ({}));
    /* `texte` est renvoyé pour que l'appelant puisse journaliser CE QUI est
       parti : le message est choisi ici, selon le contexte du dossier, et
       l'appelant ne le connaît pas autrement. */
    return { ok: true, messageId: d.message_id, convId: d.conv_id, texte: message.slice(0, 600) };
  } catch (err) {
    console.error('[ringover-sms] erreur réseau :', err && err.message ? err.message : err);
    return { ok: false, raison: 'reseau' };
  }
}

/* ── Sonde de diagnostic ────────────────────────────────────────────────────
 *
 * Depuis le 25/09/2026, chaque envoi reçoit « 403 insufficient permissions ».
 * On a vérifié une à une les causes possibles de notre côté — droit
 * Conversations en écriture actif sur une clé régénérée, numéro expéditeur
 * valide et attribué au même utilisateur, crédits disponibles, serveur
 * redémarré — sans rien trouver. Deviner coûte des allers-retours ; autant
 * demander à Ringover.
 *
 * La sonde appelle un endpoint en LECTURE avec la MÊME clé, et ne retient que
 * le code HTTP. Elle n'envoie rien, ne lit aucune donnée client, et ne montre
 * jamais la clé. Trois réponses, trois conclusions :
 *
 *   200 ou 400 → la clé est acceptée et a le droit de LIRE les conversations.
 *                Seule l'écriture est refusée : la panne est du côté Ringover.
 *   401        → la clé n'est pas reconnue : ce n'est pas celle qu'on croit
 *                (mauvaise valeur dans RINGOVER_API_KEY, ou clé supprimée).
 *   403        → la clé est valide mais n'a AUCUN droit sur Conversations :
 *                les bascules de l'interface ne sont pas appliquées.
 */
async function sonder() {
  const { cle, actif } = conf();
  if (!actif) return { ok: false, statut: 0, raison: 'non_configure' };
  try {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${API_RACINE}/conversations?limit_count=1`, {
      headers: { Authorization: cle },
      signal: ctl.signal,
    });
    clearTimeout(minuteur);
    const corps = await r.text().catch(() => '');
    return { ok: true, statut: r.status, detail: corps.slice(0, 160) };
  } catch (err) {
    return { ok: false, statut: 0, raison: 'reseau' };
  }
}

/** Ce que le code renvoyé par la sonde nous apprend, en français. */
function lireSonde(statut) {
  if (statut === 200 || statut === 400) {
    return 'La clé est acceptée en LECTURE sur Conversations : seule l’écriture est refusée. '
      + 'Le blocage est donc côté Ringover, pas chez nous.';
  }
  if (statut === 401) {
    return 'La clé n’est pas reconnue par Ringover : la valeur de RINGOVER_API_KEY n’est pas '
      + 'celle d’une clé existante (mauvaise valeur, ou clé supprimée).';
  }
  if (statut === 403) {
    return 'La clé est valide mais n’a AUCUN droit sur Conversations, ni lecture ni écriture : '
      + 'les bascules de l’interface Ringover ne sont pas appliquées à cette clé.';
  }
  if (!statut) return 'Ringover est injoignable depuis le serveur.';
  return `Ringover répond ${statut} sur la lecture des conversations.`;
}

module.exports = {
  envoyer, estActif, texteSelonContexte, peutRecevoir, prefixesAutorises,
  sonder, lireSonde, TEXTE_DEFAUT, TEXTES,
};
