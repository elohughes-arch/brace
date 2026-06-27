import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Card, Button, Tag, Label } from '../components/ui';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { Subscription } from '../types';
import type { RootStackParamList } from '../navigation/types';

type IconName = React.ComponentProps<typeof Feather>['name'];

const BENEFITS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'eye', title: 'Clear lens included', text: 'A bundled Brace clear lens ships with your founding membership.' },
  { icon: 'activity', title: 'Unlimited analysis', text: 'Import and analyse every session — no clip limits.' },
  { icon: 'bar-chart-2', title: 'Full performance history', text: 'Trends, per-shot breakdowns and technique scores over time.' },
  { icon: 'users', title: 'Groups & leaderboards', text: 'Create unlimited groups and compete with your guns.' },
  { icon: 'star', title: 'Founding member perks', text: 'Early features and locked-in founding pricing.' },
];

export default function MembershipScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAuth();

  const [sub, setSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      setSub(await api.getSubscription(user.id));
    } catch {
      setSub(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const isMember = sub?.plan === 'member' && sub?.status === 'active';

  // STUB upgrade. Real purchases MUST go through App Store IAP / Google Play
  // Billing via RevenueCat — never charge directly. This only flips the local
  // subscription flag so the rest of the app can be exercised pre-launch.
  const onUpgrade = useCallback(async () => {
    if (!user) return;
    try {
      setWorking(true);
      await api.setMembership(user.id, true);
      await load();
      Alert.alert('Welcome to Brace', 'Your founding membership is active.');
    } catch (e: any) {
      Alert.alert('Could not upgrade', e?.message ?? 'Please try again.');
    } finally {
      setWorking(false);
    }
  }, [user, load]);

  const onCancel = useCallback(() => {
    if (!user) return;
    Alert.alert(
      'Cancel membership?',
      'You will keep access until the end of your current period.',
      [
        { text: 'Keep membership', style: 'cancel' },
        {
          text: 'Cancel',
          style: 'destructive',
          onPress: async () => {
            try {
              setWorking(true);
              await api.setMembership(user.id, false);
              await load();
            } catch (e: any) {
              Alert.alert('Could not cancel', e?.message ?? 'Please try again.');
            } finally {
              setWorking(false);
            }
          },
        },
      ],
    );
  }, [user, load]);

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle}>Membership</Text>
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false}>
          {/* Plan card */}
          <Card style={st.planCard}>
            <View style={st.planTop}>
              <View>
                <Label>{isMember ? 'Current plan' : 'Free'}</Label>
                <Text style={st.planName}>{isMember ? 'Brace Membership' : 'Brace Free'}</Text>
              </View>
              <Tag color={isMember ? colors.primary : colors.textMuted} solid={isMember}>
                {isMember ? 'Active' : 'Inactive'}
              </Tag>
            </View>
            {isMember && sub?.renews_at ? (
              <Text style={st.renews}>Renews {new Date(sub.renews_at).toLocaleDateString()}</Text>
            ) : (
              <Text style={st.renews}>Upgrade to unlock the full Brace experience.</Text>
            )}
          </Card>

          {/* Benefits */}
          <Label>What's included</Label>
          <View style={st.benefits}>
            {BENEFITS.map((b) => (
              <View key={b.title} style={st.benefitRow}>
                <View style={st.benefitIcon}>
                  <Feather name={b.icon} size={18} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={st.benefitTitle}>{b.title}</Text>
                  <Text style={st.benefitText}>{b.text}</Text>
                </View>
              </View>
            ))}
          </View>

          {isMember ? (
            <Button
              title="Cancel membership"
              variant="outline"
              color={colors.red}
              onPress={onCancel}
              loading={working}
              style={{ marginTop: space.lg }}
            />
          ) : (
            <>
              <Button
                title="Become a member"
                icon="award"
                onPress={onUpgrade}
                loading={working}
                style={{ marginTop: space.lg }}
              />
              <Text style={st.legal}>
                Purchases are processed by the App Store or Google Play. Founding-member pricing applies.
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.huge },

  planCard: { marginTop: space.sm, marginBottom: space.lg },
  planTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  planName: { ...T.h2, marginTop: 4 },
  renews: { ...T.small, marginTop: space.md },

  benefits: { marginTop: space.sm },
  benefitRow: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.card,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingVertical: space.lg, marginBottom: space.sm,
  },
  benefitIcon: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary + '1A',
    borderWidth: 1, borderColor: colors.primary + '44', alignItems: 'center', justifyContent: 'center', marginRight: space.md,
  },
  benefitTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  benefitText: { ...T.small, marginTop: 3, lineHeight: 18 },

  legal: { ...T.small, color: colors.textDim, textAlign: 'center', marginTop: space.md, lineHeight: 17 },
});
