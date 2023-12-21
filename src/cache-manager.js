import {
  getQueryDefinition,
  isField
} from '@apollo/client/utilities';

export const createCacheManager = (cache, debug, readOnly) => {
  return {
    createKey: operation => ({ query: operation.query, variables: operation.variables }),
    performTransaction: writeFn => {
      if (cache.performTransaction) {
        return cache.performTransaction(writeFn);
      } else {
        return writeFn(cache);
      }
    },
    read: query => {
      try {
        return cache.readQuery(query);
      } catch (error) {
        if (debug) {
          window.console.log({
            message: 'Error --- Unable to read from cache',
            cacheKey: query,
            error
          });
        }
      }
    },
    write: (query, data) => {
      if (readOnly) {
        if (debug) {
          window.console.log({
            message: 'ReadOnly --- this link will NOT write to the cache but it would have attempted to',
            cacheKey: query,
            data
          });
        }
        return;
      }
      try {
        cache.writeQuery({ ...query, data });
        if (debug) {
          window.console.log({
            message: 'Success --- Updated the cache upon a mutation/subscription',
            cacheKey: query,
            data
          });
        }
      } catch (error) {
        if (debug) {
          window.console.log({
            message: 'Error --- Unable to write to the cache',
            cacheKey: query,
            data,
            error
          });
        }
      }
    },
    evict: query => {
      if (readOnly) {
        if (debug) {
          window.console.log({
            message: 'ReadOnly --- this link will NOT evict from the cache but it would have attempted to',
            cacheKey: query
          });
        }
        return false;
      }
      try {
        // Calculate the cache-ids of the query, since the cache
        // does not support DocumentNode when evicting.
        const queryDefinition = getQueryDefinition(query.query);
        const queryTypename = cache.policies.rootTypenamesById['ROOT_QUERY'];
        const cacheIds = queryDefinition.selectionSet.selections.filter(isField).map(fieldNode =>
          cache.policies.getStoreFieldName({
            typename: queryTypename,
            fieldName: fieldNode.name.value,
            field: fieldNode,
            variables: query.variables,
          }),
        );

        let evicted = false;
        cacheIds.forEach(cacheId => {
          evicted ||= cache.evict({ fieldName: cacheId });
        });
        if (debug) {
          window.console.log({
            message: 'Success --- Evicted a query from the cache upon a mutation/subscription',
            queryName: queryName,
            cacheKey: query,
            evicted
          });
        }
        return evicted;
      } catch (error) {
        if (debug) {
          window.console.log({
            message: 'Error --- Unable to evict from cache',
            queryName: queryName,
            cacheKey: query,
            error
          });
        }
      }
    },
    gc: () => {
      try {
        cache.gc();
      } catch (error) {
        if (debug) {
          window.console.log({
            message: 'Error --- Unable to run garbage collection on cache',
            error
          });
        }
      }
    }
  };
};
