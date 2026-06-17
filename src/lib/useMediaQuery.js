import { useCallback, useSyncExternalStore } from 'react'

export function useMediaQuery(query) {
  // useSyncExternalStore is the idiomatic way to subscribe to an external
  // store (here, matchMedia) without a setState-in-effect: getSnapshot reads
  // the current match on every render, subscribe wires the change listener.
  const subscribe = useCallback((onChange) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  const getSnapshot = () => typeof window !== 'undefined' && window.matchMedia(query).matches

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

export const useIsMobile = () => useMediaQuery('(max-width: 720px)')
