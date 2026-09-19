"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `run` once `key` has stopped changing for `delayMs`, and never on the
 * first render.
 *
 * Both of this screen's network calls want exactly that shape: a judge dragging
 * a slider should produce one voice-preview call and one save, not forty, and
 * neither should fire for a personality nobody has touched yet. The callback is
 * held in a ref so it always sees the newest state without restarting the timer
 * on every keystroke.
 *
 * The `AbortSignal` is aborted when `key` changes again, so a slow answer for
 * an abandoned slider position can never overwrite a newer one.
 */
export function useDebouncedEffect(
  key: string,
  delayMs: number,
  run: (signal: AbortSignal) => void,
): void {
  const latest = useRef(run);
  const first = useRef(true);

  useEffect(() => {
    latest.current = run;
  });

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => latest.current(controller.signal), delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, delayMs]);
}
