import assert from 'node:assert/strict';

/**
 * Minimal `expect` shim over node:assert/strict.
 *
 * This Node build does not export `expect` from `node:test`, but its own
 * runner still handles describe/it lifecycle. Only the assertion sugar is
 * local, so the specs read the way Jest/Vitest ones do. If `expect` ever
 * lands in the runtime, delete this file and change the import.
 */

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, replacer, 0) ?? String(value);
  } catch {
    return String(value);
  }
}

// JSON.stringify chokes on cycles; fall back to a shallow readable form.
function replacer(_key, value) {
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

function deepEqual(actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

const PRIMITIVES = { String, Number, Boolean, BigInt, Function, Symbol };

/** Asymmetric matcher: matches anything of the given type or shape. */
function asymmetricMatch(predicate, describe) {
  return {
    asymmetricMatch: predicate,
    toString: () => describe,
    // Vitest/Jest call this when the value is the whole expectation.
    get expected() {
      return describe;
    },
  };
}

function matches(actual, expected) {
  if (expected && typeof expected === 'object' && 'asymmetricMatch' in expected) {
    return expected.asymmetricMatch(actual);
  }
  return deepEqual(actual, expected);
}

export function expect(actual) {
  const api = {
    toBe(expected) {
      assert.strictEqual(actual, expected, `expected ${format(actual)} to be ${format(expected)}`);
    },
    toEqual(expected) {
      assert.deepStrictEqual(
        actual,
        expected,
        `expected ${format(actual)} to equal ${format(expected)}`,
      );
    },
    toBeTruthy() {
      assert.ok(actual, `expected ${format(actual)} to be truthy`);
    },
    toBeFalsy() {
      assert.ok(!actual, `expected ${format(actual)} to be falsy`);
    },
    toBeNull() {
      assert.strictEqual(actual, null, `expected ${format(actual)} to be null`);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined, `expected ${format(actual)} to be undefined`);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined, 'expected value to be defined');
    },
    toHaveLength(expected) {
      assert.strictEqual(
        actual?.length,
        expected,
        `expected length ${actual?.length} to be ${expected}`,
      );
    },
    toContain(expected) {
      assert.ok(
        Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(expected),
        `expected ${format(actual)} to contain ${format(expected)}`,
      );
    },
    toMatchObject(expected) {
      for (const [key, value] of Object.entries(expected)) {
        const received = actual?.[key];
        const ok =
          value && typeof value === 'object' && !(value instanceof RegExp)
            ? matches(received, value)
            : deepEqual(received, value);
        assert.ok(
          ok,
          `key "${key}": expected ${format(value)}, got ${format(received)}`,
        );
      }
    },
    toBeCloseTo(expected, digits = 2) {
      const tolerance = 10 ** -digits / 2;
      assert.ok(
        Math.abs(actual - expected) < tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`,
      );
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected, `expected ${actual} > ${expected}`);
    },
    toBeGreaterThanOrEqual(expected) {
      assert.ok(actual >= expected, `expected ${actual} >= ${expected}`);
    },
    toBeLessThan(expected) {
      assert.ok(actual < expected, `expected ${actual} < ${expected}`);
    },
    toThrow(expected) {
      assert.throws(actual, expected instanceof RegExp ? expected : undefined);
    },
  };

  api.not = {
    toBe(expected) {
      assert.notStrictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.notDeepStrictEqual(actual, expected);
    },
    toBeTruthy() {
      assert.ok(!actual, `expected ${format(actual)} to be falsy`);
    },
    toBeNull() {
      assert.notStrictEqual(actual, null);
    },
    toContain(expected) {
      assert.ok(!actual?.includes(expected), `expected not to contain ${format(expected)}`);
    },
  };

  return api;
}

/**
 * Asymmetric matchers, hung off `expect` the way Vitest exposes them.
 * `expect.any(String)`, `expect.stringMatching(/x/)`, `expect.objectContaining({...})`.
 */
expect.any = (constructor) => {
  const name = constructor?.name ?? 'value';
  if (PRIMITIVES[constructor.name]) {
    return asymmetricMatch((v) => typeof v === constructor.name.toLowerCase(), `Any<${name}>`);
  }
  return asymmetricMatch(
    (v) => v instanceof constructor,
    `Any<${name}>`,
  );
};

expect.stringMatching = (pattern) =>
  asymmetricMatch((v) => typeof v === 'string' && pattern.test(v), `stringMatching(${pattern})`);

expect.objectContaining = (shape) =>
  asymmetricMatch(
    (v) =>
      v !== null &&
      typeof v === 'object' &&
      Object.entries(shape).every(([k, expected]) => matches(v[k], expected)),
    `objectContaining(${JSON.stringify(shape)})`,
  );