import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps docs/PACKAGING.md §7 (the flow engine) honest about the variadic input
 * shape. The SDK does not export flow block types: `FlowBlockDefinition` lives
 * in `@holodeck/flow-runtime` (holodeck `packages/flow-runtime/src/block.ts`),
 * which this repo must not depend on. So `checkVariadicInput` below mirrors the
 * runtime validator's variadic rules (`validatePorts` in block.ts); update both
 * together if the runtime changes. See issue #38: the doc once said
 * `variadic: { min, max }`, which the runtime rejects with
 * `inputs[0].variadic: must be a boolean`.
 */

const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'PACKAGING.md'), 'utf8');

/** Mirrors `FLOW_LIMITS.maxVariadic` and `DEFAULT_VARIADIC_MIN/MAX` in @holodeck/flow-runtime. */
const MAX_VARIADIC = 64;
const DEFAULT_MIN = 2;
const DEFAULT_MAX = 16;

function section7(): string {
  const start = doc.indexOf('## 7. ');
  const end = doc.indexOf('\n## 8. ', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

function tsBlocks(text: string): string[] {
  return [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** The runtime's variadic checks for one input spec, as error strings (empty = valid). */
function checkVariadicInput(port: Record<string, unknown>, at = 'inputs[0]'): string[] {
  const errors: string[] = [];
  if (port.variadic !== undefined && typeof port.variadic !== 'boolean') errors.push(`${at}.variadic: must be a boolean`);
  if (port.variadic !== true) {
    if (port.min !== undefined || port.max !== undefined) errors.push(`${at}: min/max need variadic: true`);
    return errors;
  }
  const min = port.min === undefined ? DEFAULT_MIN : port.min;
  const max = port.max === undefined ? Math.max(DEFAULT_MAX, min as number) : port.max;
  if (!Number.isInteger(min) || (min as number) < 0 || (min as number) > MAX_VARIADIC) {
    errors.push(`${at}.min: must be an integer 0–${MAX_VARIADIC}`);
  } else if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_VARIADIC) {
    errors.push(`${at}.max: must be an integer 1–${MAX_VARIADIC}`);
  } else if ((min as number) > (max as number)) errors.push(`${at}: min must be ≤ max`);
  if (typeof port.name === 'string' && /\d$/.test(port.name)) errors.push(`${at}.name: a variadic input name may not end in a digit`);
  return errors;
}

describe('PACKAGING.md §7 variadic inputs match @holodeck/flow-runtime', () => {
  it('FlowBlockDefinition outline declares variadic as a boolean with flat min/max', () => {
    const outline = tsBlocks(section7()).find((b) => b.includes('interface FlowBlockDefinition'));
    expect(outline).toBeDefined();
    expect(outline).toMatch(/variadic\?: boolean;/);
    expect(outline).toMatch(/min\?: number;/);
    expect(outline).toMatch(/max\?: number;/);
    // The old, wrong nested shape (issue #38).
    expect(outline).not.toMatch(/variadic\?:\s*\{/);
  });

  it('the documented example input passes the runtime variadic rules', () => {
    const example = tsBlocks(section7()).find((b) => /^inputs: \[/.test(b.trim()));
    expect(example).toBeDefined();
    // The snippet is a TS object literal (unquoted keys), not JSON, so evaluate
    // it as JS. It is our own checked-in doc, never user input.
    const inputs = new Function(`return ${example!.trim().replace(/^inputs:\s*/, '')};`)() as Record<string, unknown>[];
    expect(inputs).toEqual([{ name: 'in', type: 'bool', variadic: true, min: 2, max: 8 }]);
    expect(inputs.flatMap((p, i) => checkVariadicInput(p, `inputs[${i}]`))).toEqual([]);
    // Prose names the right instance ports for that example.
    expect(section7()).toContain('`in1` … `in8`');
  });

  it('the mirrored rules reject the shapes the doc warns about', () => {
    expect(checkVariadicInput({ name: 'in', type: 'bool', variadic: { min: 2, max: 8 } })).toEqual([
      'inputs[0].variadic: must be a boolean',
    ]);
    expect(checkVariadicInput({ name: 'in', type: 'bool', min: 2, max: 8 })).toEqual(['inputs[0]: min/max need variadic: true']);
    expect(checkVariadicInput({ name: 'in2', type: 'bool', variadic: true })).toEqual([
      'inputs[0].name: a variadic input name may not end in a digit',
    ]);
    expect(checkVariadicInput({ name: 'in', type: 'bool', variadic: true, min: 9, max: 8 })).toEqual(['inputs[0]: min must be ≤ max']);
    expect(checkVariadicInput({ name: 'in', type: 'bool', variadic: true, max: 65 })).toEqual(['inputs[0].max: must be an integer 1–64']);
    expect(checkVariadicInput({ name: 'in', type: 'bool', variadic: true })).toEqual([]);
  });
});
