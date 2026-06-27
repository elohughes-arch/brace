import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, ScrollView, Linking, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { Card, Button, Tag, SectionLabel, EmptyState, Divider } from '../components/ui';
import * as api from '../lib/api';
import type { Venue, VenueType } from '../types';
import type { RootStackParamList } from '../navigation/types';

const VENUE_LABEL: Record<VenueType, string> = {
  ground: 'Shooting Ground',
  simulated: 'Simulated Game',
  driven: 'Driven Game',
  hotel: 'Shooting Hotel',
};
const VENUE_TINT: Record<VenueType, string> = {
  ground: colors.primary,
  simulated: colors.blue,
  driven: colors.orange,
  hotel: colors.amber,
};
const VENUE_ICON: Record<VenueType, React.ComponentProps<typeof Feather>['name']> = {
  ground: 'target',
  simulated: 'monitor',
  driven: 'feather',
  hotel: 'home',
};

export default function VenueDetailScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'VenueDetail'>>();
  const { id } = route.params;

  const [venue, setVenue] = useState<Venue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const venues = await api.listVenues();
      const match = venues.find((v) => v.id === id) || null;
      setVenue(match);
      if (!match) setError(true);
    } catch {
      setError(true);
      setVenue(null);
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onBook = useCallback(async () => {
    if (!venue?.booking_url) return;
    try {
      const ok = await Linking.canOpenURL(venue.booking_url);
      if (ok) await Linking.openURL(venue.booking_url);
      else Alert.alert('Cannot open link', 'This booking link could not be opened.');
    } catch {
      Alert.alert('Cannot open link', 'This booking link could not be opened.');
    }
  }, [venue]);

  const onContact = useCallback(async () => {
    if (!venue?.contact) return;
    const raw = venue.contact.trim();
    // Build a tel: / mailto: link where possible, otherwise just copy-friendly alert.
    let url: string | null = null;
    if (raw.includes('@')) url = `mailto:${raw}`;
    else if (/^[+0-9 ()-]{6,}$/.test(raw)) url = `tel:${raw.replace(/[^+0-9]/g, '')}`;
    if (!url) { Alert.alert('Contact', raw); return; }
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) await Linking.openURL(url);
      else Alert.alert('Contact', raw);
    } catch {
      Alert.alert('Contact', raw);
    }
  }, [venue]);

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <Header onBack={() => nav.goBack()} />
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  if (error || !venue) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <Header onBack={() => nav.goBack()} />
        <EmptyState
          icon="alert-circle"
          title="Venue not found"
          text="This venue may have been removed."
          action={<Button title="Back" variant="outline" onPress={() => nav.goBack()} />}
        />
      </SafeAreaView>
    );
  }

  const tint = VENUE_TINT[venue.type] || colors.primary;
  const hasCoords = venue.lat != null && venue.lng != null;

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <Header onBack={() => nav.goBack()} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.content}>
        {/* HERO */}
        <View style={[st.hero, { backgroundColor: tint + '1A', borderColor: tint + '44' }]}>
          <Feather name={VENUE_ICON[venue.type]} size={36} color={tint} />
          {venue.is_featured ? (
            <View style={st.heroBadge}><Tag color={colors.amber} solid>Featured</Tag></View>
          ) : null}
        </View>

        <View style={st.titleBlock}>
          <Text style={st.name}>{venue.name}</Text>
          <View style={st.metaRow}>
            <Tag color={tint}>{VENUE_LABEL[venue.type]}</Tag>
            {venue.region ? (
              <View style={st.regionPill}>
                <Feather name="map-pin" size={12} color={colors.textMuted} />
                <Text style={st.regionText}>{venue.region}</Text>
              </View>
            ) : null}
          </View>
          {venue.is_featured ? (
            <Text style={st.sponsoredNote}>Sponsored — featured by partner placement.</Text>
          ) : null}
        </View>

        {/* DESCRIPTION */}
        {venue.description ? (
          <>
            <SectionLabel>About</SectionLabel>
            <Card>
              <Text style={st.body}>{venue.description}</Text>
            </Card>
          </>
        ) : null}

        {/* MAP PLACEHOLDER (react-native-maps unavailable in this build) */}
        <SectionLabel>Location</SectionLabel>
        <Card style={st.mapCard}>
          <View style={st.mapPlaceholder}>
            <Feather name="map" size={26} color={colors.textDim} />
            <Text style={st.mapHint}>Map preview unavailable</Text>
          </View>
          <Divider />
          {hasCoords ? (
            <View style={st.coordRow}>
              <Feather name="navigation" size={14} color={tint} />
              <Text style={st.coordText}>
                {venue.lat!.toFixed(5)}, {venue.lng!.toFixed(5)}
              </Text>
            </View>
          ) : (
            <Text style={st.coordText}>Coordinates not provided.</Text>
          )}
        </Card>

        {/* CONTACT */}
        {venue.contact ? (
          <>
            <SectionLabel>Contact</SectionLabel>
            <Card onPress={onContact} style={st.contactCard}>
              <Feather name="phone" size={18} color={tint} />
              <Text style={st.contactText} numberOfLines={2}>{venue.contact}</Text>
              <Feather name="chevron-right" size={20} color={colors.textDim} />
            </Card>
          </>
        ) : null}

        {/* BOOK / ENQUIRE */}
        <View style={st.cta}>
          {venue.booking_url ? (
            <Button title="Book / Enquire" icon="external-link" onPress={onBook} />
          ) : (
            <Button title="No booking link" icon="slash" variant="outline" disabled onPress={() => {}} />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={st.header}>
      <Feather
        name="chevron-left"
        size={26}
        color={colors.text}
        onPress={onBack}
        style={st.backBtn}
      />
      <Text style={st.headerTitle}>Venue</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  backBtn: { position: 'absolute', left: space.lg, zIndex: 1 },
  content: { paddingHorizontal: space.lg, paddingBottom: space.huge },

  hero: {
    height: 150, borderRadius: radius.lg, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginTop: space.sm,
  },
  heroBadge: { position: 'absolute', top: space.md, left: space.md },

  titleBlock: { marginTop: space.lg },
  name: { ...T.h1, fontSize: 26 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' },
  regionPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  regionText: { ...T.small, color: colors.textMuted, fontWeight: '700' },
  sponsoredNote: { ...T.small, color: colors.textDim, marginTop: space.sm },

  body: { ...T.body, lineHeight: 22 },

  mapCard: { padding: space.lg },
  mapPlaceholder: { height: 120, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  mapHint: { ...T.small, color: colors.textDim },
  coordRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  coordText: { ...T.small, color: colors.textMuted, fontWeight: '600' },

  contactCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  contactText: { ...T.body, flex: 1 },

  cta: { marginTop: space.xl },
});
