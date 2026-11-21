import {
  getNativeMediaApi,
  type NativeUpdateEventPayload,
} from '../engine/nativeMediaBridge';
import { nativeFetch } from './transport';

export const APP_VERSION = '1.1.1';
export const GITHUB_RELEASES_API = 'https://api.github.com/repos/ChKSz/cplayer-native/releases/latest';
export const GITHUB_RELEASES_PAGE = 'https://github.com/ChKSz/cplayer-native/releases';

const DISMISSED_UPDATE_KEY = 'cp_dismissed_update_ver';

export function getDismissedUpdateVersion(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISSED_UPDATE_KEY) : null;
  } catch {
    return null;
  }
}

export function setDismissedUpdateVersion(version: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DISMISSED_UPDATE_KEY, version.trim());
    }
  } catch {
    // Ignore storage error
  }
}

export function isNativeApkUpdateSupported(): boolean {
  const api = getNativeMediaApi();
  return Boolean(api && typeof api.downloadAndInstallApk === 'function');
}

export function startNativeApkDownload(url: string, version: string): boolean {
  const api = getNativeMediaApi();
  if (!api?.downloadAndInstallApk) return false;
  try {
    return Boolean(api.downloadAndInstallApk(url, version));
  } catch {
    return false;
  }
}

export function cancelNativeApkDownload(): boolean {
  const api = getNativeMediaApi();
  if (!api?.cancelApkDownload) return false;
  try {
    return Boolean(api.cancelApkDownload());
  } catch {
    return false;
  }
}

export function triggerNativeApkInstall(): boolean {
  const api = getNativeMediaApi();
  if (!api?.installDownloadedApk) return false;
  try {
    return Boolean(api.installDownloadedApk());
  } catch {
    return false;
  }
}

export function registerNativeUpdateListener(
  listener: (event: NativeUpdateEventPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const bridge = {
    onEvent: (payloadJson: string) => {
      try {
        const parsed = JSON.parse(payloadJson) as NativeUpdateEventPayload;
        if (parsed && typeof parsed.status === 'string') {
          listener(parsed);
        }
      } catch {
        // Ignore malformed bridge event
      }
    },
  };
  window.__cplayerUpdateBridge = bridge;
  return () => {
    if (window.__cplayerUpdateBridge === bridge) {
      delete window.__cplayerUpdateBridge;
    }
  };
}

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  downloadUrl: string;
  releaseUrl: string;
  noPublishedRelease?: boolean;
}

function parseSemverParts(version: string): number[] {
  const clean = version.trim().replace(/^v/i, '').split('-')[0];
  return clean.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

/**
 * Returns >0 if `a > b`, <0 if `a < b`, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

export async function checkForAppUpdate(
  fetchImpl: typeof nativeFetch = nativeFetch,
  currentVersion: string = APP_VERSION,
): Promise<AppUpdateCheckResult> {
  const res = await fetchImpl(GITHUB_RELEASES_API, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (res.status === 404) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseName: `v${currentVersion}`,
      releaseNotes: '',
      downloadUrl: GITHUB_RELEASES_PAGE,
      releaseUrl: GITHUB_RELEASES_PAGE,
      noPublishedRelease: true,
    };
  }

  if (!res.ok) {
    throw new Error(`检查更新失败（HTTP ${res.status}）`);
  }

  const data = (await res.json()) as {
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    assets?: { name?: string; browser_download_url?: string }[];
  };

  const latestRaw = String(data.tag_name || '').trim();
  if (!latestRaw) {
    throw new Error('未获取到有效版本信息');
  }
  const latestVersion = latestRaw.replace(/^v/i, '');
  const apkAsset = Array.isArray(data.assets)
    ? data.assets.find((a) => String(a.name || '').toLowerCase().endsWith('.apk'))
    : undefined;

  const releaseUrl = data.html_url || GITHUB_RELEASES_PAGE;
  const downloadUrl = apkAsset?.browser_download_url || releaseUrl;

  return {
    hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
    currentVersion,
    latestVersion,
    releaseName: data.name || latestRaw,
    releaseNotes: String(data.body || '').trim(),
    downloadUrl,
    releaseUrl,
  };
}
