import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors, metricColors } from '../theme';

export function Ring({ size = 104, stroke = 9, progress, color, value, sub, label }: {
  size?: number; stroke?: number; progress: number; color: string;
  value: string; sub?: string; label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, progress)));
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.ringTrack} strokeWidth={stroke} fill="none" />
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
            strokeDasharray={`${c} ${c}`} strokeDashoffset={off} strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </Svg>
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={[st.value, { fontSize: size * 0.26 }]}>{value}</Text>
          {sub ? <Text style={st.sub}>{sub}</Text> : null}
        </View>
      </View>
      {label ? <Text style={st.label}>{label}</Text> : null}
    </View>
  );
}

// The Home hero: ACCURACY · HITS · SHOTS FIRED
export function RingTrio({ accuracy, hits, shots }: { accuracy: number; hits: number; shots: number }) {
  return (
    <View style={st.trio}>
      <Ring size={106} progress={accuracy / 100} color={metricColors.accuracy} value={`${accuracy}%`} label="Accuracy" />
      <Ring size={106} progress={shots ? hits / shots : 0} color={metricColors.hits} value={`${hits}`} label="Hits" />
      <Ring size={106} progress={Math.min(1, shots / 100)} color={metricColors.shots} value={`${shots}`} label="Shots Fired" />
    </View>
  );
}

const st = StyleSheet.create({
  value: { color: colors.text, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.textMuted, fontSize: 10, marginTop: 1 },
  label: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 10 },
  trio: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
});
