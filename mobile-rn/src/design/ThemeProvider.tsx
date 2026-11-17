/**
 * Theme plumbing. One context carries both the resolved theme and the
 * controller the development gallery drives.
 *
 * There is deliberately no persistence and no global store: the app mounts a
 * `ThemeProvider` with its starting mode and accent, and only the gallery calls
 * the setters.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { createTheme, darkTheme, type AccentName, type Theme, type ThemeMode } from './themes';

export type ThemeController = {
  mode: ThemeMode;
  accent: AccentName;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentName) => void;
};

type ThemeContextValue = {
  theme: Theme;
  controller: ThemeController;
};

const noop = (): void => {};

/**
 * Outside a provider the system falls back to the dark theme and read-only
 * setters, so a gallery preview or a test can render a single component without
 * wrapping it.
 */
const fallback: ThemeContextValue = {
  theme: darkTheme,
  controller: {
    mode: darkTheme.mode,
    accent: darkTheme.accent,
    setMode: noop,
    setAccent: noop,
  },
};

const ThemeContext = createContext<ThemeContextValue>(fallback);

export type ThemeProviderProps = {
  children: ReactNode;
  mode?: ThemeMode;
  accent?: AccentName;
};

export function ThemeProvider({
  children,
  mode: modeProp = 'dark',
  accent: accentProp = 'green',
}: ThemeProviderProps): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(modeProp);
  const [accent, setAccent] = useState<AccentName>(accentProp);

  // A prop change from the host wins over whatever the gallery set locally.
  useEffect(() => {
    setMode(modeProp);
  }, [modeProp]);

  useEffect(() => {
    setAccent(accentProp);
  }, [accentProp]);

  const theme = useMemo(() => createTheme(mode, accent), [mode, accent]);

  const controller = useMemo<ThemeController>(
    () => ({ mode, accent, setMode, setAccent }),
    [mode, accent],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, controller }),
    [theme, controller],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

export function useThemeController(): ThemeController {
  return useContext(ThemeContext).controller;
}

/**
 * `StyleSheet.create` for a theme-dependent sheet. Keep the factory module-level
 * (or memoised by the caller) so the styles survive re-renders.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: Theme) => T,
): T {
  const theme = useTheme();
  return useMemo(() => StyleSheet.create(factory(theme)), [factory, theme]);
}
