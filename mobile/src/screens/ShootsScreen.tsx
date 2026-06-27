import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, RefreshControl,
  ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';

import { colors, space, radius, type as T } from '../theme';
import { SectionLabel, EmptyState, Tag } from '../components/ui';
import { ListingCard } from '../components/cards';
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

type TypeFilter = 'all' | VenueType;
const TYPE_CHIPS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ground', label: 'Ground' },
  { key: 'simulated', label: 'Simulated' },
  { key: 'driven', label: 'Driven' },
  { key: 'hotel', label: 'Hotels' },
];

export default function ShootsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [region, setRegion] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.listVenues();
      setVenues(v);
    } catch {
      setVenues([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Regions present in the data (optional region filter)
  const regions = useMemo(() => {
    const set = new Set<string>();
    venues.forEach((v) => { if (v.region) set.add(v.region); });
    return Array.from(set).sort();
  }, [venues]);

  const featured = useMemo(() => venues.filter((v) => v.is_featured), [venues]);

  const filtered = useMemo(() => {
    return venues.filter((v) => {
      if (typeFilter !== 'all' && v.type !== typeFilter) return false;
      if (region && v.region !== region) return false;
      return true;
    });
  }, [venues, typeFilter, region]);

  const goVenue = useCallback((id: string) => nav.navigate('VenueDetail', { id }), [nav]);

  if (loading) {
    return (
      <SafeAreaView style={st.screen} edges={['top']}>
        <View style={st.header}><Text style={st.headerTitle}>Shoots</Text></View>
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={st.screen} edges={['top']}>
      <View style={st.header}><Text style={st.headerTitle}>Shoots</Text></View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={st.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />}
      >
        {venues.length === 0 ? (
          <EmptyState
            icon="map-pin"
            title="No venues yet"
            text="Shooting grounds, simulated days and driven estates will appear here."
          />
        ) : (
          <>
            {/* FEATURED RAIL — sponsored placement */}
            {featured.length > 0 ? (
              <>
                <SectionLabel>Featured</SectionLabel>
                <Text style={st.sponsoredNote}>Sponsored placements from partner venues.</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={st.rail}
                >
                  {featured.map((v) => (
                    <ListingCard key={v.id} venue={v} onPress={() => goVenue(v.id)} />
                  ))}
                </ScrollView>
              </>
            ) : null}

            {/* TYPE FILTER CHIPS */}
            <SectionLabel>Browse</SectionLabel>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={st.chipRow}
            >
              {TYPE_CHIPS.map((chip) => {
                const active = typeFilter === chip.key;
                return (
                  <Pressable
                    key={chip.key}
                    onPress={() => setTypeFilter(chip.key)}
                    style={[st.chip, active && st.chipActive]}
                  >
                    <Text style={[st.chipText, active && st.chipTextActive]}>{chip.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* OPTIONAL REGION FILTER */}
            {regions.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={st.chipRow}
              >
                <Pressable
                  onPress={() => setRegion(null)}
                  style={[st.regionChip, region === null && st.regionChipActive]}
                >
                  <Feather name="map-pin" size={12} color={region === null ? colors.bg : colors.textMuted} />
                  <Text style={[st.regionChipText, region === null && st.regionChipTextActive]}>All regions</Text>
                </Pressable>
                {regions.map((r) => {
                  const active = region === r;
                  return (
                    <Pressable
                      key={r}
                      onPress={() => setRegion(active ? null : r)}
                      style={[st.regionChip, active && st.regionChipActive]}
                    >
                      <Text style={[st.regionChipText, active && st.regionChipTextActive]}>{r}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            {/* RESULTS LIST */}
            {filtered.length === 0 ? (
              <EmptyState
                icon="filter"
                title="No venues match"
                text="Try a different type or region."
              />
            ) : (
              <View style={{ marginTop: space.sm }}>
                {filtered.map((v) => (
                  <VenueRow key={v.id} venue={v} onPress={() => goVenue(v.id)} />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function VenueRow({ venue, onPress }: { venue: Venue; onPress: () => void }) {
  const tint = VENUE_TINT[venue.type] || colors.primary;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.row, pressed && { opacity: 0.85 }]}>
      <View style={[st.rowIcon, { backgroundColor: tint + '1A' }]}>
        <Feather name={VENUE_ICON[venue.type]} size={20} color={tint} />
      </View>
      <View style={{ flex: 1, marginLeft: space.md }}>
        <View style={st.rowTitleLine}>
          <Text style={st.rowName} numberOfLines={1}>{venue.name}</Text>
          {venue.is_featured ? <Tag color={colors.amber} solid>Featured</Tag> : null}
        </View>
        <Text style={st.rowMeta} numberOfLines={1}>
          {VENUE_LABEL[venue.type]}{venue.region ? ` · ${venue.region}` : ''}
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.textDim} />
    </Pressable>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { ...T.label, fontSize: 13, color: colors.text },
  content: { paddingHorizontal: space.lg, paddingBottom: space.huge },

  sponsoredNote: { ...T.small, color: colors.textDim, marginTop: -space.sm, marginBottom: space.md },
  rail: { paddingRight: space.lg, paddingVertical: space.xs },

  chipRow: { gap: space.sm, paddingVertical: space.xs, paddingRight: space.lg },
  chip: {
    paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...T.label, fontSize: 12, color: colors.textMuted },
  chipTextActive: { color: colors.onPrimary },

  regionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill,
    backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border,
  },
  regionChipActive: { backgroundColor: colors.blue, borderColor: colors.blue },
  regionChipText: { ...T.small, color: colors.textMuted, fontWeight: '700' },
  regionChipTextActive: { color: colors.bg },

  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: space.lg, paddingVertical: space.md, marginBottom: space.sm,
  },
  rowIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowName: { ...T.h3, fontSize: 16, flexShrink: 1 },
  rowMeta: { ...T.small, marginTop: 3 },
});
