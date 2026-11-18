/**
 * plan-share.js is shared with the Web client and evaluates two browser globals while
 * its module graph loads:
 *
 *  - `import.meta.env.VITE_MOBILE` in frontend/src/lib/mobile.js. Expo rewrites
 *    `import.meta` to `globalThis.__ExpoImportMetaRegistry`, whose native object has
 *    no `env`; without one, reading `VITE_MOBILE` throws before plan-share can load.
 *  - `btoa(...)` in frontend/src/lib/print-pictures.js for its placeholder picture.
 *    React Native does not provide the Web API.
 *
 * This module is imported before plan-share, so both exist when that graph is
 * evaluated. Only the Web-client plan functions are used here; nothing prints.
 */

type ImportMetaRegistry = {
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
};

type RuntimeScope = typeof globalThis & {
  __ExpoImportMetaRegistry?: ImportMetaRegistry;
  btoa?: (data: string) => string;
};

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The ASCII subset btoa has always accepted; enough for the SVG placeholder. */
function encodeBase64(input: string): string {
  let output = '';
  let index = 0;
  while (index < input.length) {
    const first = input.charCodeAt(index++);
    const second = index < input.length ? input.charCodeAt(index++) : Number.NaN;
    const third = index < input.length ? input.charCodeAt(index++) : Number.NaN;
    if (first > 255 || second > 255 || third > 255) {
      throw new Error('btoa: the string contains a character outside Latin-1.');
    }
    const bits = (first << 16) |
      ((Number.isNaN(second) ? 0 : second) << 8) |
      (Number.isNaN(third) ? 0 : third);
    output += BASE64[(bits >> 18) & 63] + BASE64[(bits >> 12) & 63] +
      (Number.isNaN(second) ? '=' : BASE64[(bits >> 6) & 63]) +
      (Number.isNaN(third) ? '=' : BASE64[bits & 63]);
  }
  return output;
}

const scope = globalThis as RuntimeScope;
const registry = scope.__ExpoImportMetaRegistry ?? {};
if (!registry.env) registry.env = {};
scope.__ExpoImportMetaRegistry = registry;

if (typeof scope.btoa !== 'function') scope.btoa = encodeBase64;
