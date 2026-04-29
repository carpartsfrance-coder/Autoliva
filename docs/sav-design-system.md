# SAV Design System — carpartsfrance.fr

Ce document décrit les règles visuelles et UX du module SAV intégré. **Le module ne doit JAMAIS introduire de couleur, typo ou composant qui sortirait de la charte du site principal.** Tout est basé sur Tailwind (config : `app/tailwind.config.js`).

---

## 1. Tokens à réutiliser (depuis `tailwind.config.js`)

### Couleurs

| Rôle | Token Tailwind | Hex |
|---|---|---|
| Primaire (CTA, accent) | `primary` | `#ec1313` |
| Primaire hover | `primary-hover` | `#B71C1C` |
| Rouge footer | `footer-red` | `#b31d1d` |
| Texte foncé | `dark-grey` | `#1a1a1a` |
| Fond clair | `background-light` | `#F9FAFB` |
| Surface (cartes) | `surface-light` | `#FFFFFF` |
| Bord neutre | `border-light` | `#E5E7EB` |
| Fond dark mode | `background-dark` | `#111827` |
| Surface dark | `surface-dark` | `#1F2937` |
| Bord dark | `border-dark` | `#374151` |

**Couleurs sémantiques (à utiliser via les palettes Tailwind par défaut, pas de tokens custom à créer)** :

| Sémantique | Classe Tailwind |
|---|---|
| Succès | `emerald-600` / fond `emerald-50` |
| Erreur | `red-600` / fond `red-50` (⚠️ ne pas confondre avec `primary` qui sert aux CTA) |
| Warning / SLA proche | `amber-600` / fond `amber-50` |
| Info | `sky-600` / fond `sky-50` |
| Neutre / désactivé | `slate-400` |

### Typographie

- **Famille unique** : `Inter` (`font-display` = `font-body` = Inter, défini dans tailwind.config.js)
- **Tailles SAV** :
  - Titre page : `text-2xl sm:text-3xl font-bold`
  - Titre section : `text-lg sm:text-xl font-semibold`
  - Body : `text-base`
  - Meta / labels : `text-sm text-slate-500`
  - Micro / badges : `text-xs uppercase tracking-wide`

### Espacements

Échelle Tailwind par défaut. Conventions SAV :

- Padding carte : `p-5 sm:p-6`
- Gap stack vertical : `space-y-4`
- Gap formulaire : `space-y-5`
- Gap entre étapes (timeline) : `gap-6`

### Radius & ombres

- Cartes : `rounded-2xl` (cohérent avec `.product-card`, `.summary-card`)
- Inputs : `rounded-xl`
- Boutons : `rounded-xl`
- Pills / badges : `rounded-full`
- Ombre : `shadow-premium` (existante, à réutiliser pour les cartes principales)

### Breakpoints

Standard Tailwind. Cible : **mobile-first**.

| Breakpoint | px | Usage SAV |
|---|---|---|
| (default) | <640 | Mobile garage (60% du trafic) |
| `sm:` | ≥640 | Tablette portrait |
| `md:` | ≥768 | Tablette paysage |
| `lg:` | ≥1024 | Desktop admin standard |
| `xl:` | ≥1280 | Desktop admin large |

**Tests obligatoires : 360px / 768px / 1280px.**

---

## 2. Composants existants à réutiliser

| Composant | Source | Réutiliser pour |
|---|---|---|
| `.product-card` | main.css `@layer components` | Base des cards SAV (statut, étape, ticket admin) |
| `.summary-card` | main.css | Encadré récap pré-qualification, récap analyse |
| `.cart-btn-premium` | main.css | Boutons icône secondaires |
| Header / Footer partials | `views/partials/{header,footer}.ejs` | Layout client SAV (englobé dans le layout principal) |
| Tabs `#tab-...` pattern | `views/products/show.ejs` | Onglets du détail ticket admin |
| Plugin `@tailwindcss/forms` | tailwind.config.js | Inputs SAV (déjà stylés par défaut) |

**Iconographie** : Material Symbols (Outlined / Rounded), déjà chargés via `head.ejs`. Ne PAS introduire Font Awesome ni Lucide.

---

## 3. Composants à CRÉER (spécifiques SAV → `public/css/sav.css`)

| Composant | Pourquoi pas dans Tailwind direct | Classe |
|---|---|---|
| Timeline verticale d'étapes | Logique de connectors entre items | `.sav-timeline`, `.sav-timeline__item`, `.sav-timeline__dot--{ouvert,en_cours,fait,bloc}` |
| Stepper horizontal du formulaire | Indicateur multi-étapes mobile-first | `.sav-stepper`, `.sav-stepper__step` |
| Badge SLA dynamique (vert / orange / rouge) | Calcul couleur lié à `dateLimite` | `.sav-sla-badge`, modifiers `--ok`, `--warn`, `--late` |
| Carte de statut client (large hero state) | Variation visuelle de `.summary-card` | `.sav-status-card` |
| Drop-zone upload doc | Pas dans Tailwind | `.sav-dropzone` |
| Toast confirmation | Réutilisé sur tout le module | `.sav-toast`, `.sav-toast--success`, `--error` |

Tout le reste = utilitaires Tailwind directs dans les `.ejs`.

---

## 4. Patterns d'interaction (UX)

### Loading states
- **Boutons en cours** : `disabled`, spinner Material Symbols `progress_activity` en rotation, label `"En cours…"`
- **Cartes en chargement** : skeleton `animate-pulse bg-slate-200 rounded-xl h-N`
- **Pages admin (liste)** : skeleton de 5 lignes pendant le fetch

### Validation inline (formulaire client)
- Validation **au blur** du champ (pas au keystroke pour ne pas être agressif)
- Erreur affichée **sous le champ** en `text-sm text-red-600` avec icône `error_outline`
- Champ en erreur : `border-red-500 ring-1 ring-red-200`
- Champ valide après correction : pas de coche, juste retour à l'état neutre
- Le bouton "Étape suivante" reste cliquable, mais le clic re-déclenche les validations et scroll au premier champ en erreur

### Erreurs (messages humains)

❌ Interdit côté client : "Error 500", "ValidationError", "Field required", "ticket", "SLA"

✅ Modèle :
> **Quelque chose n'a pas fonctionné.** Voici ce qui s'est passé : *[message clair]*. Voici ce que vous pouvez faire : *[action concrète]*.

Exemples :
- 500 → "Notre service est momentanément indisponible. Réessayez dans une minute, ou écrivez-nous à sav@carpartsfrance.fr."
- Email invalide → "Cet email ne semble pas valide. Vérifiez qu'il contient bien un @ et une extension."
- Document trop lourd → "Ce fichier dépasse 15 Mo. Compressez-le ou envoyez une photo de meilleur cadrage plutôt qu'un scan."

### Confirmation visuelle
- Toast bas-droite (desktop) / bas centré (mobile), `aria-live="polite"`, auto-dismiss 4s
- Toast succès : icône `check_circle`, fond `emerald-50`, texte `emerald-800`
- Toast erreur : icône `error`, fond `red-50`, texte `red-800`
- Animation : `transform translate-y-2 opacity-0 → translate-y-0 opacity-100` sur 200ms

### Vocabulaire client (jamais de jargon)

| ❌ Jargon interne | ✅ Côté client |
|---|---|
| Ticket SAV | Demande |
| Numéro de ticket | Numéro de demande |
| SLA | Réponse garantie sous X jours ouvrés |
| Pré-qualification | Quelques questions pour démarrer |
| Statut `en_analyse` | "Votre pièce est sur notre banc" |
| `red_flag` | (non affiché côté client) |
| Conclusion `non_defectueux` | "La pièce fonctionne normalement à nos tests" |
| Frais d'analyse 149€ | "Forfait analyse 149€" (mentionné dès l'engagement) |

---

## 5. Accessibilité (obligatoire)

- **Contraste WCAG AA minimum** (4.5:1 texte normal, 3:1 texte large). Le `primary` `#ec1313` sur blanc passe (4.94:1). Sur fond clair, ne pas mettre de `text-primary` plus petit que `text-base`.
- **Focus visibles** sur tous les éléments interactifs : `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`. Ne JAMAIS écrire `outline-none` sans remplacement.
- **Labels explicites** sur tous les inputs (`<label for="…">`), pas de placeholder seul.
- **ARIA** :
  - Stepper : `role="progressbar" aria-valuenow=… aria-valuemin=1 aria-valuemax=N`
  - Toast : `role="status" aria-live="polite"` (succès) / `role="alert" aria-live="assertive"` (erreur)
  - Modals : `role="dialog" aria-modal="true" aria-labelledby="…"` + focus trap
  - Badges SLA : doublé d'un texte (pas seulement la couleur)
- **Navigation clavier** : tabulation cohérente, `Escape` ferme les modals, `Enter` soumet les formulaires
- **Touch targets** : minimum 44×44px sur mobile (Tailwind `min-h-[44px]`)

---

## 6. Responsive (mobile-first)

- Tous les `.ejs` SAV partent du viewport 360px et ajoutent les overrides `sm:` `md:` `lg:` ensuite.
- **Formulaire client** : 1 colonne mobile, 1 colonne tablette, max 1 colonne desktop (max-width `max-w-2xl mx-auto`) pour rester focus.
- **Liste admin tickets** :
  - Mobile : carte par ticket (titre + badges)
  - `md:` : table dense avec colonnes (numéro, client, pièce, statut, SLA, actions)
- **Détail admin** : split `lg:grid-cols-3` (col 1-2 = ticket, col 3 = sidebar actions). Stack en mobile.

---

## 7. Dark mode

Le site supporte `darkMode: 'class'` (classe sur `<html>`). Le module SAV doit fonctionner en dark, mais **uniquement côté admin** dans un premier temps. Côté client : forcer light pour éviter les ambiguïtés sur les badges/statuts.

Sur les composants `.sav-*` créés dans `sav.css`, prévoir systématiquement les variantes dark via les classes utilitaires Tailwind dans le markup, pas dans le CSS.

---

## 8. Règles d'or (à relire avant chaque PR)

1. **Mobile-first** absolu, testé à 360px.
2. **Une seule action principale** par écran, CTA en `bg-primary` plein.
3. **Validation inline au blur**, jamais d'erreur globale en bas.
4. **Loading visible** sur chaque action async.
5. **Messages d'erreur humains** (« voici ce qui s'est passé… voici ce que vous pouvez faire »).
6. **Toast de confirmation** après chaque action utilisateur.
7. **Pas de jargon** côté client (table §4).
8. **Densité maximale** côté admin, raccourcis clavier sur les actions fréquentes.
9. **Dark mode admin** seulement.
10. **Pas de pop-up intrusive** : modals contextuelles `aria-modal` avec overlay `bg-black/50`.
