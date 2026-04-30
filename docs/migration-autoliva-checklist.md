# Migration carpartsfrance.fr → autoliva.com — Checklist

État actuel (2026-04-30) : la stack code est brand-aware (`BRAND=autoliva`)
mais quelques chantiers restent à finaliser pour clore proprement la migration.
Cette checklist sert de référence opérationnelle.

---

## 1. Code (déjà fait dans cette branche)

- [x] `services/brandSanitizer.js` créé : sanitize les overrides DB legacy
  ("CarParts France", "Car Parts France", `carpartsfrance.fr`, emails @carpartsfrance.fr).
- [x] Homepage meta description (`homeController.js`) : `aboutText` passé via
  `sanitizeBrandLeak()`.
- [x] Fiches produits (`productController.js`) : `seo.metaTitle` et
  `seo.metaDescription` passés via `sanitizeBrandLeak()`. `ensureBrandSuffix()`
  ajoute ` | Autoliva` aux titles overrides qui n'en ont pas.
- [x] Pages catégorie (`categoryController.js`) : `formatCategoryDisplayName()`
  retire les chevrons `>` dans le H1 et le `<title>` ("Moteur > Bloc moteur"
  → "Bloc moteur").
- [x] Backoffice (`adminController.js`, `savAdminController.js`,
  `blogAdminController.js`) : tous les `title: 'Erreur - CarParts France'` et
  `'Page introuvable - CarParts France'` remplacés par `${brand.NAME}`.
- [x] SAV (`savPlaybooks.js`, `savReportPdf.js`, `savCgvPdf.js`,
  `routes/api/sav.js`) : signatures email, header PDF, mentions légales
  passées en `${brand.NAME}` / `${brand.EMAIL_SAV}` / `${brand.PHONE}` /
  `${brand.SITE_URL}`.
- [x] Vues admin (`dashboard.ejs`, `login.ejs`, `sav-ticket.ejs`,
  `partials/sidebar.ejs`, `blog-post.ejs`, `product.ejs`) : strings hardcodées
  remplacées par `<%= brand.NAME %>`.
- [x] Sitemap splitté : `/sitemap.xml` est maintenant un index pointant vers
  `/sitemap-{pages,categories,products,vehicles,references,blog}.xml`. Permet
  un crawl Google plus ciblé. Flag `SITEMAP_LEGACY_FLAT=true` pour rollback.

## 2. Base de données (à exécuter en production)

- [ ] **Lancer le script de cleanup DB** sur l'environnement de prod
  (idéalement après un dump/backup) :

  ```bash
  # Dry-run (lecture seule, recommandé en premier)
  BRAND=autoliva MONGODB_URI=... node scripts/migrate-brand-leak.js -v

  # Si le rapport est OK, appliquer :
  BRAND=autoliva MONGODB_URI=... node scripts/migrate-brand-leak.js --apply
  ```

  Le script nettoie : `SiteSettings.aboutText` + 3 autres champs,
  `Product.{name,shortDescription,description,seo.metaTitle,seo.metaDescription}`,
  `BlogPost.{title,excerpt,contentHtml,contentMarkdown,seo.*}`,
  `Category.{name,seoText}`, `LegalPage.{title,contentHtml,contentMarkdown}`.

  > Le sanitizer côté rendu rattrape déjà ces leaks à l'affichage, mais
  > nettoyer la DB évite la latence de la sanitization et rend l'admin
  > cohérent visuellement.

## 3. Variables d'environnement (Render)

- [ ] Confirmer `BRAND=autoliva` sur le service Render principal
  (autoliva.com).
- [ ] Confirmer `ENABLE_CPF_REDIRECT=true` sur le même service (le middleware
  `cpfRedirects` 301 carpartsfrance.fr → autoliva.com côté app).
- [ ] Confirmer `REDIRECT_TARGET_URL=https://autoliva.com` (par défaut).
- [ ] Confirmer `SITE_URL=https://autoliva.com` (sans `www.`).
- [ ] Vérifier que `SESSION_SECRET` et `MONGODB_URI` sont bien définis.

## 4. DNS / Cloudflare (action manuelle)

**Problème actuel** : `carpartsfrance.fr` (apex) → 301 → `www.carpartsfrance.fr`
→ 301 → `autoliva.com` = chaîne de 2 sauts (perte ~1-3 % de link equity).

- [ ] Sur Cloudflare, supprimer (ou modifier) la Page Rule qui force
  `carpartsfrance.fr → www.carpartsfrance.fr`.
- [ ] Configurer le record DNS de l'apex `carpartsfrance.fr` pour qu'il pointe
  directement sur le service Render qui héberge autoliva.com (CNAME flattening
  ou A record vers l'IP Render). Le middleware `cpfRedirects` se chargera
  ensuite du 301 final en 1 seul saut.
- [ ] **Test après modification** :
  ```bash
  curl -sI https://carpartsfrance.fr/produits/X
  # Attendu : HTTP/2 301 + Location: https://autoliva.com/produits/X
  # (en 1 seul saut, sans détour par www.)
  ```

## 5. Google Search Console

### 5.0. Bug fix critique : sitemap.xml Set-Cookie pollution

**Symptôme observé** : Search Console affichait "Impossible de lire le sitemap" avec 0 page découverte malgré un sitemap valide en HTTP 200.

**Cause** : `express-session` (avec `rolling: true`) ajoutait un `Set-Cookie: carpartsfrance.sid=...` sur **toutes** les réponses, y compris `/sitemap.xml` et `/robots.txt`. Or :
- Une réponse avec `Set-Cookie` est traitée comme **par-utilisateur** par les CDN et bots → pas de cache CDN partagé.
- Google Search Console refuse de parser un sitemap qui set un cookie (le sitemap doit être 100 % public et identique pour tous les bots).

**Fix appliqué** dans cette branche (`src/app.js`) : les routes `/sitemap.xml`, `/sitemap-{pages,categories,products,vehicles,references,blog}.xml` et `/robots.txt` sont maintenant déclarées **avant** le middleware `session()`, ce qui les exclut de la chaîne. Vérifié : `curl -sI https://localhost/sitemap.xml | grep -i set-cookie` ne renvoie plus rien.

**Action après déploiement** :
- [ ] Vérifier en prod : `curl -sI https://autoliva.com/sitemap.xml | grep -i set-cookie` doit ne **rien** renvoyer.
- [ ] Dans GSC, supprimer le sitemap de la liste, puis le re-soumettre (`/sitemap.xml`). Sous 24-48 h, "Impossible de lire" doit passer à "Réussi" avec ≥ 3 000 pages découvertes.



- [ ] **Soumettre le Change of Address** : Search Console → carpartsfrance.fr
  property → Settings → Change of Address → cible = autoliva.com.
- [ ] Vérifier que la propriété `autoliva.com` est bien créée et validée
  (DNS TXT ou meta tag).
- [ ] Soumettre `https://autoliva.com/sitemap.xml` sur la propriété autoliva.com.
- [ ] Demander l'indexation manuelle des 20 top URLs (HP, top catégories,
  top fiches produits, top articles blog) via "URL Inspection" → "Request
  Indexing".
- [ ] Surveiller les rapports "Pages" et "Coverage" pendant 4-8 semaines pour
  détecter les pertes d'indexation.
- [ ] Conserver la propriété `carpartsfrance.fr` au moins 6 mois pour
  surveiller la transition.

## 6. Avis externes — preuves sociales

- [ ] **Trustpilot** : contacter le support pour transférer le profil
  `carpartsfrance.fr` (36 avis) vers `autoliva.com`. Trustpilot accepte les
  rebrandings sur preuve documentaire (Kbis, capture des 301, attestation).
- [ ] **Avis Vérifiés** : contacter le support pour migrer le compte (4.6/5).
- [ ] **Google Business Profile** : créer ou renommer l'établissement
  "Autoliva" à l'adresse 50 Bd Stalingrad, 06300 Nice (site web =
  https://autoliva.com).
- [ ] **Pages Jaunes** : mettre à jour la fiche existante avec le nouveau nom
  + URL.

## 7. Liens externes & ads

- [ ] **Google Ads** : mettre à jour les URLs de destination dans toutes les
  campagnes actives. Les redirections 301 préservent les UTM, mais Google Ads
  préfère des URLs finales propres pour le Quality Score.
- [ ] **Google Merchant Center** : si présent, repointer le feed produits sur
  autoliva.com.
- [ ] **Réseaux sociaux** : mettre à jour les URL bio sur Facebook,
  Instagram, YouTube, TikTok, LinkedIn (configurés dans `brand.SOCIAL`).
- [ ] **Backlinks notables** : contacter les sites éditeurs qui linkent
  `carpartsfrance.fr` pour les remplacer par `autoliva.com` (les 301
  conservent le link equity, mais un lien direct est meilleur long terme).

## 8. Tests post-déploiement

```bash
# Title brand cohérent partout
curl -s https://autoliva.com/ | grep -oE '<title>[^<]+</title>'
# Attendu : "Pièces auto reconditionnées, d'occasion et testées | Autoliva"

# Meta description sans leak
curl -s https://autoliva.com/ | grep 'meta name="description"'
# Ne doit PAS contenir "Car Parts France"

# Fiche produit sans leak ni suffix manquant
curl -s https://autoliva.com/product/mecatronique-dsg-7-dq200-pour-volkswagen-audi-seat-et-skoda/ | grep -oE '<title>[^<]+</title>'
# Doit finir par "| Autoliva"

# Catégorie sans chevrons HTML
curl -s https://autoliva.com/categorie/moteur-bloc-moteur | grep -oE '<h1[^>]*>[^<]+</h1>'
# Attendu : "Bloc moteur" (sans le préfixe "Moteur >")

# Sitemap index
curl -s https://autoliva.com/sitemap.xml | head -3
# Attendu : <sitemapindex …>

# Sous-sitemaps accessibles
for sub in pages categories products vehicles references blog; do
  echo -n "sitemap-$sub : "
  curl -sI "https://autoliva.com/sitemap-$sub.xml" | head -1
done

# Migration carpartsfrance → autoliva : 1 seul saut
curl -sI https://carpartsfrance.fr/produits | grep -iE '(HTTP|location)'
# Attendu : HTTP/2 301 + Location: https://autoliva.com/produits (UN saut)
```

## 9. Suivi à 30 / 60 / 90 jours

- [ ] **J+30** : vérifier dans GSC que `autoliva.com` reçoit la majorité des
  impressions/clics. Le trafic carpartsfrance.fr doit décroître à mesure que
  Google met à jour son index.
- [ ] **J+60** : vérifier qu'au moins 80 % des URLs critiques sont indexées
  sur autoliva.com (HP, top 50 fiches, top catégories, blog).
- [ ] **J+90** : décider si on peut clôturer la propriété GSC carpartsfrance.fr
  et libérer les Page Rules Cloudflare. Garder les 301 actifs au moins 12 mois.
