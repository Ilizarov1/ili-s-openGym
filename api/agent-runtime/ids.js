/* Host-injected identifiers.
 *
 * node:crypto is deliberately not imported: the same module runs in Metro. The
 * host passes expo-crypto's randomUUID on RN and node:crypto's on the server.
 */

function defaultRandomUUID() {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.randomUUID !== 'function') {
    throw new Error('agent runtime: no randomUUID implementation; inject one from the host');
  }
  return crypto.randomUUID();
}

/**
 * @param {string} prefix
 * @param {() => string} [randomUUID]
 */
export function createId(prefix, randomUUID = defaultRandomUUID) {
  const clean = String(prefix || '').replace(/_+$/, '');
  if (!/^[a-z][a-z0-9]*$/.test(clean)) throw new Error(`agent runtime: bad id prefix "${prefix}"`);
  if (typeof randomUUID !== 'function') throw new Error('agent runtime: randomUUID must be a function');
  const uuid = String(randomUUID()).toLowerCase();
  if (!/^[0-9a-f-]{32,40}$/.test(uuid)) throw new Error('agent runtime: randomUUID returned an invalid value');
  return `${clean}_${uuid}`;
}

/**
 * @param {() => string} [randomUUID]
 */
export function createIds(randomUUID = defaultRandomUUID) {
  return {
    run: () => createId('run', randomUUID),
    session: () => createId('ses', randomUUID),
    memory: () => createId('mem', randomUUID),
    proposal: () => createId('prop', randomUUID),
    evidence: () => createId('ev', randomUUID),
    record: prefix => createId(prefix, randomUUID),
  };
}
