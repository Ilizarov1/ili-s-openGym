/**
 * Raw design values, ported from the upstream stylesheet (`frontend/src/index.css`).
 *
 * This is the only file allowed to hold raw type sizes, radii, spacing and
 * motion numbers. Themes pick semantics out of these values in `themes.ts`;
 * screens and components read the theme.
 */

/** iOS system palette, dark values — the same names the upstream CSS uses. */
export const palette = {
  black: '#000000',
  white: '#ffffff',
  gray1: '#1c1c1e',
  gray2: '#2c2c2e',
  gray3: '#3a3a3c',
  gray4: '#636366',
  green: '#30d158',
  greenPressed: '#248a3d',
  blue: '#0a84ff',
  orange: '#ff9f0a',
  red: '#ff453a',
  yellow: '#ffd60a',
  teal: '#40c8e0',
  indigo: '#5e5ce6',
  pink: '#ff375f',
  purple: '#bf5af2',
  mint: '#63e6e2',
  brown: '#ac8e68',
  grey: '#8e8e93',
} as const;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 22,
  xxxl: 32,
} as const;

export const radius = {
  xs: 7,
  sm: 8,
  md: 9,
  lg: 12,
  card: 14,
  xl: 16,
  xxl: 22,
  pill: 99,
} as const;

export const sizes = {
  icon: 24,
  tabIcon: 25,
  buttonIcon: 19,
  tileSm: 29,
  tileMd: 36,
  tileLg: 40,
  touch: 44,
  tabStart: 52,
  input: 46,
  button: 46,
  hairline: 0.5,
} as const;

export const motion = {
  fast: 140,
  med: 220,
  sheet: 340,
  ease: [0.32, 0.72, 0, 1] as const,
  pressScale: 0.97,
  pressScaleSmall: 0.92,
  pressScaleCard: 0.985,
} as const;

/**
 * The upstream type scale: size, leading and tracking move as a set, tighter as
 * the type grows. Sizes are in points, matching the stylesheet's rem values at a
 * 16px root.
 */
export const typography = {
  pageTitle: { fontSize: 30, lineHeight: 32, fontWeight: '700', letterSpacing: -0.84 },
  pageTitleWide: { fontSize: 34, lineHeight: 36, fontWeight: '700', letterSpacing: -0.95 },
  title2: { fontSize: 22, lineHeight: 26, fontWeight: '600', letterSpacing: -0.46 },
  title3: { fontSize: 20, lineHeight: 24, fontWeight: '600', letterSpacing: -0.42 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.17 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400', letterSpacing: -0.17 },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.09 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: -0.05 },
  chip: { fontSize: 14, lineHeight: 18, fontWeight: '400', letterSpacing: -0.08 },
  segment: { fontSize: 14, lineHeight: 18, fontWeight: '500', letterSpacing: -0.08 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0 },
  caption2: { fontSize: 11, lineHeight: 14, fontWeight: '500', letterSpacing: 0 },
  button: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  tab: { fontSize: 10, lineHeight: 12, fontWeight: '500', letterSpacing: 0.05 },
} as const;

export type ShadowStyle = {
  shadowColor: string;
  shadowOpacity: number;
  shadowOffset: { width: number; height: number };
  shadowRadius: number;
  elevation: number;
};

/**
 * Shadow geometry only. `tabStart` carries the default accent colour; themes
 * swap it for the active accent so the glow follows the user's choice.
 */
export const shadows: Readonly<{
  tabStart: ShadowStyle;
  segThumb: ShadowStyle;
  sheet: ShadowStyle;
}> = {
  tabStart: {
    shadowColor: palette.green,
    shadowOpacity: 0.55,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 18,
    elevation: 8,
  },
  segThumb: {
    shadowColor: palette.black,
    shadowOpacity: 0.24,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 8,
    elevation: 2,
  },
  sheet: {
    shadowColor: palette.black,
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: -8 },
    shadowRadius: 24,
    elevation: 24,
  },
};

/** Fixed layout metrics: page and card padding, the list-row box, section gaps. */
export const layout = {
  pagePadding: 16,
  loadingPadding: 24,
  listBottomPadding: 28,
  cardPadding: 16,
  cardGap: 12,
  headerBottom: 18,
  sectionGap: 22,
  listRowPaddingX: 14,
  listRowPaddingY: 11,
  listRowMinHeight: 46,
} as const;
