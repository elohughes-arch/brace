// ── Core data model (mirrors the Supabase schema) ──────────────────────────
export type Discipline = 'Sporting' | 'Trap' | 'Skeet' | 'Simulated' | 'Driven';
export type VenueType = 'ground' | 'simulated' | 'driven' | 'hotel';
export type ClipStatus = 'imported' | 'processing' | 'analysed' | 'failed';

export interface Profile {
  id: string;
  name: string | null;
  handle: string | null;
  avatar_url: string | null;
  age_verified: boolean;
  eyewear_confirmed: boolean;
  onboarded: boolean;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: string;
  shot_at: string;
  name: string;
  discipline: string;
  ground: string | null;
  venue_id: string | null;
  targets: number;     // shots fired
  hits: number;
  hit_rate: number;    // accuracy %
  best_run: number;
  score: number;
  status: string;
  video_path: string | null;
  metrics: Record<string, any>;
  notes: string | null;
}

export interface Clip {
  id: string;
  user_id: string;
  session_id: string | null;
  source: string;
  source_ref: string | null;
  video_path: string | null;
  status: ClipStatus;
  created_at: string;
}

export interface PerShot { t: number; hit: boolean; notes?: string }
export interface TechniqueScores { mount: number; swing: number; follow: number }

export interface AnalysisResult {
  id: string;
  clip_id: string;
  user_id: string;
  shots_fired: number;
  hits: number;
  accuracy: number;
  per_shot: PerShot[];
  technique_scores: TechniqueScores;
  processed_clip_url: string | null;
  created_at: string;
}

export interface ArchiveItem {
  id: string; user_id: string; clip_id: string | null; session_id: string | null;
  title: string | null; created_at: string;
}

export interface Group {
  id: string; owner_id: string; name: string; event_date: string | null;
  discipline: string | null; invite_code: string; created_at: string;
}
export interface GroupMembership { id: string; group_id: string; user_id: string; role: string; created_at: string }

export interface Community { id: string; slug: string; name: string; description: string | null; sort: number }

export interface Message {
  id: string; user_id: string; community_id: string | null; group_id: string | null;
  body: string; removed: boolean; created_at: string;
  author?: { name: string | null; avatar_url: string | null };
}

export interface Venue {
  id: string; name: string; type: VenueType; region: string | null; description: string | null;
  lat: number | null; lng: number | null; image_url: string | null; booking_url: string | null;
  contact: string | null; tier: number; is_featured: boolean;
}

export interface Subscription {
  id: string; user_id: string; plan: 'free' | 'member'; status: 'inactive' | 'active' | 'cancelled';
  store: string | null; store_ref: string | null; renews_at: string | null;
}

export interface LeaderboardEntry {
  user_id: string; name: string; accuracy: number; hits: number; shots: number; sessions: number;
}
