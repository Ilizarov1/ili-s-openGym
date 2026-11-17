/**
 * Semantic themes: the layer screens actually read.
 *
 * Values come from `docs/RN_UI_DESIGN_SYSTEM.md` §5.1–5.3, which mirror
 * `frontend/src/index.css`. `createTheme()` returns a fresh object on every call
 * so a caller can never mutate the shared `darkTheme` / `lightTheme`.
 */

import { alpha } from './color';
import { layout, motion, radius, shadows, sizes, space, typography } from './tokens';

export type ThemeMode = 'dark' | 'light';

export type AccentName =
  | 'green'
  | 'blue'
  | 'orange'
  | 'purple'
  | 'pink'
  | 'red'
  | 'teal'
  | 'yellow';

export type ThemeColors = {
  bg: string;
  bgEl: string;
  surface: string;
  surface2: string;
  surface3: string;
  label: string;
  label2: string;
  label3: string;
  label4: string;
  sep: string;
  sepOp: string;
  accent: string;
  accentPressed: string;
  accentInk: string;
  onAccent: string;
  accentSoft: string;
  accentLine: string;
  danger: string;
  warning: string;
  overlay: string;
};

export type Theme = {
  mode: ThemeMode;
  accent: AccentName;
  colors: ThemeColors;
  space: typeof space;
  radius: typeof radius;
  type: typeof typography;
  motion: typeof motion;
  shadows: typeof shadows;
  sizes: typeof sizes;
  layout: typeof layout;
};

type Ink = '#000000' | '#ffffff';

type AccentDefinition = {
  /** Fill in the dark theme (iOS dark system colour). */
  dark: string;
  /** Fill in the light theme (iOS light system colour). */
  light: string;
  /** Pressed fill, upstream `--acc-2`, shared by both themes. */
  pressed: string;
  /** The accent as text in the light theme, picked to clear 4.5:1 on bg and white. */
  inkLight: string;
  onDark: Ink;
  onLight: Ink;
};

const accents: Record<AccentName, AccentDefinition> = {
  green: {
    dark: '#30d158',
    light: '#34c759',
    pressed: '#248a3d',
    inkLight: '#1a7f37',
    onDark: '#000000',
    onLight: '#000000',
  },
  blue: {
    dark: '#0a84ff',
    light: '#007aff',
    pressed: '#0060df',
    inkLight: '#0062cc',
    onDark: '#ffffff',
    onLight: '#ffffff',
  },
  orange: {
    dark: '#ff9f0a',
    light: '#ff9500',
    pressed: '#c76b00',
    inkLight: '#a85200',
    onDark: '#000000',
    onLight: '#000000',
  },
  purple: {
    dark: '#bf5af2',
    light: '#af52de',
    pressed: '#8944ab',
    inkLight: '#8944ab',
    onDark: '#ffffff',
    onLight: '#ffffff',
  },
  pink: {
    dark: '#ff375f',
    light: '#ff2d55',
    pressed: '#d70036',
    inkLight: '#d70036',
    onDark: '#ffffff',
    onLight: '#ffffff',
  },
  red: {
    dark: '#ff453a',
    light: '#ff3b30',
    pressed: '#d70015',
    inkLight: '#d70015',
    onDark: '#ffffff',
    onLight: '#ffffff',
  },
  teal: {
    dark: '#40c8e0',
    light: '#30b0c7',
    pressed: '#0071a4',
    inkLight: '#0071a4',
    onDark: '#000000',
    onLight: '#000000',
  },
  yellow: {
    dark: '#ffd60a',
    light: '#ffcc00',
    pressed: '#b25000',
    inkLight: '#8f5e00',
    onDark: '#000000',
    onLight: '#000000',
  },
};

const darkColors = {
  bg: '#000000',
  bgEl: '#0e0e10',
  surface: '#1c1c1e',
  surface2: '#2c2c2e',
  surface3: '#3a3a3c',
  label: '#ffffff',
  label2: 'rgba(235,235,245,0.60)',
  label3: 'rgba(235,235,245,0.32)',
  label4: 'rgba(235,235,245,0.18)',
  sep: 'rgba(84,84,88,0.60)',
  sepOp: 'rgba(84,84,88,0.34)',
  danger: '#ff453a',
  warning: '#ff9f0a',
  overlay: 'rgba(0,0,0,0.50)',
} as const;

const lightColors = {
  bg: '#f2f2f7',
  bgEl: '#f7f7fa',
  surface: '#ffffff',
  surface2: '#ececef',
  surface3: '#e3e3e8',
  label: '#000000',
  label2: 'rgba(60,60,67,0.75)',
  label3: 'rgba(60,60,67,0.30)',
  label4: 'rgba(60,60,67,0.16)',
  sep: 'rgba(60,60,67,0.29)',
  sepOp: 'rgba(60,60,67,0.20)',
  danger: '#ff3b30',
  warning: '#ff9500',
  // The upstream sheet scrim in light mode; the dark 50% would read as a hole.
  overlay: 'rgba(0,0,0,0.40)',
} as const;

/** Build a theme from a mode and accent. Always a new object. */
export function createTheme(mode: ThemeMode = 'dark', accent: AccentName = 'green'): Theme {
  const definition = accents[accent];
  const base = mode === 'dark' ? darkColors : lightColors;
  const accentColor = mode === 'dark' ? definition.dark : definition.light;

  const colors: ThemeColors = {
    ...base,
    accent: accentColor,
    accentPressed: definition.pressed,
    // Dark keeps the accent itself for text; light needs the darker hue that
    // reaches 4.5:1 on both #f2f2f7 and white.
    accentInk: mode === 'dark' ? accentColor : definition.inkLight,
    onAccent: mode === 'dark' ? definition.onDark : definition.onLight,
    accentSoft: alpha(accentColor, 0.16),
    accentLine: alpha(accentColor, 0.38),
  };

  return {
    mode,
    accent,
    colors,
    space,
    radius,
    type: typography,
    motion,
    shadows: {
      ...shadows,
      tabStart: { ...shadows.tabStart, shadowColor: accentColor },
    },
    sizes,
    layout,
  };
}

export const darkTheme: Theme = createTheme('dark', 'green');
export const lightTheme: Theme = createTheme('light', 'green');
