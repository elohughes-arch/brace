import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Linking, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Card, Button, ListRow, Label } from '../components/ui';
import type { RootStackParamList } from '../navigation/types';

const SUPPORT_EMAIL = 'support@braceshooting.app';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do I import a session?',
    a: 'Film on your smart glasses or any camera so the clip lands in your camera roll, then open Analyse and pick the clip. Brace runs the analysis and creates a session with your shots, hits and accuracy.',
  },
  {
    q: 'How is accuracy calculated?',
    a: 'Accuracy is hits divided by shots fired, shown as a percentage. Each shot is detected from the clip and marked as a hit or a miss.',
  },
  {
    q: 'Does Brace identify me from my footage?',
    a: 'No. Brace analyses movement and technique — your mount, swing and follow-through — not biometric identity. There is no facial recognition. See Privacy for full detail.',
  },
  {
    q: 'What comes with membership?',
    a: 'Founding membership includes a bundled clear lens, unlimited analysis, full performance history and groups. See the Membership screen for the full list.',
  },
  {
    q: 'Which cameras work with Brace?',
    a: 'Any camera that saves a video to your camera roll works — smart shooting glasses, an action camera or your phone.',
  },
];

export default function SupportScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [open, setOpen] = useState<number | null>(0);

  const toggle = useCallback((i: number) => {
    setOpen((prev) => (prev === i ? null : i));
  }, []);

  const openLink = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Could not open link', 'Please try again later.');
    }
  }, []);

  const contactSupport = useCallback(() => {
    openLink(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Brace support')}`);
  }, [openLink]);

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8} style={st.back}>
          <Feather name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={st.headerTitle}>Support</Text>
      </View>

      <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false}>
        {/* Contact card */}
        <Card style={st.contactCard}>
          <View style={st.contactIcon}>
            <Feather name="life-buoy" size={20} color={colors.primary} />
          </View>
          <Text style={st.contactTitle}>We're here to help</Text>
          <Text style={st.contactText}>
            Founding members get direct support. Email us and we'll get back to you.
          </Text>
          <Button
            title="Contact support"
            icon="mail"
            onPress={contactSupport}
            style={{ marginTop: space.lg }}
          />
        </Card>

        {/* FAQ */}
        <Label>FAQ & tutorials</Label>
        <View style={st.faqGroup}>
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <Pressable key={f.q} onPress={() => toggle(i)} style={st.faqItem}>
                <View style={st.faqHead}>
                  <Text style={st.faqQ}>{f.q}</Text>
                  <Feather name={isOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textDim} />
                </View>
                {isOpen ? <Text style={st.faqA}>{f.a}</Text> : null}
              </Pressable>
            );
          })}
        </View>

        {/* Links */}
        <Label>More</Label>
        <View style={st.linkGroup}>
          <ListRow
            icon="book-open"
            title="Help centre"
            onPress={() => openLink('https://braceshooting.app/help')}
          />
          <ListRow
            icon="file-text"
            title="Terms of service"
            onPress={() => openLink('https://braceshooting.app/terms')}
          />
          <ListRow
            icon="lock"
            title="Privacy policy"
            onPress={() => openLink('https://braceshooting.app/privacy')}
          />
        </View>

        <Text style={st.about}>
          Brace turns your shooting footage into performance metrics — clay, simulated and driven game.
          Built for founding members.
        </Text>
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

  contactCard: { marginTop: space.sm, marginBottom: space.lg },
  contactIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary + '1A',
    borderWidth: 1, borderColor: colors.primary + '66', alignItems: 'center', justifyContent: 'center', marginBottom: space.md,
  },
  contactTitle: { ...T.h3 },
  contactText: { ...T.bodyMuted, marginTop: space.sm, lineHeight: 21 },

  faqGroup: { marginTop: space.sm, marginBottom: space.md },
  faqItem: {
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingVertical: space.lg, marginBottom: space.sm,
  },
  faqHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  faqQ: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700', paddingRight: space.md },
  faqA: { ...T.bodyMuted, marginTop: space.md, lineHeight: 21 },

  linkGroup: { marginTop: space.sm },
  about: { ...T.small, color: colors.textDim, marginTop: space.lg, lineHeight: 18, textAlign: 'center' },
});
