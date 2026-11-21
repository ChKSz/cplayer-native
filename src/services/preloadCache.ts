import { resolveQualityLevel } from './musicApi';
import type { QualityLevel, SongPlaybackData } from '../types/music';

const HIGH_BITRATE_LEVELS = new Set<string>([
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
]);

/**
 * Resolves the effective API quality level after applying optional mobile-network
 * bandwidth protection (clamps FLAC/Hi-Res/Master down to 320k `exhigh` on metered cellular).
 */
export function resolveEffectiveQuality(
  preferred: QualityLevel,
  isMeteredNetwork: boolean,
  mobileQualityLimit: boolean,
): Exclude<QualityLevel, 'auto'> {
  const resolved = resolveQualityLevel(preferred);
  if (isMeteredNetwork && mobileQualityLimit && HIGH_BITRATE_LEVELS.has(resolved)) {
    return 'exhigh';
  }
  return resolved;
}

/**
 * Generates a stable ExoPlayer SimpleCache key independent of dynamic CDN auth tokens.
 */
export function buildAudioCacheKey(
  trackId: string | number,
  qualityOrSource: string | null | undefined,
): string {
  const cleanId = String(trackId).trim();
  const cleanQ = String(qualityOrSource || 'default').trim().toLowerCase();
  return `cplayer:track:${cleanId}:${cleanQ}`;
}

interface PreloadEntry {
  data: SongPlaybackData;
  fetchedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
const EXPIRY_SAFETY_MARGIN_MS = 20_000; // avoid handing out a URL about to expire
const MAX_ENTRIES = 24;

/**
 * In-memory cache of pre-resolved track playback URLs.
 * Allows instant gapless switching and pushing pre-resolved next tracks into ExoPlayer.
 */
export class PreloadCache {
  private entries = new Map<string, PreloadEntry>();
  private inflight = new Map<string, Promise<SongPlaybackData>>();
  private clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  private keyOf(id: string | number, qualityKey: string): string {
    return `${String(id)}::${qualityKey}`;
  }

  public getValid(id: string | number, qualityKey: string): SongPlaybackData | null {
    const key = this.keyOf(id, qualityKey);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return entry.data;
  }

  public set(id: string | number, qualityKey: string, data: SongPlaybackData): void {
    const now = this.clock();
    const defaultExpiry = now + DEFAULT_TTL_MS;
    const streamExpiry =
      typeof data.streamExpiresAt === 'number' && Number.isFinite(data.streamExpiresAt)
        ? data.streamExpiresAt - EXPIRY_SAFETY_MARGIN_MS
        : defaultExpiry;
    const expiresAt = Math.min(defaultExpiry, streamExpiry);
    if (expiresAt <= now) return;

    const key = this.keyOf(id, qualityKey);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { data, fetchedAt: now, expiresAt });
  }

  public async getOrFetch(
    id: string | number,
    qualityKey: string,
    fetcher: () => Promise<SongPlaybackData>,
  ): Promise<SongPlaybackData> {
    const cached = this.getValid(id, qualityKey);
    if (cached) return cached;

    const key = this.keyOf(id, qualityKey);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = fetcher()
      .then((data) => {
        this.set(id, qualityKey, data);
        return data;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, promise);
    return promise;
  }

  public invalidate(id?: string | number): void {
    if (id === undefined) {
      this.entries.clear();
      return;
    }
    const prefix = `${String(id)}::`;
    for (const k of Array.from(this.entries.keys())) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  public size(): number {
    return this.entries.size;
  }
}
