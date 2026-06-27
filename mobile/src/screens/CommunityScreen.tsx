import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, RefreshControl,
  ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Card, SectionLabel, Avatar, EmptyState, Button } from '../components/ui';
import * as api from '../lib/api';
import type { Group, Community } from '../types';
import type { RootStackParamList } from '../navigation/types';

function eventLabel(g: Group): string {
  if (!g.event_date) return g.discipline || 'Group';
  const d = new Date(g.event_date);
  const when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return g.discipline ? `${g.discipline} · ${when}` : when;
}

export default function CommunityScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [groups, setGroups] = useState<Group[]>([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([api.listMyGroups(), api.listCommunities()]);
      setGroups(g);
      setCommunities(c);
    } catch {
      setGroups([]);
      setCommunities([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  // refresh groups when returning from CreateGroup / Group
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <View style={st.header}><Text style={st.headerTitle}>Community</Text></View>
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}><Text style={st.headerTitle}>Community</Text></View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={st.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />}
      >
        {/* MY GROUPS */}
        <SectionLabel actionLabel="+ New group" onAction={() => nav.navigate('CreateGroup')}>
          My Groups
        </SectionLabel>

        {groups.length === 0 ? (
          <EmptyState
            icon="users"
            title="No groups yet"
            text="Start a group for your next shoot and invite your guns."
            action={<Button title="New group" icon="plus" onPress={() => nav.navigate('CreateGroup')} />}
          />
        ) : (
          groups.map((g) => (
            <Pressable
              key={g.id}
              onPress={() => nav.navigate('Group', { id: g.id })}
              style={({ pressed }) => [st.groupRow, pressed && { opacity: 0.85 }]}
            >
              <Avatar name={g.name} size={44} />
              <View style={{ flex: 1, marginLeft: space.md }}>
                <Text style={st.groupName} numberOfLines={1}>{g.name}</Text>
                <Text style={st.groupMeta} numberOfLines={1}>{eventLabel(g)}</Text>
              </View>
              <Feather name="chevron-right" size={20} color={colors.textDim} />
            </Pressable>
          ))
        )}

        {/* COMMUNITIES */}
        <SectionLabel>Communities</SectionLabel>

        {communities.length === 0 ? (
          <EmptyState icon="message-circle" title="No communities" text="Topical forums will appear here soon." />
        ) : (
          communities.map((c) => (
            <Card
              key={c.id}
              onPress={() => nav.navigate('Forum', { id: c.id, name: c.name })}
              style={st.communityCard}
            >
              <View style={st.communityIcon}>
                <Feather name="hash" size={20} color={colors.blue} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.communityName} numberOfLines={1}>{c.name}</Text>
                {c.description ? (
                  <Text style={st.communityDesc} numberOfLines={2}>{c.description}</Text>
                ) : null}
              </View>
              <Feather name="chevron-right" size={20} color={colors.textDim} />
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  content: { paddingHorizontal: space.lg, paddingBottom: space.huge },

  groupRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingVertical: space.md, marginBottom: space.sm,
  },
  groupName: { ...T.h3, fontSize: 16 },
  groupMeta: { ...T.small, marginTop: 3 },

  communityCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm, padding: space.lg },
  communityIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.blue + '1A', alignItems: 'center', justifyContent: 'center' },
  communityName: { ...T.h3, fontSize: 16 },
  communityDesc: { ...T.small, marginTop: 3 },
});
