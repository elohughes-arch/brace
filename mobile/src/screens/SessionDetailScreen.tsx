import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, ScrollView, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';

import { colors, space, radius, type as T, metricColors } from '../theme';
import { Card, Button, Label, MetricStrip, EmptyState } from '../components/ui';
import { RingTrio } from '../components/Ring';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Session, PerShot, TechniqueScores } from '../types';
import type { RootStackParamList } from '../navigation/types';

function isPlayable(uri: string | null): uri is string {
  return !!uri && (uri.startsWith('http') || uri.startsWith('file://') || uri.startsWith('content://') || uri.startsWith('ph://') || uri.startsWith('assets-library://'));
}

const TECH_META: { key: keyof TechniqueScores; label: string; color: string }[] = [
  { key: 'mount', label: 'Mount', color: colors.primary },
  { key: 'swing', label: 'Swing', color: colors.blue },
  { key: 'follow', label: 'Follow', color: colors.orange },
];

export default function SessionDetailScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SessionDetail'>>();
  const { id } = route.params;
  const { user } = useAuth();

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const s = await api.getSession(id);
        setSession(s);
        if (!s) setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const videoUri = session && isPlayable(session.video_path) ? session.video_path : null;

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <Header onBack={() => nav.goBack()} title="Session" />
        <View style={st.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (failed || !session) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <Header onBack={() => nav.goBack()} title="Session" />
        <View style={st.center}>
          <EmptyState
            icon="alert-circle"
            title="Session unavailable"
            text="We couldn't load this session. Pull back and try again."
            action={<Button title="Go back" variant="outline" onPress={() => nav.goBack()} />}
          />
        </View>
      </SafeAreaView>
    );
  }

  const accuracy = Math.round(session.hit_rate);
  const perShot: PerShot[] = Array.isArray(session.metrics?.perShot) ? session.metrics.perShot : [];
  const technique: TechniqueScores | null =
    session.metrics?.technique && typeof session.metrics.technique === 'object'
      ? session.metrics.technique
      : null;

  const onSave = async () => {
    if (!user || saving || saved) return;
    try {
      setSaving(true);
      await api.addToArchive(user.id, session.id, `${session.discipline} · ${accuracy}%`);
      setSaved(true);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <Header onBack={() => nav.goBack()} title={session.discipline} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.content}>
        {/* Hero rings */}
        <Card style={st.hero}>
          <View style={st.heroHead}>
            <Label>Session Breakdown</Label>
            <Text style={st.heroDate}>
              {new Date(session.shot_at || session.created_at).toLocaleDateString(undefined, {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </Text>
          </View>
          <RingTrio accuracy={accuracy} hits={session.hits} shots={session.targets} />
        </Card>

        {/* Metric strip */}
        <View style={{ marginTop: space.lg }}>
          <MetricStrip
            items={[
              { icon: 'percent', label: 'Accuracy', value: `${accuracy}%`, color: metricColors.accuracy },
              { icon: 'check-circle', label: 'Hits', value: `${session.hits}`, color: metricColors.hits },
              { icon: 'target', label: 'Shots', value: `${session.targets}`, color: metricColors.shots },
              { icon: 'zap', label: 'Best run', value: `${session.best_run}` },
            ]}
          />
        </View>

        {/* Video player */}
        {videoUri ? (
          <VideoPlayerCard uri={videoUri} />
        ) : session.video_path ? (
          <Card style={{ marginTop: space.lg, alignItems: 'center', paddingVertical: space.xl }}>
            <Feather name="video-off" size={22} color={colors.textDim} />
            <Text style={st.unplayable}>Footage isn't available for playback on this device.</Text>
          </Card>
        ) : null}

        {/* Technique scores */}
        {technique ? (
          <View style={{ marginTop: space.xl }}>
            <Label>Technique</Label>
            <Card style={{ marginTop: space.sm }}>
              {TECH_META.map((m, i) => (
                <TechniqueBar
                  key={m.key}
                  label={m.label}
                  value={Math.round(technique[m.key] ?? 0)}
                  color={m.color}
                  last={i === TECH_META.length - 1}
                />
              ))}
            </Card>
          </View>
        ) : null}

        {/* Per-shot timeline */}
        <View style={{ marginTop: space.xl }}>
          <Label>Per-shot</Label>
          <Card style={{ marginTop: space.sm }}>
            {perShot.length === 0 ? (
              <Text style={st.unplayable}>No per-shot data for this session.</Text>
            ) : (
              <>
                <View style={st.shotGrid}>
                  {perShot.map((ps, i) => (
                    <View
                      key={i}
                      style={[
                        st.shotMark,
                        { backgroundColor: ps.hit ? colors.primary : colors.cardAlt, borderColor: ps.hit ? colors.primary : colors.borderStrong },
                      ]}
                    />
                  ))}
                </View>
                <View style={st.legend}>
                  <View style={st.legendItem}>
                    <View style={[st.legendDot, { backgroundColor: colors.primary }]} />
                    <Text style={st.legendText}>Hit</Text>
                  </View>
                  <View style={st.legendItem}>
                    <View style={[st.legendDot, { backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.borderStrong }]} />
                    <Text style={st.legendText}>Miss</Text>
                  </View>
                  <Text style={st.legendCount}>{perShot.length} shots</Text>
                </View>
              </>
            )}
          </Card>
        </View>

        {/* Save to archive */}
        <View style={{ marginTop: space.xxl }}>
          <Button
            title={saved ? 'Saved to archive' : 'Save to archive'}
            icon={saved ? 'check' : 'bookmark'}
            onPress={onSave}
            loading={saving}
            disabled={saved}
            variant={saved ? 'outline' : 'primary'}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={st.header}>
      <Pressable onPress={onBack} hitSlop={10} style={st.backBtn}>
        <Feather name="chevron-left" size={24} color={colors.text} />
      </Pressable>
      <Text style={st.headerTitle} numberOfLines={1}>{title.toUpperCase()}</Text>
    </View>
  );
}

function VideoPlayerCard({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
  });
  const [slow, setSlow] = useState(false);
  const [playing, setPlaying] = useState(false);

  const toggleSlow = useCallback(() => {
    setSlow((prev) => {
      const next = !prev;
      try { player.playbackRate = next ? 0.25 : 1; } catch { /* not ready */ }
      return next;
    });
  }, [player]);

  const togglePlay = useCallback(() => {
    try {
      if (playing) player.pause();
      else player.play();
      setPlaying((p) => !p);
    } catch { /* not ready */ }
  }, [player, playing]);

  return (
    <View style={{ marginTop: space.lg }}>
      <Label>Footage</Label>
      <View style={st.videoWrap}>
        <VideoView player={player} style={st.video} contentFit="cover" nativeControls={false} />
        <View style={st.videoControls}>
          <Pressable onPress={togglePlay} hitSlop={8} style={st.videoBtn}>
            <Feather name={playing ? 'pause' : 'play'} size={16} color={colors.text} />
          </Pressable>
          <Pressable onPress={toggleSlow} hitSlop={8} style={[st.slowBtn, slow && st.slowBtnActive]}>
            <Text style={[st.slowText, slow && st.slowTextActive]}>{slow ? '0.25× SLO-MO' : 'SLO-MO'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function TechniqueBar({ label, value, color, last }: { label: string; value: number; color: string; last: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={[st.techRow, !last && st.techDivider]}>
      <Text style={st.techLabel}>{label}</Text>
      <View style={st.techTrack}>
        <View style={[st.techFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={[st.techVal, { color }]}>{value}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.huge },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  backBtn: { position: 'absolute', left: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text, maxWidth: '70%' },

  hero: { paddingVertical: space.xl },
  heroHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.lg },
  heroDate: { ...T.small },

  unplayable: { ...T.small, textAlign: 'center', marginTop: space.sm },

  videoWrap: {
    marginTop: space.sm, borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, backgroundColor: '#000',
  },
  video: { width: '100%', aspectRatio: 16 / 9 },
  videoControls: {
    position: 'absolute', bottom: space.md, left: space.md, right: space.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  videoBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  slowBtn: {
    paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.pill,
    backgroundColor: colors.overlay, borderWidth: 1, borderColor: 'transparent',
  },
  slowBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  slowText: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.text },
  slowTextActive: { color: colors.onPrimary },

  techRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md },
  techDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  techLabel: { ...T.label, fontSize: 11, color: colors.textMuted, width: 64 },
  techTrack: { flex: 1, height: 8, borderRadius: radius.pill, backgroundColor: colors.ringTrack, marginHorizontal: space.md, overflow: 'hidden' },
  techFill: { height: '100%', borderRadius: radius.pill },
  techVal: { fontSize: 16, fontWeight: '800', width: 34, textAlign: 'right' },

  shotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  shotMark: { width: 14, height: 14, borderRadius: 4, borderWidth: 1 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.lg },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendText: { ...T.small },
  legendCount: { ...T.small, marginLeft: 'auto', color: colors.textMuted },
});
