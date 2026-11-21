/**
 * Multi-mode HTTP transport:
 * - Inside Android WebView (`window.CPlayerNativeHttp`): routes API requests through
 *   Kotlin `HttpURLConnection` bridge so WebView CORS / `tauri.localhost` origin
 *   restrictions never break sync or music APIs without bundling Rust TLS/HTTP crates.
 * - Inside Desktop Tauri 2: routes API requests through Rust `api_fetch`.
 * - Inside normal browser (local Vite preview / unit tests): uses native `fetch()`.
 */

export interface ApiFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CPlayerNativeHttpApi {
  isAvailable(): boolean;
  request(
    reqId: string,
    url: string,
    method: string,
    headersJson: string,
    hasBody: boolean,
    body: string,
    rejectRedirects: boolean,
  ): void;
  abort(reqId: string): void;
}

export interface NativeHttpCallbacks {
  onResolve: (reqId: string, payloadJson: string) => void;
  onReject: (reqId: string, message: string) => void;
}

declare global {
  interface Window {
    CPlayerNativeHttp?: CPlayerNativeHttpApi;
    __cplayerNativeHttp?: NativeHttpCallbacks;
  }
}

interface PendingNativeHttpRequest {
  resolve: (result: ApiFetchResult) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

const pendingHttpRequests = new Map<string, PendingNativeHttpRequest>();
let reqSeq = 0;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getNativeHttpApi(): CPlayerNativeHttpApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.CPlayerNativeHttp;
  try {
    if (api && typeof api.isAvailable === 'function' && api.isAvailable()) {
      return api;
    }
  } catch {
    return null;
  }
  return null;
}

function ensureNativeHttpCallbacks(): void {
  if (typeof window === 'undefined' || window.__cplayerNativeHttp) return;
  window.__cplayerNativeHttp = {
    onResolve: (reqId: string, payloadJson: string) => {
      const entry = pendingHttpRequests.get(reqId);
      if (!entry) return;
      pendingHttpRequests.delete(reqId);
      entry.cleanup();
      try {
        const parsed = JSON.parse(payloadJson) as ApiFetchResult;
        entry.resolve(parsed);
      } catch (err) {
        entry.reject(new Error(err instanceof Error ? err.message : '解析原生响应失败'));
      }
    },
    onReject: (reqId: string, message: string) => {
      const entry = pendingHttpRequests.get(reqId);
      if (!entry) return;
      pendingHttpRequests.delete(reqId);
      entry.cleanup();
      entry.reject(new Error(message || '网络请求失败'));
    },
  };
}

function buildFetchResponse(result: ApiFetchResult): Response {
  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) {
    respHeaders.set(k, v);
  }

  // Status 204 / 205 / 304 cannot have a body in Fetch Response constructor
  const nullBodyStatus = result.status === 204 || result.status === 205 || result.status === 304;
  return new Response(nullBodyStatus ? null : result.body, {
    status: result.status,
    headers: respHeaders,
  });
}

function extractRequestParts(input: RequestInfo | URL, init: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const headersObj: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headersObj[key] = value;
    });
  }
  const hasBody = typeof init.body === 'string';
  const body = hasBody ? (init.body as string) : '';
  const rejectRedirects = init.redirect === 'error';
  return { url, method, headersObj, hasBody, body, rejectRedirects };
}

export async function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal;
  if (signal?.aborted) {
    throw new DOMException('操作已取消', 'AbortError');
  }

  const nativeHttp = getNativeHttpApi();
  if (nativeHttp) {
    const { url, method, headersObj, hasBody, body, rejectRedirects } = extractRequestParts(input, init);
    ensureNativeHttpCallbacks();
    const reqId = `http_${++reqSeq}`;

    const result = await new Promise<ApiFetchResult>((resolve, reject) => {
      const onAbort = () => {
        const entry = pendingHttpRequests.get(reqId);
        if (!entry) return;
        pendingHttpRequests.delete(reqId);
        entry.cleanup();
        try {
          nativeHttp.abort(reqId);
        } catch {
          // Ignore abort bridge errors
        }
        entry.reject(new DOMException('操作已取消', 'AbortError'));
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      pendingHttpRequests.set(reqId, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        nativeHttp.request(reqId, url, method, JSON.stringify(headersObj), hasBody, body, rejectRedirects);
      } catch (err) {
        const entry = pendingHttpRequests.get(reqId);
        if (entry) {
          pendingHttpRequests.delete(reqId);
          entry.cleanup();
          entry.reject(err instanceof Error ? err : new Error(String(err || '网络请求失败')));
        }
      }
    });

    return buildFetchResponse(result);
  }

  if (!isTauriRuntime()) {
    return fetch(input, init);
  }

  const { url, method, headersObj, hasBody, body, rejectRedirects } = extractRequestParts(input, init);
  const { invoke } = await import('@tauri-apps/api/core');

  const invokePromise = invoke<ApiFetchResult>('api_fetch', {
    req: {
      url,
      method,
      headers: headersObj,
      body: hasBody ? body : null,
      rejectRedirects,
    },
  });

  const result = await new Promise<ApiFetchResult>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('操作已取消', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    invokePromise.then(
      (val) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(typeof err === 'string' ? err : err?.message || '网络请求失败'));
      },
    );
  });

  return buildFetchResponse(result);
}

export async function triggerHaptic(style: 'selection' | 'light' | 'medium' = 'selection'): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const haptics = await import('@tauri-apps/plugin-haptics');
    if (style === 'selection') {
      await haptics.selectionFeedback();
    } else {
      await haptics.impactFeedback(style);
    }
  } catch {
    // Non-Android or haptics unavailable
  }
}
