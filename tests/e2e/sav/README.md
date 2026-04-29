# Tests e2e SAV — Playwright (skeleton)

> Ces fichiers sont des **squelettes documentés**. Playwright n'est pas encore
> installé dans le projet. Pour les exécuter :
>
> ```bash
> cd app
> npm install -D @playwright/test @axe-core/playwright
> npx playwright install --with-deps chromium firefox webkit
> npx playwright test
> ```
>
> Puis ajouter à `app/package.json` :
> ```json
> "scripts": {
>   "e2e": "playwright test",
>   "e2e:ui": "playwright test --ui"
> }
> ```
>
> Et créer `app/playwright.config.js` (un exemple est dans
> `tests/e2e/playwright.config.example.js`).

## Pré-requis runtime

- Le serveur Express tourne sur `http://localhost:3000`
- MongoDB est connectée
- Au moins un compte client de test existe : `e2e+client@example.com / e2eClientPass!`
- Au moins un compte admin de test existe : `e2e+admin@carpartsfrance.fr / e2eAdminPass!`
- Une commande `CP-E2E-0001` payée < 24 mois est associée au client de test

## Specs fournies

| Fichier | Couvre |
|---|---|
| `01-parcours-client.spec.js` | Parcours complet : login client, wizard 6 étapes, upload 2 fichiers, validation, page confirmation |
| `02-brouillon-restauration.spec.js` | Remplir 3 étapes, fermer, rouvrir, vérifier reprise |
| `03-recommencer-a-zero.spec.js` | Reset complet (modale + clearDraft + retour étape 1) |
| `04-validation-inline.spec.js` | VIN invalide (16 chars / I/O/Q), plaque invalide, description < 20 chars |
| `05-admin-recoit-ticket.spec.js` | Login admin, vérifie le ticket dans la liste avec toutes les données du client |
| `06-workflow-admin.spec.js` | Changer statut, ajouter diagnostic, facturer 149€ (mock Mollie), clôturer |
| `07-alertes-sla.spec.js` | Mock du temps via injection direct DB, vérifie pré-alerte 24h/12h envoyée |
| `08-responsive-mobile.spec.js` | Refait le parcours en viewport iPhone 14 Pro (390x844) |
| `09-a11y-axe.spec.js` | Audit axe-core sur /sav, /sav/feedback, /admin/sav |

## Variables d'env attendues par les specs

```
E2E_BASE_URL=http://localhost:3000
E2E_CLIENT_EMAIL=e2e+client@example.com
E2E_CLIENT_PASS=e2eClientPass!
E2E_ADMIN_EMAIL=e2e+admin@carpartsfrance.fr
E2E_ADMIN_PASS=e2eAdminPass!
E2E_ORDER_NUMBER=CP-E2E-0001
```
