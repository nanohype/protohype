/**
 * Throw after `ms` if the promise has not settled. The underlying task
 * keeps running — we don't abort it — because detection layers are CPU-
 * bound or already signal-aware internally. The deadline here is a fail-
 * secure backstop.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
