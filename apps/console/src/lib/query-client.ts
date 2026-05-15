import { QueryClient } from "@tanstack/react-query";

/**
 * Single QueryClient instance. Tunes:
 * - staleTime 30s — most console data is stable across short windows;
 *   no point refetching `/v1/agents` every focus event when the user
 *   just looked at it 5 seconds ago.
 * - gcTime 5min — drop unused cache entries after 5 min idle.
 * - refetchOnWindowFocus true — when the user tabs back, freshen lists
 *   that have gone stale. Implicit "the world might have changed while
 *   I was gone" expectation.
 * - retry 1 — one quick retry papers over transient flakes (CF cold
 *   start, brief proxy 502). Anything more re-runs broken queries on
 *   real failures and slows down user-visible error states.
 * - retryDelay 800ms — short, fixed. Default exponential adds latency
 *   on transient failures without buying much.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
      retryDelay: 800,
    },
    mutations: {
      retry: 0,
    },
  },
});
