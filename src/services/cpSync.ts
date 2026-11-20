import { nativeFetch } from './transport';
import type {
  AuthUser,
  PlaybackStateRecord,
  PlaylistDetail,
  PlaylistSummary,
  SyncStatusType,
  SyncTrack,
  Track,
} from '../types/music';

const DEFAULT_BASE_URL = 'https://sync.chksz.top/api/v1';
const TOKEN_KEY = 'cp_sync_token';
const MIRROR_KEY = 'cp_sync_mirror';

export interface SyncMirror {
  playlists: PlaylistSummary[];
  detail: Record<string, PlaylistDetail>;
  playbackState: PlaybackStateRecord | null;
}

export interface SyncError extends Error {
  status?: number;
  payload?: unknown;
}

export interface ConflictContext {
  local: PlaylistDetail;
  remote: PlaylistDetail;
}

export type ConflictResolution =
  | 'remote'
  | { name?: string; tracks?: SyncTrack[] }
  | null
  | undefined;

function now(): number {
  return Date.now();
}

export function shortId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function validShortId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{6}$/.test(id);
}

function cleanName(value: unknown, fallback = '未命名歌单'): string {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 60) : fallback;
}

export class CPSync extends EventTarget {
  public baseUrl: string;
  public token: string;
  public user: AuthUser | null = null;
  public status: SyncStatusType = 'idle';
  public mirror: SyncMirror;
  private playbackSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { baseUrl?: string } = {}) {
    super();
    this.baseUrl = (
      options.baseUrl ||
      localStorage.getItem('cp_sync_api') ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.token = localStorage.getItem(TOKEN_KEY) || '';
    this.mirror = this.loadMirror();
  }

  public setBaseUrl(url: string): void {
    const clean = (url || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
    this.baseUrl = clean;
    localStorage.setItem('cp_sync_api', clean);
  }

  private loadMirror(): SyncMirror {
    try {
      const data = JSON.parse(localStorage.getItem(MIRROR_KEY) || '{}');
      const playlists: PlaylistSummary[] = (Array.isArray(data.playlists) ? data.playlists : []).filter(
        (p: PlaylistSummary) => validShortId(p?.id),
      );
      const detail: Record<string, PlaylistDetail> = {};
      if (data.detail && typeof data.detail === 'object') {
        for (const [id, value] of Object.entries(data.detail)) {
          if (validShortId(id)) detail[id] = value as PlaylistDetail;
        }
      }
      return {
        playlists,
        detail,
        playbackState: this.normalizePlaybackState(data.playbackState),
      };
    } catch {
      return { playlists: [], detail: {}, playbackState: null };
    }
  }

  private saveMirror(): void {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(this.mirror));
    this.emit('mirror', this.mirror);
  }

  private setStatus(status: SyncStatusType, detail?: unknown): void {
    this.status = status;
    this.emit('status', { status, detail });
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    options: Omit<RequestInit, 'body'> & { body?: unknown } = {},
  ): Promise<T> {
    const jsonBody = options.body !== undefined && typeof options.body !== 'string';
    const init: RequestInit = {
      ...options,
      headers: {
        ...this.headers(jsonBody),
        ...((options.headers as Record<string, string>) || {}),
      },
      body: jsonBody ? JSON.stringify(options.body) : (options.body as string | undefined),
    };

    try {
      const res = await nativeFetch(`${this.baseUrl}${path}`, init);
      let payload: { ok?: boolean; error?: string; data?: T } | null = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (!res.ok || !payload || payload.ok === false) {
        const err: SyncError = new Error(payload?.error || `请求失败 (${res.status})`);
        err.status = res.status;
        err.payload = payload;
        throw err;
      }
      return payload.data as T;
    } catch (e) {
      const err = e as SyncError;
      if (!err.status) {
        this.setStatus('offline', err);
        const netErr: SyncError = new Error('无法连接同步服务，请检查网络或稍后重试');
        throw netErr;
      }
      throw err;
    }
  }

  public async register(username: string, password: string, inviteCode?: string) {
    this.setStatus('syncing');
    const data = await this.request<{ token: string; user: AuthUser }>('/auth/register', {
      method: 'POST',
      body: { username, password, inviteCode: inviteCode || '' },
    });
    this.applySession(data);
    await this.refreshAll();
    return data;
  }

  public async login(username: string, password: string) {
    this.setStatus('syncing');
    const data = await this.request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    this.applySession(data);
    await this.refreshAll();
    return data;
  }

  public async logout(): Promise<void> {
    try {
      if (this.token) await this.request('/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network errors on logout
    }
    if (this.playbackSyncTimer) clearTimeout(this.playbackSyncTimer);
    this.playbackSyncTimer = null;
    this.token = '';
    this.user = null;
    this.mirror.playbackState = null;
    this.saveMirror();
    localStorage.removeItem(TOKEN_KEY);
    this.setStatus('idle');
    this.emit('auth', { user: null });
  }

  private applySession(data: { token: string; user: AuthUser }): void {
    this.token = data.token;
    this.user = data.user;
    localStorage.setItem(TOKEN_KEY, this.token);
    this.emit('auth', { user: this.user });
  }

  public async restoreSession(): Promise<AuthUser | null> {
    if (!this.token) return null;
    try {
      const data = await this.request<{ user: AuthUser }>('/auth/me', { method: 'GET' });
      this.user = data.user;
      this.emit('auth', { user: this.user });
      await this.refreshAll();
      return this.user;
    } catch (e) {
      if ((e as SyncError).status === 401) await this.logout();
      return null;
    }
  }

  public isLoggedIn(): boolean {
    return Boolean(this.token && this.user);
  }

  public async refreshAll(): Promise<PlaylistSummary[]> {
    if (!this.token) return this.mirror.playlists;
    this.setStatus('syncing');
    const data = await this.request<{ playlists?: PlaylistSummary[] }>('/playlists', { method: 'GET' });
    const remote = (data.playlists || []).map((p) =>
      this.normalizePlaylistSummary({ ...p, syncState: 'cloud' }),
    );
    const localOnly = this.mirror.playlists.filter(
      (p) => p.syncState === 'local' || p.syncState === 'dirty',
    );
    this.mirror.playlists = [
      ...localOnly,
      ...remote.filter((r) => !localOnly.some((l) => String(l.id) === String(r.id))),
    ];
    await this.refreshPlaybackState();
    this.saveMirror();
    this.setStatus('synced');
    return this.mirror.playlists;
  }

  public async refreshPlaybackState(): Promise<PlaybackStateRecord | null> {
    if (!this.token) return this.mirror.playbackState || null;
    try {
      const data = await this.request<{ playbackState?: PlaybackStateRecord }>('/playback-state', {
        method: 'GET',
      });
      const remote = this.normalizePlaybackState(data.playbackState);
      const local = this.mirror.playbackState;
      if (remote && (!local || remote.updatedAt >= local.updatedAt)) {
        this.mirror.playbackState = remote;
        this.emit('playback', { state: remote, origin: 'remote' });
      }
      return this.mirror.playbackState || null;
    } catch (error) {
      const status = (error as SyncError).status;
      if (status === 404 || status === 405) return this.mirror.playbackState || null;
      throw error;
    }
  }

  public setPlaybackState(
    state: Partial<PlaybackStateRecord>,
    { remote = true }: { remote?: boolean } = {},
  ): PlaybackStateRecord | null {
    const normalized = this.normalizePlaybackState(state);
    if (!normalized) return null;
    this.mirror.playbackState = normalized;
    this.saveMirror();
    this.emit('playback', { state: normalized, origin: 'local' });
    if (remote && this.isLoggedIn()) this.queuePlaybackStateSync();
    return normalized;
  }

  private queuePlaybackStateSync(): void {
    if (this.playbackSyncTimer) clearTimeout(this.playbackSyncTimer);
    this.playbackSyncTimer = setTimeout(() => {
      this.playbackSyncTimer = null;
      this.flushPlaybackState().catch(() => {});
    }, 600);
  }

  public async flushPlaybackState(): Promise<PlaybackStateRecord | null> {
    const state = this.normalizePlaybackState(this.mirror.playbackState);
    if (!state || !this.isLoggedIn()) return state;
    const submittedAt = state.updatedAt;
    this.setStatus('syncing');
    try {
      const data = await this.request<{ playbackState?: PlaybackStateRecord }>('/playback-state', {
        method: 'PUT',
        body: state,
      });
      const remote = this.normalizePlaybackState(data.playbackState);
      if (remote && (this.mirror.playbackState?.updatedAt || 0) <= submittedAt) {
        this.mirror.playbackState = remote;
        this.saveMirror();
      }
      this.setStatus('synced');
      return remote || state;
    } catch (error) {
      const status = (error as SyncError).status;
      if (status === 404 || status === 405) {
        this.setStatus('synced');
        return state;
      }
      if (this.status !== 'offline') this.setStatus('conflict', error);
      throw error;
    }
  }

  public async fetchRemotePlaylist(id: string): Promise<PlaylistDetail> {
    this.setStatus('syncing');
    const data = await this.request<{ playlist: PlaylistDetail }>(
      `/playlists/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    const playlist = this.normalizePlaylistDetail({
      ...data.playlist,
      syncState: 'cloud',
      dirty: false,
    });
    this.mirror.detail[playlist.id] = playlist;
    this.upsertListSummary(playlist);
    this.saveMirror();
    this.setStatus('synced');
    return playlist;
  }

  public async fetchPublicPlaylist(id: string): Promise<PlaylistDetail> {
    const data = await this.request<{ playlist: PlaylistDetail }>(
      `/public/playlists/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    return this.normalizePlaylistDetail({ ...data.playlist, syncState: 'public', dirty: false });
  }

  public async getPlaylist(id: string, force = false): Promise<PlaylistDetail> {
    if (!force && this.mirror.detail[id]) return this.mirror.detail[id];
    const summary = this.mirror.playlists.find((p) => String(p.id) === String(id));
    if (summary && summary.syncState === 'local' && this.mirror.detail[id]) {
      return this.mirror.detail[id];
    }
    return this.fetchRemotePlaylist(id);
  }

  public createLocalPlaylist(opts: {
    name: string;
    source?: string;
    sourceId?: string | null;
    tracks?: (Track | SyncTrack)[];
    id?: string;
  }): PlaylistDetail {
    const id = opts.id || shortId();
    const existing = this.mirror.detail[id];
    const playlist = this.normalizePlaylistDetail({
      ...existing,
      id,
      name: cleanName(opts.name),
      source: opts.source || 'custom',
      sourceId: opts.sourceId ?? null,
      tracks: CPSync.normalizeTracks(opts.tracks || []),
      version: existing?.version || 0,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      syncState: 'local',
      dirty: true,
    });
    this.mirror.detail[id] = playlist;
    this.upsertListSummary(playlist);
    this.saveMirror();
    return playlist;
  }

  public async createPlaylist(opts: {
    name: string;
    source?: string;
    sourceId?: string | null;
    tracks?: (Track | SyncTrack)[];
    id?: string;
  }): Promise<PlaylistDetail> {
    const id = opts.id || shortId();
    if (!this.isLoggedIn()) return this.createLocalPlaylist({ ...opts, id });
    this.setStatus('syncing');
    const body = {
      id,
      name: cleanName(opts.name),
      source: opts.source || 'custom',
      sourceId: opts.sourceId ?? null,
      tracks: CPSync.normalizeTracks(opts.tracks || []),
    };
    const data = await this.request<{ id?: string; version?: number }>('/playlists', {
      method: 'POST',
      body,
    });
    const cloudId = data.id || id;
    const playlist = this.normalizePlaylistDetail({
      ...body,
      id: cloudId,
      version: data.version || 1,
      syncState: 'cloud',
      dirty: false,
    });
    this.mirror.detail[playlist.id] = playlist;
    this.upsertListSummary(playlist);
    this.saveMirror();
    this.setStatus('synced');
    return playlist;
  }

  public async updatePlaylist(
    id: string,
    patch: { name?: string; tracks?: (Track | SyncTrack)[] },
    baseVersion: number,
    onConflict?: (ctx: ConflictContext) => Promise<ConflictResolution>,
  ): Promise<PlaylistDetail> {
    const current = this.mirror.detail[id];
    const normalizedTracks = patch.tracks ? CPSync.normalizeTracks(patch.tracks) : current?.tracks || [];
    const local = this.normalizePlaylistDetail({
      ...current,
      ...patch,
      tracks: normalizedTracks,
      id,
    });

    if (current?.syncState === 'local') {
      local.syncState = 'local';
      local.dirty = true;
      local.updatedAt = now();
      this.mirror.detail[id] = local;
      this.upsertListSummary(local);
      this.saveMirror();
      return local;
    }

    this.setStatus('syncing');
    try {
      const body: Record<string, unknown> = { baseVersion };
      if (patch.name !== undefined) body.name = cleanName(patch.name);
      if (patch.tracks !== undefined) body.tracks = normalizedTracks;
      const data = await this.request<{ version: number }>(
        `/playlists/${encodeURIComponent(id)}`,
        { method: 'PUT', body },
      );
      const next = this.normalizePlaylistDetail({
        ...local,
        version: data.version,
        syncState: 'cloud',
        dirty: false,
      });
      this.mirror.detail[id] = next;
      this.upsertListSummary(next);
      this.saveMirror();
      this.setStatus('synced');
      return next;
    } catch (e) {
      if ((e as SyncError).status === 409) {
        this.setStatus('conflict', e);
        const remote = await this.fetchRemotePlaylist(id);
        if (typeof onConflict === 'function') {
          const resolved = await onConflict({ local, remote });
          if (resolved === 'remote') return remote;
          if (resolved && typeof resolved === 'object') {
            return this.updatePlaylist(id, resolved, remote.version);
          }
        }
      }
      throw e;
    }
  }

  public async deletePlaylist(id: string): Promise<void> {
    const summary = this.mirror.playlists.find((p) => String(p.id) === String(id));
    if (summary && summary.syncState !== 'local') {
      this.setStatus('syncing');
      await this.request(`/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.setStatus('synced');
    }
    this.mirror.playlists = this.mirror.playlists.filter((p) => String(p.id) !== String(id));
    delete this.mirror.detail[id];
    if (String(this.mirror.playbackState?.playlistId || '') === String(id)) {
      this.mirror.playbackState = null;
    }
    this.saveMirror();
  }

  public async addTracks(id: string, tracks: (Track | SyncTrack)[]) {
    const detail = await this.getPlaylist(id);
    const clean = CPSync.normalizeTracks(tracks);
    const merged = CPSync.mergeTracks(detail.tracks || [], clean);
    if (detail.syncState === 'local') {
      const next = await this.updatePlaylist(id, { tracks: merged }, detail.version || 0);
      return { added: merged.length - (detail.tracks || []).length, total: merged.length, playlist: next };
    }
    this.setStatus('syncing');
    const data = await this.request<{ added?: number; total?: number }>(
      `/playlists/${encodeURIComponent(id)}/tracks`,
      { method: 'POST', body: { tracks: clean } },
    );
    const remote = await this.fetchRemotePlaylist(id);
    this.setStatus('synced');
    return { ...data, playlist: remote };
  }

  public async removeTrack(id: string, trackId: string | number) {
    const detail = await this.getPlaylist(id);
    const tracks = (detail.tracks || []).filter((t) => String(t.id) !== String(trackId));
    if (detail.syncState === 'local') {
      const next = await this.updatePlaylist(id, { tracks }, detail.version || 0);
      return { total: tracks.length, playlist: next };
    }
    this.setStatus('syncing');
    const data = await this.request<{ total?: number }>(
      `/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(String(trackId))}`,
      { method: 'DELETE' },
    );
    const remote = await this.fetchRemotePlaylist(id);
    this.setStatus('synced');
    return { ...data, playlist: remote };
  }

  public async resolveShortLink(url: string): Promise<string> {
    const data = await this.request<{ playlistId: string }>(
      `/resolve_short_link?url=${encodeURIComponent(url)}`,
      { method: 'GET' },
    );
    return data.playlistId;
  }

  private normalizePlaylistSummary(p: Partial<PlaylistSummary> & { tracks?: SyncTrack[] }): PlaylistSummary {
    return {
      id: p.id || shortId(),
      name: cleanName(p.name),
      source: p.source || 'custom',
      sourceId: p.sourceId ?? null,
      version: p.version || 0,
      trackCount: p.trackCount ?? (p.tracks ? p.tracks.length : 0),
      updatedAt: p.updatedAt || now(),
      syncState: p.syncState || (p.dirty ? 'dirty' : 'cloud'),
      dirty: Boolean(p.dirty),
    };
  }

  private normalizePlaylistDetail(p: Partial<PlaylistDetail> & { created_at?: number }): PlaylistDetail {
    const tracks = CPSync.normalizeTracks(p.tracks || []);
    return {
      ...this.normalizePlaylistSummary({ ...p, tracks }),
      tracks,
      createdAt: p.createdAt || p.created_at || now(),
    };
  }

  private normalizePlaybackState(state: Partial<PlaybackStateRecord> | null | undefined): PlaybackStateRecord | null {
    if (!state || typeof state !== 'object') return null;
    const kind = state.kind && ['cloud', 'public', 'netease'].includes(state.kind) ? state.kind : null;
    if (!kind) return null;
    const pid = String(state.playlistId || '').toLowerCase();
    const playlistId = validShortId(pid) ? pid : null;
    const sourceId = state.sourceId == null ? null : String(state.sourceId).slice(0, 128);
    if ((kind === 'cloud' || kind === 'public') && !playlistId) return null;
    if (kind === 'netease' && !sourceId) return null;
    const rawIdx = Number(state.trackIndex);
    const trackIndex = Number.isFinite(rawIdx) ? Math.max(-1, Math.floor(rawIdx)) : -1;
    return {
      kind,
      playlistId,
      sourceId,
      trackIndex,
      trackId: state.trackId == null ? null : String(state.trackId).slice(0, 64),
      updatedAt: Number(state.updatedAt) || now(),
    };
  }

  private upsertListSummary(playlist: PlaylistDetail): void {
    const summary = this.normalizePlaylistSummary(playlist);
    const i = this.mirror.playlists.findIndex((p) => String(p.id) === String(summary.id));
    if (i >= 0) this.mirror.playlists.splice(i, 1, summary);
    else this.mirror.playlists.push(summary);
  }

  public static normalizeTracks(tracks: (Track | SyncTrack)[]): SyncTrack[] {
    return (Array.isArray(tracks) ? tracks : [])
      .filter((t) => t && t.id !== undefined)
      .map((t) => ({
        id: t.id,
        name: String(t.name || '未知歌曲'),
        artists: String('artists' in t && t.artists ? t.artists : ('artist' in t && t.artist ? t.artist : '未知歌手')),
        album: String(t.album || ''),
        picUrl: String('picUrl' in t && t.picUrl ? t.picUrl : ('cover' in t && t.cover ? t.cover : '')),
      }));
  }

  public static toPlayerTracks(tracks: (Track | SyncTrack)[]): Track[] {
    return (Array.isArray(tracks) ? tracks : []).map((t) => ({
      id: t.id,
      name: t.name || '未知歌曲',
      artist: ('artist' in t && t.artist) || ('artists' in t && t.artists) || '未知歌手',
      album: t.album || '',
      cover: ('cover' in t && t.cover) || ('picUrl' in t && t.picUrl) || '',
      source: 'Cloud',
    }));
  }

  public static mergeTracks(a: SyncTrack[], b: SyncTrack[]): SyncTrack[] {
    const map = new Map<string, SyncTrack>();
    [...(a || []), ...(b || [])].forEach((t) => {
      if (t && t.id !== undefined && !map.has(String(t.id))) {
        map.set(String(t.id), t);
      }
    });
    return Array.from(map.values());
  }
}
