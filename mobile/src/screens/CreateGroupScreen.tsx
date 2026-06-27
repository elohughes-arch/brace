import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert, Share,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Field, Button, Label, Card } from '../components/ui';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Group, Discipline } from '../types';
import type { RootStackParamList } from '../navigation/types';

const DISCIPLINES: Discipline[] = ['Sporting', 'Trap', 'Skeet', 'Simulated', 'Driven'];

export default function CreateGroupScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAuth();

  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [discipline, setDiscipline] = useState<Discipline>('Sporting');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Group | null>(null);

  const onCreate = useCallback(async () => {
    if (!user) return;
    if (!name.trim()) {
      Alert.alert('Name required', 'Give your group a name.');
      return;
    }
    try {
      setSaving(true);
      const g = await api.createGroup(
        user.id,
        name.trim(),
        eventDate.trim() ? eventDate.trim() : null,
        discipline,
      );
      setCreated(g);
    } catch (e: any) {
      Alert.alert('Could not create group', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  }, [user, name, eventDate, discipline]);

  const shareCode = useCallback(async (g: Group) => {
    try {
      await Share.share({
        message: `Join my Brace group "${g.name}" — invite code: ${g.invite_code}`,
      });
    } catch {
      /* user dismissed */
    }
  }, []);

  // ── Success: show invite code ──
  if (created) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <View style={st.header}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
            <Feather name="chevron-left" size={24} color={colors.text} />
          </Pressable>
          <Text style={st.headerTitle}>Group created</Text>
        </View>
        <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false}>
          <View style={st.successIcon}>
            <Feather name="check" size={28} color={colors.primary} />
          </View>
          <Text style={st.successTitle}>{created.name}</Text>
          <Text style={st.successSub}>Share this code so your guns can join.</Text>

          <Card style={st.codeCard}>
            <Label>Invite code</Label>
            <Text style={st.code}>{created.invite_code}</Text>
          </Card>

          <Button title="Share invite" icon="share-2" onPress={() => shareCode(created)} style={{ marginTop: space.lg }} />
          <Button
            title="Go to group"
            variant="outline"
            onPress={() => nav.replace('Group', { id: created.id })}
            style={{ marginTop: space.md }}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Form ──
  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle}>New group</Text>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Field
            label="Group name"
            value={name}
            onChangeText={setName}
            placeholder="Saturday at the ground"
            autoCapitalize="words"
          />
          <Field
            label="Event date"
            value={eventDate}
            onChangeText={setEventDate}
            placeholder="2026-07-12"
          />

          <Text style={[T.label, { marginBottom: space.sm }]}>Discipline</Text>
          <View style={st.chips}>
            {DISCIPLINES.map((d) => {
              const active = d === discipline;
              return (
                <Pressable
                  key={d}
                  onPress={() => setDiscipline(d)}
                  style={[st.chip, active ? st.chipActive : st.chipIdle]}
                >
                  <Text style={[st.chipText, { color: active ? colors.onPrimary : colors.textMuted }]}>{d}</Text>
                </Pressable>
              );
            })}
          </View>

          <Button title="Create group" icon="users" onPress={onCreate} loading={saving} style={{ marginTop: space.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.huge },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipIdle: { backgroundColor: colors.card, borderColor: colors.border },
  chipText: { fontSize: 13, fontWeight: '700' },

  successIcon: {
    width: 56, height: 56, borderRadius: 28, alignSelf: 'center',
    backgroundColor: colors.primary + '1A', borderWidth: 1, borderColor: colors.primary + '66',
    alignItems: 'center', justifyContent: 'center', marginTop: space.lg,
  },
  successTitle: { ...T.h1, textAlign: 'center', marginTop: space.lg },
  successSub: { ...T.bodyMuted, textAlign: 'center', marginTop: space.sm },
  codeCard: { alignItems: 'center', marginTop: space.xl },
  code: { fontSize: 32, fontWeight: '800', letterSpacing: 4, color: colors.primary, marginTop: space.sm, textTransform: 'uppercase' },
});
