export type MusicSource = 'wy' | 'qq' | 'kg';

export type QualityLevel =
  | 'auto'
  | 'standard'
  | 'higher'
  | 'exhigh'
  | 'lossless'
  | 'hires'
  | 'jyeffect'
  | 'sky'
  | 'jymaster';

export type PlayMode = 'sequence' | 'random' | 'single';

export interface QualityOption {
  level: QualityLevel;
  group: '智能推荐' | '常规音质' | '特色音质';
  name: string;
  format: string;
  spec: string;
  hint: string;
  mobileHint?: string;
}

export interface Track {
  id: string | number;
  name: string;
  artist: string;
  album: string;
  cover: string;
  source?: string;
}

export interface SongPlaybackData {
  id: string | number;
  url: string;
  streamExpiresAt?: number | null;
  name: string;
  artist: string;
  album?: string;
  cover: string;
  source: string;
  requestedLevel: QualityLevel | null;
  level: string | null;
  br: number | null;
  qualityText?: string;
}

export interface LyricWord {
  startTime: number; // seconds
  duration: number;  // seconds
  text: string;
}

export interface LyricLine {
  time: number;
  duration?: number;
  text: string;
  translation: string | null;
  romaji?: string | null;
  words?: LyricWord[];
}

export interface LyricPayload {
  lrc: string;
  tlrc: string;
  romalrc?: string;
  yrc?: string;
  ytlrc?: string;
  yromalrc?: string;
}

export type SyncState = 'local' | 'dirty' | 'cloud' | 'public';

export interface SyncTrack {
  id: string | number;
  name: string;
  artists: string;
  album: string;
  picUrl: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  source: string;
  sourceId: string | null;
  version: number;
  trackCount: number;
  updatedAt: number;
  syncState: SyncState;
  dirty: boolean;
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: SyncTrack[];
  createdAt: number;
}

export interface PlaybackStateRecord {
  kind: 'cloud' | 'public' | 'netease';
  playlistId: string | null;
  sourceId: string | null;
  trackIndex: number;
  trackId: string | null;
  updatedAt: number;
}

export interface AuthUser {
  id?: string | number;
  username: string;
}

export type SyncStatusType = 'idle' | 'syncing' | 'synced' | 'offline' | 'conflict';

export const SOURCE_META: Record<MusicSource, { label: string; name: string }> = {
  wy: { label: 'WY', name: '网易云' },
  qq: { label: 'QQ', name: 'QQ 音乐' },
  kg: { label: 'KG', name: '酷狗' },
};

export const QUALITY_OPTIONS: QualityOption[] = [
  {
    level: 'auto',
    group: '智能推荐',
    name: '智能推荐',
    format: '自动',
    spec: '移动端无损 / 桌面端超清母带',
    hint: '按设备自动选择推荐音质',
  },
  {
    level: 'standard',
    group: '常规音质',
    name: '标准',
    format: 'MP3',
    spec: '128 kbps',
    hint: '流量最低，兼容性最好',
  },
  {
    level: 'higher',
    group: '常规音质',
    name: '较高',
    format: 'MP3',
    spec: '192 kbps',
    hint: '流量较低，兼容性好',
  },
  {
    level: 'exhigh',
    group: '常规音质',
    name: '极高',
    format: 'MP3',
    spec: '320 kbps',
    hint: '较高流量，兼容性好',
  },
  {
    level: 'lossless',
    group: '常规音质',
    name: '无损',
    format: 'FLAC',
    spec: '最高约 48 kHz / 16 bit',
    hint: '高流量，移动端推荐',
  },
  {
    level: 'hires',
    group: '常规音质',
    name: 'Hi-Res',
    format: 'FLAC',
    spec: '最高 192 kHz / 24 bit',
    hint: '超高流量，需设备支持',
  },
  {
    level: 'jyeffect',
    group: '特色音质',
    name: '高清臻音',
    format: '双声道',
    spec: '96 kHz / 24 bit',
    hint: '高流量；效果取决于播放设备',
  },
  {
    level: 'sky',
    group: '特色音质',
    name: '沉浸环绕声',
    format: '5.1 声道',
    spec: '多声道沉浸音频',
    hint: '由播放设备决定输出或下混',
  },
  {
    level: 'jymaster',
    group: '特色音质',
    name: '超清母带',
    format: '双声道',
    spec: '192 kHz / 24 bit',
    hint: '超高流量，需高解析设备支持',
  },
];

export function songSourceOf(id: string | number | null | undefined): MusicSource {
  const s = String(id ?? '');
  if (s.startsWith('qq:')) return 'qq';
  if (s.startsWith('kg:')) return 'kg';
  return 'wy';
}

export function stripSourcePrefix(id: string | number | null | undefined): string {
  return String(id ?? '').replace(/^(qq|kg):/, '');
}
