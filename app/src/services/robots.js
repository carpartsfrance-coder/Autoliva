'use strict';

/* Reconnaître un robot à son User-Agent.
 *
 * Googlebot exécute le JavaScript des pages : il déclenchait le traceur
 * d'audience exactement comme un visiteur, et « direct » gonflait de 70 000
 * sessions à une seule page par semaine — des robots, pas des clients. Les
 * mesures d'audience ne veulent que des humains ; les robots, eux, ont les
 * journaux du serveur.
 *
 * La liste vise les familles (bot, crawler, spider), les outils de mesure
 * (Lighthouse, PageSpeed, GTmetrix, Pingdom) et les clients HTTP sans
 * navigateur (curl, python-requests, Go, Java…). Un User-Agent vide n'est pas
 * un navigateur non plus.
 */

const MOTIF = new RegExp([
  '(?:bot|crawler|spider)(?:[\\s\\/;:,)\\-]|$)',
  'slurp', 'headless', 'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot', 'monitor',
  'facebookexternalhit', 'inspectiontool', 'bytespider', 'dataforseo', 'semrush', 'ahrefs', 'mj12', 'dotbot',
  'petalbot', 'yandex', 'baidu', 'sogou', 'archive\\.org', 'ia_archiver',
  'python-requests', 'python-urllib', 'go-http-client', 'okhttp', 'java\\/', 'curl\\/', 'wget\\/', 'scrapy',
  'httpclient', 'axios\\/', 'node-fetch', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
].join('|'), 'i');

function estRobot(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return true;
  return MOTIF.test(ua);
}

module.exports = { estRobot };
