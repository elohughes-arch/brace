// ── Data services (thin wrappers over Supabase) ────────────────────────────
import { supabase } from './supabase';
import { analyzeClip } from './analysis';
import type {
  Profile, Session, Community, Message, Group, GroupMembership, Venue,
  ArchiveItem, Subscription, LeaderboardEntry, VenueType,
} from '../types';

// ---------- profile ----------
export async function getProfile(id: string): Promise<Profile | null> {
  const { data } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
  return data as Profile | null;
}
export async function updateProfile(id: string, patch: Partial<Profile>) {
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

// ---------- sessions / import + analyse ----------
export async function listSessions(): Promise<Session[]> {
  const { data } = await supabase.from('sessions').select('*').order('created_at', { ascending: false });
  return (data || []) as Session[];
}
export async function getSession(id: string): Promise<Session | null> {
  const { data } = await supabase.from('sessions').select('*').eq('id', id).maybeSingle();
  return data as Session | null;
}

/**
 * Import a clip (camera roll uri) and run it through analysis, producing a
 * session + clip + analysis_result. For the MVP the upload is skipped (the
 * local uri is stored as the reference); the analysis is mocked.
 */
export async function importAndAnalyse(userId: string, videoUri: string): Promise<Session> {
  // record the clip
  const { data: clip } = await supabase.from('clips')
    .insert({ user_id: userId, source: 'camera_roll', source_ref: videoUri, video_path: videoUri, status: 'processing' })
    .select().single();

  const a = await analyzeClip(videoUri);

  if (clip) {
    await supabase.from('clips').update({ status: 'analysed' }).eq('id', clip.id);
    await supabase.from('analysis_results').insert({
      clip_id: clip.id, user_id: userId,
      shots_fired: a.shotsFired, hits: a.hits, accuracy: a.accuracy,
      per_shot: a.perShot, technique_scores: a.techniqueScores, processed_clip_url: a.processedClipUrl,
    });
  }

  const { data: session, error } = await supabase.from('sessions').insert({
    user_id: userId, name: `${a.discipline} session`, discipline: a.discipline,
    targets: a.shotsFired, hits: a.hits, hit_rate: a.accuracy, best_run: a.bestRun,
    score: Math.round(a.accuracy * 0.6 + a.techniqueScores.mount * 0.25 + a.bestRun * 0.6),
    status: 'analysed', video_path: videoUri,
    metrics: { perShot: a.perShot, technique: a.techniqueScores },
  }).select().single();
  if (error) throw error;
  if (clip && session) await supabase.from('clips').update({ session_id: session.id }).eq('id', clip.id);
  return session as Session;
}

// ---------- archive ----------
export async function listArchive(): Promise<ArchiveItem[]> {
  const { data } = await supabase.from('archive_items').select('*').order('created_at', { ascending: false });
  return (data || []) as ArchiveItem[];
}
export async function addToArchive(userId: string, sessionId: string, title: string) {
  const { error } = await supabase.from('archive_items').insert({ user_id: userId, session_id: sessionId, title });
  if (error) throw error;
}

// ---------- groups ----------
export async function listMyGroups(): Promise<Group[]> {
  const { data } = await supabase.from('groups').select('*').order('created_at', { ascending: false });
  return (data || []) as Group[];
}
export async function createGroup(userId: string, name: string, eventDate: string | null, discipline: string | null): Promise<Group> {
  const { data, error } = await supabase.from('groups')
    .insert({ owner_id: userId, name, event_date: eventDate, discipline }).select().single();
  if (error) throw error;
  await supabase.from('group_memberships').insert({ group_id: data.id, user_id: userId, role: 'owner' });
  return data as Group;
}
export async function joinGroupByCode(userId: string, code: string): Promise<Group> {
  const { data: g, error } = await supabase.from('groups').select('*').eq('invite_code', code.trim().toLowerCase()).maybeSingle();
  if (error || !g) throw new Error('No group found for that code.');
  await supabase.from('group_memberships').insert({ group_id: g.id, user_id: userId, role: 'member' });
  return g as Group;
}
export async function getGroupMembers(groupId: string): Promise<GroupMembership[]> {
  const { data } = await supabase.from('group_memberships').select('*').eq('group_id', groupId);
  return (data || []) as GroupMembership[];
}
export async function groupLeaderboard(groupId: string): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc('group_leaderboard', { gid: groupId });
  if (error) return [];
  return (data || []) as LeaderboardEntry[];
}

// ---------- communities + messages ----------
export async function listCommunities(): Promise<Community[]> {
  const { data } = await supabase.from('communities').select('*').order('sort');
  return (data || []) as Community[];
}
export async function listMessages(opts: { communityId?: string; groupId?: string }): Promise<Message[]> {
  let q = supabase.from('messages').select('*, author:profiles(name, avatar_url)').order('created_at', { ascending: true }).limit(200);
  q = opts.communityId ? q.eq('community_id', opts.communityId) : q.eq('group_id', opts.groupId!);
  const { data } = await q;
  return (data || []) as Message[];
}
export async function sendMessage(userId: string, opts: { communityId?: string; groupId?: string }, body: string) {
  const { error } = await supabase.from('messages').insert({
    user_id: userId, community_id: opts.communityId || null, group_id: opts.groupId || null, body,
  });
  if (error) throw error;
}
export function subscribeMessages(opts: { communityId?: string; groupId?: string }, onInsert: () => void) {
  const filter = opts.communityId ? `community_id=eq.${opts.communityId}` : `group_id=eq.${opts.groupId}`;
  const ch = supabase.channel(`msgs:${filter}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, onInsert)
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}

// ---------- moderation ----------
export async function reportContent(userId: string, p: { messageId?: string; targetUserId?: string; reason: string }) {
  const { error } = await supabase.from('reports').insert({
    reporter_id: userId, message_id: p.messageId || null, target_user_id: p.targetUserId || null, reason: p.reason,
  });
  if (error) throw error;
}
export async function blockUser(userId: string, blockedUserId: string) {
  await supabase.from('blocks').insert({ user_id: userId, blocked_user_id: blockedUserId });
}
export async function listBlockedIds(): Promise<string[]> {
  const { data } = await supabase.from('blocks').select('blocked_user_id');
  return (data || []).map((b: any) => b.blocked_user_id);
}

// ---------- venues (Shoots) ----------
export async function listVenues(filter?: { type?: VenueType; region?: string }): Promise<Venue[]> {
  let q = supabase.from('venues').select('*').order('is_featured', { ascending: false }).order('tier', { ascending: false });
  if (filter?.type) q = q.eq('type', filter.type);
  if (filter?.region) q = q.eq('region', filter.region);
  const { data } = await q;
  return (data || []) as Venue[];
}

// ---------- subscription ----------
export async function getSubscription(userId: string): Promise<Subscription | null> {
  const { data } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
  return data as Subscription | null;
}
export async function setMembership(userId: string, active: boolean) {
  const { error } = await supabase.from('subscriptions').upsert(
    { user_id: userId, plan: active ? 'member' : 'free', status: active ? 'active' : 'cancelled', store: 'revenuecat' },
    { onConflict: 'user_id' });
  if (error) throw error;
}

// ---------- account data controls (GDPR) ----------
export async function exportMyData(userId: string) {
  const [sessions, archive, groups] = await Promise.all([listSessions(), listArchive(), listMyGroups()]);
  return { exportedAt: new Date().toISOString(), userId, sessions, archive, groups };
}
export async function deleteMyData(userId: string) {
  // sessions/clips/analysis/archive cascade off the user; remove the visible rows
  await supabase.from('sessions').delete().eq('user_id', userId);
  await supabase.from('archive_items').delete().eq('user_id', userId);
}
