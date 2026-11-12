'use strict';

// Réduction d'image hors du fil principal, une à la fois, avec un délai maximal.
//
// Le site tourne sur un seul processus : décoder une photo de téléphone prend
// deux à trois secondes de calcul, pendant lesquelles plus aucune page ne
// serait servie. Le travail part donc dans un fil séparé (worker_threads).
// Garde-fous :
//   - une seule image à la fois (les appels d'un assistant arrivent souvent
//     par paquets : cinq photos décodées ensemble, c'est un gigaoctet) ;
//   - file d'attente bornée : au-delà, on refuse au lieu d'empiler ;
//   - délai maximal : le fil est arrêté s'il ne rend rien à temps.
// La limite de pixels, elle, est vérifiée par l'appelant AVANT d'arriver ici
// (voir imageDims.js) : c'est elle qui borne la mémoire. `resourceLimits` ne
// plafonne que le tas JavaScript du fil, pas l'image décodée (hors tas).

const path = require('path');
const { Worker } = require('worker_threads');

const TIMEOUT_MS = 20000;
const MAX_WAITING = 8;

let chain = Promise.resolve();
let waiting = 0;

function runWorker(buffer, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'imageResizeWorker.js'), {
      workerData: { bytes: Uint8Array.from(buffer), maxWidth: opts.maxWidth, maxHeight: opts.maxHeight, quality: opts.quality },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('délai dépassé')), opts.timeoutMs || TIMEOUT_MS);
    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, { buffer: Buffer.from(msg.bytes), width: msg.width, height: msg.height });
      else finish(reject, new Error((msg && msg.error) || 'échec du décodage'));
    });
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`fil arrêté (code ${code})`)));
  });
}

/**
 * @param {Buffer} buffer  JPEG ou PNG dont les dimensions ont déjà été vérifiées
 * @param {{ maxWidth: number, maxHeight: number, quality: number, timeoutMs?: number }} opts
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>} un JPEG réduit
 */
function resizeToJpeg(buffer, opts) {
  if (waiting >= MAX_WAITING) {
    return Promise.reject(new Error('trop de lectures d\'images en cours'));
  }
  waiting += 1;
  const job = chain.then(() => runWorker(buffer, opts));
  // La file continue même si ce travail échoue.
  chain = job.then(() => {}, () => {}).finally(() => { waiting -= 1; });
  return job;
}

module.exports = { resizeToJpeg, TIMEOUT_MS, MAX_WAITING };
