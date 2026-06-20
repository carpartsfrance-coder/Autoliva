# Import de conversions hors-ligne vers Google Ads

Remonte les **vraies** conversions du tunnel moteur (demande de devis = *lead*, puis
vente gagnée = *sale* avec sa valeur) à Google Ads, via le `gclid` déjà capté par
`captureAttribution.js`. Objectif : que l'algo optimise vers de vrais clients et plus
vers le faux « Achats ».

## Ce qui est déjà codé (côté site)
- `src/services/googleAdsConversions.js` — client API (REST, OAuth refresh-token).
- `src/services/googleAdsConversionSync.js` — trouve les leads moteur avec `gclid` non
  encore remontés et envoie les conversions (idempotent via `AbandonedCart.googleAdsUpload`).
- **Cron horaire** (`src/jobs/scheduler.js`, à :40) — tourne tout seul, **no-op tant que
  les variables `GOOGLE_ADS_*` ne sont pas posées**.
- `scripts/google-ads-conversion-sync.js` — exécution manuelle (test + backfill).

> Rien ne se déclenche tant que la config ci-dessous n'est pas faite. Déploiement sûr.

## Ce que TOI tu dois faire (ordre conseillé)

### 1. Activer l'auto-tagging (sinon pas de gclid)
Google Ads → **Paramètres → Suivi des annonces** → « Baliser automatiquement mon URL… » = **ON**.

### 2. Créer 2 actions de conversion (import par clic)
Google Ads → **Objectifs → Conversions → + Action de conversion → Importer →
« Importer manuellement à partir de clics »** :
- **« Lead – Demande de devis »** — catégorie *Prospect / Soumission de formulaire*, comptage *Une*.
- **« Vente moteur »** — catégorie *Achat*, comptage *Une*, *Utiliser des valeurs différentes* (on envoie la valeur).

Récupère l'**ID** de chaque action → variables `GOOGLE_ADS_LEAD_ACTION` / `GOOGLE_ADS_SALE_ACTION`
(l'id numérique suffit ; un resource name complet `customers/.../conversionActions/...` marche aussi).

Puis : passe **« Lead »** (et/ou « Vente ») en conversion **principale**, et **retire/relègue l'ancienne
conversion « Achats »** qui pollue (la cause des 641 fausses conversions).

### 3. Accès API Google Ads
- **Developer token** : Google Ads → Outils → Configuration → API Center (peut prendre quelques jours ; *Basic* suffit).
- **OAuth2** : Google Cloud Console → identifiants OAuth → `client_id` + `client_secret`.
- **Refresh token** : générer un refresh token (OAuth Playground, scope `https://www.googleapis.com/auth/adwords`).

### 4. Poser les variables d'env (Render)
```
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
GOOGLE_ADS_REFRESH_TOKEN=...
GOOGLE_ADS_CUSTOMER_ID=9562598225        # compte Car Parts France, chiffres sans tirets
GOOGLE_ADS_LOGIN_CUSTOMER_ID=8306316896  # (optionnel) compte manager si accès via MCC
GOOGLE_ADS_LEAD_ACTION=<id action Lead>
GOOGLE_ADS_SALE_ACTION=<id action Vente>
GOOGLE_ADS_LEAD_VALUE=0                   # (optionnel) valeur nominale du lead, 0 = sans valeur
GOOGLE_ADS_API_VERSION=v18               # (optionnel)
```

### 5. Tester puis laisser tourner
```
# DRY-RUN (valide côté Google, n'envoie rien, n'écrit rien)
node scripts/google-ads-conversion-sync.js
# Envoi réel + backfill de l'historique
APPLY=1 node scripts/google-ads-conversion-sync.js
```
Ensuite le **cron horaire** prend le relais automatiquement.

## Notes
- Fenêtre `gclid` ≈ 90 j → le backfill ne remonte que les leads des ~80 derniers jours.
- Valeur de la vente = `engineQuote.pricing.sellPrice`. Adapter à la marge si tu préfères optimiser sur le profit.
- Idempotent : chaque lead n'est remonté qu'une fois (`googleAdsUpload.leadAt` / `.saleAt`).
