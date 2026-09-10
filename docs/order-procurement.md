# Traitement des commandes et colis fournisseurs

La liste des commandes conserve les filtres existants et propose une présentation compacte, les pièces visibles, un panneau de suivi et un retour à la liste avec son contexte. Les files À commander, À recevoir et Retards fournisseur utilisent le même calcul que les compteurs. La page `/admin/fournisseurs` regroupe les lignes par fournisseur.

## Utilisation

1. Ouvrir le suivi des pièces depuis une commande. Indiquer pour chaque ligne : en stock, à commander, commandée ou reçue ; renseigner le fournisseur et les dates.
2. Préparer un message fournisseur depuis une pièce ou sélectionner plusieurs commandes du même fournisseur. Les quantités identiques sont regroupées dans le brouillon.
3. Pour un colis entrant DHL, FedEx ou UPS, sélectionner les lignes commandées et saisir le numéro. Saisie possible directement dans le panneau ; la page fournisseurs permet de regrouper plusieurs commandes dans un colis.
4. Le statut du transporteur est visible dans les commandes associées. Après livraison, vérifier le contenu et confirmer les pièces « Reçue chez nous ». L’expédition au client reste distincte du colis entrant.
5. Renseigner la date annoncée au client, préparer un email de retard et noter les contacts téléphone, email ou WhatsApp. Aucun message n’est envoyé automatiquement.

L’indicateur de disponibilité porte sur toutes les lignes et tient compte du clonage. Il ne bloque pas les actions d’expédition existantes. Les états concernent toute la quantité d’une ligne : la réception partielle et le partage d’une même ligne entre plusieurs colis ne sont pas gérés. Un colis enregistré n’est pas encore modifiable depuis cette interface.

## Activation du suivi réel

Le service réutilise l’intégration 17TRACK existante. Configurer `TRACK17_API_KEY` sur le serveur et ne pas désactiver `TRACK17_ENABLED` (`false`, `0` ou `off`). Le scheduler de l’application vérifie au maximum 40 colis toutes les 20 minutes ; en cas de volume supérieur, les plus anciens contrôles passent en premier. Le bouton d’actualisation respecte un délai de 20 minutes. Sans clé, la saisie reste disponible et un message indique que la synchronisation est inactive.

Les transporteurs sont détectés par 17TRACK ; la sélection DHL/FedEx/UPS sert également au lien de consultation. Vérifier la prise en charge du service transporteur et les droits du compte avec un vrai suivi avant activation opérationnelle. Aucun appel réel ni configuration de production n’a été validé pendant ces tests.

## Compatibilité et protection des données

- Les anciens états `sourcing` servent de valeur initiale tant qu’une ligne n’a pas de suivi individuel. La première sauvegarde initialise le suivi sans migration globale.
- Les sauvegardes concurrentes et les changements de composition sont rejetés pour éviter d’écraser un suivi récent.
- Les associations de colis sont uniques par numéro/transporteur et par ligne ; une composition devenue différente est signalée dans le panneau.
- Le statut de livraison repose sur le statut explicite du transporteur. « En cours de livraison » et « tentative de livraison » ne signifient pas livré.
- Un colis entrant livré ne marque ni la commande client expédiée ni les pièces vérifiées.
- Les routes sont réservées aux administrateurs. Les écritures exigent du JSON.

## Vérification

Tests unitaires et intégration avec MongoDB temporaire : anciennes commandes, filtres, concurrence, colis partagé entre commandes, doublons, composition modifiée et transitions transporteur. Aperçu local avec commandes et suivis fictifs, suivi externe désactivé. Compilation du CSS admin vérifiée ; le fichier généré reste produit par le build habituel.

## Fiche détaillée

La fiche commence par le client, la prochaine étape et la date annoncée. Les pièces et leurs états manuels sont visibles avant le parcours de commande. Les anciennes indications de stock catalogue ne sont plus présentées comme la disponibilité réelle de cette commande. Les colis entrants apparaissent séparément des expéditions client et retours.

Les actions d’archivage, retour, avis et impression de page restent dans « Autres actions » ; l’impression d’étiquette conserve son accès direct. Le dossier client et les changements manuels sont regroupés dans un panneau ouvrable depuis la navigation. La confirmation de départ d’un colis dont l’étiquette est créée reste visible au-dessus des pièces. Les notes internes et client existantes sont rappelées en tête.

Les changements enregistrés dans le panneau de suivi actualisent les pièces, la prochaine étape, la date client et les colis affichés sans recharger la fiche. Tests de rendu avec le véritable contrôleur pour brouillon, payée, étiquette créée et expédiée ; tests visuels en 1440 × 900, 1280 × 800 et 390 × 844. Total après cette extension : 269 réussites, 5 tests historiques ignorés, aucun échec.
