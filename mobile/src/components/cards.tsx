import React from 'react';
import { View, Text, StyleSheet, Pressable, Image } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, space, radius, type as T } from '../theme';
import { Tag, Avatar } from './ui';
import type { Venue, Message, LeaderboardEntry } from '../types';

const VENUE_LABEL: Record<string, string> = { ground: 'Shooting Ground', simulated: 'Simulated Game', driven: 'Driven Game', hotel: 'Shooting Hotel' };
const VENUE_TINT: Record<string, string> = { ground: colors.primary, simulated: colors.blue, driven: colors.orange, hotel: colors.amber };

// ── Listing card (venues / forums) — image or gradient + badge + title + meta ─
export function ListingCard({ venue, onPress }: { venue: Venue; onPress?: () => void }) {
  const tint = VENUE_TINT[venue.type] || colors.primary;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [c.listing, pressed && { opacity: 0.9 }]}>
      <View style={[c.listingMedia, { backgroundColor: tint + '22' }]}>
        <Feather name={venue.type === 'hotel' ? 'home' : 'target'} size={26} color={tint} />
        {venue.is_featured ? <View style={c.featured}><Tag color={colors.amber} solid>Featured</Tag></View> : null}
      </View>
      <View style={{ padding: space.lg }}>
        <Text style={c.listingTitle} numberOfLines={1}>{venue.name}</Text>
        <Text style={c.listingMeta} numberOfLines={1}>{VENUE_LABEL[venue.type]} · {venue.region || 'UK'}</Text>
      </View>
    </Pressable>
  );
}

// ── Leaderboard row ────────────────────────────────────────────────────────
export function LeaderboardRow({ rank, entry, metric }: { rank: number; entry: LeaderboardEntry; metric: 'accuracy' | 'hits' | 'shots' }) {
  const val = metric === 'accuracy' ? `${Math.round(entry.accuracy)}%` : metric === 'hits' ? `${entry.hits}` : `${entry.shots}`;
  return (
    <View style={c.lbRow}>
      <Text style={[c.rank, rank <= 3 && { color: colors.primary }]}>{rank}</Text>
      <Avatar name={entry.name} size={36} color={rank === 1 ? colors.amber : colors.primary} />
      <View style={{ flex: 1, marginLeft: space.md }}>
        <Text style={c.lbName}>{entry.name}</Text>
        <Text style={c.lbSub}>{entry.sessions} session{entry.sessions === 1 ? '' : 's'}</Text>
      </View>
      <Text style={c.lbVal}>{val}</Text>
    </View>
  );
}

// ── Chat bubble (with moderation actions) ──────────────────────────────────
export function ChatBubble({ message, mine, onReport, onBlock }: {
  message: Message; mine: boolean; onReport?: () => void; onBlock?: () => void;
}) {
  return (
    <Pressable onLongPress={mine ? undefined : onReport} style={[c.bubbleRow, mine && { justifyContent: 'flex-end' }]}>
      {!mine ? <Avatar name={message.author?.name || 'Gun'} size={30} /> : null}
      <View style={[c.bubble, mine ? c.bubbleMine : c.bubbleOther]}>
        {!mine ? <Text style={c.bubbleName}>{message.author?.name || 'Gun'}</Text> : null}
        <Text style={c.bubbleBody}>{message.body}</Text>
        {!mine && (onReport || onBlock) ? (
          <View style={c.modRow}>
            {onReport ? <Pressable onPress={onReport} hitSlop={6}><Text style={c.modAction}>Report</Text></Pressable> : null}
            {onBlock ? <Pressable onPress={onBlock} hitSlop={6}><Text style={c.modAction}>Block</Text></Pressable> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const c = StyleSheet.create({
  listing: { width: 230, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginRight: space.md },
  listingMedia: { height: 110, alignItems: 'center', justifyContent: 'center' },
  featured: { position: 'absolute', top: space.md, left: space.md },
  listingTitle: { ...T.h3, fontSize: 16 },
  listingMeta: { ...T.small, marginTop: 3 },
  lbRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  rank: { width: 26, textAlign: 'center', color: colors.textMuted, fontWeight: '800', fontSize: 15 },
  lbName: { color: colors.text, fontWeight: '700', fontSize: 15 },
  lbSub: { ...T.small, marginTop: 1 },
  lbVal: { color: colors.text, fontWeight: '800', fontSize: 18 },
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: space.md },
  bubble: { maxWidth: '78%', borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  bubbleOther: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  bubbleMine: { backgroundColor: colors.primary },
  bubbleName: { ...T.label, fontSize: 10, color: colors.primary, marginBottom: 3 },
  bubbleBody: { color: colors.text, fontSize: 15 },
  modRow: { flexDirection: 'row', gap: space.md, marginTop: 6 },
  modAction: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
});
