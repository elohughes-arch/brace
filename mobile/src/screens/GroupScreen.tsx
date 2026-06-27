import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert, Share,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T, metricColors } from '../theme';
import { Card, Label, EmptyState } from '../components/ui';
import { LeaderboardRow, ChatBubble } from '../components/cards';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Group, LeaderboardEntry, Message } from '../types';
import type { RootStackParamList } from '../navigation/types';

type Metric = 'accuracy' | 'hits' | 'shots';
const METRICS: { key: Metric; label: string }[] = [
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'hits', label: 'Hits' },
  { key: 'shots', label: 'Shots' },
];

export default function GroupScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Group'>>();
  const groupId = route.params.id;
  const { user } = useAuth();

  const [group, setGroup] = useState<Group | null>(null);
  const [metric, setMetric] = useState<Metric>('accuracy');
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const loadGroup = useCallback(async () => {
    try {
      const groups = await api.listMyGroups();
      setGroup(groups.find((g) => g.id === groupId) ?? null);
    } catch {
      setGroup(null);
    }
  }, [groupId]);

  const loadBoard = useCallback(async () => {
    try {
      setBoard(await api.groupLeaderboard(groupId));
    } catch {
      setBoard([]);
    }
  }, [groupId]);

  const loadMessages = useCallback(async () => {
    try {
      const [msgs, blk] = await Promise.all([
        api.listMessages({ groupId }),
        api.listBlockedIds(),
      ]);
      setBlocked(blk);
      setMessages(msgs.filter((m) => !m.removed && !blk.includes(m.user_id)));
    } catch {
      setMessages([]);
    }
  }, [groupId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadGroup(), loadBoard(), loadMessages()]);
      setLoading(false);
    })();
  }, [loadGroup, loadBoard, loadMessages]);

  // realtime chat
  useEffect(() => {
    const unsub = api.subscribeMessages({ groupId }, () => { loadMessages(); });
    return unsub;
  }, [groupId, loadMessages]);

  const onSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || !user) return;
    try {
      setSending(true);
      setDraft('');
      await api.sendMessage(user.id, { groupId }, body);
      await loadMessages();
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? 'Please try again.');
    } finally {
      setSending(false);
    }
  }, [draft, user, groupId, loadMessages]);

  const onReport = useCallback(async (m: Message) => {
    if (!user) return;
    try {
      await api.reportContent(user.id, { messageId: m.id, targetUserId: m.user_id, reason: 'inappropriate' });
      Alert.alert('Reported', 'Thanks — our team will review this message.');
    } catch (e: any) {
      Alert.alert('Could not report', e?.message ?? 'Please try again.');
    }
  }, [user]);

  const onBlock = useCallback((m: Message) => {
    if (!user) return;
    Alert.alert('Block this gun?', 'You will no longer see their messages.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.blockUser(user.id, m.user_id);
            const next = [...blocked, m.user_id];
            setBlocked(next);
            setMessages((prev) => prev.filter((x) => x.user_id !== m.user_id));
          } catch (e: any) {
            Alert.alert('Could not block', e?.message ?? 'Please try again.');
          }
        },
      },
    ]);
  }, [user, blocked]);

  const shareInvite = useCallback(async () => {
    if (!group) return;
    try {
      await Share.share({ message: `Join my Brace group "${group.name}" — invite code: ${group.invite_code}` });
    } catch {
      /* dismissed */
    }
  }, [group]);

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <Header title="Group" onBack={() => nav.goBack()} />
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <Header title={group?.name ?? 'Group'} onBack={() => nav.goBack()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={st.content}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {/* Invite code */}
          {group ? (
            <Card style={st.inviteCard}>
              <View style={{ flex: 1 }}>
                <Label>Invite code</Label>
                <Text style={st.inviteCode}>{group.invite_code}</Text>
              </View>
              <Pressable onPress={shareInvite} hitSlop={8} style={st.shareBtn}>
                <Feather name="share-2" size={18} color={colors.primary} />
                <Text style={st.shareText}>Share</Text>
              </Pressable>
            </Card>
          ) : null}

          {/* Metric selector */}
          <View style={st.segment}>
            {METRICS.map((m) => {
              const active = m.key === metric;
              return (
                <Pressable
                  key={m.key}
                  onPress={() => setMetric(m.key)}
                  style={[st.segItem, active && { backgroundColor: colors.cardAlt }]}
                >
                  <Text style={[st.segText, active && { color: metricColors[m.key] }]}>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Leaderboard */}
          <Text style={[T.label, st.sectionLabel]}>Live Leaderboard</Text>
          {board.length === 0 ? (
            <EmptyState icon="bar-chart-2" title="No scores yet" text="Import a session to climb the board." />
          ) : (
            <Card style={{ paddingVertical: space.sm }}>
              {board.map((entry, i) => (
                <LeaderboardRow key={entry.user_id} rank={i + 1} entry={entry} metric={metric} />
              ))}
            </Card>
          )}

          {/* Chat */}
          <Text style={[T.label, st.sectionLabel]}>Group Chat</Text>
          {messages.length === 0 ? (
            <EmptyState icon="message-circle" title="No messages yet" text="Say hello to your group." />
          ) : (
            messages.map((m) => (
              <ChatBubble
                key={m.id}
                message={m}
                mine={m.user_id === user?.id}
                onReport={() => onReport(m)}
                onBlock={() => onBlock(m)}
              />
            ))
          )}
        </ScrollView>

        {/* Composer */}
        <View style={st.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message your group…"
            placeholderTextColor={colors.textDim}
            style={st.input}
            multiline
          />
          <Pressable
            onPress={onSend}
            disabled={sending || !draft.trim()}
            style={[st.sendBtn, (sending || !draft.trim()) && { opacity: 0.4 }]}
          >
            {sending ? <ActivityIndicator color={colors.onPrimary} /> : <Feather name="arrow-up" size={20} color={colors.onPrimary} />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={st.header}>
      <Pressable onPress={onBack} hitSlop={8} style={st.back}>
        <Feather name="chevron-left" size={24} color={colors.text} />
      </Pressable>
      <Text style={st.headerTitle} numberOfLines={1}>{title}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.huge, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },

  inviteCard: { flexDirection: 'row', alignItems: 'center' },
  inviteCode: { fontSize: 24, fontWeight: '800', letterSpacing: 3, color: colors.primary, marginTop: 4, textTransform: 'uppercase' },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary + '66', backgroundColor: colors.primary + '14' },
  shareText: { color: colors.primary, fontWeight: '800', fontSize: 12, letterSpacing: 0.5, textTransform: 'uppercase' },

  segment: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, padding: 4, marginTop: space.lg },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.pill },
  segText: { ...T.label, fontSize: 11, color: colors.textMuted },

  sectionLabel: { marginTop: space.xl, marginBottom: space.md },

  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  input: { flex: 1, maxHeight: 120, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: 12, color: colors.text, fontSize: 15 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
});
