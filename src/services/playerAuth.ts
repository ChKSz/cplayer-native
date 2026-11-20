/**
 * Exact TypeScript port of CPlayer `js/player-auth.js`.
 *
 * Security invariants (must NEVER be violated):
 * 1. Login via `POST ${syncBase}/auth/login` -> `cp_sync_token` session Bearer.
 * 2. Exchange session Bearer ONLY at same-origin `POST ${syncBase}/player/token`
 *    for a short-lived (5 min) in-memory playback credential.
 * 3. NEVER persist the playback credential to localStorage.
 * 4. Send the playback credential ONLY to official `API_ORIGINS` + `MUSIC_PATHS`.
 * 5. NEVER send the login session Bearer to the music API.
 * 6. NEVER attach any Bearer to audio CDNs, custom APIs, or personal-key URLs.
 * 7. Always use `redirect: 'error'` and `credentials: 'omit'`.
 */

import { nativeFetch } from './transport';

export const OFFICIAL_API_ORIGINS = ['https://api.chksz.com', 'https://api.chksz.top'] as const;
export const MUSIC_PATHS = new Set([
  '163_search',
  '163_music',
  '163_lyric',
  '163_playlist',
  'qq_music',
  'kugou_music',
]);

export interface PlayerCredential {
  token: string;
  role: 'guest' | 'member';
  expiresAt: number;
}

export interface PlayerConfig {
  enabled: boolean;
  guestEnabled: boolean;
  sitekey?: string;
  action?: string;
}

export interface AuthError extends Error {
  status?: number;
  code?: string;
  retryAfter?: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PlayerAuthOptions {
  storage?: StorageLike;
  fetchImpl?: FetchLike;
  challenge?: (config: PlayerConfig) => Promise<string>;
  syncBase?: string;
  apiOrigins?: readonly string[];
  clock?: () => number;
}

function abortError(): DOMException {
  return new DOMException('操作已取消', 'AbortError');
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const stop = () => signal.removeEventListener('abort', cancel);
    const cancel = () => {
      stop();
      reject(abortError());
    };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
}

async function responseError(response: Response): Promise<AuthError> {
  let payload: { error?: string; msg?: string; code?: string } | undefined;
  try {
    payload = await response.clone().json();
  } catch {
    // Non-JSON gateway response
  }
  const fallback =
    response.status === 429
      ? '当前播放额度已用尽或服务繁忙，请稍后再试'
      : `请求失败（${response.status}）`;
  const error: AuthError = new Error(payload?.error || payload?.msg || fallback);
  error.status = response.status;
  error.code = payload?.code;
  error.retryAfter = Math.min(3600, Math.max(1, Number(response.headers.get('Retry-After')) || 60));
  return error;
}

export class PlayerAuth {
  private storage: StorageLike;
  private fetchImpl: FetchLike;
  private challenge?: (config: PlayerConfig) => Promise<string>;
  private apiOrigins: Set<string>;
  private clock: () => number;
  private generation = 0;
  private lastSession = '';
  private credential: PlayerCredential | null = null;
  private pending: Promise<PlayerCredential> | null = null;
  private cooldown: { error: AuthError; until: number } | null = null;
  public syncBase: string;

  constructor(options: PlayerAuthOptions = {}) {
    this.storage = options.storage || window.localStorage;
    this.fetchImpl = options.fetchImpl || nativeFetch;
    this.challenge = options.challenge;
    this.clock = options.clock || Date.now;
    this.syncBase = (
      options.syncBase ||
      this.storage.getItem('cp_sync_api') ||
      'https://sync.chksz.top/api/v1'
    ).replace(/\/$/, '');
    this.apiOrigins = new Set(options.apiOrigins || OFFICIAL_API_ORIGINS);
  }

  public setSyncBase(url: string): void {
    this.syncBase = url.replace(/\/$/, '');
    this.invalidate();
  }

  public getCredentialSnapshot(): PlayerCredential | null {
    if (!this.credential) return null;
    if (this.credential.expiresAt <= this.clock()) return null;
    return this.credential;
  }

  public invalidate(): void {
    this.generation++;
    this.credential = null;
    this.pending = null;
    this.cooldown = null;
  }

  public session(): string {
    const value = this.storage.getItem('cp_sync_token') || '';
    if (value !== this.lastSession) {
      this.invalidate();
      this.lastSession = value;
    }
    return value;
  }

  private async mint(session: string): Promise<PlayerCredential> {
    let challengeToken: string | undefined;
    if (!session) {
      const configRes = await this.fetchImpl(`${this.syncBase}/player/config`, {
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!configRes.ok) throw await responseError(configRes);
      const config: PlayerConfig = (await configRes.json()).data;
      if (!config?.enabled || !config.guestEnabled) {
        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('cplayer:login-required'));
        }
        throw new Error('游客播放暂不可用，请登录账号');
      }
      if (!this.challenge) {
        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('cplayer:login-required'));
        }
        throw new Error('请登录 CPlayerSync 账号以获取播放凭证');
      }
      challengeToken = await this.challenge(config);
      if (!challengeToken) throw abortError();
    }

    const tokenRes = await this.fetchImpl(`${this.syncBase}/player/token`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(challengeToken ? { challenge: challengeToken } : {}),
    });
    if (!tokenRes.ok) throw await responseError(tokenRes);
    const result: PlayerCredential = (await tokenRes.json()).data;
    if (
      !result?.token ||
      !['guest', 'member'].includes(result.role) ||
      !Number.isFinite(result.expiresAt) ||
      result.expiresAt <= this.clock()
    ) {
      throw new Error('播放认证响应无效');
    }
    return result;
  }

  public credentialFor(signal?: AbortSignal | null): Promise<PlayerCredential> {
    if (signal?.aborted) return Promise.reject(abortError());
    const session = this.session();
    if (this.cooldown && this.cooldown.until > this.clock()) {
      return Promise.reject(this.cooldown.error);
    }
    if (this.credential && this.credential.expiresAt > this.clock() + 10_000) {
      return Promise.resolve(this.credential);
    }
    if (!this.pending) {
      const generation = this.generation;
      const pending = this.mint(session)
        .then((value) => {
          if (generation !== this.generation || session !== this.session()) {
            throw abortError();
          }
          this.credential = value;
          return value;
        })
        .catch((error: AuthError) => {
          if (generation === this.generation && error.status === 429) {
            this.cooldown = {
              error,
              until: this.clock() + (error.retryAfter || 60) * 1000,
            };
          }
          throw error;
        })
        .finally(() => {
          if (this.pending === pending) this.pending = null;
        });
      this.pending = pending;
    }
    return waitFor(this.pending, signal);
  }

  public async fetch(input: string, options: RequestInit = {}): Promise<Response> {
    const baseHref = typeof window !== 'undefined' ? window.location?.href : 'https://cp.chksz.top/';
    const url = new URL(input, baseHref);
    const official = this.apiOrigins.has(url.origin) && url.pathname.startsWith('/api/');
    const personal = Boolean(url.searchParams.get('apikey'));
    const init: RequestInit = {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    };

    // Custom API or explicit personal key never receives a Sync playback credential
    if (!official || personal) {
      const response = await this.fetchImpl(url.href, init);
      if (!response.ok) throw await responseError(response);
      return response;
    }

    const path = url.pathname.slice(5);
    if (!MUSIC_PATHS.has(path)) {
      throw new Error('此接口不支持播放凭证');
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await this.credentialFor(options.signal);
      if (credential.role === 'guest') {
        if (path === '163_playlist') {
          const error: AuthError = new Error('请登录后导入网易云歌单');
          error.status = 403;
          throw error;
        }
        if (path === '163_search') url.searchParams.set('limit', '30');
        if (path === '163_music') url.searchParams.set('level', 'exhigh');
        if (path === 'qq_music' || path === 'kugou_music') {
          url.searchParams.set('size', '320k');
          url.searchParams.set('num', '30');
        }
      }
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${credential.token}`);
      const response = await this.fetchImpl(url.href, { ...init, headers });
      if (response.status === 401 && attempt === 0) {
        if (this.credential === credential) this.credential = null;
        continue;
      }
      if (!response.ok) throw await responseError(response);
      return response;
    }

    throw new Error('播放凭证校验失败');
  }
}
