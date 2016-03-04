/* eslint-env worker, serviceworker */

(function(global) {
  'use strict';
  // Code in the ServiceWorkerGlobalScope can safely assume that a greater
  // set of ES2015 features are available, without having to transpile.

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
   * @returns {Promise.<Response>}
   */
  function fetchWithFallback(request, fallbackUrl) {
    console.debug('Trying fetch for', request.url);
    return fetch(request).catch(() => {
      console.debug('fetch() failed. Falling back to cache of', fallbackUrl);
      return caches.open(constants.CACHE_NAME).then(
        cache => cache.match(fallbackUrl));
    });
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
    console.debug('Starting appCacheBehaviorForUrl for', requestUrl);

    // If this is a request that, as per the AppCache spec, should be handled
    // via a direct fetch(), then do that and bail early.
    if (event.request.headers.get('X-Use-Fetch') === 'true') {
      console.debug('Using fetch() because X-Use-Fetch: true');
      return fetch(event.request);
    }

    return getDbInstance().then(db => {
      return getClientUrlForEvent(event).then(clientUrl => {
        console.debug('clientUrl is', clientUrl);
        if (clientUrl) {
          const tx = db.transaction(
            constants.OBJECT_STORES.PATH_TO_MANIFEST);
          const store = tx.objectStore(
            constants.OBJECT_STORES.PATH_TO_MANIFEST);
          return store.get(clientUrl).then(manifestUrl => {
            console.debug('manifestUrl is', manifestUrl);

            // Now, the complicated bit. First, see if we have a manifest
            // associated with the client. I.e., is manifestUrl defined?
            if (manifestUrl) {
              // If we know which manifest applies, let's put it to use.
              const manifestTx = db.transaction(
                constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
              const manifestStore = manifestTx.objectStore(
                constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

              return manifestStore.get(manifestUrl).then(manifest => {
                console.debug('manifest is', manifest);
                // Is our request URL listed in the CACHES section?
                // Or is our request URL the client URL, since any page that
                // registers a manifest is treated as if it were in the CACHE?
                if (manifest.parsed.cache.includes(requestUrl) ||
                    requestUrl === clientUrl) {
                  console.debug('CACHE includes URL; using cache.match()');
                  // If so, return the cached response.
                  return caches.open(constants.CACHE_NAME).then(
                    cache => cache.match(requestUrl));
                }

                // Otherwise, check the FALLBACK section next.
                // FALLBACK keys are URL prefixes, and if more than one prefix
                // matches our request URL, the longest prefix "wins".
                // (Of course, it might be that none of the prefixes match.)
                const fallbackKey = longestMatchingPrefix(
                  Object.keys(manifest.parsed.fallback), requestUrl);
                if (fallbackKey) {
                  console.debug('fallbackKey in manifest matches', fallbackKey);
                  return fetchWithFallback(event.request,
                    manifest.parsed.fallback[fallbackKey]);
                }

                // If CACHE and FALLBACK don't apply, try NETWORK.
                if (manifest.parsed.network.includes(requestUrl) ||
                  manifest.parsed.network.includes('*')) {
                  console.debug('Match or * in NETWORK; using fetch()');
                  return fetch(event.request);
                }

                // If nothing matches, then return an error response.
                // TODO: Is returning Response.error() the best approach?
                console.debug('Nothing matches; using Response.error()');
                return Response.error();
              });
            }

            console.debug('No matching manifest for client found.');
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
              console.debug('All manifests:', manifests);
              // Use .map() to create an array of the longest matching prefix
              // for each manifest. If no prefixes match for a given manifest,
              // the value will be ''.
              const longestForEach = manifests.map(manifest => {
                return longestMatchingPrefix(
                  Object.keys(manifest.parsed.fallback), requestUrl);
              });
              console.debug('longestForEach:', longestForEach);

              // Next, find which of the longest matching prefixes from each
              // manifest is the longest overall. Return both the index of the
              // manifest in which that match appears and the prefix itself.
              const longest = longestForEach.reduce((soFar, current, i) => {
                if (current.length >= soFar.prefix.length) {
                  return {prefix: current, index: i};
                }

                return soFar;
              }, {prefix: '', index: 0});
              console.debug('longest:', longest);

              // Now that we know the longest overall prefix, we'll use that
              // to lookup the fallback URL value in the winning manifest.
              const fallbackKey = longest.prefix;
              console.debug('fallbackKey:', fallbackKey);
              if (fallbackKey) {
                const winningManifest = manifests[longest.index];
                console.debug('winningManifest:', winningManifest);
                return fetchWithFallback(event.request,
                  winningManifest.parsed.fallback[fallbackKey]);
              }

              // If nothing matches, then just fetch().
              console.debug('Nothing at all matches. Using fetch()');
              return fetch(event.request);
            });
          });
        }
      });
    });
  }

  /**
   * A wrapper on top of appCacheBehaviorForEvent() that handles rejections with
   * a default of fetch().
   *
   * @param {FetchEvent} event
   * @returns {Promise.<Response>}
   */
  global.legacyAppCacheBehavior = event => {
    return appCacheBehaviorForEvent(event).catch(error => {
      console.warn(`No AppCache behavior for ${event.request.url}:`, error);
      // TODO: Is it sensible to use fetch() here as a fallback?
      return fetch(event.request);
    });
  };
})(self);
