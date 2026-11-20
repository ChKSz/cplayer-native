/**
 * Dual-mode HTTP transport:
 * - Inside Tauri 2 (Android/Desktop): routes API requests through Rust `api_fetch`
 *   so WebView CORS / `tauri.localhost` origin restrictions never break sync or music APIs.
 * - Inside normal browser (local Vite preview / unit tests): uses native `fetch()`.
 */

export interface ApiFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isTauriRuntime()) {
    return fetch(input, init);
  }

  const signal = init.signal;
  if (signal?.aborted) {
    throw new DOMException('操作已取消', 'AbortError');
  }

  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const headersObj: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headersObj[key] = value;
    });
  }
  const body = typeof init.body === 'string' ? init.body : undefined;
  const rejectRedirects = init.redirect === 'error';

  const { invoke } = await import('@tauri-apps/api/core');

  const invokePromise = invoke<ApiFetchResult>('api_fetch', {
    req: {
      url,
      method,
      headers: headersObj,
      body: body ?? null,
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

  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) {
    respHeaders.set(k, v);
  }

  // Status 204 / 304 cannot have a body in Fetch Response constructor
  const nullBodyStatus = result.status === 204 || result.status === 205 || result.status === 304;
  return new Response(nullBodyStatus ? null : result.body, {
    status: result.status,
    headers: respHeaders,
  });
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
