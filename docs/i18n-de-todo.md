# I18n DE — état d'avancement et TODO

État au 30 avril 2026.

## ✅ Fait (Phase 1 + Phase 2)

### Pipeline de traduction
- Schéma `BlogPost.localizations.de` (Mongoose).
- `scripts/translate-blog-de.js` — batch FR→DE via Claude API
  (Sonnet 4.6 / Haiku 4.5 selon classification heuristique).
- `scripts/glossary-de.json` — glossaire technique imposé (~150 termes).
- `npm run translate:blog:de:dry` / `translate:blog:de` / `:retry`.

### Routes publiques DE
- `GET /de/blog` — index (articles avec `localizations.de.translatedAt`).
- `GET /de/blog/:slug` — article DE, 404 si non traduit (pas de fallback FR).
- `GET /de/*` — catchall 302 vers la version FR équivalente.

### SEO
- `<link rel="alternate" hreflang="fr|de|x-default">` réciproque sur les
  articles ayant les deux langues.
- `GET /sitemap-blog-de.xml` — uniquement les articles traduits.
- `sitemap.xml` (index) et `robots.txt` listent `sitemap-blog-de.xml`.
- JSON-LD côté DE déclare `inLanguage: "de"`.

## ⚠️ Avant de promouvoir le DE en prod, à fournir par toi

### Légal allemand (BLOQUANT pour vendre en Allemagne)
Ces 3 documents sont **obligatoires** par la loi DE pour un site e-commerce
qui livre en Allemagne. Ne pas les pondre via LLM : c'est juridique, faut
soit un template d'un cabinet (eRecht24, Trusted Shops…), soit un avocat.
Tarif moyen template : 0–200 €. Tarif avocat : 500–1 500 €.

- **Impressum** (mentions légales DE) — page `/de/legal/impressum`.
  Doit mentionner : raison sociale exacte, adresse postale physique,
  email, téléphone, n° SIRET équivalent (Handelsregisternummer),
  identification fiscale (USt-IdNr. obligatoire si livraison intra-EU
  B2C > 10 k€/an), nom du responsable de publication.
- **AGB** (CGV DE) — page `/de/legal/agb`. À adapter de tes CGV FR avec
  les mentions DE-spécifiques sur le délai de rétractation (14 jours),
  la facturation TVA, le mode de paiement, etc.
- **Widerrufsrecht** (droit de rétractation 14 jours) — page
  `/de/legal/widerrufsrecht`. Texte officiel disponible sur le site
  du Bundesministerium der Justiz.

### Paiement local
- Activer **Klarna** dans Mollie (le moyen de paiement #1 en DE).
  Sans Klarna, taux de conversion DE divisé par ~2.
- Vérifier que **SEPA** marche (généralement OK avec Mollie).

### Logistique
- Calculer les frais de port DE (15-25 € pour colis ~15-20 kg vers DE
  via DHL/DPD France).
- Mettre un message clair sur les fiches produit DE :
  "Versand aus Frankreich, 3-5 Werktage" — transparent.
- Optionnel : tarif transporteur intra-EU Heppner / Geodis pour
  industrialiser.

## 📋 Phase 3 (après lancement DE)

- Traduction des **fiches produits** + **catégories** DE
  (le pipeline existe, il faut juste l'étendre à `Product.localizations.de`).
- Switcher de langue dans le header (FR / DE).
- Slugs DE pour les articles
  (actuellement les URLs DE gardent les slugs FR — pas optimal SEO mais OK
  pour Phase 1, on optimise après si trafic suffisant).
- Mass-update des liens internes `/blog/...` dans le contenu DE pour
  pointer vers `/de/blog/...` (quand on a tout traduit).
- Search Console : créer une nouvelle propriété pour autoliva.com/de/
  et soumettre `sitemap-blog-de.xml`.
- Optionnel selon trafic : migrer `/de/` vers `autoliva.de` (ccTLD)
  une fois qu'on a 30+ ventes/mois.

## 📊 Suivi du batch en cours

```bash
# Progression
LOG=$(ls -1t tmp/translation-logs/full-batch-*.log | head -1)
DONE=$(grep -c "💾 sauvegardé" "$LOG")
echo "$DONE / 360 articles traduits"

# Tail live
tail -f "$LOG"

# Stop si besoin
kill $(cat tmp/translation-logs/full-batch.pid)
```

Si le batch est interrompu, relancer avec :
```bash
cd app && npm run translate:blog:de
# Le script saute les articles déjà traduits (filtre sur translatedAt).
```
