import { query } from '../db/index.js';
import { normalizeProfile, voiceBrief, type VoiceProfile } from './profile.js';

export interface ProfileRow {
  profile: VoiceProfile;
  post_count: number;
  enabled: boolean;
  updated_at: Date | string;
}

export async function loadProfile(userId: string): Promise<ProfileRow | null> {
  const [row] = await query<ProfileRow>(`SELECT profile, post_count, enabled, updated_at FROM voice_profiles WHERE user_id = $1`, [userId]);
  return row ?? null;
}

/**
 * The style brief for this user's generation, or null when Write Like Me is off,
 * not set up, or can't be loaded. Never throws: voice must not break generation.
 */
export async function voiceForGeneration(userId: string): Promise<string | null> {
  try {
    const row = await loadProfile(userId);
    if (!row?.enabled) return null;
    return voiceBrief(normalizeProfile(row.profile, row.profile.stats));
  } catch (err) {
    console.error('[IdeaBird] Could not load voice profile; generating without it.', (err as Error)?.message);
    return null;
  }
}
