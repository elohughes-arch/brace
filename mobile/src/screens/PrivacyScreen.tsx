import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert, Share, Switch, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Card, Button, Label } from '../components/ui';
import { useAuth } from '../lib/auth';
import * as api from '../lib/api';
import type { RootStackParamList } from '../navigation/types';

type IconName = React.ComponentProps<typeof Feather>['name'];

interface Pref {
  key: string;
  icon: IconName;
  title: string;
  text: string;
  value: boolean;
}

export default function PrivacyScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAuth();

  // Local-only preferences (would persist to profile/settings in production).
  const [prefs, setPrefs] = useState<Pref[]>([
    { key: 'analysis', icon: 'activity', title: 'Movement & technique analysis', text: 'Process your clips to extract shots, hits and technique scores.', value: true },
    { key: 'cloud', icon: 'upload-cloud', title: 'Cloud processing', text: 'Allow clips to be analysed in the cloud rather than only on-device.', value: true },
    { key: 'leaderboards', icon: 'bar-chart-2', title: 'Share scores on leaderboards', text: 'Show your accuracy in groups you join.', value: true },
    { key: 'product', icon: 'mail', title: 'Product updates', text: 'Occasional emails about new features and founding-member perks.', value: false },
  ]);

  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const toggle = useCallback((key: string) => {
    setPrefs((prev) => prev.map((p) => (p.key === key ? { ...p, value: !p.value } : p)));
  }, []);

  const onExport = useCallback(async () => {
    if (!user) return;
    try {
      setExporting(true);
      const data = await api.exportMyData(user.id);
      const json = JSON.stringify(data, null, 2);
      await Share.share({ message: json, title: 'Brace — my data export' });
    } catch (e: any) {
      Alert.alert('Could not export', e?.message ?? 'Please try again.');
    } finally {
      setExporting(false);
    }
  }, [user]);

  const onDelete = useCallback(() => {
    if (!user) return;
    Alert.alert(
      'Delete my data?',
      'This permanently removes your sessions and archive. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              await api.deleteMyData(user.id);
              Alert.alert('Data deleted', 'Your sessions and archive have been removed.');
            } catch (e: any) {
              Alert.alert('Could not delete', e?.message ?? 'Please try again.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  }, [user]);

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle}>Privacy</Text>
      </View>

      <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false}>
        {/* How we process */}
        <Card style={st.infoCard}>
          <View style={st.infoIcon}>
            <Feather name="shield" size={20} color={colors.primary} />
          </View>
          <Text style={st.infoTitle}>How Brace handles your footage</Text>
          <Text style={st.infoBody}>
            Brace analyses the movement and technique in your clips — gun mount, swing and follow-through —
            to turn a session into performance metrics. We do not run biometric identification or facial
            recognition, and your footage is never used to identify you.
          </Text>
        </Card>

        <Label>Processing preferences</Label>
        <View style={st.group}>
          {prefs.map((p) => (
            <View key={p.key} style={st.prefRow}>
              <Feather name={p.icon} size={20} color={colors.textMuted} style={{ marginRight: space.md, marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={st.prefTitle}>{p.title}</Text>
                <Text style={st.prefText}>{p.text}</Text>
              </View>
              <Switch
                value={p.value}
                onValueChange={() => toggle(p.key)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor={colors.text}
                ios_backgroundColor={colors.border}
              />
            </View>
          ))}
        </View>

        <Label>Your data rights</Label>
        <Text style={st.rightsText}>
          Under GDPR you can request a copy of your data or have it erased at any time.
        </Text>

        <Button
          title="Export my data"
          icon="download"
          variant="outline"
          onPress={onExport}
          loading={exporting}
          style={{ marginTop: space.md }}
        />
        <Button
          title="Delete my data"
          icon="trash-2"
          variant="outline"
          color={colors.red}
          onPress={onDelete}
          loading={deleting}
          style={{ marginTop: space.md }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  back: { position: 'absolute', left: space.lg },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.huge },

  infoCard: { marginTop: space.sm },
  infoIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary + '1A',
    borderWidth: 1, borderColor: colors.primary + '66', alignItems: 'center', justifyContent: 'center', marginBottom: space.md,
  },
  infoTitle: { ...T.h3, marginBottom: space.sm },
  infoBody: { ...T.bodyMuted, lineHeight: 21 },

  group: { marginTop: space.sm, marginBottom: space.md },
  prefRow: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.card,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingVertical: space.lg, marginBottom: space.sm,
  },
  prefTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  prefText: { ...T.small, marginTop: 3, lineHeight: 18, paddingRight: space.sm },

  rightsText: { ...T.bodyMuted, marginTop: space.sm },
});
