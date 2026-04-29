'use strict';

/**
 * carpartsfrance.fr -> autoliva.com 301 redirect middleware.
 *
 * Permet de continuer à servir l'ancien domaine (carpartsfrance.fr) sur le
 * même service Render, en redirigeant tous les visiteurs humains vers la
 * nouvelle marque autoliva.com tout en préservant path + query params (UTM,
 * cgid, etc.) — critique pour les campagnes Google Ads et le SEO existants.
 *
 * Configuration :
 *   - ENABLE_CPF_REDIRECT=true        (active le middleware, sinon pass-through)
 *   - REDIRECT_TARGET_URL=https://...  (cible ; fallback https://autoliva.com)
 *
 * Comportement :
 *   - SI le Host est carpartsfrance.fr OU www.carpartsfrance.fr ET ENABLE_CPF_REDIRECT
 *     → 301 vers ${target}${req.originalUrl}
 *     SAUF pour les paths d'exception ci-dessous.
 *   - SINON : next()
 *
 * Exceptions (pas de redirect, on laisse l'app gérer normalement) :
 *   - /admin et /admin/*                 (admin accessible sur l'ancien domaine
 *                                         pendant la transition douce)
 *   - /api/sav/*                         (webhooks SAV externes)
 *   - /commande/paiement/webhook*        (webhooks Mollie + Scalapay en vol)
 *
 * Logging :
 *   - Toujours loggé en dev
 *   - Sampling 1% en production (sinon les logs explosent sous trafic SEO)
 *
 * Header :
 *   - Ajoute X-Brand-Migration: carpartsfrance->autoliva sur les redirections
 *
 * Tests manuels attendus :
 *   - GET https://carpartsfrance.fr/panier?utm_source=fb
 *     → 301 https://autoliva.com/panier?utm_source=fb
 *   - GET https://www.carpartsfrance.fr/produits/X
 *     → 301 https://autoliva.com/produits/X
 *   - GET https://carpartsfrance.fr/admin
 *     → next() (pas de redirection)
 *   - GET https://carpartsfrance.fr/api/sav/some-webhook
 *     → next() (pas de redirection)
 *   - GET https://carpartsfrance.fr/commande/paiement/webhook
 *     → next() (pas de redirection)
 *   - GET https://autoliva.com/panier
 *     → next() (pas de redirection)
 *   - ENABLE_CPF_REDIRECT=false + GET https://carpartsfrance.fr/panier
 *     → next() (désactivé)
 */

const SOURCE_HOSTS = new Set(['carpartsfrance.fr', 'www.carpartsfrance.fr']);

const EXCEPTION_PATTERNS = [
  /^\/admin(\/|$)/i,
  /^\/api\/sav(\/|$)/i,
  /^\/commande\/paiement\/webhook(\/|\?|$)/i,
];

function getTargetUrl() {
  const raw = (process.env.REDIRECT_TARGET_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  return 'https://autoliva.com';
}

function isEnabled() {
  return process.env.ENABLE_CPF_REDIRECT === 'true';
}

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function shouldSampleLog() {
  if (!isProd()) return true;
  return Math.random() < 0.01;
}

function isExceptedPath(pathname) {
  if (!pathname) return false;
  return EXCEPTION_PATTERNS.some((re) => re.test(pathname));
}

function cpfRedirectsMiddleware(req, res, next) {
  if (!isEnabled()) return next();

  const host = (req.hostname || '').toLowerCase();
  if (!SOURCE_HOSTS.has(host)) return next();

  // path-only check for exceptions (req.path strips the query string)
  if (isExceptedPath(req.path)) return next();

  const target = getTargetUrl();
  const destination = `${target}${req.originalUrl}`;

  res.set('X-Brand-Migration', 'carpartsfrance->autoliva');

  if (shouldSampleLog()) {
    console.log(`[301-CPF] ${req.originalUrl} -> ${destination}`);
  }

  return res.redirect(301, destination);
}

module.exports = cpfRedirectsMiddleware;
