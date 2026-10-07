/** Bounded, cancellable polling: unrelated DOM activity cannot extend the deadline. */
export function waitFor<T>(
  read: () => T | null | undefined | false,
  { timeout = 6000, stableFor = 120, signal }: { timeout?: number; stableFor?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    let previous: T | null = null;
    let stableSince = 0;
    const started = performance.now();
    const finish = (value: T | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish(null);
    const check = () => {
      if (signal?.aborted) return finish(null);
      const now = performance.now();
      let value: T | null | undefined | false;
      try { value = read(); } catch { value = null; }
      if (value) {
        if (value !== previous) stableSince = now;
        if (now - stableSince >= stableFor) return finish(value);
        previous = value;
      } else {
        previous = null;
      }
      if (now - started >= timeout) return finish(null);
      timer = setTimeout(check, Math.min(50, timeout - (now - started)));
    };
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

export function samePage(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}
