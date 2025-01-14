import { ApolloLink } from '@apollo/client/core';
import { getMainDefinition } from '@apollo/client/utilities';
import { assertPreconditions } from './validation';
import {
  isSuccessfulQuery,
  isSuccessfulMutation,
  isFailedMutation,
  isOptimistic,
  getQueryName
} from './utils';
import { createCacheManager } from './cache-manager';
import { createQueryKeyManager } from './queries-to-update-manager';
import { createMutationsManager } from './mutations-to-update-manager';
import { createInflightRequestManager } from './inflight-request-manager';


export class WatchedMutationLink extends ApolloLink {
  /**
   * @param cache - cache used w/ apollo-client
   * @param mutationQueryResolverMap - map of mutations -> map of queries -> callbacks for updating the cache
   * @param debug - flag for debug logging, will log if truthy
   * @param readOnly - flag for telling this link never to write to the cache but otherwise operate as normal
   */
  constructor(cache, mutationQueryResolverMap, debug = 0, readOnly = 0) {
    assertPreconditions(cache, mutationQueryResolverMap);
    super();

    this.cache = createCacheManager(cache, debug, readOnly);
    this.debug = debug;
    this.readOnly = readOnly;
    this.mutationManager = createMutationsManager(mutationQueryResolverMap);
    this.queryManager = createQueryKeyManager();
    this.inflightOptimisticRequests = createInflightRequestManager();
    this.debugLog({
      message: 'Success --- Constructed our link',
      watchedMutations: this.mutationManager.getMutationNames()
    });
  }

  debugLog = payload => this.debug && window.console.log(payload);
  isQueryRelated = operationName => {
    const registeredQueryNames = this.mutationManager.getAllRegisteredQueryNames();
    return registeredQueryNames.some(queryName => queryName === operationName || false);
  }
  addRelatedQuery = (queryName, operation) => {
    this.queryManager.addQuery(queryName, this.cache.createKey(operation));
  }
  removeRelatedQuery = (queryName, queryKey) => {
    this.queryManager.removeQuery(queryName, queryKey);
  }
  getCachedQueryKeysToUpdate = mutationName => {
    // gets all the unique Query + QueryVariable cache keys used by the apollo-cache
    const relevantQueryNames = this.mutationManager.getRegisteredQueryNames(mutationName);
    const relevantQueryKeys = relevantQueryNames.reduce((queryCacheKeyList, queryName) => {
      const relevantQueryCacheKeys = this.queryManager.getQueryKeysToUpdate(queryName);
      return [
        ...queryCacheKeyList,
        ...relevantQueryCacheKeys
      ];
    }, []);
    return relevantQueryKeys;
  }

  getUpdateAfterMutation = (mutationOperation, mutationData, queryKey) => {
    const queryName = getQueryName(queryKey.query);
    const cachedQueryData = this.cache.read(queryKey);
    if (!cachedQueryData) {
      // we failed reading from the cache so there's nothing to update
      // probably it was invalidated outside of this link, we should remove it from our queries to update
      this.removeRelatedQuery(queryName, queryKey);
      return;
    }
    const mutationName = getQueryName(mutationOperation.query);
    const updateQueryCb = this.mutationManager.getUpdateFn(mutationName, queryName);
    const updatedData = updateQueryCb({
      mutation: {
        name: mutationName,
        variables: mutationOperation.variables,
        result: mutationData
      },
      query: {
        name: queryName,
        variables: queryKey.variables,
        result: cachedQueryData
      }
    });
    if (updatedData !== null && updatedData !== undefined) {
      return { queryKey, updatedData };
    }
  }
  updateQueriesAfterMutation = (operation, operationName, result) => {
    const cachedQueryToUpdateKeys = this.getCachedQueryKeysToUpdate(operationName);
    const itemsToWrite = cachedQueryToUpdateKeys.reduce((items, queryKey) => {
      this.debugLog({
        message: 'Found a cached query related to this successful mutation, this Link will invoke the associated callback',
        mutationName: operationName
      });
      const resultToWrite = this.getUpdateAfterMutation(operation, result, queryKey);
      if (resultToWrite) {
        items.push(resultToWrite);
      } else {
        this.debugLog({
          message: 'We did NOT receive anything new to write to the cache so we will not do anything',
          cacheKey: queryKey
        });
      }
      return items;
    }, []);
    this.cache.performTransaction(() => {
      itemsToWrite.forEach(data => this.cache.write(data.queryKey, data.updatedData));
    });
  }

  addOptimisticRequest = (operationName) => {
    const cachedQueryToUpdateKeys = this.getCachedQueryKeysToUpdate(operationName);
    cachedQueryToUpdateKeys.forEach(queryKey => {
      const currentCachedState = this.cache.read(queryKey);
      this.inflightOptimisticRequests.set(queryKey, currentCachedState);
      this.debugLog({
        message: 'Added a cached optimistic query in case we need to revert it after an optimistic error',
        mutationName: operationName
      });
    });
  }
  clearOptimisticRequest = queryKey => {
    this.inflightOptimisticRequests.set(queryKey, null);
    this.debugLog({ message: 'Cleared a cached optimistic query' });
  }
  revertOptimisticRequest = (operationName) => {
    const cachedQueryToUpdateKeys = this.getCachedQueryKeysToUpdate(operationName);
    cachedQueryToUpdateKeys.forEach(queryKey => {
      const previousCachedState = this.inflightOptimisticRequests.getBeforeState(queryKey);
      if (previousCachedState) {
        this.cache.write(queryKey, previousCachedState);
        this.debugLog({
          message: 'Reverted an optimistic request after an error',
          afterRevert: previousCachedState,
          mutationName: operationName
        });
      }
      this.clearOptimisticRequest(queryKey);
    });
  }

  request(operation, forward) {
    const observer = forward(operation);
    const definition = getMainDefinition(operation.query);
    const operationName = (definition && definition.name && definition.name.value) || '';
    const context = operation.getContext();

    if (isOptimistic(context) && this.mutationManager.isWatched(operationName)) {
      this.addOptimisticRequest(operationName);
      this.updateQueriesAfterMutation(operation, operationName, { data: context.optimisticResponse });
    }

    return observer.map(result => {
      if (isSuccessfulQuery(definition.operation, result) && this.isQueryRelated(operationName)) {
        // for every successful query, if any watched mutations care about it, store the cacheKey to update it later
        this.debugLog({ message: 'Found a successful query related to a watched mutation', relatedQueryName: operationName });
        this.addRelatedQuery(operationName, operation);
      }
      else if (isSuccessfulMutation(definition.operation, result) && this.mutationManager.isWatched(operationName)) {
        if (isOptimistic(context)) {
          this.clearOptimisticRequest(operationName);
        } else {
          // for every successful mutation, look up the cachedQueryKeys the mutation cares about, and invoke the update callback for each one
          this.updateQueriesAfterMutation(operation, operationName, result);
        }
      } else if (
        isFailedMutation(definition.operation, result) &&
        this.mutationManager.isWatched(operationName) &&
        isOptimistic(context)
      ) {
        this.revertOptimisticRequest(operationName);
      }
      return result;
    });
  }
}

export default WatchedMutationLink;
