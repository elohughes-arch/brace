import React from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, ScrollView,
  ViewStyle, TextStyle, StyleProp, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors, space, radius, type as T } from '../theme';

type IconName = React.ComponentProps<typeof Feather>['name'];

// ── Screen wrapper ─────────────────────────────────────────────────────────
export function Screen({ title, right, scroll = true, children, contentStyle }: {
  title?: string; right?: React.ReactNode; scroll?: boolean;
  children: React.ReactNode; contentStyle?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View style={[{ paddingHorizontal: space.lg, paddingBottom: space.huge }, contentStyle]}>{children}</View>
  );
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      {title !== undefined && (
        <View style={s.header}>
          <Text style={s.headerTitle}>{title}</Text>
          {right ? <View style={s.headerRight}>{right}</View> : null}
        </View>
      )}
      {scroll ? <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: title ? 0 : space.md }}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

// ── Text helpers ───────────────────────────────────────────────────────────
export const H1 = (p: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <Text style={[T.h1, p.style]}>{p.children}</Text>;
export const H2 = (p: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <Text style={[T.h2, p.style]}>{p.children}</Text>;
export const Muted = (p: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <Text style={[T.bodyMuted, p.style]}>{p.children}</Text>;
export const Label = (p: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <Text style={[T.label, p.style]}>{p.children}</Text>;

// ── Card ───────────────────────────────────────────────────────────────────
export function Card({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress) return <Pressable onPress={onPress} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }, style]}>{children}</Pressable>;
  return <View style={[s.card, style]}>{children}</View>;
}

// ── Section label with optional right action ──────────────────────────────
export function SectionLabel({ children, actionLabel, onAction }: { children: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={s.sectionLabel}>
      <Text style={T.label}>{children}</Text>
      {actionLabel ? <Pressable onPress={onAction} hitSlop={8}><Text style={s.sectionAction}>{actionLabel}</Text></Pressable> : null}
    </View>
  );
}

// ── List row (icon · title · subtitle · chevron) — the settings/More pattern ─
export function ListRow({ icon, title, subtitle, right, onPress, color }: {
  icon?: IconName; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; color?: string;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.listRow, pressed && { opacity: 0.8 }]}>
      {icon ? <Feather name={icon} size={20} color={color || colors.textMuted} style={{ marginRight: space.md }} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={s.listTitle}>{title}</Text>
        {subtitle ? <Text style={s.listSub}>{subtitle}</Text> : null}
      </View>
      {right ?? <Feather name="chevron-right" size={20} color={colors.textDim} />}
    </Pressable>
  );
}

// ── Button ─────────────────────────────────────────────────────────────────
export function Button({ title, onPress, variant = 'primary', icon, loading, disabled, style, color }: {
  title: string; onPress?: () => void; variant?: 'primary' | 'outline' | 'ghost' | 'dark';
  icon?: IconName; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; color?: string;
}) {
  const bg = variant === 'primary' ? (color || colors.primary) : variant === 'dark' ? colors.cardAlt : 'transparent';
  const fg = variant === 'primary' ? colors.onPrimary : variant === 'outline' ? colors.text : colors.text;
  const border = variant === 'outline' ? { borderWidth: 1, borderColor: colors.borderStrong } : null;
  return (
    <Pressable onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => [s.btn, { backgroundColor: bg }, border, (disabled || loading) && { opacity: 0.5 }, pressed && { opacity: 0.85 }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon ? <Feather name={icon} size={16} color={fg} style={{ marginRight: 8 }} /> : null}
          <Text style={[s.btnText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

// ── Tag / badge ────────────────────────────────────────────────────────────
export function Tag({ children, color = colors.primary, solid }: { children: string; color?: string; solid?: boolean }) {
  return (
    <View style={[s.tag, solid ? { backgroundColor: color } : { borderWidth: 1, borderColor: color, backgroundColor: color + '1A' }]}>
      <Text style={[s.tagText, { color: solid ? colors.onPrimary : color }]}>{children}</Text>
    </View>
  );
}

// ── Field (labelled input) ─────────────────────────────────────────────────
export const Field = React.forwardRef<TextInput, {
  label: string; value: string; onChangeText: (t: string) => void; placeholder?: string;
  secureTextEntry?: boolean; keyboardType?: any; autoCapitalize?: any;
}>(function Field(p, ref) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={[T.label, { marginBottom: 8 }]}>{p.label}</Text>
      <TextInput ref={ref} value={p.value} onChangeText={p.onChangeText} placeholder={p.placeholder}
        placeholderTextColor={colors.textDim} style={s.input}
        secureTextEntry={p.secureTextEntry} keyboardType={p.keyboardType} autoCapitalize={p.autoCapitalize}
        autoCorrect={false} />
    </View>
  );
});

// ── Metric strip (icon · label · value, hairline dividers) ──────────────────
export function MetricStrip({ items }: { items: { icon: IconName; label: string; value: string; color?: string }[] }) {
  return (
    <View style={s.strip}>
      {items.map((it, i) => (
        <View key={it.label} style={[s.stripItem, i < items.length - 1 && s.stripDivider]}>
          <Feather name={it.icon} size={16} color={it.color || colors.textMuted} />
          <Text style={s.stripLabel}>{it.label}</Text>
          <Text style={[s.stripValue, it.color ? { color: it.color } : null]}>{it.value}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Avatar ─────────────────────────────────────────────────────────────────
export function Avatar({ name, size = 40, color = colors.primary }: { name?: string | null; size?: number; color?: string }) {
  const initials = (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color + '33', borderWidth: 1, borderColor: color + '66', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color, fontWeight: '800', fontSize: size * 0.36 }}>{initials}</Text>
    </View>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
export function EmptyState({ icon = 'inbox', title, text, action }: { icon?: IconName; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <View style={s.empty}>
      <Feather name={icon} size={28} color={colors.textDim} />
      <Text style={[T.h3, { marginTop: space.md }]}>{title}</Text>
      {text ? <Text style={[T.bodyMuted, { textAlign: 'center', marginTop: 4 }]}>{text}</Text> : null}
      {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
    </View>
  );
}

export const Divider = () => <View style={s.divider} />;

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  headerRight: { position: 'absolute', right: space.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: space.lg },
  sectionLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl, marginBottom: space.md },
  sectionAction: { ...T.label, color: colors.primary },
  listRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.lg, paddingVertical: space.lg, marginBottom: space.sm },
  listTitle: { ...T.label, fontSize: 13, color: colors.text },
  listSub: { ...T.small, marginTop: 3 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 50, borderRadius: radius.pill, paddingHorizontal: space.xl },
  btnText: { fontSize: 13, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm, alignSelf: 'flex-start' },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  input: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: 14, color: colors.text, fontSize: 15 },
  strip: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingVertical: space.lg },
  stripItem: { flex: 1, alignItems: 'center', gap: 6 },
  stripDivider: { borderRightWidth: 1, borderRightColor: colors.border },
  stripLabel: { ...T.label, fontSize: 10 },
  stripValue: { ...T.h3, fontSize: 18 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.huge, paddingHorizontal: space.xl },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: space.md },
});
