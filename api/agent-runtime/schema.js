/* A deliberately small JSON Schema 2020-12 subset.
 *
 * Supported: type (string or array), properties, required,
 * additionalProperties (boolean), items, enum, const, oneOf, minLength,
 * maxLength, pattern, minimum, maximum. That is everything the agent tool and
 * task definitions need, and it keeps RN free of a JSON Schema dependency.
 */
import { AgentError } from './errors.js';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const fail = (path, message) => ({ ok: false, path, message });

function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameJson(a[key], b[key]));
}

function typeMatches(type, value) {
  switch (type) {
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {{ ok: true, value: unknown } | { ok: false, path: string, message: string }}
 */
export function validate(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return fail(path, 'schema must be an object');
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameJson(value, schema.const)) {
    return fail(path, 'must equal the const value');
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => sameJson(candidate, value))) {
    return fail(path, 'must be one of the allowed values');
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some(type => !TYPES.has(type))) return fail(path, 'schema type is invalid');
    if (!types.some(type => typeMatches(type, value))) {
      return fail(path, `must be ${types.join(' or ')}`);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = [];
    for (let index = 0; index < schema.oneOf.length; index++) {
      const result = validate(schema.oneOf[index], value, `${path}.oneOf[${index}]`);
      if (result.ok) matches.push(index);
    }
    if (matches.length === 0) return fail(path, 'must match one of the allowed shapes');
    if (matches.length > 1) return fail(path, 'matches more than one allowed shape');
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return fail(path, `must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return fail(path, `must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string') {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        return fail(path, 'schema pattern is invalid');
      }
      if (!pattern.test(value)) return fail(path, 'does not match the required pattern');
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return fail(path, `must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return fail(path, `must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const result = validate(schema.items, value[index], `${path}[${index}]`);
      if (!result.ok) return result;
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return fail(`${path}.${required}`, 'is required');
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const result = validate(properties[key], child, `${path}.${key}`);
        if (!result.ok) return result;
      } else if (schema.additionalProperties === false) {
        return fail(`${path}.${key}`, 'is not allowed');
      }
    }
  }

  return { ok: true, value };
}

/** Validate or throw the stable agent error carrying the JSON path. */
export function assertValid(schema, value, path = '$', code = 'tool_args_invalid') {
  const result = validate(schema, value, path);
  if (!result.ok) {
    throw new AgentError(code, `${result.path}: ${result.message}`, {
      details: { path: result.path, reason: result.message },
    });
  }
  return result.value;
}

export function isValid(schema, value) {
  return validate(schema, value).ok;
}

/** A compact one-line description, useful in a model tool list. */
export function describeSchema(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes('object') && schema.properties) {
      return `{${Object.keys(schema.properties).join(', ')}}`;
    }
    return types.join('|');
  }
  return 'any';
}
