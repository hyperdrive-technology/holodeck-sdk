import { describe, expect, it } from 'vitest';
import { assertValidRange, compareVersions, isValidRange, isValidVersion, parseVersion, satisfiesRange } from './version';

describe('parseVersion', () => {
  it('parses full versions with optional pre-release', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('0.0.1-beta.2')).toEqual({ major: 0, minor: 0, patch: 1, prerelease: 'beta.2' });
  });

  it.each(['1.2', '01.2.3', '1.2.3.4', 'v1.2.3', '', '1.2.x', '1.2.3-'])('rejects %j', (v) => {
    expect(parseVersion(v)).toBeUndefined();
    expect(isValidVersion(v)).toBe(false);
  });

  it('isValidVersion rejects non-strings', () => {
    expect(isValidVersion(1)).toBe(false);
    expect(isValidVersion(undefined)).toBe(false);
  });
});

describe('compareVersions', () => {
  const c = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);
  it('orders by major, minor, patch', () => {
    expect(c('1.0.0', '2.0.0')).toBe(-1);
    expect(c('1.2.0', '1.1.9')).toBe(1);
    expect(c('1.1.1', '1.1.1')).toBe(0);
  });
  it('puts pre-releases before their release', () => {
    expect(c('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(c('1.0.0', '1.0.0-beta')).toBe(1);
    expect(c('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['*', '0.0.1', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['1.2', '1.2.0', true],
    ['^1.2', '1.2.0', true],
    ['^1.2', '1.9.9', true],
    ['^1.2', '2.0.0', false],
    ['^1.2', '1.1.9', false],
    ['^0.2', '0.2.5', true],
    ['^0.2', '0.3.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['~1.2', '1.2.9', true],
    ['~1.2', '1.3.0', false],
    ['~1.2.3', '1.2.2', false],
    ['>=1.2.3', '9.0.0', true],
    ['>=1.2.3', '1.2.2', false],
    [' ^1.0 ', '1.0.0', true],
  ])('%s vs %s → %s', (range, version, ok) => {
    expect(satisfiesRange(version, range)).toBe(ok);
  });

  it('pre-release versions only satisfy *', () => {
    expect(satisfiesRange('1.0.0-beta', '*')).toBe(true);
    expect(satisfiesRange('1.0.0-beta', '^1.0')).toBe(false);
    expect(satisfiesRange('1.1.0-beta', '>=1.0.0')).toBe(false);
  });

  it('malformed versions never satisfy', () => {
    expect(satisfiesRange('1.0', '*')).toBe(false);
  });

  it.each(['1.x', '^1.0.0-beta', '>1.0.0', '<=2', '1.0 || 2.0', '', 'latest'])('throws for unsupported range %j', (r) => {
    expect(() => satisfiesRange('1.0.0', r)).toThrow(RangeError);
    expect(() => assertValidRange(r)).toThrow(RangeError);
    expect(isValidRange(r)).toBe(false);
  });

  it('isValidRange accepts the supported subset only', () => {
    for (const r of ['*', '1.2.3', '^1.2', '~1.2.3', '>=0.1']) expect(isValidRange(r)).toBe(true);
    expect(isValidRange(5)).toBe(false);
  });
});
