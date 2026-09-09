# Connecteur Comptoir (getcomptoir.fr)

Chaque commande encaissée sur Autoliva est poussée vers Comptoir, qui sert de
tableau de bord unique des ventes.

Guide officiel de leur API : <https://getcomptoir.fr/guide-connecteur.html>

---

## Mise en service — 3 minutes, côté Killian

1. Dans l'app Comptoir : **Connecteurs → + Connecteur personnalisé**, nom
   « Autoliva ».
2. Copier la **clé API** affichée. ⚠ Elle n'est plus jamais réaffichée.
   Noter aussi l'**endpoint** indiqué.
3. Sur Render (service Autoliva) → **Environment** :

   ```
   COMPTOIR_API_KEY = <la clé>
   ```

   Ajouter `COMPTOIR_ENDPOINT` **seulement** si Comptoir affiche une autre
   adresse que `https://getcomptoir.fr/api/ingest/orders` (le défaut).
4. Redéployer. C'est tout : les commandes suivantes partent toutes seules.

**Tant que `COMPTOIR_API_KEY` est absente, le connecteur est totalement
inactif** — aucun appel réseau, aucune écriture. Le code peut donc être
déployé avant même que le connecteur existe côté Comptoir.

### Reprendre l'historique

Le connecteur ne pousse que les ventes à partir de sa mise en service. Pour que
le tableau de bord ne parte pas de zéro :

```bash
node scripts/comptoir-backfill.js               # simulation : liste ce qui partirait
node scripts/comptoir-backfill.js --apply       # envoie (12 derniers mois)
node scripts/comptoir-backfill.js --apply --all # tout l'historique
```

Relançable sans risque : Comptoir ignore une commande déjà connue.

---

## Ce qui part, et quand

| Moment | Déclencheur |
|---|---|
| Paiement Mollie confirmé | `applyMolliePaymentToOrder` (webhook ou retour client) |
| Paiement Scalapay capturé | `applyScalapayPaymentToOrder` |
| Commande créée à la main déjà payée | `/admin` → nouvelle commande |
| Brouillon validé en « payé » | `/admin` → valider un brouillon |
| Rattrapage horaire (:33) | `src/jobs/syncComptoirOrders.js` |

Payload envoyé :

```json
{
  "externalId": "CP2026-000485",
  "amount": 1299.00,
  "status": "preparation",
  "date": "2026-09-01T10:04:00.000Z",
  "customerName": "Jean Dupont",
  "productName": "Mécatronique DQ200 (+1 autre)"
}
```

- `amount` = `totalCents / 100`, c'est-à-dire **le montant encaissé** (donc HT
  en cas d'autoliquidation TVA — cohérent avec la facture).
- `customerName` = nom de facturation, à défaut nom de livraison.
- `productName` = premier article, en signalant les autres.
- Une commande **non encaissée** (`paymentStatus` ≠ paid/captured/completed)
  n'est jamais envoyée : un brouillon passé « en préparation » à la main ne
  gonfle pas le compteur.

### Correspondance des statuts

| Autoliva | Comptoir |
|---|---|
| `paid`, `processing`, `label_created` | `preparation` |
| `shipped`, `delivered`, `completed` | `livree` |
| `cancelled`, `refunded`, `partially_refunded` | `retour` |

---

## Deux limites qui viennent de leur API

**1. Création seulement.** Comptoir ignore un `externalId` déjà connu — c'est
l'anti-doublon documenté. Conséquence : **le statut est figé à l'envoi**. Une
commande poussée au paiement reste « preparation » chez Comptoir même une fois
livrée ou remboursée. Renvoyer la commande n'y changerait rien.

*Si ça devient gênant :* leur demander un endpoint de mise à jour, ou décaler
l'envoi à la livraison — mais on perdrait alors le temps réel sur les ventes du
jour.

**2. Réessai toujours sûr.** La même protection rend tout renvoi inoffensif :
d'où le rattrapage horaire plutôt qu'un envoi unique qu'un incident réseau
perdrait en silence.

---

## Vérifier que ça tourne

Les envois sont tracés sur la commande, dans `order.comptoir` :

```js
{ sentAt, externalId, duplicate, attempts, lastAttemptAt, lastError, permanentError }
```

- `sentAt` posé → la vente est chez Comptoir, elle ne sera plus renvoyée.
- `lastError` non vide → l'appel a échoué ; le rattrapage reprendra la commande
  (5 tentatives au maximum).
- `permanentError: true` → montant invalide (400) ou clé morte (401). Le
  rattrapage l'abandonne : il faut corriger la clé, puis relancer le backfill.

Dans les logs Render : `[comptoir]` pour les envois unitaires,
`[comptoir-sync]` pour le bilan horaire du rattrapage.

Pour lister ce qui n'est pas parti, sans rien envoyer :

```bash
node scripts/comptoir-backfill.js --days=30
```

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `app/src/services/comptoir.js` | client API, payload, envoi + marquage |
| `app/src/jobs/syncComptoirOrders.js` | rattrapage horaire |
| `app/scripts/comptoir-backfill.js` | reprise de l'historique / diagnostic |
| `app/src/models/Order.js` | sous-document `comptoir` |
| `app/tests/unit/comptoir-connecteur.test.js` | payload, statuts, codes HTTP |
| `app/tests/integration/comptoir-envoi.test.js` | verrou, rattrapage (vrai MongoDB) |
