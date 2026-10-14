/**
 * Overflow-resistant linear interpolation for `scale` transforms (#28).
 * Internal: not re-exported from `index.ts`.
 *
 * The naive `a + t * (b - a)` overflows when `b - a` exceeds Number.MAX_VALUE
 * (e.g. a = -1e308, b = 1e308), turning valid inputs into NaN or Infinity.
 * Working with halves keeps every intermediate finite for finite inputs.
 */

/** Position of `x` in `[a, b]` (0 at a, 1 at b). A zero-width range yields 0. */
export function unlerp(x: number, a: number, b: number): number {
  const span = b * 0.5 - a * 0.5;
  if (span === 0) return 0;
  return (x * 0.5 - a * 0.5) / span;
}

/** Point at `t` along `[a, b]`; `a * (1 - t) + b * t` cannot overflow for t in [0, 1]. */
export function lerp(t: number, a: number, b: number): number {
  return a * (1 - t) + b * t;
}

/** `scale` mapping `x` from `[inA, inB]` to `[outA, outB]`, clamped unless `clamp` is false. `null` if not finite. */
export function scaleNumber(x: number, inA: number, inB: number, outA: number, outB: number, clamp: boolean): number | null {
  const t = unlerp(x, inA, inB);
  const result = lerp(clamp ? Math.min(1, Math.max(0, t)) : t, outA, outB);
  return Number.isFinite(result) ? result : null;
}
