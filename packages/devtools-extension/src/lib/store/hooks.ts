import { State, Store } from './store';
import { useCallback, useContext, useMemo } from 'react';
import { Action } from './action';
import { StoreContext } from './context';
import { Selector } from './selector';
import { useSyncExternalStore } from 'use-sync-external-store/shim';
import { StoreView } from './store-view';

export function useStore<STATE>(): Store<STATE> {
  return useContext(StoreContext);
}

export function useDispatch() {
  const store = useStore();
  return useCallback((action: Action) => store.dispatch(action), [store]);
}

export function useDispatchCallback<T extends any[]>(
  callback: (...args: [...T]) => Action | undefined,
  deps: ReadonlyArray<any>
): (...args: [...T]) => void {
  const dispatch = useDispatch();
  return useCallback((...args) => {
    const action = callback(...args);
    if (action) {
      dispatch(action);
    }
  }, deps);
}

function useSelection<STATE, RESULT>(
  store: StoreView<STATE>,
  selector: Selector<STATE, RESULT>
) {
  return useMemo(() => selector.select(store), [store, selector]);
}

export function useSelector<STATE, RESULT>(
  selector: Selector<STATE, RESULT>
): RESULT {
  const store = useStore<STATE>();
  const selection = useSelection(store, selector);
  const subscribe = useCallback(
    (callback: () => void) => {
      const subscription = selection.subscribe(callback);
      return () => subscription.unsubscribe();
    },
    [store]
  );
  const getSnapshot = useCallback(() => selection.get(), [store, selection]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useSelectorFunction<STATE, RESULT, ARGS extends any[]>(
  selectorFunction: (...args: [...ARGS]) => Selector<STATE, RESULT>,
  ...args: [...ARGS]
) {
  const selector = useMemo(
    () => selectorFunction(...args),
    [selectorFunction, ...args]
  );

  return useSelector(selector);
}

export interface StoreHooks<STATE> {
  useStore(): Store<STATE>;
  useDispatch(): Store<STATE>['dispatch'];
  useSelector<RESULT>(selector: Selector<STATE, RESULT>): RESULT;
  useSelectorFunction<RESULT, ARGS extends any[]>(
    selectorFunction: (...args: [...ARGS]) => Selector<STATE, RESULT>,
    ...args: [...ARGS]
  ): RESULT;
}

export function createStoreHooks<STORE extends Store<any>>(): StoreHooks<
  State<STORE>
> {
  return {
    useStore,
    useDispatch,
    useSelector,
    useSelectorFunction,
  };
}
