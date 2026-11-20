import { PlayerAuth } from './playerAuth';
import {
  QUALITY_OPTIONS,
  songSourceOf,
  stripSourcePrefix,
  type LyricPayload,
  type MusicSource,
  type QualityLevel,
  type SongPlaybackData,
  type Track,
} from '../types/music';

export const API_BASE_DEFAULT = 'https://api.chksz.com/api';

const QUALITY_LEVELS = new Set<string>(QUALITY_OPTIONS.map((o) => o.level));
const API_QUALITY_LEVELS = new Set<string>(
  QUALITY_OPTIONS.filter((o) => o.level !== 'auto').map((o) => o.level),
);

export function resolveQualityLevel(level: QualityLevel): Exclude<QualityLevel, 'auto'> {
  if (level !== 'auto' && API_QUALITY_LEVELS.has(level)) {
    return level as Exclude<QualityLevel, 'auto'>;
  }
  // Native Android APK defaults `auto` to lossless FLAC
  return 'lossless';
}

export class MusicService {
  public auth: PlayerAuth;
  public baseUrl: string;
  public quality: QualityLevel;
  private sourceLyricCache = new Map<string, string>();

  constructor(auth?: PlayerAuth) {
    this.auth = auth || new PlayerAuth();
    this.baseUrl = (localStorage.getItem('cp_api_base') || API_BASE_DEFAULT).replace(/\/$/, '');
    const savedQ = localStorage.getItem('cp_quality');
    this.quality = savedQ && QUALITY_LEVELS.has(savedQ) ? (savedQ as QualityLevel) : 'auto';
  }

  public setBaseUrl(url: string): void {
    const clean = (url || API_BASE_DEFAULT).trim().replace(/\/$/, '');
    this.baseUrl = clean;
    localStorage.setItem('cp_api_base', clean);
  }

  public setQuality(q: QualityLevel): void {
    if (!QUALITY_LEVELS.has(q)) return;
    this.quality = q;
    localStorage.setItem('cp_quality', q);
  }

  public apiUrl(path: string, params: Record<string, string | number | undefined | null> = {}): string {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
    }
    const qs = usp.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private cacheSourceLyric(id: string | number, lrc: string | undefined | null): void {
    if (!lrc) return;
    if (this.sourceLyricCache.size > 50) {
      const oldest = this.sourceLyricCache.keys().next().value;
      if (oldest !== undefined) this.sourceLyricCache.delete(oldest);
    }
    this.sourceLyricCache.set(String(id), lrc);
  }

  public async searchBySource(source: MusicSource, query: string, signal?: AbortSignal): Promise<Track[]> {
    if (source === 'qq') return this.searchQQ(query, signal);
    if (source === 'kg') return this.searchKG(query, signal);
    return this.searchWY(query, signal);
  }

  public async searchWY(query: string, signal?: AbortSignal): Promise<Track[]> {
    const url = this.apiUrl('/163_search', { keyword: query, limit: 30 });
    const res = await this.auth.fetch(url, { signal });
    const json = await res.json();
    let items: Record<string, unknown>[] = [];
    if (json.code === 200) {
      if (Array.isArray(json.data)) items = json.data;
      else if (json.data && Array.isArray(json.data.songs)) items = json.data.songs;
      else if (json.result && Array.isArray(json.result.songs)) items = json.result.songs;
    }
    return items.map((item) => {
      const artists = item.artists as string | { name?: string } | { name?: string }[] | undefined;
      const artist = Array.isArray(artists)
        ? artists.map((a) => a.name || '').filter(Boolean).join(', ')
        : typeof artists === 'string'
          ? artists
          : artists?.name || '未知歌手';
      const albumObj = item.album as string | { name?: string; picUrl?: string } | undefined;
      const album = typeof albumObj === 'string' ? albumObj : albumObj?.name || '';
      const cover = String(item.picUrl || (typeof albumObj === 'object' ? albumObj?.picUrl : '') || '').replace(
        /^http:/,
        'https:',
      );
      return {
        id: item.id as string | number,
        name: String(item.name || '未知歌曲'),
        artist,
        album,
        cover,
        source: 'ChKSz',
      };
    });
  }

  public async searchQQ(query: string, signal?: AbortSignal): Promise<Track[]> {
    const url = this.apiUrl('/qq_music', { msg: query, num: 30 });
    const res = await this.auth.fetch(url, { signal });
    const json = await res.json();
    const list: Record<string, unknown>[] = Array.isArray(json.list) ? json.list : [];
    return list.map((item) => ({
      id: `qq:${item.id}`,
      name: String(item.name || '未知歌曲'),
      artist: String(item.artists || '未知歌手'),
      album: '',
      cover: String(item.cover || '').replace(/^http:/, 'https:'),
      source: 'QQ Music',
    }));
  }

  public async searchKG(query: string, signal?: AbortSignal): Promise<Track[]> {
    const url = this.apiUrl('/kugou_music', { msg: query });
    const res = await this.auth.fetch(url, { signal });
    const json = await res.json();
    const list: Record<string, unknown>[] =
      json.code === 200 && Array.isArray(json.list) ? json.list : [];
    return list.map((item) => ({
      id: `kg:${item.id}`,
      name: String(item.SongName || '未知歌曲'),
      artist: String(item.SingerName || '未知歌手'),
      album: String(item.AlbumName || ''),
      cover: String(item.Image || '').replace(/^http:/, 'https:'),
      source: 'KuGou',
    }));
  }

  public async getSong(
    id: string | number,
    requestedLevel?: QualityLevel,
    signal?: AbortSignal,
  ): Promise<SongPlaybackData> {
    const source = songSourceOf(id);
    if (source === 'qq') return this.getSongQQ(id, signal);
    if (source === 'kg') return this.getSongKG(id, signal);

    const level = resolveQualityLevel(requestedLevel || this.quality);
    const url = this.apiUrl('/163_music', { id, level });
    const res = await this.auth.fetch(url, { signal });
    const json = await res.json();
    if (json.code === 200 && json.data) {
      const d = Array.isArray(json.data) ? json.data[0] : json.data;
      if (d?.url) {
        return {
          id: d.id ?? id,
          url: String(d.url).replace(/^http:/, 'https:'),
          name: String(d.name || '未知歌曲'),
          artist: String(d.artist || '未知歌手'),
          cover: String(d.picUrl || '').replace(/^http:/, 'https:'),
          source: 'ChKSz',
          requestedLevel: level,
          level: d.level || null,
          br: d.br || d.bitrate || null,
        };
      }
    }
    throw new Error('获取网易云音源失败');
  }

  private async getSongQQ(id: string | number, signal?: AbortSignal): Promise<SongPlaybackData> {
    const mid = stripSourcePrefix(id);
    const url = this.apiUrl('/qq_music', { mid });
    const res = await this.auth.fetch(url, { signal });
    const d = await res.json();
    if (!d?.url) throw new Error('获取 QQ 音源失败');
    this.cacheSourceLyric(id, d.lyric?.text);
    const artist = Array.isArray(d.artists)
      ? d.artists.map((a: { name?: string }) => a.name).filter(Boolean).join(', ')
      : String(d.artists || '未知歌手');
    const cover = d.cover ? d.cover.large || d.cover.medium || d.cover.small || '' : '';
    const tag = (String(d.url).match(/\/(F000|M800|M500|C600|C400|C200)/) || [])[1] || '';
    const qualityText =
      tag === 'F000'
        ? '无损 FLAC'
        : tag === 'M800'
          ? 'HQ 320K'
          : tag === 'C600'
            ? '192K'
            : tag === 'C400' || tag === 'C200'
              ? '128K M4A'
              : 'QQ 音源';

    return {
      id: `qq:${d.id || mid}`,
      url: String(d.url).replace(/^http:/, 'https:'),
      name: String(d.name || '未知歌曲'),
      artist,
      album: d.album?.name || '',
      cover: String(cover).replace(/^http:/, 'https:'),
      source: 'QQ Music',
      requestedLevel: null,
      level: null,
      br: null,
      qualityText,
    };
  }

  /**
   * KuGou strictly prefers server-returned signed `d.streamUrl` + `d.streamExpiresAt`.
   * Do NOT concatenate unsigned `/kg_stream` relay URLs.
   */
  private async getSongKG(id: string | number, signal?: AbortSignal): Promise<SongPlaybackData> {
    const songId = stripSourcePrefix(id);
    const url = this.apiUrl('/kugou_music', { id: songId });
    const res = await this.auth.fetch(url, { signal });
    const json = await res.json();
    const d = json.code === 200 && json.data ? json.data : null;
    if (!d || (!d.streamUrl && !d.url)) throw new Error('获取酷狗音源失败');
    this.cacheSourceLyric(id, d.lyrics);
    const br = Number(d.bitRate) || 0;
    const ext = String(d.extName || '').toUpperCase();
    const qualityText =
      ext === 'FLAC' || br >= 900000
        ? `无损${ext ? ` ${ext}` : ''}`
        : br >= 320000
          ? `HQ ${Math.round(br / 1000)}K`
          : br > 0
            ? `${Math.round(br / 1000)}K`
            : '酷狗音源';

    const playUrl = d.streamUrl
      ? String(d.streamUrl)
      : String(d.url).replace(/^http:/, 'https:');

    return {
      id: `kg:${songId}`,
      url: playUrl,
      streamExpiresAt: d.streamExpiresAt || null,
      name: String(d.songName || '未知歌曲'),
      artist: String(d.singerName || '未知歌手'),
      album: '',
      cover: String(d.albumImage || '').replace(/^http:/, 'https:'),
      source: 'KuGou',
      requestedLevel: null,
      level: null,
      br: d.bitRate || null,
      qualityText,
    };
  }

  public async getLyric(id: string | number): Promise<LyricPayload | null> {
    const source = songSourceOf(id);
    if (source === 'qq' || source === 'kg') {
      const key = String(id);
      if (this.sourceLyricCache.has(key)) {
        const cached = this.sourceLyricCache.get(key);
        return cached ? { lrc: cached, tlrc: '' } : null;
      }
      try {
        await this.getSong(id);
        const lrc = this.sourceLyricCache.get(key);
        return lrc ? { lrc, tlrc: '' } : null;
      } catch {
        return null;
      }
    }

    const url = this.apiUrl('/163_lyric', { id });
    try {
      const res = await this.auth.fetch(url);
      const json = await res.json();
      if (json.code === 200 && json.data) {
        return {
          lrc: json.data.lrc || '',
          tlrc: json.data.tlyric || '',
          romalrc: json.data.romalrc || '',
          yrc: json.data.yrc || '',
          ytlrc: json.data.ytlrc || '',
          yromalrc: json.data.yromalrc || '',
        };
      }
    } catch {
      // Ignore lyric fetch failure
    }
    return null;
  }

  public async fetchNeteasePlaylist(listId: string): Promise<{ name: string; tracks: Track[] }> {
    const url = this.apiUrl('/163_playlist', { id: listId });
    const res = await this.auth.fetch(url);
    const json = await res.json();
    let rawTracks: Record<string, unknown>[] = [];
    let name = `网易云歌单 #${listId}`;

    if (json.data && Array.isArray(json.data.tracks)) {
      rawTracks = json.data.tracks;
      if (json.data.name) name = String(json.data.name);
    } else if (Array.isArray(json.data)) {
      rawTracks = json.data;
    } else if (json.playlist && Array.isArray(json.playlist.tracks)) {
      rawTracks = json.playlist.tracks;
      if (json.playlist.name) name = String(json.playlist.name);
    }

    const tracks: Track[] = rawTracks.map((item) => {
      const artists = item.artists as string | { name?: string }[] | undefined;
      const ar = item.ar as { name?: string }[] | undefined;
      const artist = artists
        ? typeof artists === 'string'
          ? artists
          : Array.isArray(artists)
            ? artists.map((a) => a.name).filter(Boolean).join(' / ')
            : '未知歌手'
        : ar
          ? ar.map((a) => a.name).filter(Boolean).join(' / ')
          : '未知歌手';

      const al = item.al as { name?: string; picUrl?: string } | undefined;
      const album = typeof item.album === 'string' ? item.album : al?.name || '';
      const cover = String(item.picUrl || al?.picUrl || '').replace(/^http:/, 'https:');
      return {
        id: item.id as string | number,
        name: String(item.name || '未知歌曲'),
        artist,
        album,
        cover,
        source: 'NetEase',
      };
    });

    return { name, tracks };
  }
}
