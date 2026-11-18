/**
 * Strict parser for the mobile-pairing QR the Web app shows.
 *
 * Accepted exactly:
 *   opengym://pair?server=<urlencoded base address>&code=<8-character code>
 *
 * Everything else is refused: ordinary URLs, the “add another device” login QR
 * (`?link=`), duplicated or extra parameters, malformed codes and public HTTP
 * addresses. The address itself goes through the same `normalizeServer` the manual
 * Settings form uses, so LAN HTTP keeps working and public HTTP does not.
 */

import { normalizeServer } from '../server';

export type PairingTarget = {
  /** Normalised server base, including a reverse-proxy subpath when the QR has one. */
  address: string;
  /** Eight characters from the server's pairing alphabet (no 0/O/1/I). */
  code: string;
};

export type PairingErrorReason =
  | 'empty'
  | 'not-pairing'
  | 'device-link'
  | 'invalid-encoding'
  | 'duplicate-param'
  | 'extra-param'
  | 'missing-param'
  | 'invalid-code'
  | 'invalid-address';

export type PairingParseResult =
  | { ok: true; target: PairingTarget }
  | { ok: false; reason: PairingErrorReason; message: string };

const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const ORDINARY_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

function fail(reason: PairingErrorReason, message: string): PairingParseResult {
  return { ok: false, reason, message };
}

/** Uppercase, ignore spaces/hyphens, and require the server's 8-character alphabet. */
export function normalizePairingCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]+/g, '');
  return PAIRING_CODE.test(code) ? code : null;
}

/**
 * Parse a scanned QR payload. No network request is made; the caller only shows a
 * confirmation page and redeems the code after the person taps confirm.
 */
export function parsePairingUrl(raw: string): PairingParseResult {
  const text = String(raw ?? '').trim();
  if (!text) return fail('empty', '二维码是空的。');

  if (ORDINARY_URL.test(text) && !/^opengym:\/\//i.test(text)) {
    return /[?&]link=/.test(text)
      ? fail('device-link', '这是添加到浏览器的登录二维码。请使用网页端的「添加另一设备」流程。')
      : fail('not-pairing', '这不是 openGym 移动端配对二维码。');
  }

  // Host must be `pair`, with an optional trailing slash and no path, fragment or
  // credentials. The query is read by hand so duplicate keys can be refused rather
  // than silently collapsed by URLSearchParams.
  const match = /^opengym:\/\/pair\/?(?:\?([^#]*))?$/i.exec(text);
  if (!match) {
    if (/^opengym:\/\//i.test(text)) {
      return fail('not-pairing', '这不是 openGym 移动端配对二维码。请扫描网页端「配对移动应用」面板中的二维码。');
    }
    return fail('not-pairing', '这不是 openGym 移动端配对二维码。');
  }

  const query = match[1];
  if (query === undefined || query === '') {
    return fail('missing-param', '二维码缺少服务器地址和配对码。');
  }

  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) return fail('extra-param', '二维码包含空参数，已拒绝。');
    const equals = part.indexOf('=');
    if (equals <= 0) return fail('missing-param', '二维码缺少服务器地址或配对码。');
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, equals));
      value = decodeURIComponent(part.slice(equals + 1));
    } catch {
      return fail('invalid-encoding', '二维码内容的编码无效。');
    }
    if (!key) return fail('missing-param', '二维码缺少服务器地址或配对码。');
    if (params.has(key)) return fail('duplicate-param', '二维码里重复出现了同一个参数，已拒绝。');
    params.set(key, value);
  }

  for (const key of params.keys()) {
    if (key !== 'server' && key !== 'code') {
      return fail('extra-param', '二维码包含多余参数，已拒绝。');
    }
  }

  const server = params.get('server');
  const rawCode = params.get('code');
  if (!server || !rawCode) return fail('missing-param', '二维码缺少服务器地址或配对码。');

  const code = normalizePairingCode(rawCode);
  if (!code) {
    return fail('invalid-code', '配对码无效：应为 8 位字母或数字（不含 0、O、1、I）。');
  }

  let address: string;
  try {
    address = normalizeServer(server);
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务器地址无效。';
    return fail('invalid-address', `服务器地址无效：${message}`);
  }

  return { ok: true, target: { address, code } };
}
