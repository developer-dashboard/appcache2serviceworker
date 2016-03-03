module.exports = {
  CACHE_NAME: 'appcache-manifest-entries',
  DB_NAME: 'appcache-to-service-worker',
  DB_VERSION: 1,
  OBJECT_STORES: {
    MANIFEST_URL_TO_CONTENTS: 'manifest-url-to-contents',
    PATH_TO_MANIFEST: 'path-to-manifest'
  }
};
