import { useCallback, useRef } from "react";
import { newId } from "./ids";

/**
 * One Idempotency-Key per submission attempt: retrying the exact same body
 * (e.g. after a network failure) reuses the key so the server replays instead
 * of applying twice; any change to the body gets a fresh key, because the
 * server refuses a reused key with a different body.
 */
export function useAttemptKey() {
  const ref = useRef<{ json: string; key: string } | null>(null);
  const keyFor = useCallback((body: unknown): string => {
    const json = JSON.stringify(body);
    if (ref.current && ref.current.json === json) return ref.current.key;
    ref.current = { json, key: newId() };
    return ref.current.key;
  }, []);
  const reset = useCallback(() => {
    ref.current = null;
  }, []);
  return { keyFor, reset };
}
