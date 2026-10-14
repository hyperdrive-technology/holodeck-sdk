import { describe, expect, it } from 'vitest';
import {
  HOLODECK_DOCUMENT_FORMAT,
  applyTransform,
  parseHolodeckDocument,
  validateBindings,
  validateHolodeckDocument,
  validateTransform,
  type HolodeckDocument,
  type ValueTransform,
} from './document';

const doc = (over: Record<string, unknown> = {}) => ({
  format: HOLODECK_DOCUMENT_FORMAT,
  id: 'd1',
  name: 'Prod',
  engine: 'holodeck.iso',
  body: { objects: [] },
  ...over,
});

describe('applyTransform', () => {
  it('passes values through without a transform, and null always stays null', () => {
    expect(applyTransform(undefined, 5)).toBe(5);
    expect(applyTransform({ kind: 'format', template: '{value}' }, null)).toBeNull();
  });

  describe('scale', () => {
    const t: ValueTransform = { kind: 'scale', inMin: 0, inMax: 100, outMin: 0, outMax: 1 };
    it('maps linearly and clamps by default', () => {
      expect(applyTransform(t, 50)).toBe(0.5);
      expect(applyTransform(t, 150)).toBe(1);
      expect(applyTransform(t, -10)).toBe(0);
    });
    it('extrapolates with clamp: false', () => {
      expect(applyTransform({ ...t, clamp: false }, 150)).toBe(1.5);
    });
    it('supports inverted output ranges', () => {
      expect(applyTransform({ ...t, outMin: 10, outMax: 0 }, 25)).toBe(7.5);
    });
    it('coerces booleans and numeric strings; other strings → null', () => {
      expect(applyTransform(t, true)).toBe(0.01);
      expect(applyTransform(t, '25')).toBe(0.25);
      expect(applyTransform(t, 'abc')).toBeNull();
      expect(applyTransform(t, '  ')).toBeNull();
    });
    it('#28: stays finite across the whole double range', () => {
      const wide: ValueTransform = { kind: 'scale', inMin: 0, inMax: 1, outMin: -1e308, outMax: 1e308 };
      expect(applyTransform(wide, 0)).toBe(-1e308);
      expect(applyTransform(wide, 0.5)).toBe(0);
      expect(applyTransform(wide, 1)).toBe(1e308);
      const wideIn: ValueTransform = { kind: 'scale', inMin: -1e308, inMax: 1e308, outMin: 0, outMax: 1 };
      expect(applyTransform(wideIn, 0)).toBe(0.5);
      expect(applyTransform({ ...wide, clamp: false }, 1e300)).toBeNull(); // extrapolates past MAX_VALUE
    });

    it('sdk#31 review: subnormal ranges and finite extrapolation near the limits behave as on main', () => {
      expect(applyTransform({ kind: 'scale', inMin: 0, inMax: Number.MIN_VALUE, outMin: 0, outMax: 1 }, Number.MIN_VALUE)).toBe(1);
      expect(applyTransform({ kind: 'scale', inMin: 0, inMax: 1, outMin: 1e308, outMax: 1.1e308, clamp: false }, 2)).toBe(1e308 + 2 * (1.1e308 - 1e308));
    });

    it('#32: stays finite when only the offset from inMin overflows', () => {
      const t: ValueTransform = { kind: 'scale', inMin: -1e308, inMax: -9e307, outMin: 0, outMax: 1, clamp: false };
      expect(applyTransform(t, 1e308)).toBeCloseTo(20, 10);
      expect(applyTransform({ ...t, clamp: true }, 1e308)).toBe(1);
      expect(applyTransform({ ...t, clamp: true }, -1.7e308)).toBe(0);
    });

    it('matches main\'s formula wherever main was finite (seeded sweep)', () => {
      // main: t = span === 0 ? 0 : (x - inMin) / span; out = outMin + clamp(t) * (outMax - outMin)
      const mainScale = (x: number, a: number, b: number, c: number, d: number, clamp: boolean) => {
        const span = b - a;
        const t = span === 0 ? 0 : (x - a) / span;
        const tt = clamp ? Math.min(1, Math.max(0, t)) : t;
        return c + tt * (d - c);
      };
      let seed = 12345;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const magnitudes = [1e-310, 1e-12, 1, 1e6, 1e150, 1e300, 1e307];
      const pick = () => (rnd() - 0.5) * 2 * (magnitudes[Math.floor(rnd() * magnitudes.length)] as number);
      let compared = 0;
      for (let i = 0; i < 20000; i++) {
        const [x, a, b, c, d] = [pick(), pick(), pick(), pick(), pick()];
        const clamp = rnd() < 0.5;
        const expected = mainScale(x, a, b, c, d, clamp);
        if (!Number.isFinite(expected)) continue;
        compared++;
        expect(applyTransform({ kind: 'scale', inMin: a, inMax: b, outMin: c, outMax: d, clamp }, x)).toBe(expected);
      }
      expect(compared).toBeGreaterThan(10000);
    });

    it('maps a zero-width input range to outMin', () => {
      expect(applyTransform({ ...t, inMin: 5, inMax: 5, outMin: 3 }, 9)).toBe(3);
    });
  });

  describe('threshold', () => {
    const t: ValueTransform = {
      kind: 'threshold',
      below: 'green',
      steps: [
        { at: 70, value: 'amber' },
        { at: 90, value: 'red' },
      ],
    };
    it('picks the last step at or below the input', () => {
      expect(applyTransform(t, 10)).toBe('green');
      expect(applyTransform(t, 70)).toBe('amber');
      expect(applyTransform(t, 89.9)).toBe('amber');
      expect(applyTransform(t, 95)).toBe('red');
    });
    it('returns null below the first step without `below`', () => {
      expect(applyTransform({ kind: 'threshold', steps: [{ at: 1, value: 'x' }] }, 0)).toBeNull();
    });
    it('treats non-numeric input as null', () => {
      expect(applyTransform(t, 'warm')).toBeNull();
    });
  });

  describe('map', () => {
    const t: ValueTransform = { kind: 'map', cases: { true: 'open', false: 'closed', ALARM: 'red' }, default: 'grey' };
    it('looks up String(value) and falls back to default', () => {
      expect(applyTransform(t, true)).toBe('open');
      expect(applyTransform(t, 'ALARM')).toBe('red');
      expect(applyTransform(t, 'OK')).toBe('grey');
    });
    it('does not match inherited keys', () => {
      expect(applyTransform({ kind: 'map', cases: {} }, 'toString')).toBeNull();
    });
  });

  describe('format', () => {
    it('substitutes every {value} and applies digits to numbers', () => {
      expect(applyTransform({ kind: 'format', template: '{value} % ({value})', digits: 1 }, 42.25)).toBe('42.3 % (42.3)');
      expect(applyTransform({ kind: 'format', template: 'state: {value}', digits: 2 }, 'ok')).toBe('state: ok');
      expect(applyTransform({ kind: 'format', template: '{value}' }, false)).toBe('false');
    });
  });
});

describe('validateTransform', () => {
  it('accepts every well-formed kind', () => {
    expect(validateTransform({ kind: 'scale', inMin: 0, inMax: 1, outMin: 0, outMax: 2, clamp: false })).toEqual([]);
    expect(validateTransform({ kind: 'threshold', steps: [{ at: 1, value: 'a' }, { at: 2, value: null }], below: 0 })).toEqual([]);
    expect(validateTransform({ kind: 'map', cases: { a: 1 }, default: 'b' })).toEqual([]);
    expect(validateTransform({ kind: 'format', template: 'x {value}', digits: 0 })).toEqual([]);
  });

  it('reports each problem with its path', () => {
    expect(validateTransform(null)).toEqual(['transform: must be an object']);
    expect(validateTransform({ kind: 'spin' })[0]).toMatch(/kind: must be one of/);
    expect(validateTransform({ kind: 'scale', inMin: 0, inMax: 'x', outMin: NaN, outMax: 1 })).toHaveLength(2);
    expect(validateTransform({ kind: 'scale', inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: 'yes' })).toHaveLength(1);
    expect(validateTransform({ kind: 'threshold', steps: [] })[0]).toMatch(/non-empty/);
    expect(validateTransform({ kind: 'threshold', steps: [{ at: 2, value: 1 }, { at: 1, value: 2 }] })[0]).toMatch(/ascending/);
    expect(validateTransform({ kind: 'threshold', steps: [{ at: 1, value: {} }] })[0]).toMatch(/steps\[0\]/);
    expect(validateTransform({ kind: 'threshold', steps: [{ at: 1, value: 1 }], below: [] })[0]).toMatch(/below/);
    expect(validateTransform({ kind: 'map', cases: { a: {} } })[0]).toMatch(/cases/);
    expect(validateTransform({ kind: 'map', cases: {}, default: [] })[0]).toMatch(/default/);
    expect(validateTransform({ kind: 'format', template: 'no placeholder' })[0]).toMatch(/\{value\}/);
    expect(validateTransform({ kind: 'format', template: '{value}', digits: 2.5 })[0]).toMatch(/digits/);
    expect(validateTransform({ kind: 'format', template: '{value}' }, 'a.b')[0]).toBeUndefined();
    expect(validateTransform(5, 'p.q')).toEqual(['p.q: must be an object']);
  });
});

describe('validateHolodeckDocument', () => {
  it('accepts a minimal and a full document', () => {
    expect(validateHolodeckDocument(doc())).toEqual([]);
    expect(
      validateHolodeckDocument(
        doc({
          engineVersion: '1.0.0',
          theme: 'arcentry-light',
          requires: { 'holodeck.aws': '^0.1' },
          connections: [{ id: 'prod', provider: 'aws.cloudwatch', label: 'Prod', config: { region: 'eu-west-1' } }],
          metadata: { author: 'Des' },
          extensions: { 'acme.notes': {} },
        }),
      ),
    ).toEqual([]);
  });

  it('reports every envelope problem at once', () => {
    const errors = validateHolodeckDocument({
      format: 'holodeck.document.v0',
      id: '',
      name: 3,
      engine: 'Iso Engine',
      engineVersion: '1',
      theme: '',
      requires: { 'Bad Id': 'latest' },
      connections: [{ id: 'a', provider: 'x.y' }, { id: 'a', provider: 'BAD' }, 7, { provider: 'p', label: 1, config: [] }],
      metadata: [],
      extensions: 'x',
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^format/),
        expect.stringMatching(/^id/),
        expect.stringMatching(/^name/),
        expect.stringMatching(/^engine:/),
        expect.stringMatching(/^engineVersion/),
        expect.stringMatching(/^theme/),
        expect.stringMatching(/not a dotted package id/),
        expect.stringMatching(/unsupported version range "latest"/),
        expect.stringMatching(/duplicate connection id "a"/),
        expect.stringMatching(/connections\[1\]\.provider/),
        expect.stringMatching(/connections\[2\]: must be an object/),
        expect.stringMatching(/connections\[3\]\.id/),
        expect.stringMatching(/connections\[3\]\.label/),
        expect.stringMatching(/connections\[3\]\.config/),
        expect.stringMatching(/^body/),
        expect.stringMatching(/^metadata/),
        expect.stringMatching(/^extensions/),
      ]),
    );
  });

  it('#26: validates metadata field types', () => {
    expect(validateHolodeckDocument(doc({ metadata: { description: 'd', author: 'a', created: 'c', updated: 'u', tags: ['x'] } }))).toEqual([]);
    expect(validateHolodeckDocument(doc({ metadata: { tags: 7, author: 1, created: {}, description: false, updated: [] } }))).toEqual([
      'metadata.description: must be a string',
      'metadata.author: must be a string',
      'metadata.created: must be a string',
      'metadata.updated: must be a string',
      'metadata.tags: must be an array of strings',
    ]);
    expect(validateHolodeckDocument(doc({ metadata: { tags: ['ok', 3] } }))).toEqual(['metadata.tags: must be an array of strings']);
  });

  it('rejects non-objects and non-string requires values', () => {
    expect(validateHolodeckDocument([])).toEqual(['document: must be an object']);
    expect(validateHolodeckDocument(doc({ requires: { a: 1 } }))[0]).toMatch(/requires: must map/);
    expect(validateHolodeckDocument(doc({ connections: {} }))[0]).toMatch(/connections: must be an array/);
  });

  it('parseHolodeckDocument throws with all problems or returns the document', () => {
    const ok = parseHolodeckDocument<{ objects: unknown[] }>(doc());
    expect(ok.body.objects).toEqual([]);
    expect(() => parseHolodeckDocument({})).toThrow(/invalid Holodeck document:\n- format/);
  });
});

describe('validateBindings', () => {
  const d: Pick<HolodeckDocument, 'connections'> = { connections: [{ id: 'prod', provider: 'aws.cloudwatch' }] };
  it('accepts bindings on known connections', () => {
    expect(
      validateBindings(d, [
        { objectId: 'web', param: 'color', binding: { connection: 'prod', source: 'cpu', transform: { kind: 'map', cases: {} } } },
      ]),
    ).toEqual([]);
  });
  it('reports unknown connections, empty sources and bad transforms', () => {
    const errors = validateBindings(d, [
      { objectId: 'a', param: 'x', binding: { connection: 'nope', source: '' } },
      { objectId: 'b', param: 'y', binding: { connection: 'prod', source: 's', transform: { kind: 'scale' } as never } },
      { objectId: 'c', param: 'z', binding: null as never },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        'a.x: unknown connection "nope"',
        'a.x: source must be a non-empty string',
        expect.stringMatching(/^b\.y\.transform\.inMin/),
        'c.z: binding must be an object',
      ]),
    );
  });
  it('treats a document without connections as having none', () => {
    expect(validateBindings({}, [{ objectId: 'a', param: 'x', binding: { connection: 'c', source: 's' } }])).toHaveLength(1);
  });
});
