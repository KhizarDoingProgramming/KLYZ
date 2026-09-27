"use client";

import * as React from "react";

export type Theme = "dark" | "light";

const subscribe = () => () => {};

/**
 * Reads a value that only exists on the client (time, local storage, the DOM)
 * without an effect. The server snapshot keeps the first paint deterministic,
 * then React re-renders with the real client value — no hydration mismatch,
 * no state update inside an effect.
 *
 * `getClientValue` must return a primitive; a fresh object each call would
 * make `useSyncExternalStore` re-render forever.
 */
export function useClientValue<T>(serverValue: T, getClientValue: () => T): T {
  return React.useSyncExternalStore(subscribe, getClientValue, () => serverValue);
}

/** True once the component is running in the browser. */
export const useMounted = (): boolean => useClientValue(false, () => true);
