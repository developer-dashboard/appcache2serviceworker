/* eslint-env browser */

var constants = require('./lib/constants.js');

var swScript = document.currentScript.dataset.serviceWorker;
var manifestAttribute = document.documentElement.getAttribute('manifest');

if (manifestAttribute && 'serviceWorker' in navigator) {
  var manifestUrl = (new URL(manifestAttribute, location.href)).href;

  var idb = require('idb');

  idb.open(constants.DB_NAME, constants.DB_VERSION, function(upgradeDB) {
    if (upgradeDB.oldVersion === 0) {
      Object.keys(constants.OBJECT_STORES).forEach(function(objectStore) {
        upgradeDB.createObjectStore(constants.OBJECT_STORES[objectStore]);
      });
    }
  }).then(function(db) {
    return Promise.all([
      updateManifestAssociationForCurrentPage(db, manifestUrl),
      handlePossibleManifestUpdate(db, manifestUrl)
    ]);
  }).then(function() {
    if (swScript) {
      return navigator.serviceWorker.register(swScript);
    }
  });
}

/**
 * Caches the Responses for one or more URLs, using the Cache Storage API.
 *
 * @param {Array.<String>} urls
 * @returns {Promise.<T>}
 */
function addToCache(urls) {
  return caches.open(constants.CACHE_NAME).then(function(cache) {
    return cache.addAll(urls.map(function(url) {
      // These caching requests need to always result in a fetch() even if
      // there's a service worker that might otherwise treat them differently.
      // Let's use this special request header to let the service worker know.
      return new Request(url, {headers: {'X-Use-Network': true}});
    }));
  });
}

/**
 * Compares the copy of a manifest obtained from fetch() with the copy stored
 * in IndexedDB. If they differ, it kicks off the manifest update process.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @returns {Promise.<T>}
 */
function handlePossibleManifestUpdate(db, manifestUrl) {
  var tx = db.transaction(constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
  var store = tx.objectStore(
    constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

  return Promise.all([
    fetch(manifestUrl).then(function(manifestResponse) {
      return manifestResponse.text();
    }),
    store.get(manifestUrl).then(function(idbEntryForManifest) {
      return idbEntryForManifest ? idbEntryForManifest.text : '';
    })
  ]).then(function(manifestTexts) {
    // manifestTexts[0] is the text content from the fetch().
    // manifestTexts[1] is the text content from IDB.
    if (manifestTexts[0] !== manifestTexts[1]) {
      return performManifestUpdate(db, manifestUrl, manifestTexts[0]);
    }
  });
}

/**
 * Parses the newest manifest text into the format described at
 * https://www.npmjs.com/package/parse-appcache-manifest
 * The parsed manifest is stored in IndexedDB.
 * This also calls addToCache() to cache the relevant URLs from the manifest.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @param {String} manifestText
 * @returns {Promise.<T>}
 */
function performManifestUpdate(db, manifestUrl, manifestText) {
  var parseAppCacheManifest = require('parse-appcache-manifest');
  var parsedManifest = makeManifestUrlsAbsolute(manifestUrl,
    parseAppCacheManifest(manifestText));

  var tx = db.transaction(constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS,
    'readwrite');
  var store = tx.objectStore(
    constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

  var fallbackUrls = Object.keys(parsedManifest.fallback).map(function(key) {
    return parsedManifest.fallback[key];
  });

  return Promise.all([
    store.put({
      text: manifestText,
      parsed: parsedManifest
    }, manifestUrl),
    // Wait on tx.complete to ensure that the transaction succeeded.
    tx.complete,
    addToCache(parsedManifest.cache.concat(fallbackUrls))
  ]);
}

/**
 * Updates IndexedDB to indicate that the current page's URL is associated
 * with the AppCache manifest at manifestUrl.
 * It also adds the current page to the cache, matching the implicit
 * cache-as-you-go behavior you get with AppCache.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @returns {Promise.<T>}
 */
function updateManifestAssociationForCurrentPage(db, manifestUrl) {
  var tx = db.transaction(constants.OBJECT_STORES.PATH_TO_MANIFEST,
    'readwrite');
  var store = tx.objectStore(constants.OBJECT_STORES.PATH_TO_MANIFEST);

  return Promise.all([
    store.put(manifestUrl, location.href),
    // Wait on tx.complete to ensure that the transaction succeeded.
    tx.complete,
    addToCache([location.href])
  ]);
}

/**
 * Converts all the URLs in a given manifest's CACHE, NETWORK, and FALLBACK
 * sections to be absolute URLs.
 *
 * @param {String} baseUrl
 * @param {Object} originalManifest
 * @returns {Object}
 */
function makeManifestUrlsAbsolute(baseUrl, originalManifest) {
  var manifest = {};

  manifest.cache = originalManifest.cache.map(function(relativeUrl) {
    return (new URL(relativeUrl, baseUrl)).href;
  });

  manifest.network = originalManifest.network.map(function(relativeUrl) {
    if (relativeUrl === '*') {
      return relativeUrl;
    }

    return (new URL(relativeUrl, baseUrl)).href;
  });

  manifest.fallback = {};
  Object.keys(originalManifest.fallback).forEach(function(key) {
    manifest.fallback[(new URL(key, baseUrl)).href] =
      (new URL(originalManifest.fallback[key], baseUrl)).href;
  });

  return manifest;
}
