/* eslint-env worker, serviceworker */

(function(global) {
  'use strict';
  // Code in the ServiceWorkerGlobalScope can safely assume that a greater
  // set of ES2015 features are available, without having to transpile.
  
  const log = console.debug.bind(console);

  const constants = require('./lib/constants.js');
  let _db = null;

  /**
   * Gets an open instance of DB, a Promise-based wrapper on top of IndexedDB.
   * If there's already a previously opened instance, it returns that.
   *
   * @returns {Promise.<DB>} The open DB instance
   */
  function getDbInstance() {
    if (_db) {
      return Promise.resolve(_db);
    }

    const idb = require('idb');
    // The object stores will have been created by the web page prior to
    // service worker registration.
    return idb.open(constants.DB_NAME, constants.DB_VERSION).then(db => {
      _db = db;
      return _db;
    });
  }

  /**
   * Determines what the most likely URL is associated with the client page from
   * which the event's request originates. This is used to determine which
   * AppCache manifest's rules should be applied.
   *
   * @param {FetchEvent} event
   * @returns {String} The client URL
   */
  function getClientUrlForEvent(event) {
    // If our service worker implementation supports client identifiers, try
    // to get the client URL using that.
    if (global.clients && global.clients.get && event.clientId) {
      return global.clients.get(event.clientId).then(client => client.url);
    }

    // Otherwise, try to get the client URL using the Referer header.
    // And if that's not set, assume that it's a navigation request and the
    // effective client URL should be the request URL.
    // TODO: Is that a reasonable assumption?
    return Promise.resolve(event.request.referrer || event.request.url);
  }

  /**
   * Finds the longest matching prefix, given an array of possible matches.
   *
   * @param {Array.<String>} urlPrefixes
   * @param {String} fullUrl
   * @returns {String} The longest matching prefix, or '' if none match
   */
  function longestMatchingPrefix(urlPrefixes, fullUrl) {
    return urlPrefixes
      .filter(urlPrefix => fullUrl.startsWith(urlPrefix))
      .reduce((longestSoFar, current) => {
        return longestSoFar.length >= current.length ? longestSoFar : current;
      }, '');
  }

  /**
   * Performs a fetch(), using a cached response as a fallback if that fails.
   *
   * @param {Request} request
   * @param {String} fallbackUrl
   * @param {String} cacheName
   * @returns {Promise.<Response>}
   */
  function fetchWithFallback(request, fallbackUrl, cacheName) {
    log('Trying fetch for', request.url);
    return fetch(request).catch(() => {
      log('fetch() failed. Falling back to cache of', fallbackUrl);
      return caches.open(cacheName).then(
        cache => cache.match(fallbackUrl));
    });
  }

  /**
   * Checks IndexedDB for a manifest with a given URL, versioned with the
   * given hash. If found, it fulfills with the parsed manifest.
   *
   * @param db
   * @param manifestUrl
   * @param manifestHash
   * @returns {Promise.<Object>}
   */
  function getParsedManifest(db, manifestUrl, manifestHash) {
    const tx = db.transaction(
      constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
    const store = tx.objectStore(
      constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

    return store.get(manifestUrl).then(versions => {
      versions = versions || [];
      log('versions is', versions);
      return versions.reduce((result, current) => {
        log('current is', current);
        // If we already have a result, just keep returning it.
        if (result) {
          log('result is', result);
          return result;
        }

        // Otherwise, check to see if the hashes match. If so, use the parsed
        // manifest for the current entry as the result.
        if (current.hash === manifestHash) {
          log('manifestHash match', current);
          return current.parsed;
        }
      }, null);
    });
  }

  /**
   * Updates the CLIENT_ID_TO_HASH store in IndexedDB with the client id to
   * hash association.
   *
   * @param db
   * @param clientId
   * @param hash
   * @returns {Promise.<T>}
   */
  function saveClientIdAndHash(db, clientId, hash) {
    if (clientId) {
      const tx = db.transaction(constants.OBJECT_STORES.CLIENT_ID_TO_HASH,
        'readwrite');
      const store = tx.objectStore(constants.OBJECT_STORES.CLIENT_ID_TO_HASH);
      store.put(hash, clientId);
      return tx.complete;
    }

    return Promise.resolve();
  }

  /**
   * An attempt to mimic AppCache behavior, using the primitives available to
   * a service worker.
   *
   * @param {FetchEvent} event
   * @returns {Promise.<Response>}
   */
  function appCacheBehaviorForEvent(event) {
    const requestUrl = event.request.url;
    log('Starting appCacheBehaviorForUrl for', requestUrl);

    // If this is a request that, as per the AppCache spec, should be handled
    // via a direct fetch(), then do that and bail early.
    if (event.request.headers.get('X-Use-Fetch') === 'true') {
      log('Using fetch() because X-Use-Fetch: true');
      return fetch(event.request);
    }

    // TODO: Use the client id mappings when possible.
    // Refactor this code.
    return getDbInstance().then(db => {
      return getClientUrlForEvent(event).then(clientUrl => {
        log('clientUrl is', clientUrl);
        if (clientUrl) {
          const tx = db.transaction(
            constants.OBJECT_STORES.PATH_TO_MANIFEST);
          const store = tx.objectStore(
            constants.OBJECT_STORES.PATH_TO_MANIFEST);
          return store.get(clientUrl).then(manifestForClient => {
            log('manifestForClient is', manifestForClient);

            // Now, the complicated bit. First, see if we have a manifest
            // associated with the client.
            if (manifestForClient) {
              const url = manifestForClient.url;
              const hash = manifestForClient.hash;

              // Save the mapping between the current client id and hash.
              return saveClientIdAndHash(db, event.clientId, hash).then(() => {
                return getParsedManifest(db, url, hash)
              }).then(parsedManifest => {
                log('parsedManifest is', parsedManifest);
                // Is our request URL listed in the CACHES section?
                // Or is our request URL the client URL, since any page that
                // registers a manifest is treated as if it were in the CACHE?
                if (parsedManifest.cache.includes(requestUrl) ||
                    requestUrl === clientUrl) {
                  log('CACHE includes URL; using cache.match()');
                  // If so, return the cached response.
                  return caches.open(manifestForClient.hash).then(
                    cache => cache.match(requestUrl));
                }

                // Otherwise, check the FALLBACK section next.
                // FALLBACK keys are URL prefixes, and if more than one prefix
                // matches our request URL, the longest prefix "wins".
                // (Of course, it might be that none of the prefixes match.)
                const fallbackKey = longestMatchingPrefix(
                  Object.keys(parsedManifest.fallback), requestUrl);
                if (fallbackKey) {
                  log('fallbackKey in parsedManifest matches', fallbackKey);
                  return fetchWithFallback(event.request,
                    parsedManifest.fallback[fallbackKey],
                    manifestForClient.hash);
                }

                // If CACHE and FALLBACK don't apply, try NETWORK.
                if (parsedManifest.network.includes(requestUrl) ||
                  parsedManifest.network.includes('*')) {
                  log('Match or * in NETWORK; using fetch()');
                  return fetch(event.request);
                }

                // If nothing matches, then return an error response.
                // TODO: Is returning Response.error() the best approach?
                log('Nothing matches; using Response.error()');
                return Response.error();
              });
            }

            log('No matching manifest for client found.');
            // If we fall through to this point, then we don't have a known
            // manifest associated with the client making the request.
            // We now need to check to see if our request URL matches a prefix
            // from the FALLBACK section of *any* manifest in our origin. If
            // there are multiple matches, the longest prefix wins. If there are
            // multiple prefixes of the same length in different manifest, then
            // the one returned last from IDB wins. (This might not match
            // browser behavior.)
            // See https://www.w3.org/TR/2011/WD-html5-20110525/offline.html#concept-appcache-matches-fallback
            const tx = db.transaction(
              constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
            const store = tx.objectStore(
              constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
            return store.getAll().then(manifests => {
              log('All manifests:', manifests);
              // Use .map() to create an array of the longest matching prefix
              // for each manifest. If no prefixes match for a given manifest,
              // the value will be ''.
              const longestForEach = manifests.map(manifestVersions => {
                // Use the latest version of a given manifest.
                const parsedManifest =
                  manifestVersions[manifestVersions.length - 1].parsed;
                return longestMatchingPrefix(
                  Object.keys(parsedManifest.fallback), requestUrl);
              });
              log('longestForEach:', longestForEach);

              // Next, find which of the longest matching prefixes from each
              // manifest is the longest overall. Return both the index of the
              // manifest in which that match appears and the prefix itself.
              const longest = longestForEach.reduce((soFar, current, i) => {
                if (current.length >= soFar.prefix.length) {
                  return {prefix: current, index: i};
                }

                return soFar;
              }, {prefix: '', index: 0});
              log('longest:', longest);

              // Now that we know the longest overall prefix, we'll use that
              // to lookup the fallback URL value in the winning manifest.
              const fallbackKey = longest.prefix;
              log('fallbackKey:', fallbackKey);
              if (fallbackKey) {
                const winningManifest = manifests[longest.index];
                log('winningManifest:', winningManifest);
                const winningManifestVersion =
                  winningManifest[winningManifest.length - 1];
                log('winningManifestVersion:', winningManifestVersion);
                const hash =
                  winningManifest[winningManifest.length - 1].hash;
                const parsedManifest =
                  winningManifest[winningManifest.length - 1].parsed;
                return fetchWithFallback(event.request,
                  parsedManifest.fallback[fallbackKey], hash);
              }

              // If nothing matches, then just fetch().
              log('Nothing at all matches. Using fetch()');
              return fetch(event.request);
            });
          });
        }
      });
    });
  }

  /**
   * Fulfills with an array of all the hash ids that correspond to outdated
   * manifest versions.
   *
   * @returns {Promise.<String>}
   */
  function getHashesOfOlderVersions() {
    return getDbInstance().then(db => {
      const tx = db.transaction(
        constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
      const store = tx.objectStore(
        constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

      return store.getAll().then(manifests => {
        return manifests.map(versions => {
          // versions.slice(0, -1) will give all the versions other than the
          // last, or [] if there's aren't any older versions.
          return versions.slice(0, -1)
            .map(version => version.hash);
        }).reduce((prev, curr) => {
          return prev.concat(curr);
        }, []);
      });
    });
  }

  /**
   * Given a list of client ids that are still active, this:
   * 1. Gets a list of all the client ids in IndexedDB's CLIENT_ID_TO_HASH
   * 2. Filters them to remove the active ones
   * 3. Delete the inactive entries from IndexedDB's CLIENT_ID_TO_HASH
   * 4. For each inactive one, return the corresponding hash association.
   *
   * @param idsOfActiveClients
   * @returns {Promise.<Array.<String>>}
   */
  function cleanupClientIdAndHash(idsOfActiveClients) {
    return getDbInstance().then(db => {
      const readTx = db.transaction(constants.OBJECT_STORES.CLIENT_ID_TO_HASH);
      const readStore = readTx.objectStore(
        constants.OBJECT_STORES.CLIENT_ID_TO_HASH);
      return readStore.getAllKeys().then(allKnownIds => {
        return allKnownIds.filter(id => !idsOfActiveClients.includes(id));
      }).then(idsOfInactiveClients => {
        return Promise.all(idsOfInactiveClients.map(id => {
          const readTx = db.transaction(
            constants.OBJECT_STORES.CLIENT_ID_TO_HASH);
          const readStore = readTx.objectStore(
            constants.OBJECT_STORES.CLIENT_ID_TO_HASH);

          return readStore.get(id).then(hash => {
            const writeTx = db.transaction(
              constants.OBJECT_STORES.CLIENT_ID_TO_HASH, 'readwrite');
            const writeStore = writeTx.objectStore(
              constants.OBJECT_STORES.CLIENT_ID_TO_HASH);
            writeStore.delete(id);
            return writeTx.complete.then(() => hash);
          });
        }));
      });
    });
  }

  /**
   * Does the following:
   * 1. Gets a list of all client ids associated with this service worker.
   * 2. Calls cleanupClientIdAndHash() to remove the out of date client id
   *    to hash associations.
   * 3. Calls getHashesOfOlderVersions() to get a list of all the hashes
   *    that correspond to out-of-date manifest versions.
   * 4. If there's a match between an out of date hash and a hash that is no
   *    longer being used by a client, then it deletes the corresponding cache.
   */
  function cleanupOldCaches() {
    self.clients.matchAll().then(clients => {
      return clients.map(client => client.id);
    }).then(idsOfActiveClients => {
      return cleanupClientIdAndHash(idsOfActiveClients);
    }).then(hashesNotInUse => {
      return getHashesOfOlderVersions().then(hashesOfOlderVersions => {
        return hashesOfOlderVersions.filter(hashOfOlderVersion => {
          return hashesNotInUse.includes(hashOfOlderVersion);
        });
      });
    }).then(idsToDelete => {
      log('deleting cache ids', idsToDelete);
      return Promise.all(idsToDelete.map(cacheId => caches.delete(cacheId)));
    });

    // TODO: Delete the entry in the array stored in MANIFEST_URL_TO_CONTENT.
  }

  /**
   * A wrapper on top of appCacheBehaviorForEvent() that handles rejections with
   * a default of fetch().
   *
   * @param {FetchEvent} event
   * @returns {Promise.<Response>}
   */
  global.legacyAppCacheBehavior = event => {
    return appCacheBehaviorForEvent(event).then(response => {
      // If this is a navigation, clean up unused caches that correspond to old
      // AppCache manifest versions which are no longer associated with an
      // active client. This will be done asynchronously, and won't block the
      // response from being returned to the onfetch handler.
      if (event.request.mode === 'navigate') {
        cleanupOldCaches();
      }

      return response;
    }).catch(error => {
      console.warn(`No AppCache behavior for ${event.request.url}:`, error);
      // TODO: Is it sensible to use fetch() here as a fallback?
      return fetch(event.request);
    });
  };
})(self);
