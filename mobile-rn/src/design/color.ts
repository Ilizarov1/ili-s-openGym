/**
 * Colour maths for the design system: the RN stand-in for the stylesheet's
 * `color-mix()`, plus the contrast helpers used to pick ink on an accent.
 *
 * Pure functions, no React or React Native imports. Every parser throws on an
 * input it does not understand instead of quietly painting black: a typo in a
 * token should fail the design gallery, not ship as an invisible label.
 */

type Rgba = { r: number; g: number; b: number; a: number };
type Rgb = { r: number; g: number; b: number };

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_PATTERN = /^rgba?\((.+)\)$/i;
const CHANNEL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assertNumber(value: number, source: string): number {
  if (!Number.isFinite(value)) throw new Error(`Invalid color: ${source}`);
  return value;
}

function parseChannel(token: string, source: string): number {
  if (!CHANNEL_PATTERN.test(token)) throw new Error(`Invalid color: ${source}`);
  const value = token.endsWith('%')
    ? (parseFloat(token) / 100) * 255
    : parseFloat(token);
  return clamp01(assertNumber(value, source) / 255) * 255;
}

function parseAlpha(token: string, source: string): number {
  if (!CHANNEL_PATTERN.test(token)) throw new Error(`Invalid color: ${source}`);
  const value = token.endsWith('%')
    ? parseFloat(token) / 100
    : parseFloat(token);
  return clamp01(assertNumber(value, source));
}

function parseHex(value: string): Rgba {
  const hex = value.slice(1).toLowerCase();
  const short = hex.length === 3 || hex.length === 4;
  const expand = (index: number): string => {
    const char = hex[index];
    return short ? char + char : hex.slice(index * 2, index * 2 + 2);
  };
  const r = parseInt(expand(0), 16);
  const g = parseInt(expand(1), 16);
  const b = parseInt(expand(2), 16);
  const a = short ? (hex.length === 4 ? parseInt(expand(3), 16) / 255 : 1) : hex.length === 8 ? parseInt(expand(3), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseFunction(value: string): Rgba {
  const match = FUNCTION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid color: ${value}`);
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error(`Invalid color: ${value}`);
  return {
    r: parseChannel(parts[0], value),
    g: parseChannel(parts[1], value),
    b: parseChannel(parts[2], value),
    a: parts.length === 4 ? parseAlpha(parts[3], value) : 1,
  };
}

function parseColor(value: string): Rgba {
  const input = value.trim();
  if (HEX_PATTERN.test(input)) return parseHex(input);
  if (FUNCTION_PATTERN.test(input)) return parseFunction(input);
  throw new Error(`Invalid color: ${value}`);
}

function toHex(channel: number): string {
  return Math.round(clamp01(channel / 255) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** `rgba()` string for a colour, with `opacity` multiplied into its own alpha. */
export function alpha(color: string, opacity: number): string {
  const { r, g, b, a } = parseColor(color);
  const next = round(clamp01(opacity) * a, 3);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${next})`;
}

/**
 * Linear blend of `foreground` and `background`; `amount` is the foreground's
 * share. Alpha is ignored — the result is always an opaque `#rrggbb`, which is
 * what a solid RN surface needs.
 */
export function mix(foreground: string, background: string, amount: number): string {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const weight = clamp01(amount);
  const blend = (front: number, back: number): number =>
    front * weight + back * (1 - weight);
  return `#${toHex(blend(fg.r, bg.r))}${toHex(blend(fg.g, bg.g))}${toHex(blend(fg.b, bg.b))}`;
}

function channelLuminance(channel: number): number {
  const value = clamp01(channel / 255);
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** Composite a translucent colour over a backdrop and return the visible RGB. */
function flatten(color: Rgba, backdrop: Rgb): Rgb {
  return {
    r: color.r * color.a + backdrop.r * (1 - color.a),
    g: color.g * color.a + backdrop.g * (1 - color.a),
    b: color.b * color.a + backdrop.b * (1 - color.a),
  };
}

/**
 * WCAG 2.1 contrast ratio between two colours, 1–21. A translucent colour is
 * measured as it appears over its counterpart, so `rgba(235,235,245,.6)` on
 * black is judged on the grey the eye actually sees.
 */
export function contrastRatio(a: string, b: string): number {
  const first = parseColor(a);
  const second = parseColor(b);
  const one = luminance(flatten(first, second));
  const two = luminance(flatten(second, first));
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/** Black or white, whichever is more legible on `background`. */
export function readableOn(background: string): '#000000' | '#ffffff' {
  const onBlack = contrastRatio('#000000', background);
  const onWhite = contrastRatio('#ffffff', background);
  return onBlack >= onWhite ? '#000000' : '#ffffff';
}
