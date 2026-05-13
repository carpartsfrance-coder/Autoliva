# Campagne Google Ads — Service Clonage TCU (Autoliva)

**Cible** : générer du trafic chaud sur `/product/clonage-mecatronique-tcu-dsg-s-tronic/` via Google Ads Search.

**Infrastructure tracking existante** :
- ✅ GTM installé (`GTM-NZDFRVCG`) sur toutes les pages
- ✅ Capture automatique des `gclid` en attribution (Order.attribution)
- ✅ Enhanced Conversions ready côté code (`services/enhancedConversionData.js`)
- ✅ Modèle Order avec champ `googleAdsConversionId` pour tracking

---

## 1. Structure du compte

```
Campagne : "Service Clonage TCU — France"
├── Groupe d'annonces 1 : Clonage générique
├── Groupe d'annonces 2 : Prix / Coût
├── Groupe d'annonces 3 : Symptômes / Diagnostic
└── Groupe d'annonces 4 : Par modèle de boîte
```

**Type de campagne** : Search (réseau de recherche uniquement, **PAS** réseau Display).

**Stratégie d'enchère** :
- **Phase 1 (S1-S2, ~30 conv. minimum)** : « Maximiser les clics » avec CPC max plafonné à 4€ — pour générer rapidement de la donnée
- **Phase 2 (S3+)** : Bascule sur « Maximiser les conversions » avec CPA cible **40€** (= 20% du prix 199€ = marge brute préservée)

**Budget quotidien** :
- Test : **15-20€/jour** (~450-600€/mois)
- Si CPA < 40€ après S3 : scaler à 30-40€/jour

**Méthode budget** : Standard (pas accéléré).

**Ciblage géographique** : France métropolitaine + Corse + DOM-TOM (exclure les pays/régions hors France).

**Langue** : Français.

**Appareils** : tous activés, mais surveiller mobile (intent forte, vérifier vitesse fiche produit sur mobile).

**Horaires** : 24/7 au démarrage, optimiser après 2 semaines (couper les créneaux à CPA > 80€).

---

## 2. Mots-clés par groupe d'annonces

### Groupe 1 — Clonage générique

| Mot-clé | Type | Intent |
|---|---|---|
| `[clonage mécatronique DSG]` | Exact | Acheteur direct |
| `[clonage TCU DSG]` | Exact | Acheteur technique |
| `[clonage mécatronique S-tronic]` | Exact | Acheteur Audi |
| `[clonage TCU]` | Exact | Très large, monitor CPA |
| `[transfert TCU DSG]` | Exact | Acheteur technique |
| `[clonage software TCU]` | Exact | Pro |
| `"clonage mécatronique"` | Phrase | Plus large |
| `"clonage TCU"` | Phrase | Plus large |

### Groupe 2 — Prix / Coût

| Mot-clé | Type | Intent |
|---|---|---|
| `[prix clonage mécatronique DSG]` | Exact | 🔥 Très chaud |
| `[prix clonage TCU]` | Exact | 🔥 Très chaud |
| `[combien coûte clonage mécatronique]` | Exact | 🔥 |
| `[tarif clonage DSG]` | Exact | 🔥 |
| `[clonage mécatronique pas cher]` | Exact | Sensible prix |
| `"prix clonage"` | Phrase | Large |

### Groupe 3 — Symptômes / Diagnostic

| Mot-clé | Type | Intent |
|---|---|---|
| `[mécatronique DSG HS]` | Exact | Diagnostic |
| `[symptômes mécatronique DSG]` | Exact | Diagnostic |
| `[mode dégradé DSG après changement mécatronique]` | Exact | 🔥 Urgence |
| `[code défaut P17BF DSG]` | Exact | Technique |
| `[code défaut P189C]` | Exact | Technique |
| `[réglage de base DSG impossible]` | Exact | 🔥 Urgence |
| `"mécatronique DSG HS"` | Phrase | Large |

### Groupe 4 — Par modèle de boîte

| Mot-clé | Type | Volume estimé |
|---|---|---|
| `[clonage DQ200]` | Exact | ⭐⭐⭐ |
| `[clonage mécatronique DQ200]` | Exact | ⭐⭐⭐ |
| `[clonage DQ250]` | Exact | ⭐⭐ |
| `[clonage DL501]` | Exact | ⭐⭐ |
| `[clonage S-tronic DL501]` | Exact | ⭐⭐ |
| `[clonage DQ500]` | Exact | ⭐ |
| `[clonage DQ381]` | Exact | ⭐ |
| `[clonage DL382]` | Exact | ⭐ |

---

## 3. Mots-clés négatifs (au niveau campagne)

À ajouter en bloc dans **Outils → Mots-clés négatifs → Liste** :

```
mécatronique neuve
mécatronique occasion
mécatronique pas cher
mécatronique gratuit
mécatronique tuto
mécatronique réparation
réparer mécatronique soi-même
formation
emploi
job
recrutement
école
tutoriel
youtube
vidéo gratuite
diy
guide gratuit
amazon
ebay
leboncoin
le bon coin
forum
wikipédia
définition
qu'est ce que
```

**Pourquoi** : ces termes attirent du trafic non-acheteur (curieux, recherche d'info gratuite, achat de pièces seules sans service).

---

## 4. Annonces (Responsive Search Ads)

Configure **3 RSA par groupe d'annonces** (Google teste automatiquement les combinaisons).

### Bloc titres (15 max par annonce — varier les angles)

```
Clonage Mécatronique DSG 199€
Service Clonage TCU à 199€
Mécatronique DSG : Clonage 24h
Clonage TCU Toutes Boîtes DSG
Clonage S-tronic + DSG — Autoliva
Spécialiste Mécatronique VAG
Clonage TCU Sans Devis Surprise
Étiquettes Aller + Retour Offertes
Garantie 30 Jours Sur le Clonage
DQ200, DQ250, DL501… Toutes Boîtes
Évitez 2000€ Chez Audi/VW
Mode Dégradé Après Méca ? Solution
Clonage Software TCU — 24h Chrono
Atelier Spécialisé DSG/S-tronic
Paiement en 3× Sans Frais
```

### Bloc descriptions (4 max par annonce)

```
Clonage logiciel TCU 199€ TTC flat. Toutes boîtes DSG (DQ200/250/381/500) et S-tronic (DL501/382). Retour 24h. Étiquettes aller + retour incluses.

Vous avez changé votre mécatronique et la boîte refuse le réglage de base ? Le clonage TCU règle le problème en 24h. Service 199€ tout inclus.

Évitez le passage Audi/VW à 2000-4000€. Envoyez vos 2 mécatroniques, on clone le TCU sous 24h ouvrées et on vous renvoie les pièces. Garantie 30j.

Spécialiste Autoliva — clonage TCU DSG/S-tronic depuis 2024. Paiement sécurisé, étiquettes pré-payées, suivi en temps réel sur votre espace client.
```

### URL finale (par groupe d'annonces)

- **Groupe 1** : `https://autoliva.com/product/clonage-mecatronique-tcu-dsg-s-tronic/`
- **Groupe 2** : `https://autoliva.com/product/clonage-mecatronique-tcu-dsg-s-tronic/?utm_source=google&utm_medium=cpc&utm_campaign=clonage-tcu&utm_content=prix`
- **Groupe 3** : `https://autoliva.com/blog/voiture-mode-degrade-apres-changement-mecatronique-dsg/?utm_source=google&utm_medium=cpc&utm_campaign=clonage-tcu&utm_content=mode-degrade`
- **Groupe 4** : `https://autoliva.com/product/clonage-mecatronique-tcu-dsg-s-tronic/?utm_source=google&utm_medium=cpc&utm_campaign=clonage-tcu&utm_content={keyword}` (avec `{keyword}` = nom de la boîte)

⚠️ **Important** : sur Google Ads, mettre l'URL **sans UTM** en URL finale et l'UTM en **URL de tracking** (l'auto-tagging gclid se rajoute en plus).

---

## 5. Extensions d'annonces

### Liens annexes (sitelinks) — 6 obligatoires
| Texte | URL | Description |
|---|---|---|
| Commander le service | `/product/clonage-mecatronique-tcu-dsg-s-tronic/` | 199€ TTC tout inclus, retour 24h |
| Prix & comparatif | `/blog/prix-clonage-mecatronique-dsg-france-guide-2026/` | Tarifs marché 2026, pourquoi 199€ flat |
| Symptômes mécatronique HS | `/blog/symptomes-mecatronique-dsg-hs-comment-diagnostiquer/` | 7 signes qui confirment la panne |
| Mode dégradé ? Solution | `/blog/voiture-mode-degrade-apres-changement-mecatronique-dsg/` | P17BF, P189C, réglage de base impossible |
| Comparatif des options | `/blog/clonage-tcu-vs-remplacement-mecatronique-comparatif/` | Neuf, recond, occasion + clonage, réparation |
| Conditions du service | `/legal/cgv-service-clonage-tcu/` | Garantie 30j, périmètre, droit rétractation |

### Accroches (callouts) — 8 obligatoires
```
199€ TTC prix fixe
Toutes boîtes DSG & S-tronic
Clonage 24h après réception
Étiquettes aller + retour incluses
Garantie 30 jours
Spécialiste depuis 2024
Paiement sécurisé Mollie
Suivi temps réel espace client
```

### Texte descriptif (structured snippets)
- **Type de service** : Clonage TCU, Transfert logiciel, Test sur banc
- **Boîtes prises en charge** : DQ200, DQ250, DQ381, DQ500, DL501, DL382

### Appel (extension Téléphone)
À configurer si tu veux capter aussi les appels — sinon laisser tomber pour focus 100% web. Si activé, programmer en heures ouvrées seulement (9h-19h LMV).

---

## 6. Configuration conversions Google Ads

### Conversion principale : Commande validée (paiement reçu)

À créer dans **Outils → Conversions → +** :

| Paramètre | Valeur |
|---|---|
| Type | Action sur le site |
| Nom de conversion | `Commande Clonage TCU payée` |
| Catégorie | Achat |
| Valeur | Utiliser des valeurs différentes pour chaque conversion |
| Valeur par défaut | 199 (EUR) |
| Comptage | Une |
| Fenêtre de conversion | 30 jours |
| Fenêtre clic → view | 1 jour |
| Modèle d'attribution | Basé sur les données |
| Compte dans "Conversions" | Oui |

### Implémentation tracking (côté code — à faire ensuite)

Sur la page de confirmation de commande (`/commande/merci` ou équivalent), ajouter via GTM :

```javascript
// Event GA4 / Google Ads
gtag('event', 'purchase', {
  transaction_id: order.number,
  value: order.totalCents / 100,
  currency: 'EUR',
  items: [{
    item_id: 'CPF-SVC-CLONE-TCU-001',
    item_name: 'Clonage mécatronique TCU DSG & S-tronic',
    price: 199,
    quantity: 1,
    item_category: 'Service'
  }]
});

// Google Ads conversion specific
gtag('event', 'conversion', {
  send_to: 'AW-XXXXXXXXXX/YYYYYYYY', // à remplacer après création du compte Ads
  value: 199.0,
  currency: 'EUR',
  transaction_id: order.number
});
```

### Conversion secondaire : Add to Cart (signal soft)

| Paramètre | Valeur |
|---|---|
| Nom | `Ajout au panier service clonage` |
| Catégorie | Add to Cart |
| Valeur | Pas de valeur |
| Comptage | Une |
| Compte dans "Conversions" | **Non** (signal d'aide seulement) |

### Enhanced Conversions (CRITIQUE pour iOS et 2026)

Activer dans **Outils → Conversions → [Commande payée] → Conversions optimisées**.

Le code existant `services/enhancedConversionData.js` génère déjà les hashes email/téléphone — il suffit de connecter le tag GTM aux variables dataLayer correspondantes :

```javascript
window.dataLayer.push({
  enhanced_conversion_data: {
    email: '<hashed_email_from_order>',
    phone_number: '<hashed_phone>',
    first_name: '<hashed_first_name>',
    last_name: '<hashed_last_name>',
    address: { ... }
  }
});
```

→ **Bénéfice** : récupère ~30% de conversions perdues à cause d'ITP/ITP/Safari/iOS.

---

## 7. Pré-requis avant lancement

Checklist à valider AVANT d'activer la campagne :

- [ ] **Compte Google Ads créé** sous le bon profil pro (avec facturation)
- [ ] **GTM `GTM-NZDFRVCG` linké à Google Ads** (variable Conversion ID importable)
- [ ] **GA4 linké à Google Ads** (import des conversions GA4 vers Ads)
- [ ] **Conversion "Commande payée" configurée** + tag GTM déployé en prod
- [ ] **Enhanced Conversions activées** sur la conversion principale
- [ ] **Test conversion** : passer 1 commande de test sur le site, vérifier que la conversion remonte dans Ads sous 6-24h
- [ ] **UTM auto-tagging activé** sur le compte Ads (Settings → Account → Auto-tagging = ON)
- [ ] **Liste de mots-clés négatifs créée** et associée à la campagne (cf. §3)
- [ ] **Vitesse fiche produit mobile vérifiée** sur PageSpeed Insights (cible > 70/100, sinon CPC va monter)
- [ ] **Reseaux sociaux exclus** : le tracking doit fonctionner même si l'utilisateur a un AdBlocker (server-side fallback via captureAttribution déjà en place ✅)

---

## 8. KPIs à surveiller — plan d'optimisation

### Semaine 1 (premières 200 impressions)
- **CTR par groupe d'annonces** : cible ≥ 3% (sinon revoir titres/descriptions)
- **Position moyenne** : cible 1-3 (sinon augmenter CPC max)
- **Mots-clés à 0 impression** : pause ou élargir
- **Search terms report** : ajouter tous les termes hors-sujet en mots-clés négatifs

### Semaine 2-3 (30 conversions minimum)
- **CPA effectif** vs cible 40€ : si > 60€, pause les mots-clés sous-performants
- **CR (conversion rate) sur la fiche produit** : cible ≥ 2.5%
- **Quality Score par mot-clé** : cible ≥ 6/10 (sinon améliorer landing + titres)
- **Devices** : si mobile a CPA > 2× desktop, ajuster bid adjustment mobile à -30%

### Mois 1 — décision scale ou pause
- Si CPA < 40€ et volume ≥ 10 conv/semaine → **scaler** budget à 30-40€/jour
- Si CPA 40-60€ → **optimiser** (couper mots-clés faibles, améliorer annonces, A/B test)
- Si CPA > 60€ après 4 semaines → **pause** et revoir le funnel (vitesse site, prix, USPs)

### Mois 2-3 — extension du compte
- Activer une 2e campagne **Display Remarketing** (audience = visiteurs fiche produit qui n'ont pas converti) — budget 5-10€/jour
- Tester une campagne **Performance Max** sur la base des conversions accumulées

---

## 9. Budget mensuel estimé — Mois 1

| Poste | Montant |
|---|---|
| Test Search ads | 450-600€ |
| Outils auxiliaires (Keywords Planner inclus) | 0€ |
| Création visuels (pas nécessaire en Search uniquement) | 0€ |
| **TOTAL** | **450-600€** |

ROI attendu :
- Hypothèse basse : CPA 50€ → 9-12 commandes/mois → CA 1791-2388€ — marge ~70% = 1250-1670€ — **ROI x2-3**
- Hypothèse haute : CPA 30€ → 15-20 commandes/mois → CA 2985-3980€ — marge = 2090-2790€ — **ROI x4-5**

---

## 10. Fichier d'import en bloc (CSV pour Google Ads Editor)

À copier-coller dans Google Ads Editor (Tools → Make multiple changes → Keywords) pour gagner du temps :

```csv
Campaign,Ad group,Keyword,Match Type,Max CPC
Service Clonage TCU - France,Clonage générique,clonage mécatronique DSG,Exact,3.50
Service Clonage TCU - France,Clonage générique,clonage TCU DSG,Exact,3.00
Service Clonage TCU - France,Clonage générique,clonage mécatronique S-tronic,Exact,3.00
Service Clonage TCU - France,Clonage générique,clonage TCU,Exact,2.50
Service Clonage TCU - France,Clonage générique,transfert TCU DSG,Exact,2.50
Service Clonage TCU - France,Clonage générique,clonage software TCU,Exact,3.00
Service Clonage TCU - France,Clonage générique,clonage mécatronique,Phrase,2.00
Service Clonage TCU - France,Clonage générique,clonage TCU,Phrase,2.00
Service Clonage TCU - France,Prix / Coût,prix clonage mécatronique DSG,Exact,4.00
Service Clonage TCU - France,Prix / Coût,prix clonage TCU,Exact,4.00
Service Clonage TCU - France,Prix / Coût,combien coûte clonage mécatronique,Exact,3.50
Service Clonage TCU - France,Prix / Coût,tarif clonage DSG,Exact,3.50
Service Clonage TCU - France,Prix / Coût,clonage mécatronique pas cher,Exact,2.50
Service Clonage TCU - France,Prix / Coût,prix clonage,Phrase,2.50
Service Clonage TCU - France,Symptômes,mécatronique DSG HS,Exact,2.50
Service Clonage TCU - France,Symptômes,symptômes mécatronique DSG,Exact,2.00
Service Clonage TCU - France,Symptômes,mode dégradé DSG après changement mécatronique,Exact,3.50
Service Clonage TCU - France,Symptômes,code défaut P17BF DSG,Exact,2.00
Service Clonage TCU - France,Symptômes,code défaut P189C,Exact,2.00
Service Clonage TCU - France,Symptômes,réglage de base DSG impossible,Exact,3.00
Service Clonage TCU - France,Symptômes,mécatronique DSG HS,Phrase,2.00
Service Clonage TCU - France,Par modèle,clonage DQ200,Exact,3.00
Service Clonage TCU - France,Par modèle,clonage mécatronique DQ200,Exact,3.00
Service Clonage TCU - France,Par modèle,clonage DQ250,Exact,2.50
Service Clonage TCU - France,Par modèle,clonage DL501,Exact,2.50
Service Clonage TCU - France,Par modèle,clonage S-tronic DL501,Exact,2.50
Service Clonage TCU - France,Par modèle,clonage DQ500,Exact,2.00
Service Clonage TCU - France,Par modèle,clonage DQ381,Exact,2.00
Service Clonage TCU - France,Par modèle,clonage DL382,Exact,2.00
```

---

## 11. Tracking conversion — code à déployer

Cette partie nécessite un développement côté front pour pousser l'event au moment de la commande validée. Le code existe partiellement (gclid captured), il manque le tag GTM final.

**Recommandation** : laisse-moi ouvrir un PR pour intégrer le snippet de conversion sur la page de confirmation de commande (`/commande/merci/...`). Dis-moi seulement le **AW Conversion ID** dès que tu auras créé la conversion dans l'interface Ads.

Sans ce snippet, la campagne tournera mais Ads ne saura pas quelles annonces convertissent vraiment → optimisation auto inopérante.

---

## Plan de lancement résumé

| Jour | Action |
|---|---|
| J0 | Création compte Google Ads + linkage GTM + GA4 |
| J1 | Création conversion + activation Enhanced Conversions |
| J2 | Déploiement snippet GTM purchase event en prod |
| J3 | Test conversion (commande test 199€ → vérif dans Ads sous 24h) |
| J4 | Import campagne via Google Ads Editor (cf. CSV §10) |
| J4 | Configuration annonces + extensions (cf. §4 et §5) |
| J5 | Validation finale : pré-requis §7 tous cochés |
| J5 soir | **Activation campagne** |
| J6-J12 | Monitoring quotidien + ajustement mots-clés négatifs depuis Search Terms |
| J13 | Bascule stratégie d'enchère vers tCPA si ≥ 30 conversions |
| J30 | Décision scale / optimise / pause selon CPA effectif |
