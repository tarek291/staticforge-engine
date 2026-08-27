/**
 * Resolve after `ms` milliseconds.
 *
 * Used to pace outbound API calls so a batch run stays inside provider rate
 * limits. Non-finite or non-positive delays resolve on the next tick instead of
 * throwing, so callers may pass a computed value without guarding it.
 *
 * @param ms - Delay in milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}
