const constants = require('./constants.js');

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
 * Wrapper on top of the idb wrapper, which simplifies saving the key/value
 * pair to the object store.
 * Returns a Promise that fulfills when the transaction completes.
 *
 * @param {String} storeName
 * @param {String} key
 * @param {Object} value
 * @returns {Promise.<T>}
 */
module.exports.put = (storeName, key, value) => {
  return getDbInstance().then(db => {
    const tx = db.transaction(storeName, 'readwrite');
    const objectStore = tx.objectStore(storeName);
    objectStore.put(value, key);
    return tx.complete;
  });
};

/**
 * Wrapper on top of the idb wrapper, which simplifies deleting an entry
 * from the object store.
 * Returns a Promise that fulfills when the transaction completes.
 *
 * @param {String} storeName
 * @param {String} key
 * @returns {Promise.<T>}
 */
module.exports.delete = (storeName, key) => {
  return getDbInstance().then(db => {
    const tx = db.transaction(storeName, 'readwrite');
    const objectStore = tx.objectStore(storeName);
    objectStore.delete(key);
    return tx.complete;
  });
};

/**
 * Wrapper on top of the idb wrapper, which simplifies getting a key's value
 * from the object store.
 * Returns a promise that fulfills with the value.
 *
 * @param {String} storeName
 * @param {String} key
 * @returns {Promise.<Object>}
 */
module.exports.get = (storeName, key) => {
  return getDbInstance().then(db => {
    const tx = db.transaction(storeName);
    const objectStore = tx.objectStore(storeName);
    return objectStore.get(key);
  });
};

/**
 * Wrapper on top of the idb wrapper, which simplifies getting all the values
 * in an object store.
 * Returns a promise that fulfills with all the values.
 *
 * @param {String} storeName
 * @returns {Promise.<Array.<Object>>}
 */
module.exports.getAll = storeName => {
  return getDbInstance().then(db => {
    const tx = db.transaction(storeName);
    const objectStore = tx.objectStore(storeName);
    return objectStore.getAll();
  });
};

/**
 * Wrapper on top of the idb wrapper, which simplifies getting all the keys
 * in an object store.
 * Returns a promise that fulfills with all the keys.
 *
 * @param {String} storeName
 * @returns {Promise.<Array.<Object>>}
 */
module.exports.getAllKeys = storeName => {
  return getDbInstance().then(db => {
    const tx = db.transaction(storeName);
    const objectStore = tx.objectStore(storeName);
    return objectStore.getAllKeys();
  });
};
