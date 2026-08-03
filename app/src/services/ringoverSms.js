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

module.exports = { envoyer, estActif, texteSelonContexte, TEXTE_DEFAUT, TEXTES };
