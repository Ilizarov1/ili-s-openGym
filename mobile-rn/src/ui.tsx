import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

export const color = {
  background: '#131714', panel: '#1D241F', border: '#354139', text: '#F1F6EF',
  muted: '#ACB9AE', accent: '#CEF383', dark: '#19230F', danger: '#FFB49C',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.background },
  content: { padding: 20, gap: 16, paddingBottom: 28 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  between: { justifyContent: 'space-between' },
  stack: { gap: 8 },
  grow: { flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 14, borderBottomColor: color.border, borderBottomWidth: 1 },
  brand: { color: color.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  heading: { color: color.text, fontSize: 29, fontWeight: '800', letterSpacing: -0.5 },
  title: { color: color.text, fontSize: 17, fontWeight: '700' },
  text: { color: color.text, fontSize: 15, lineHeight: 22 },
  muted: { color: color.muted, fontSize: 13, lineHeight: 19 },
  error: { color: color.danger, fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: color.panel, borderColor: color.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  button: { minHeight: 46, borderRadius: 12, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: color.accent },
  secondary: { borderColor: color.border, borderWidth: 1 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
  buttonLabel: { color: color.text, fontSize: 15, fontWeight: '700' },
  primaryLabel: { color: color.dark },
  input: { color: color.text, backgroundColor: color.background, borderColor: color.border, borderWidth: 1,
    borderRadius: 10, minHeight: 46, paddingHorizontal: 12, fontSize: 15 },
  field: { flex: 1, gap: 3 },
  done: { backgroundColor: color.accent, borderColor: color.accent },
  tabs: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 6, borderTopColor: color.border, borderTopWidth: 1 },
  tab: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  selectedTab: { backgroundColor: color.panel },
  selectedLabel: { color: color.accent, fontWeight: '700' },
  status: { paddingHorizontal: 20, paddingTop: 10 },
  separator: { height: 12 },
});

export function Button({ label, onPress, secondary, disabled }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary ? styles.secondary : styles.primary,
      disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.buttonLabel, !secondary && styles.primaryLabel]}>{label}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.muted}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={color.muted} style={styles.input} {...props} />
  </View>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
