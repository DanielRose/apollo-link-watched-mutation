export const createQueryKeyManager = (debug) => {
  // used to keep track of unique QueryName + QueryCacheKey combinations
  // structured as { Query: [cache_key_1, cache_key_2, ...] }
  const queriesToUpdate = {};

  const getQueryKeysToUpdate = queryName => queriesToUpdate[queryName] || [];

  return {
    addQuery: (queryName, queryKey) => {
      const existingQueryKeys = getQueryKeysToUpdate(queryName);
      if (!existingQueryKeys.some(key => JSON.stringify(key) === JSON.stringify(queryKey))) {
        queriesToUpdate[queryName] = [...getQueryKeysToUpdate(queryName), queryKey];
        if (debug) {
          window.console.log({
            message: 'Tracking a new QueryName + QueryCacheKey combination',
            queryName: queryName,
            queryKey: queryKey,
            trackedQueries: queriesToUpdate[queryName]
          });
        }
      }
    },
    removeQuery: (queryName, queryKey) => {
      const updatedQueryKeys = getQueryKeysToUpdate(queryName).filter(key => JSON.stringify(key) !== JSON.stringify(queryKey));
      if (queriesToUpdate[queryName].length !== updatedQueryKeys.length) {
        queriesToUpdate[queryName] = updatedQueryKeys;
        if (debug) {
          window.console.log({
            message: 'Removed a tracked QueryName + QueryCacheKey combination',
            queryName: queryName,
            queryKey: queryKey,
            trackedQueries: queriesToUpdate[queryName]
          });
        }
      }      
    },
    hasQueryToUpdate: queryName => getQueryKeysToUpdate(queryName).length > 0,
    getQueryKeysToUpdate
  };
}