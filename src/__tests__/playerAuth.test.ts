import { describe, expect, it } from 'vitest';
import { PlayerAuth } from '../services/playerAuth';

interface RecordedRequest {
  url: URL;
  options: RequestInit;
}

function harness(
  handler?: ((url: URL, options: RequestInit) => Response | Promise<Response>) | null,
  extra: {
    config?: { enabled: boolean; guestEnabled: boolean; sitekey?: string; action?: string };
    mint?: (options: RequestInit, count: number) => Response | Promise<Response>;
    challenge?: () => Promise<string> | string;
  } = {},
) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  let now = Date.now();
  let challenges = 0;
  let mints = 0;
  const requests: RecordedRequest[] = [];

  const fetchImpl = async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    if (url.pathname.endsWith('/player/config')) {
      return Response.json({
        data: extra.config || { enabled: true, guestEnabled: true, sitekey: 'test', action: 'cplayer-guest' },
      });
    }
    if (url.pathname.endsWith('/player/token')) {
      mints++;
      if (extra.mint) return extra.mint(options, mints);
      const authHeader = new Headers(options.headers).get('Authorization');
      return Response.json({
        data: {
          token: `signed-${mints}`,
          role: authHeader ? 'member' : 'guest',
          expiresAt: now + 300_000,
        },
      });
    }
    return handler ? handler(url, options) : Response.json({ code: 200 });
  };

  const auth = new PlayerAuth({
    storage,
    fetchImpl,
    clock: () => now,
    challenge: async () => {
      challenges++;
      if (extra.challenge) return extra.challenge();
      return 'one-use-challenge';
    },
  });

  return {
    auth,
    storage,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    counts: () => ({ challenges, mints }),
  };
}

const API = 'https://api.chksz.com/api/';

describe('PlayerAuth security & member token contract', () => {
  it('member-only site asks guests to log in and lets members play without a challenge', async () => {
    const h = harness(null, { config: { enabled: true, guestEnabled: false, sitekey: '' } });
    await expect(h.auth.fetch(`${API}163_search`)).rejects.toThrow(/请登录账号/);
    expect(h.counts()).toEqual({ challenges: 0, mints: 0 });
    expect(h.requests.length).toBe(1);

    h.storage.setItem('cp_sync_token', 'existing-session');
    await h.auth.fetch(`${API}163_search`);
    expect(h.counts()).toEqual({ challenges: 0, mints: 1 });
    expect(new Headers(h.requests.at(-1)?.options.headers).get('Authorization')).toBe('Bearer signed-1');

    h.storage.setItem('cp_sync_token', '');
    await expect(h.auth.fetch(`${API}163_search`)).rejects.toThrow(/请登录账号/);
    expect(h.requests.filter((r) => r.url.origin === 'https://api.chksz.com').length).toBe(1);
  });

  it('parallel calls share one challenge and one in-memory credential', async () => {
    const h = harness();
    await Promise.all(Array.from({ length: 10 }, () => h.auth.fetch(`${API}163_search?keyword=a`)));
    expect(h.counts()).toEqual({ challenges: 1, mints: 1 });
    const calls = h.requests.filter((r) => r.url.origin === 'https://api.chksz.com');
    expect(calls.length).toBe(10);
    for (const call of calls) {
      expect(new Headers(call.options.headers).get('Authorization')).toBe('Bearer signed-1');
      expect(call.options.redirect).toBe('error');
    }
    expect(h.storage.getItem('player_token')).toBeNull();
  });

  it('guest permissions adapt parameters and block playlist import before API work', async () => {
    const h = harness();
    await h.auth.fetch(`${API}163_music?id=1&level=lossless`);
    expect(h.requests.at(-1)?.url.searchParams.get('level')).toBe('exhigh');
    await h.auth.fetch(`${API}qq_music?mid=x`);
    expect(h.requests.at(-1)?.url.searchParams.get('size')).toBe('320k');
    await expect(h.auth.fetch(`${API}163_playlist?id=1`)).rejects.toMatchObject({ status: 403 });
    expect(h.requests.some((r) => r.url.pathname === '/api/163_playlist')).toBe(false);
  });

  it('expired credentials renew, 401 retries once, 403/429 never retry', async () => {
    let status = 200;
    let attempts = 0;
    const h = harness(() => {
      attempts++;
      return Response.json({ msg: 'denied' }, { status });
    });
    await h.auth.fetch(`${API}163_search`);
    h.advance(300_000);
    await h.auth.fetch(`${API}163_search`);
    expect(h.counts().mints).toBe(2);

    status = 401;
    attempts = 0;
    await expect(h.auth.fetch(`${API}163_search`)).rejects.toMatchObject({ status: 401 });
    expect(attempts).toBe(2);

    for (const code of [403, 429]) {
      status = code;
      attempts = 0;
      await expect(h.auth.fetch(`${API}163_search`)).rejects.toMatchObject({ status: code });
      expect(attempts).toBe(1);
    }
  });

  it('personal keys and custom API origins never receive the Sync playback token', async () => {
    const h = harness();
    for (const url of [
      `${API}163_search?apikey=personal`,
      'https://other.example/api/163_search',
      'https://api.chksz.com.evil.example/api/163_search',
    ]) {
      await h.auth.fetch(url);
    }
    expect(h.counts()).toEqual({ challenges: 0, mints: 0 });
    for (const req of h.requests) {
      expect(new Headers(req.options.headers).has('Authorization')).toBe(false);
    }
  });

  it('logout during signing prevents old member credential from reaching music APIs', async () => {
    let finish!: (res: Response) => void;
    const h = harness(null, {
      mint: () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    h.storage.setItem('cp_sync_token', 'member-session');
    const pending = h.auth.fetch(`${API}163_search`);
    h.storage.setItem('cp_sync_token', '');
    h.auth.invalidate();
    finish(Response.json({ data: { token: 'old-member', role: 'member', expiresAt: Date.now() + 300_000 } }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.requests.some((r) => r.url.origin === 'https://api.chksz.com')).toBe(false);
  });

  it('signer 429 observes cooldown without more challenge/signature attempts', async () => {
    const h = harness(null, {
      mint: () => Response.json({ error: 'limited' }, { status: 429, headers: { 'Retry-After': '60' } }),
    });
    await expect(h.auth.fetch(`${API}163_search`)).rejects.toMatchObject({ status: 429 });
    await expect(h.auth.fetch(`${API}163_search`)).rejects.toMatchObject({ status: 429 });
    expect(h.counts()).toEqual({ challenges: 1, mints: 1 });
  });

  it('official non-music endpoints cannot receive a playback credential', async () => {
    const h = harness();
    await expect(h.auth.fetch(`${API}auth/me`)).rejects.toThrow(/不支持播放凭证/);
    expect(h.requests.length).toBe(0);
  });
});
