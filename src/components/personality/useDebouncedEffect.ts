"use client";

import { useEffect, useRef } from "react";

export interface DebouncedEffectOptions {
  /**
   * Whether a call still sitting on the timer fires when the component goes
   * away. Defaults to true, because a debounced *write* that silently never
   * happens is the surprising outcome.
   *
   * Pass false for a call whose only effect is to update this screen. Once the
   * screen is gone there is nothing for the answer to land on, and firing it
   * spends a model call repainting something nobody is looking at.
   */
  flushOnUnmount?: boolean;
}

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
 * ## Abort means superseded, not unmounted
 *
 * The `AbortSignal` is aborted when `key` changes again, so a slow answer for
 * an abandoned slider position can never overwrite a newer one. That abort is
 * raised at the top of the *next* run rather than in the cleanup, and the
 * distinction is the whole point of this file: cleanup also runs on unmount,
 * and an unmount is not a superseded value. It is the last chance the call has
 * to happen at all.
 *
 * Aborting there — and dropping the timer with it — lost the personality save
 * whenever somebody moved a slider and clicked SEND MY AGENT TO THE TOWN
 * inside the debounce window. That save is what clears the finished plan, so
 * the town then repainted the previous run and the personality flip, which is
 * the one beat on stage that proves the agents are not scripted, visibly did
 * nothing. A longer window would only have moved the race; the pending call
 * now fires on the way out instead.
 */
export function useDebouncedEffect(
  key: string,
  delayMs: number,
  run: (signal: AbortSignal) => void,
  options: DebouncedEffectOptions = {},
): void {
  const { flushOnUnmount = true } = options;

  const latest = useRef(run);
  const first = useRef(true);
  /** The scheduled call that has not happened yet, or null. */
  const pending = useRef<(() => void) | null>(null);
  /** The controller of the value currently on the timer or in flight. */
  const inFlight = useRef<AbortController | null>(null);
  const flushRef = useRef(flushOnUnmount);

  useEffect(() => {
    latest.current = run;
    flushRef.current = flushOnUnmount;
  });

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }

    // A new key supersedes whatever the last call was made with, so that
    // call's answer is no longer wanted.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      pending.current = null;
      latest.current(controller.signal);
    };

    pending.current = fire;
    const timer = setTimeout(fire, delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);

  // Declared after the effect above so it is the last cleanup to run, though
  // `fire` is idempotent and the order only decides whether the timer or this
  // wins the race. Reads the flag through a ref so the hook's behaviour on the
  // way out is the caller's latest intent rather than the one from mount.
  useEffect(
    () => () => {
      if (flushRef.current) pending.current?.();
      pending.current = null;
    },
    [],
  );
}
