/* GA4 e-commerce events — DEPRECATED.
 *
 * Ce fichier était auparavant inclus depuis footer.ejs pour pousser
 * add_to_cart / phone_click / whatsapp_click. Il a été remplacé par un
 * script INLINE dans footer.ejs (source unique de vérité) pour éviter
 * tout double-push et toute race condition de chargement.
 *
 * Le fichier est conservé en NO-OP pour ne pas casser les caches
 * navigateur ou les éventuels imports externes. Toute la logique vit
 * désormais dans `app/src/views/partials/footer.ejs` :
 *   - `window.GA4Ecommerce.trackAddToCart(form)` → push avec dédup 1500ms
 *   - listeners click + submit en capture-phase
 *
 * NE RIEN AJOUTER ICI. Ajouter dans footer.ejs.
 */
(function () {
  'use strict';
  /* no-op */
})();
