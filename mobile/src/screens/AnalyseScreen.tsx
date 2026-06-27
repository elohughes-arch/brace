import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, RefreshControl,
  ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T, metricColors } from '../theme';
import { Card, Label, EmptyState } from '../components/ui';
import * as api from '../lib/api';
import type { Session, ArchiveItem } from '../types';
import type { RootStackParamList } from '../navigation/types';

type Segment = 'sessions' | 'archive';

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function AnalyseScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [segment, setSegment] = useState<Segment>('sessions');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.listSessions(), api.listArchive()]);
      setSessions(s);
      setArchive(a);
    } catch {
      setSessions([]);
      setArchive([]);
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

  // group sessions by day (API returns them newest-first)
  const groups: { key: string; items: Session[] }[] = [];
  for (const sn of sessions) {
    const key = dayKey(sn.shot_at || sn.created_at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(sn);
    else groups.push({ key, items: [sn] });
  }

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Text style={st.headerTitle}>ANALYSE</Text>
      </View>

      {/* Segmented toggle */}
      <View style={st.segments}>
        <SegmentTab label="Sessions" active={segment === 'sessions'} onPress={() => setSegment('sessions')} />
        <SegmentTab label="Archive" active={segment === 'archive'} onPress={() => setSegment('archive')} />
      </View>

      {loading ? (
        <View style={st.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={st.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
          }
        >
          {segment === 'sessions' ? (
            sessions.length === 0 ? (
              <View style={{ marginTop: space.xxxl }}>
                <EmptyState
                  icon="target"
                  title="No sessions yet"
                  text="Import a clip from Home to break down your shots."
                />
              </View>
            ) : (
              groups.map((g) => (
                <View key={g.key} style={{ marginBottom: space.lg }}>
                  <Label>{g.key}</Label>
                  <View style={{ marginTop: space.sm }}>
                    {g.items.map((sn) => (
                      <SessionRow
                        key={sn.id}
                        session={sn}
                        onPress={() => nav.navigate('SessionDetail', { id: sn.id })}
                      />
                    ))}
                  </View>
                </View>
              ))
            )
          ) : archive.length === 0 ? (
            <View style={{ marginTop: space.xxxl }}>
              <EmptyState
                icon="bookmark"
                title="Nothing saved yet"
                text="Save a standout session to your archive and it will show up here."
              />
            </View>
          ) : (
            archive.map((item) => (
              <ArchiveRow
                key={item.id}
                item={item}
                onPress={() => { if (item.session_id) nav.navigate('SessionDetail', { id: item.session_id }); }}
              />
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function SegmentTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[st.segment, active && st.segmentActive]}>
      <Text style={[st.segmentText, active && st.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SessionRow({ session, onPress }: { session: Session; onPress: () => void }) {
  const acc = Math.round(session.hit_rate);
  return (
    <Card onPress={onPress} style={st.row}>
      <View style={st.rowAcc}>
        <Text style={[st.rowAccVal, { color: metricColors.accuracy }]}>{acc}</Text>
        <Text style={st.rowAccPct}>%</Text>
      </View>
      <View style={{ flex: 1, marginLeft: space.lg }}>
        <Text style={st.rowTitle} numberOfLines={1}>{session.discipline}</Text>
        <Text style={st.rowMeta} numberOfLines={1}>
          {timeLabel(session.shot_at || session.created_at)} · {session.hits}/{session.targets} hits
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.textDim} />
    </Card>
  );
}

function ArchiveRow({ item, onPress }: { item: ArchiveItem; onPress: () => void }) {
  return (
    <Card onPress={onPress} style={st.row}>
      <View style={st.archiveIcon}>
        <Feather name="bookmark" size={18} color={colors.amber} />
      </View>
      <View style={{ flex: 1, marginLeft: space.lg }}>
        <Text style={st.rowTitle} numberOfLines={1}>{item.title || 'Saved session'}</Text>
        <Text style={st.rowMeta}>{dayKey(item.created_at)}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.textDim} />
    </Card>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.huge },

  segments: {
    flexDirection: 'row', marginHorizontal: space.lg, marginBottom: space.lg,
    backgroundColor: colors.card, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: 4,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.cardAlt },
  segmentText: { ...T.label, fontSize: 12, color: colors.textMuted },
  segmentTextActive: { color: colors.text },

  row: { flexDirection: 'row', alignItems: 'center', marginBottom: space.sm, paddingVertical: space.md, paddingHorizontal: space.lg },
  rowAcc: { flexDirection: 'row', alignItems: 'baseline', width: 56 },
  rowAccVal: { fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  rowAccPct: { ...T.small, fontSize: 12, marginLeft: 1, color: colors.textMuted },
  rowTitle: { ...T.h3, fontSize: 16 },
  rowMeta: { ...T.small, marginTop: 3 },
  archiveIcon: {
    width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.amber + '1A', borderWidth: 1, borderColor: colors.amber + '40',
  },
});
