import { describe, expectTypeOf, it } from 'vitest';

import {
  ContributionRegistry,
  PROVIDER_KIND,
  isHolodeckProvider,
  validateScene,
  type Contribution,
  type ContributionKind,
  type HolodeckProvider,
  type SceneFile,
  type ValidationResult,
} from './index.js';

/**
 * Type tests for the public API (#22). These assertions are checked by `pnpm type-check`
 * (tsconfig.check.json includes tests); at runtime `expectTypeOf` is a no-op, so this file
 * costs Vitest nothing. A `@ts-expect-error` that stops erroring fails type-check, so the
 * negative cases pin that the contracts stay strict.
 */
describe('public API types', () => {
  it('isHolodeckProvider narrows unknown to HolodeckProvider', () => {
    const item: unknown = {};
    if (isHolodeckProvider(item)) expectTypeOf(item).toEqualTypeOf<HolodeckProvider>();
    expectTypeOf(PROVIDER_KIND).toEqualTypeOf<ContributionKind<HolodeckProvider>>();
  });

  it('ContributionRegistry.get is typed by the caller and may miss', () => {
    interface Part extends Contribution {
      label: string;
    }
    const registry = new ContributionRegistry();
    expectTypeOf(registry.get<Part>('test.part', 'x')).toEqualTypeOf<Part | undefined>();
    // @ts-expect-error a contribution type must have an id
    registry.get<{ label: string }>('test.part', 'x');
  });

  it('SceneFile requires version, metadata and scene', () => {
    expectTypeOf(validateScene).parameter(0).toEqualTypeOf<SceneFile>();
    expectTypeOf(validateScene).returns.toEqualTypeOf<ValidationResult>();
    // @ts-expect-error metadata and scene are required
    const partial: SceneFile = { version: '1' };
    void partial;
  });
});
