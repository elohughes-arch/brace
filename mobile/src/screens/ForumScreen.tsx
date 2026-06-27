import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { EmptyState } from '../components/ui';
import { ChatBubble } from '../components/cards';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Message } from '../types';
import type { RootStackParamList } from '../navigation/types';

export default function ForumScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Forum'>>();
  const { id: communityId, name } = route.params;
  const { user } = useAuth();

  const [messages, setMessages] = useState<Message[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const loadMessages = useCallback(async () => {
    try {
      const [msgs, blk] = await Promise.all([
        api.listMessages({ communityId }),
        api.listBlockedIds(),
      ]);
      setBlocked(blk);
      setMessages(msgs.filter((m) => !m.removed && !blk.includes(m.user_id)));
    } catch {
      setMessages([]);
    }
  }, [communityId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadMessages();
      setLoading(false);
    })();
  }, [loadMessages]);

  // realtime
  useEffect(() => {
    const unsub = api.subscribeMessages({ communityId }, () => { loadMessages(); });
    return unsub;
  }, [communityId, loadMessages]);

  const onSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || !user) return;
    try {
      setSending(true);
      setDraft('');
      await api.sendMessage(user.id, { communityId }, body);
      await loadMessages();
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? 'Please try again.');
    } finally {
      setSending(false);
    }
  }, [draft, user, communityId, loadMessages]);

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
            setBlocked((prev) => [...prev, m.user_id]);
            setMessages((prev) => prev.filter((x) => x.user_id !== m.user_id));
          } catch (e: any) {
            Alert.alert('Could not block', e?.message ?? 'Please try again.');
          }
        },
      },
    ]);
  }, [user]);

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle} numberOfLines={1}>{name}</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        {loading ? (
          <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={st.content}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          >
            {messages.length === 0 ? (
              <EmptyState icon="message-circle" title={`Welcome to ${name}`} text="Be the first to start the conversation." />
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
        )}

        {/* Composer pinned to bottom */}
        <View style={st.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${name}…`}
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

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.huge, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xl },

  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  input: { flex: 1, maxHeight: 120, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: 12, color: colors.text, fontSize: 15 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
});
