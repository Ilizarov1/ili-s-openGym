/* Endpoint rules shared by the phone's BYOK path and the server.
 *
 * This is a copy of the portable rules in api/coach/core/providers.js, kept in
 * the agent core so the shared directory has no dependency on the Coach tree.
 */
const v4 = host => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.every(value => value <= 255) ? bytes : null;
};

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  const ip = v4(host);
  if (ip) {
    const [a, b] = ip;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    if (host === '::1') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return /^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host);
}

export function validateBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, value: null };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'only http:// and https:// endpoints are supported' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'put the key in the credential field, not in the URL' };
  }
  if (url.search || url.hash) return { ok: false, error: 'a base URL has no query string' };
  if (/\/(chat\/completions|responses|completions)\/?$/i.test(url.pathname)) {
    return { ok: false, error: 'enter the base URL only, without /chat/completions' };
  }
  return { ok: true, value: url.toString().replace(/\/+$/, '') };
}

/** The phone may call https:// anywhere; http:// only on the home network. */
export function phoneMayCall(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isPrivateHost(parsed.hostname);
}
