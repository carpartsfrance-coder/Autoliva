# Politique d'indexation — mode d'emploi

Plan de reprise SEO du 14/09/2026, actions A5 à A10 et A14. Le code est dans
`src/services/seoIndexPolicy.js`, les listes dans `src/data/seo/listes/`.

## L'interrupteur

Une seule variable Render : `SEO_PRUNE`. Elle liste les familles qui sortent de
Google, séparées par des virgules :

- `gone` : les 268 articles de `gone-410-blog.txt` répondent 410 ;
- `blog` : tout article français hors des 295 gardés passe en noindex ;
- `reference` : toute page /reference sauf les 3 gardées ;
- `pieces-auto` : toute page /pieces-auto/… sauf les 242 gardées ;
- `de` : toute la couche /de ;
- `products` : les fiches d'import sans signal et toutes les fiches `DM-`
  (à n'allumer qu'après le contrôle Merchant Center).

Variable absente ou vide : rien ne change. Les pages restent en ligne, en vente
et dans les flux Merchant ; seule la page 410 disparaît vraiment (le contenu
reste en base).

## Allumer une famille

Dans Render > Environment :

1. ajouter le mot à `SEO_PRUNE` (exemple : `gone,blog`) ;
2. poser la date du jour dans `SEO_PRUNE_SINCE_<FAMILLE>` (exemple :
   `SEO_PRUNE_SINCE_GONE=2026-09-16`, `SEO_PRUNE_SINCE_PIECES_AUTO=2026-09-18`) ;
3. « Save and deploy ».

La date sert au sitemap de retrait `sitemap-retraits-<famille>.xml`, qui montre
à Google les pages sorties pendant huit semaines, puis disparaît. Les journaux
Render affichent `[politique indexation] familles actives : …` au démarrage.

Une famille par jour, dans l'ordre du plan : `gone` et `blog`, puis
`reference`, `pieces-auto`, `de`, et `products` en dernier.

## Revenir en arrière

Retirer le mot de `SEO_PRUNE`, « Save and deploy ». Toute la famille revient
dans Google, choix de l'admin compris.

## Une page à la fois

- Une fiche : admin > fiche > « Indexation Google » > « Toujours indexable »
  (ou « Retirée de Google »). Agit quand `products` est allumée.
- Un article, une page véhicule, une référence : ajouter son adresse dans le
  fichier de `src/data/seo/listes/`, lancer `node scripts/generer-index-policy.js`,
  puis une PR.
- Les fiches créées par un import de plus de 3 fiches naissent hors de Google
  quand `products` est allumée.
