import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, RefreshControl,
  ScrollView, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

import { colors, space, radius, type as T, metricColors } from '../theme';
import {
  Card, Button, Label, SectionLabel, Tag, EmptyState, Divider,
} from '../components/ui';
import { RingTrio } from '../components/Ring';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Session } from '../types';
import type { RootStackParamList } from '../navigation/types';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function relDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function HomeScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, profile } = useAuth();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onImport = useCallback(async () => {
    if (!user) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Brace needs access to your camera roll to import footage.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'videos' });
      if (result.canceled || !result.assets[0]) return;

      const uri = result.assets[0].uri;
      setImporting(true);
      const session = await api.importAndAnalyse(user.id, uri);
      await load();
      setImporting(false);
      nav.navigate('SessionDetail', { id: session.id });
    } catch (e: any) {
      setImporting(false);
      Alert.alert('Analysis failed', e?.message ?? 'Could not analyse that clip. Please try again.');
    }
  }, [user, load, nav]);

  const latest = sessions[0];
  const eyewearOk = profile?.eyewear_confirmed ?? false;
  const name = profile?.name?.trim().split(/\s+/)[0] || 'Gun';

  // accuracy trend — oldest -> newest, last ~6 sessions
  const trend = sessions.slice(0, 6).reverse();
  const maxRate = Math.max(100, ...trend.map(t => t.hit_rate));

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <View style={st.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={st.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
        }
      >
        {/* Greeting */}
        <View style={st.greetRow}>
          <View style={{ flex: 1 }}>
            <Text style={T.label}>{greeting()}</Text>
            <Text style={st.greetName}>{name}</Text>
          </View>
          <Pressable
            onPress={() => Alert.alert(
              eyewearOk ? 'Eye protection confirmed' : 'Eye protection',
              eyewearOk
                ? 'You have confirmed you wear certified eye protection. Stay safe.'
                : 'Confirm you wear certified eye protection when shooting. Update this in your Account.',
            )}
            style={[st.chip, eyewearOk ? st.chipOk : st.chipWarn]}
          >
            <Feather
              name={eyewearOk ? 'shield' : 'alert-triangle'}
              size={13}
              color={eyewearOk ? colors.primary : colors.amber}
            />
            <Text style={[st.chipText, { color: eyewearOk ? colors.primary : colors.amber }]}>
              {eyewearOk ? 'Eyewear on' : 'Confirm eyewear'}
            </Text>
          </Pressable>
        </View>

        {/* Hero rings */}
        <Card style={st.hero}>
          <View style={st.heroHead}>
            <Label>{latest ? 'Latest Session' : 'Get Started'}</Label>
            {latest ? <Text style={st.heroDate}>{relDate(latest.shot_at || latest.created_at)}</Text> : null}
          </View>
          <RingTrio
            accuracy={latest ? Math.round(latest.hit_rate) : 0}
            hits={latest ? latest.hits : 0}
            shots={latest ? latest.targets : 0}
          />
          {!latest ? (
            <Text style={st.heroEmpty}>Import your first session to see your numbers.</Text>
          ) : null}
        </Card>

        {/* Import footage */}
        <Card style={{ marginTop: space.lg }}>
          {importing ? (
            <View style={st.processing}>
              <ActivityIndicator color={colors.primary} />
              <Text style={st.processingTitle}>Brace is analysing your day…</Text>
              <Text style={st.processingSub}>Counting shots, scoring hits and reading your technique.</Text>
            </View>
          ) : (
            <>
              <Label>Today's Footage</Label>
              <Text style={st.importBlurb}>
                Pull the clip from your glasses or camera roll and let Brace break down every shot.
              </Text>
              <Button
                title="Import today's footage"
                icon="upload-cloud"
                onPress={onImport}
                style={{ marginTop: space.md }}
              />
            </>
          )}
        </Card>

        {/* Recent session summary */}
        {latest ? (
          <>
            <SectionLabel actionLabel="History" onAction={() => nav.navigate('Tabs')}>
              Recent Session
            </SectionLabel>
            <Card onPress={() => nav.navigate('SessionDetail', { id: latest.id })}>
              <View style={st.recentHead}>
                <View style={{ flex: 1 }}>
                  <Text style={st.recentTitle} numberOfLines={1}>{latest.name}</Text>
                  <Text style={st.recentMeta}>
                    {latest.discipline} · {relDate(latest.shot_at || latest.created_at)}
                  </Text>
                </View>
                <Tag color={metricColors.accuracy}>{`${Math.round(latest.hit_rate)}%`}</Tag>
              </View>
              <Divider />
              <View style={st.recentStats}>
                <Stat label="Hits" value={`${latest.hits}`} color={metricColors.hits} />
                <Stat label="Shots" value={`${latest.targets}`} color={metricColors.shots} />
                <Stat label="Best run" value={`${latest.best_run}`} color={colors.text} />
                <Stat label="Score" value={`${latest.score}`} color={colors.text} />
              </View>
            </Card>
          </>
        ) : null}

        {/* Accuracy trend */}
        {trend.length >= 2 ? (
          <>
            <SectionLabel>Accuracy Trend</SectionLabel>
            <Card>
              <View style={st.bars}>
                {trend.map((sn, i) => {
                  const h = Math.max(6, Math.round((sn.hit_rate / maxRate) * 96));
                  return (
                    <View key={sn.id} style={st.barCol}>
                      <Text style={st.barVal}>{Math.round(sn.hit_rate)}</Text>
                      <View style={[st.bar, { height: h, backgroundColor: i === trend.length - 1 ? colors.primary : colors.primary + '55' }]} />
                      <Text style={st.barLabel}>{relShort(sn.shot_at || sn.created_at)}</Text>
                    </View>
                  );
                })}
              </View>
            </Card>
          </>
        ) : null}

        {/* Empty fallback */}
        {!latest ? (
          <View style={{ marginTop: space.xl }}>
            <EmptyState
              icon="target"
              title="No sessions yet"
              text="Import your first clip to start tracking your accuracy."
              action={<Button title="Import your first session" icon="upload-cloud" onPress={onImport} />}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={st.stat}>
      <Text style={[st.statVal, { color }]}>{value}</Text>
      <Text style={st.statLabel}>{label}</Text>
    </View>
  );
}

function relShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.huge },

  greetRow: { flexDirection: 'row', alignItems: 'center', marginBottom: space.lg },
  greetName: { ...T.h1, marginTop: 2 },

  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1 },
  chipOk: { borderColor: colors.primary + '66', backgroundColor: colors.primary + '14' },
  chipWarn: { borderColor: colors.amber + '66', backgroundColor: colors.amber + '14' },
  chipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },

  hero: { paddingVertical: space.xl },
  heroHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.lg },
  heroDate: { ...T.small },
  heroEmpty: { ...T.bodyMuted, textAlign: 'center', marginTop: space.lg },

  importBlurb: { ...T.bodyMuted, marginTop: space.sm },
  processing: { alignItems: 'center', paddingVertical: space.md, gap: space.sm },
  processingTitle: { ...T.h3, marginTop: space.sm },
  processingSub: { ...T.small, textAlign: 'center' },

  recentHead: { flexDirection: 'row', alignItems: 'center' },
  recentTitle: { ...T.h3, fontSize: 17 },
  recentMeta: { ...T.small, marginTop: 3 },
  recentStats: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', flex: 1 },
  statVal: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { ...T.label, fontSize: 10, marginTop: 3 },

  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 140, paddingTop: space.sm },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  bar: { width: 22, borderRadius: radius.sm },
  barVal: { ...T.small, fontSize: 11, color: colors.text, fontWeight: '700' },
  barLabel: { ...T.small, fontSize: 10 },
});
