"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ApiError, getJson } from "./api";

/** Reads a gateway path now and then every `everyMs`. The last good value stays on screen while it refetches. */
export function usePolled<T>(path: string, everyMs?: number): { data?: T; error?: ApiError } {
  const [state, setState] = useState<{ data?: T; error?: ApiError }>({});

  useEffect(() => {
    let live = true;
    const load = () =>
      getJson<T>(path).then(
        (data) => live && setState({ data }),
        (error: ApiError) => live && setState((previous) => ({ ...previous, error })),
      );
    load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path, everyMs]);

  return state;
}

// Stored settings. `memory` is the source of truth so the page still works when
// localStorage is blocked (private windows); storage only makes it survive a reload.
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string {
  if (!memory.has(key)) {
    try {
      memory.set(key, localStorage.getItem(key) ?? "");
    } catch {
      memory.set(key, "");
    }
  }
  return memory.get(key)!;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useStored<T extends object>(key: string, initial: T): [T, (patch: Partial<T>) => void] {
  // The server snapshot is empty, so the first client render matches the server HTML.
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => "",
  );
  const value = useMemo<T>(() => ({ ...initial, ...(raw ? JSON.parse(raw) : {}) }), [initial, raw]);

  const update = (patch: Partial<T>) => {
    const next = JSON.stringify({ ...value, ...patch });
    memory.set(key, next);
    try {
      localStorage.setItem(key, next);
    } catch {}
    listeners.forEach((listener) => listener());
  };
  return [value, update];
}
