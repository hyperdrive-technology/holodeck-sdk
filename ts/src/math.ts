/**
 * Linear interpolation for `scale` transforms (#28). Internal: not re-exported
 * from `index.ts`.
 *
 * Results are identical to the plain formula `a + t * (b - a)` whenever that
 * formula is finite: plain arithmetic is tried first, so subnormal ranges
 * (`[0, Number.MIN_VALUE]`) and finite extrapolation near the limits
 * (`[0, 1] → [1e308, 1.1e308]` at 2) behave exactly as before. Only when it
 * overflows (a span such as `[-1e308, 1e308]` exceeds Number.MAX_VALUE) is
 * the half-scaled form used, which keeps every intermediate finite.
 */

/** Position of `x` in `[a, b]` (0 at a, 1 at b). A zero-width range yields 0. */
export function unlerp(x: number, a: number, b: number): number {
  const span = b - a;
  if (span === 0) return 0;
  const offset = x - a;
  if (Number.isFinite(span) && Number.isFinite(offset)) return offset / span;
  // The span or the offset overflowed (#32: x = 1e308 in [-1e308, -9e307]):
  // halve everything; the ratio is unchanged and every half is finite.
  return (x * 0.5 - a * 0.5) / (b * 0.5 - a * 0.5);
}

/** Point at `t` along `[a, b]`. */
export function lerp(t: number, a: number, b: number): number {
  const span = b - a;
  if (Number.isFinite(span)) {
    const plain = a + t * span;
    if (Number.isFinite(plain)) return plain;
  }
  // Overflow in the span or the product: compute half the result, then double.
  return 2 * (a * 0.5 + t * (b * 0.5 - a * 0.5));
}

/** `scale` mapping `x` from `[inA, inB]` to `[outA, outB]`, clamped unless `clamp` is false. `null` if not finite. */
export function scaleNumber(x: number, inA: number, inB: number, outA: number, outB: number, clamp: boolean): number | null {
  const t = unlerp(x, inA, inB);
  const result = lerp(clamp ? Math.min(1, Math.max(0, t)) : t, outA, outB);
  return Number.isFinite(result) ? result : null;
}
