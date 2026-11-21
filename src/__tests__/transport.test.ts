import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeFetch, type CPlayerNativeHttpApi, type NativeHttpCallbacks } from '../services/transport';

interface RecordedNativeCall {
  reqId: string;
  url: string;
  method: string;
  headersJson: string;
  hasBody: boolean;
  body: string;
  rejectRedirects: boolean;
}

interface MockWindow {
  CPlayerNativeHttp?: CPlayerNativeHttpApi;
  __cplayerNativeHttp?: NativeHttpCallbacks;
  __TAURI_INTERNALS__?: unknown;
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

function installMockWindow(mockWin: MockWindow) {
  Object.defineProperty(globalThis, 'window', {
    value: mockWin,
    configurable: true,
    writable: true,
  });
}

function createNativeHttpStub(
  onRequest?: (call: RecordedNativeCall, win: MockWindow) => void,
) {
  const calls: RecordedNativeCall[] = [];
  const abortedIds: string[] = [];
  const mockWin: MockWindow = {};

  mockWin.CPlayerNativeHttp = {
    isAvailable: () => true,
    request: (reqId, url, method, headersJson, hasBody, body, rejectRedirects) => {
      const call: RecordedNativeCall = {
        reqId,
        url,
        method,
        headersJson,
        hasBody,
        body,
        rejectRedirects,
      };
      calls.push(call);
      onRequest?.(call, mockWin);
    },
    abort: (reqId) => {
      abortedIds.push(reqId);
    },
  };

  installMockWindow(mockWin);
  return { calls, abortedIds, mockWin };
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('nativeFetch multi-mode HTTP transport', () => {
  it('routes through CPlayerNativeHttp forwarding method, headers, body flags, and rejectRedirects', async () => {
    const { calls } = createNativeHttpStub((call, win) => {
      queueMicrotask(() => {
        win.__cplayerNativeHttp?.onResolve(
          call.reqId,
          JSON.stringify({
            status: 200,
            headers: { 'content-type': 'application/json', 'x-trace': 'ok' },
            body: JSON.stringify({ ok: true }),
          }),
        );
      });
    });

    const resWithBody = await nativeFetch('https://sync.chksz.top/api/v1/player/token', {
      method: 'post',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer session-token',
      },
      body: JSON.stringify({ challenge: 'abc' }),
    });

    expect(calls[0]).toMatchObject({
      url: 'https://sync.chksz.top/api/v1/player/token',
      method: 'POST',
      hasBody: true,
      body: '{"challenge":"abc"}',
      rejectRedirects: true,
    });
    expect(JSON.parse(calls[0].headersJson)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer session-token',
    });
    expect(resWithBody.status).toBe(200);
    expect(resWithBody.headers.get('x-trace')).toBe('ok');
    expect(await resWithBody.json()).toEqual({ ok: true });

    const resWithoutBody = await nativeFetch('https://sync.chksz.top/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    });

    expect(calls[1]).toMatchObject({
      url: 'https://sync.chksz.top/api/v1/auth/logout',
      method: 'POST',
      hasBody: false,
      body: '',
      rejectRedirects: false,
    });
    expect(resWithoutBody.status).toBe(200);
  });

  it('constructs null-body Response cleanly for 204 and 304 statuses', async () => {
    const statuses = [204, 304];
    let idx = 0;
    createNativeHttpStub((call, win) => {
      const status = statuses[idx++];
      queueMicrotask(() => {
        win.__cplayerNativeHttp?.onResolve(
          call.reqId,
          JSON.stringify({ status, headers: { etag: '"v1"' }, body: '' }),
        );
      });
    });

    const r204 = await nativeFetch('https://api.chksz.com/api/163_search');
    expect(r204.status).toBe(204);
    expect(r204.body).toBeNull();
    expect(r204.headers.get('etag')).toBe('"v1"');

    const r304 = await nativeFetch('https://api.chksz.com/api/163_search');
    expect(r304.status).toBe(304);
    expect(r304.body).toBeNull();
  });

  it('matches concurrent out-of-order responses by reqId', async () => {
    const { calls, mockWin } = createNativeHttpStub();

    const p1 = nativeFetch('https://api.chksz.com/api/163_search?q=first');
    const p2 = nativeFetch('https://api.chksz.com/api/163_search?q=second');
    expect(calls.length).toBe(2);

    // Resolve second call before first call
    mockWin.__cplayerNativeHttp?.onResolve(
      calls[1].reqId,
      JSON.stringify({ status: 200, headers: {}, body: 'second-body' }),
    );
    mockWin.__cplayerNativeHttp?.onResolve(
      calls[0].reqId,
      JSON.stringify({ status: 200, headers: {}, body: 'first-body' }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(await r1.text()).toBe('first-body');
    expect(await r2.text()).toBe('second-body');
  });

  it('propagates native onReject errors', async () => {
    createNativeHttpStub((call, win) => {
      queueMicrotask(() => {
        win.__cplayerNativeHttp?.onReject(call.reqId, '已拦截非预期的重定向响应');
      });
    });

    await expect(
      nativeFetch('https://sync.chksz.top/api/v1/player/token', { redirect: 'error' }),
    ).rejects.toThrow('已拦截非预期的重定向响应');
  });

  it('handles pre-aborted and mid-flight AbortSignal and ignores late callbacks', async () => {
    const { calls, abortedIds, mockWin } = createNativeHttpStub();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      nativeFetch('https://api.chksz.com/api/163_search', { signal: preAborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.length).toBe(0);

    const controller = new AbortController();
    const pending = nativeFetch('https://api.chksz.com/api/163_search', {
      signal: controller.signal,
    });
    expect(calls.length).toBe(1);
    const reqId = calls[0].reqId;

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedIds).toEqual([reqId]);

    // Late resolve/reject after abort must be a safe no-op
    expect(() => {
      mockWin.__cplayerNativeHttp?.onResolve(
        reqId,
        JSON.stringify({ status: 200, headers: {}, body: 'late' }),
      );
      mockWin.__cplayerNativeHttp?.onReject(reqId, 'late error');
    }).not.toThrow();
  });

  it('falls back to global fetch when neither CPlayerNativeHttp nor __TAURI_INTERNALS__ exists', async () => {
    installMockWindow({});
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('browser-ok', { status: 200 }));
    globalThis.fetch = fetchSpy;

    const res = await nativeFetch('https://api.chksz.com/api/163_search', { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe('browser-ok');
  });
});
