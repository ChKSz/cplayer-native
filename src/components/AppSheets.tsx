import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APP_VERSION,
  checkForAppUpdate,
  type AppUpdateCheckResult,
} from '../services/appUpdater';
import {
  cpSync,
  musicService,
  trackCoverOrFallback,
  usePlayerStore,
  type LyricFontSize,
  type SleepTimerMode,
} from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf } from '../types/music';
import {
  IconCheck,
  IconClose,
  IconDownload,
  IconHeart,
  IconRefresh,
  IconSettings,
  IconSwap,
  IconTrash,
} from './Icons';

export function SheetContentRenderer({
  onRequestExpand,
}: {
  onRequestExpand?: () => void;
}) {
  const activeSheet = usePlayerStore((s) => s.activeSheet);

  switch (activeSheet) {
    case 'queue':
      return <QueueSheetBody />;
    case 'quality':
      return <QualitySheetBody />;
    case 'account':
      return <AccountSheetBody />;
    case 'settings':
      return <SettingsSheetBody onRequestExpand={onRequestExpand} />;
    case 'importNetease':
      return <ImportNeteaseSheetBody />;
    case 'createPlaylist':
      return <CreatePlaylistSheetBody />;
    case 'playlistManage':
      return <PlaylistManageSheetBody />;
    case 'trackAction':
      return <TrackActionSheetBody />;
    default:
      return null;
  }
}

export function useSheetHeaderMeta(): { title: string; subtitle: string } {
  const activeSheet = usePlayerStore((s) => s.activeSheet);
  const playMode = usePlayerStore((s) => s.playMode);
  const queueLen = usePlayerStore((s) => s.queue.length);
  const user = usePlayerStore((s) => s.user);
  const sheetTrackTarget = usePlayerStore((s) => s.sheetTrackTarget);
  const activePlaylistName = usePlayerStore((s) => s.activePlaylistName);

  switch (activeSheet) {
    case 'queue':
      return {
        title: '当前播放队列',
        subtitle:
          playMode === 'random'
            ? `${queueLen} 首 · 随机打乱队列`
            : `${queueLen} 首`,
      };
    case 'quality':
      return {
        title: '音质选择',
        subtitle: '网易云支持多档音质切换',
      };
    case 'account':
      return {
        title: user ? '账号与云同步' : '登录账号',
        subtitle: 'CPlayerSync 账号与歌单镜像',
      };
    case 'settings':
      return {
        title: '应用设置',
        subtitle: '播放、音质、歌词、缓存与更新',
      };
    case 'importNetease':
      return {
        title: '导入网易云歌单',
        subtitle: '输入歌单 ID 或分享链接',
      };
    case 'createPlaylist':
      return {
        title: '新建云歌单',
        subtitle: '自动同步至云端',
      };
    case 'playlistManage':
      return {
        title: '歌单管理',
        subtitle: activePlaylistName || '云歌单设置',
      };
    case 'trackAction':
      return {
        title: sheetTrackTarget?.name || '歌曲操作',
        subtitle: sheetTrackTarget?.artist || '',
      };
    default:
      return { title: '', subtitle: '' };
  }
}

function QueueSheetBody() {
  const queue = usePlayerStore((s) => s.queue);
  const playMode = usePlayerStore((s) => s.playMode);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playQueueIndex = usePlayerStore((s) => s.playQueueIndex);
  const reshuffleQueue = usePlayerStore((s) => s.reshuffleQueue);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const closeSheet = usePlayerStore((s) => s.closeSheet);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const activeIdx =
    currentIndex >= 0 && currentIndex < queue.length
      ? currentIndex
      : currentTrack
        ? queue.findIndex((t) => String(t.id) === String(currentTrack.id))
        : -1;

  useEffect(() => {
    if (activeIdx < 0) return;
    const timer = setTimeout(() => {
      const row = activeRowRef.current;
      const scroller = listRef.current?.parentElement;
      if (!row || !scroller) return;
      const targetTop = row.offsetTop - scroller.clientHeight * 0.22;
      scroller.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'auto',
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [activeIdx, queue.length]);

  if (!queue.length) {
    return (
      <div className="empty-box">
        <span>播放队列为空</span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>去歌单或搜索页点选歌曲即可加入队列</span>
      </div>
    );
  }

  return (
    <div ref={listRef} style={{ position: 'relative', paddingBottom: 140 }}>
      <div className="queue-toolbar">
        <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          {playMode === 'random' ? '随机排序队列' : playMode === 'single' ? '单曲循环' : '顺序循环'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {playMode === 'random' && queue.length > 1 && (
            <button
              type="button"
              className="pill-btn tap"
              style={{ height: 28, padding: '0 10px', fontSize: 11.5 }}
              onClick={() => reshuffleQueue()}
            >
              重新洗牌
            </button>
          )}
          <button
            type="button"
            className="pill-btn tap"
            style={{ height: 28, padding: '0 10px', fontSize: 11.5 }}
            onClick={() => {
              clearQueue();
              closeSheet();
            }}
          >
            <IconTrash size={12} />
            <span>清空</span>
          </button>
        </div>
      </div>

      {queue.map((track, idx) => {
        const isCur =
          idx === activeIdx ||
          (currentTrack !== null && String(currentTrack.id) === String(track.id));
        const src = songSourceOf(track.id);
        return (
          <div
            key={`${track.id}-${idx}`}
            ref={isCur ? activeRowRef : null}
            className={`track-row tap-soft ${isCur ? 'playing' : ''}`}
            onClick={() => {
              void playQueueIndex(idx);
              closeSheet();
            }}
          >
            <div className="track-thumb">
              <img src={trackCoverOrFallback(track)} alt="" loading="lazy" />
              {isCur && (
                <div className={`eq-overlay ${isPlaying ? '' : 'paused'}`}>
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                </div>
              )}
            </div>
            <div className="track-info">
              <div className="track-name">
                <span className={`src-tag ${src}`}>{src.toUpperCase()}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</span>
              </div>
              <div className="track-sub">{track.artist}</div>
            </div>
            <button
              type="button"
              className="icon-btn ghost tap"
              style={{ width: 30, height: 30 }}
              aria-label={`移除 ${track.name}`}
              onClick={(e) => {
                e.stopPropagation();
                removeFromQueue(idx);
              }}
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function QualitySheetBody() {
  const quality = usePlayerStore((s) => s.quality);
  const isMeteredNetwork = usePlayerStore((s) => s.isMeteredNetwork);
  const mobileQualityLimit = usePlayerStore((s) => s.mobileQualityLimit);
  const setQuality = usePlayerStore((s) => s.setQuality);

  return (
    <div role="radiogroup" aria-label="音质选择">
      {isMeteredNetwork && mobileQualityLimit && (
        <div className="notice-banner">
          当前处于移动网络，无损及以上音质将自动限档为极高 320K（可在设置中关闭）
        </div>
      )}
      {QUALITY_OPTIONS.map((q) => {
        const selected = q.level === quality;
        return (
          <button
            key={q.level}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`sheet-card tap-soft ${selected ? 'selected' : ''}`}
            style={{ width: '100%', textAlign: 'left', color: 'var(--ink)' }}
            onClick={() => void setQuality(q.level)}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {q.name}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-2)', fontWeight: 500 }}>
                  {q.format}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 2 }}>
                {q.spec} · {q.hint}
              </div>
            </div>
            {selected && <IconCheck size={18} />}
          </button>
        );
      })}
    </div>
  );
}

function AccountSheetBody() {
  const user = usePlayerStore((s) => s.user);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const syncStatus = usePlayerStore((s) => s.syncStatus);
  const login = usePlayerStore((s) => s.login);
  const register = usePlayerStore((s) => s.register);
  const logout = usePlayerStore((s) => s.logout);
  const refreshCloudPlaylists = usePlayerStore((s) => s.refreshCloudPlaylists);
  const openSheet = usePlayerStore((s) => s.openSheet);
  const showToast = usePlayerStore((s) => s.showToast);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      showToast('请输入用户名和密码');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password, inviteCode);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '认证失败');
    } finally {
      setBusy(false);
    }
  };

  const onSyncNow = async () => {
    setSyncing(true);
    try {
      await refreshCloudPlaylists();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="form-stack" style={{ gap: 12, paddingBottom: 18 }}>
      {user ? (
        <div className="miuix-card">
          <div className="account-card-head">
            <div className="avatar-badge">
              {user.username.slice(0, 1).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--ink)' }}>
                {user.username}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>
                {syncStatus === 'offline'
                  ? `离线镜像 · ${cloudPlaylists.length} 个云歌单`
                  : `已同步 ${cloudPlaylists.length} 个云歌单`}
              </div>
            </div>
            <button
              type="button"
              className="pill-btn tap"
              disabled={syncing}
              onClick={() => void onSyncNow()}
            >
              {syncing ? '同步中...' : '同步歌单'}
            </button>
          </div>
          <button
            type="button"
            className="secondary-btn tap"
            style={{ width: '100%', height: 36, fontSize: 13 }}
            onClick={() => void logout()}
          >
            退出登录
          </button>
        </div>
      ) : (
        <form className="miuix-card form-stack" onSubmit={submitAuth}>
          <div className="source-segment" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 4 }}>
            <div
              className="source-thumb"
              style={{
                width: 'calc((100% - 6px) / 2)',
                transform: `translate3d(${mode === 'login' ? 0 : 100}%, 0, 0)`,
              }}
            />
            <button
              type="button"
              className={`source-opt ${mode === 'login' ? 'active' : ''}`}
              onClick={() => setMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              className={`source-opt ${mode === 'register' ? 'active' : ''}`}
              onClick={() => setMode('register')}
            >
              注册
            </button>
          </div>

          <input
            className="field"
            type="text"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            className="field"
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {mode === 'register' && (
            <input
              className="field"
              type="text"
              placeholder="邀请码（如有）"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
            />
          )}

          <button type="submit" className="primary-btn tap" disabled={busy}>
            {busy ? <span className="spinner dark" /> : mode === 'login' ? '登录并同步' : '注册并登录'}
          </button>
        </form>
      )}

      <button
        type="button"
        className="miuix-card tap-soft"
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left' }}
        onClick={() => openSheet('settings')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <IconSettings size={18} />
          <div className="pref-text">
            <span className="pref-title">应用设置</span>
            <span className="pref-sub">睡眠定时、音质保护、边听边存与检查更新</span>
          </div>
        </div>
        <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>→</span>
      </button>
    </div>
  );
}

const SLEEP_OPTIONS: { mode: SleepTimerMode; label: string }[] = [
  { mode: 'off', label: '关闭' },
  { mode: '15', label: '15分' },
  { mode: '30', label: '30分' },
  { mode: '60', label: '60分' },
  { mode: 'track', label: '播完本首' },
];

const LYRIC_SIZE_OPTIONS: { value: LyricFontSize; label: string }[] = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '标准' },
  { value: 'lg', label: '大' },
];

const SETTINGS_CATEGORIES = [
  { id: 'playback', label: '播放与音质' },
  { id: 'lyrics', label: '歌词与视效' },
  { id: 'storage', label: '存储与缓存' },
  { id: 'about', label: '关于与更新' },
] as const;

function formatCountdown(endsAt: number | null): string {
  if (!endsAt) return '';
  const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytesMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ToggleRow({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="pref-row tap-soft"
      onClick={() => onChange(!checked)}
    >
      <div className="pref-text">
        <span className="pref-title">{title}</span>
        <span className="pref-sub">{subtitle}</span>
      </div>
      <span className={`toggle-switch ${checked ? 'on' : ''}`}>
        <span className="toggle-thumb" />
      </span>
    </button>
  );
}

function SettingsSheetBody({ onRequestExpand }: { onRequestExpand?: () => void }) {
  const quality = usePlayerStore((s) => s.quality);
  const isMeteredNetwork = usePlayerStore((s) => s.isMeteredNetwork);
  const mobileQualityLimit = usePlayerStore((s) => s.mobileQualityLimit);
  const preloadNextEnabled = usePlayerStore((s) => s.preloadNextEnabled);
  const autoSkipFailed = usePlayerStore((s) => s.autoSkipFailed);

  const showVerbatim = usePlayerStore((s) => s.showVerbatim);
  const showTranslation = usePlayerStore((s) => s.showTranslation);
  const showRomaji = usePlayerStore((s) => s.showRomaji);
  const lyricFontSize = usePlayerStore((s) => s.lyricFontSize);
  const fluidMotion = usePlayerStore((s) => s.fluidMotion);
  const fluidPowerSave = usePlayerStore((s) => s.fluidPowerSave);

  const sleepTimerMode = usePlayerStore((s) => s.sleepTimerMode);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);

  const openSheet = usePlayerStore((s) => s.openSheet);
  const setPreference = usePlayerStore((s) => s.setPreference);
  const setLyricFontSize = usePlayerStore((s) => s.setLyricFontSize);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const getCacheSummary = usePlayerStore((s) => s.getCacheSummary);
  const clearAudioCache = usePlayerStore((s) => s.clearAudioCache);
  const clearMetadataCache = usePlayerStore((s) => s.clearMetadataCache);
  const updateEndpoints = usePlayerStore((s) => s.updateEndpoints);
  const openExternalLink = usePlayerStore((s) => s.openExternalLink);
  const showToast = usePlayerStore((s) => s.showToast);

  const [activeCat, setActiveCat] = useState<(typeof SETTINGS_CATEGORIES)[number]['id']>('playback');
  const [, setClockTick] = useState(0);
  const [cacheStats, setCacheStats] = useState({ audioBytes: 0, playlistCount: 0, lyricCount: 0 });
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Hidden Easter Egg: tap version footer 5 times to unlock developer endpoints
  const [eggClicks, setEggClicks] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [apiBase, setApiBase] = useState(musicService.baseUrl);
  const [syncApi, setSyncApi] = useState(cpSync.baseUrl);

  const playbackRef = useRef<HTMLDivElement | null>(null);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  const storageRef = useRef<HTMLDivElement | null>(null);
  const aboutRef = useRef<HTMLDivElement | null>(null);

  const refreshCacheSummary = useCallback(() => {
    void getCacheSummary().then((summary) => setCacheStats(summary));
  }, [getCacheSummary]);

  useEffect(() => {
    refreshCacheSummary();
  }, [refreshCacheSummary]);

  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const id = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt]);

  const jumpToCategory = (id: (typeof SETTINGS_CATEGORIES)[number]['id']) => {
    setActiveCat(id);
    const map = {
      playback: playbackRef.current,
      lyrics: lyricsRef.current,
      storage: storageRef.current,
      about: aboutRef.current,
    };
    map[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const res = await checkForAppUpdate();
      setUpdateResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检查更新失败';
      setUpdateError(msg);
      showToast(msg);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const onVersionTap = () => {
    if (showAdvanced) return;
    const next = eggClicks + 1;
    setEggClicks(next);
    if (next >= 5) {
      setShowAdvanced(true);
      onRequestExpand?.();
      showToast('已解锁开发者接口设置');
    }
  };

  const qualityOpt = QUALITY_OPTIONS.find((q) => q.level === quality);
  const activeLyricSizeIdx = Math.max(
    0,
    LYRIC_SIZE_OPTIONS.findIndex((o) => o.value === lyricFontSize),
  );

  return (
    <div className="form-stack" style={{ gap: 12, paddingBottom: 24 }}>
      {/* Sticky Category Jump Nav */}
      <div className="settings-nav" role="tablist" aria-label="设置分类">
        {SETTINGS_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={activeCat === cat.id}
            className={`chip tap ${activeCat === cat.id ? 'active' : ''}`}
            style={{ height: 30, fontSize: 12, padding: '0 12px' }}
            onClick={() => jumpToCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Section 1: Playback & Quality */}
      <div ref={playbackRef} className="settings-group" data-testid="settings-group-playback">
        <div className="settings-group-title">播放与音质</div>
        <div className="miuix-card" style={{ gap: 4, padding: '8px 10px' }}>
          <button
            type="button"
            className="pref-row tap-soft"
            onClick={() => openSheet('quality')}
          >
            <div className="pref-text">
              <span className="pref-title">默认播放音质</span>
              <span className="pref-sub">
                {qualityOpt?.name || '自动'} · {qualityOpt?.spec || ''}
                {isMeteredNetwork && mobileQualityLimit ? '（移动网已限档 320K）' : ''}
              </span>
            </div>
            <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>切换 →</span>
          </button>

          <ToggleRow
            title="移动网络自动限档"
            subtitle={`当前：${isMeteredNetwork ? '移动网络' : 'Wi-Fi / 非计量网络'} · 蜂窝流量下最高 320K`}
            checked={mobileQualityLimit}
            onChange={(v) => setPreference('mobileQualityLimit', v)}
          />

          <ToggleRow
            title="下一首预解析与无缝切歌"
            subtitle="提前解析链接并写入 ExoPlayer 队列，锁屏稳定连播"
            checked={preloadNextEnabled}
            onChange={(v) => setPreference('preloadNextEnabled', v)}
          />

          <ToggleRow
            title="失效歌曲自动跳过"
            subtitle="自动连播遇到版权受限或异常音源时顺延至下一首"
            checked={autoSkipFailed}
            onChange={(v) => setPreference('autoSkipFailed', v)}
          />
        </div>

        <div className="miuix-card">
          <div className="card-head-row">
            <span className="card-label">睡眠定时</span>
            <span className="card-hint">
              {sleepTimerMode === 'track'
                ? '本首结束后暂停'
                : sleepTimerEndsAt
                  ? `剩余 ${formatCountdown(sleepTimerEndsAt)}`
                  : '未开启'}
            </span>
          </div>
          <div className="sleep-chip-grid">
            {SLEEP_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                className={`sleep-chip tap ${sleepTimerMode === opt.mode ? 'active' : ''}`}
                onClick={() => setSleepTimer(opt.mode)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            由原生 Media3 后台服务执行，锁屏后到点自动音量淡出并暂停
          </div>
        </div>
      </div>

      {/* Section 2: Lyrics & Visuals */}
      <div ref={lyricsRef} className="settings-group" data-testid="settings-group-lyrics">
        <div className="settings-group-title">歌词与视效</div>
        <div className="miuix-card" style={{ gap: 4, padding: '8px 10px' }}>
          <ToggleRow
            title="逐字歌词动效"
            subtitle="开启流光逐字扫词与微浮韵律"
            checked={showVerbatim}
            onChange={(v) => setPreference('showVerbatim', v)}
          />
          <ToggleRow
            title="双语翻译歌词"
            subtitle="在歌词下方显示中文译文"
            checked={showTranslation}
            onChange={(v) => setPreference('showTranslation', v)}
          />
          <ToggleRow
            title="日韩罗马音"
            subtitle="展示外语歌词音译注音"
            checked={showRomaji}
            onChange={(v) => setPreference('showRomaji', v)}
          />

          <div style={{ padding: '8px 6px 6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="pref-title">歌词字号</span>
              <span className="pref-sub">即时预览生效</span>
            </div>
            <div className="seg-3">
              <div
                className="seg-3-thumb"
                style={{ transform: `translate3d(${activeLyricSizeIdx * 100}%, 0, 0)` }}
              />
              {LYRIC_SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`seg-3-opt ${lyricFontSize === opt.value ? 'active' : ''}`}
                  onClick={() => setLyricFontSize(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <ToggleRow
            title="动态流体背景"
            subtitle="CPlayer 原版 Aura-Music WebGL 流光背景"
            checked={fluidMotion}
            onChange={(v) => setPreference('fluidMotion', v)}
          />
          <ToggleRow
            title="流体省电模式"
            subtitle="降低渲染分辨率并限制 30fps（后台及暂停自动休眠）"
            checked={fluidPowerSave}
            onChange={(v) => setPreference('fluidPowerSave', v)}
          />
        </div>
      </div>

      {/* Section 3: Storage & Cache */}
      <div ref={storageRef} className="settings-group" data-testid="settings-group-storage">
        <div className="settings-group-title">存储与缓存</div>
        <div className="miuix-card" style={{ gap: 10 }}>
          <div className="card-head-row" style={{ gap: 10 }}>
            <div className="pref-text">
              <span className="pref-title">音频边听边存（500 MB LRU）</span>
              <span className="pref-sub">
                已占用 {formatBytesMb(cacheStats.audioBytes)} · 听过的歌自动缓存秒开
              </span>
            </div>
            <button
              type="button"
              className="pill-btn tap"
              style={{ flexShrink: 0 }}
              onClick={() => {
                clearAudioCache();
                refreshCacheSummary();
              }}
            >
              清理音频
            </button>
          </div>

          <div className="card-head-row" style={{ gap: 10 }}>
            <div className="pref-text">
              <span className="pref-title">歌单与歌词本地缓存</span>
              <span className="pref-sub">
                已缓存 {cacheStats.playlistCount} 个歌单 · {cacheStats.lyricCount} 首歌词
              </span>
            </div>
            <button
              type="button"
              className="pill-btn tap"
              style={{ flexShrink: 0 }}
              onClick={() => {
                void clearMetadataCache().then(refreshCacheSummary);
              }}
            >
              清理数据
            </button>
          </div>
        </div>
      </div>

      {/* Section 4: About & Updates */}
      <div ref={aboutRef} className="settings-group" data-testid="settings-group-about">
        <div className="settings-group-title">关于与更新</div>
        <div className="miuix-card">
          <div className="card-head-row">
            <div className="pref-text">
              <span className="pref-title">检查版本更新</span>
              <span className="pref-sub">当前版本 v{APP_VERSION}</span>
            </div>
            <button
              type="button"
              className="pill-btn tap"
              disabled={checkingUpdate}
              onClick={() => void onCheckUpdate()}
            >
              <IconRefresh size={13} />
              <span>{checkingUpdate ? '检查中...' : '检查更新'}</span>
            </button>
          </div>

          {updateError && (
            <div style={{ fontSize: 12, color: '#fca5a5' }}>{updateError}</div>
          )}

          {updateResult && (
            <div className="info-panel">
              {updateResult.hasUpdate ? (
                <>
                  <div className="info-row">
                    <span>发现新版本</span>
                    <strong>v{updateResult.latestVersion}</strong>
                  </div>
                  {updateResult.releaseNotes && (
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                      {updateResult.releaseNotes.slice(0, 260)}
                    </div>
                  )}
                  <button
                    type="button"
                    className="primary-btn tap"
                    style={{ height: 36, fontSize: 13 }}
                    onClick={() => openExternalLink(updateResult.downloadUrl)}
                  >
                    <IconDownload size={14} />
                    <span>前往下载新版 APK</span>
                  </button>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                  {updateResult.noPublishedRelease
                    ? `当前版本 v${APP_VERSION}（GitHub Releases 暂未发布 Tag 版本）`
                    : `已是最新版本（v${APP_VERSION}）`}
                </div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="version-footer"
          data-testid="version-footer"
          onClick={onVersionTap}
        >
          CPlayer Native v{APP_VERSION}
        </button>

        {showAdvanced && (
          <div className="miuix-card form-stack" data-testid="easter-egg-endpoints">
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}>
              开发者服务配置
            </div>
            <input
              className="field"
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="https://api.chksz.com/api"
            />
            <input
              className="field"
              value={syncApi}
              onChange={(e) => setSyncApi(e.target.value)}
              placeholder="https://sync.chksz.top/api/v1"
            />
            <button
              type="button"
              className="primary-btn tap"
              onClick={() => updateEndpoints(apiBase, syncApi)}
            >
              保存接口配置
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportNeteaseSheetBody() {
  const importNeteasePlaylist = usePlayerStore((s) => s.importNeteasePlaylist);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setBusy(true);
    try {
      await importNeteasePlaylist(input);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form-stack" onSubmit={onSubmit}>
      <input
        className="field"
        type="text"
        placeholder="粘贴网易云歌单 ID 或分享链接"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <button type="submit" className="primary-btn tap" disabled={busy}>
        {busy ? <span className="spinner dark" /> : '拉取歌单'}
      </button>
    </form>
  );
}

function CreatePlaylistSheetBody() {
  const createCloudPlaylist = usePlayerStore((s) => s.createCloudPlaylist);
  const [name, setName] = useState('');

  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void createCloudPlaylist(name);
      }}
    >
      <input
        className="field"
        type="text"
        placeholder="输入新歌单名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="primary-btn tap">
        创建
      </button>
    </form>
  );
}

function PlaylistManageSheetBody() {
  const activeCloudPlaylistId = usePlayerStore((s) => s.activeCloudPlaylistId);
  const activePlaylistName = usePlayerStore((s) => s.activePlaylistName);
  const renameCloudPlaylist = usePlayerStore((s) => s.renameCloudPlaylist);
  const deleteCloudPlaylist = usePlayerStore((s) => s.deleteCloudPlaylist);

  const [name, setName] = useState(activePlaylistName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(activePlaylistName);
    setConfirmDelete(false);
  }, [activeCloudPlaylistId, activePlaylistName]);

  if (!activeCloudPlaylistId) return null;

  const onRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await renameCloudPlaylist(activeCloudPlaylistId, name);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteCloudPlaylist(activeCloudPlaylistId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack" style={{ gap: 14 }}>
      <form className="miuix-card form-stack" onSubmit={onRename}>
        <div className="card-label">重命名歌单</div>
        <input
          className="field"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入新的歌单名称"
        />
        <button type="submit" className="primary-btn tap" disabled={busy}>
          保存名称
        </button>
      </form>

      <div className="miuix-card">
        <div className="card-label" style={{ color: '#fca5a5' }}>危险操作</div>
        {confirmDelete ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="secondary-btn tap"
              style={{ flex: 1, height: 38 }}
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="danger-btn tap"
              style={{ flex: 1, height: 38 }}
              disabled={busy}
              onClick={() => void onDelete()}
            >
              确认永久删除
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="danger-btn tap"
            style={{ width: '100%', height: 38 }}
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash size={14} />
            <span>删除当前歌单</span>
          </button>
        )}
      </div>
    </div>
  );
}

function TrackActionSheetBody() {
  const track = usePlayerStore((s) => s.sheetTrackTarget);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const activeCloudPlaylistId = usePlayerStore((s) => s.activeCloudPlaylistId);
  const favoriteTrackIds = usePlayerStore((s) => s.favoriteTrackIds);
  const playTrackNow = usePlayerStore((s) => s.playTrackNow);
  const playNextInQueue = usePlayerStore((s) => s.playNextInQueue);
  const toggleFavorite = usePlayerStore((s) => s.toggleFavorite);
  const switchSourceForTrack = usePlayerStore((s) => s.switchSourceForTrack);
  const addTrackToCloudPlaylist = usePlayerStore((s) => s.addTrackToCloudPlaylist);
  const removeTrackFromActivePlaylist = usePlayerStore((s) => s.removeTrackFromActivePlaylist);
  const closeSheet = usePlayerStore((s) => s.closeSheet);

  if (!track) return null;
  const isFav = favoriteTrackIds.includes(String(track.id));

  return (
    <div className="form-stack">
      <button
        type="button"
        className="sheet-card tap-soft"
        style={{ width: '100%', color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}
        onClick={() => {
          void playTrackNow(track);
          closeSheet();
        }}
      >
        <span>立即播放</span>
      </button>
      <button
        type="button"
        className="sheet-card tap-soft"
        style={{ width: '100%', color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}
        onClick={() => {
          playNextInQueue(track);
          closeSheet();
        }}
      >
        <span>下一首播放</span>
      </button>
      <button
        type="button"
        className="sheet-card tap-soft"
        style={{ width: '100%', color: isFav ? '#fda4af' : 'var(--ink)', fontSize: 14, fontWeight: 600 }}
        onClick={() => {
          void toggleFavorite(track);
          closeSheet();
        }}
      >
        <span>{isFav ? '从我喜欢的音乐移除' : '收藏到我喜欢的音乐'}</span>
        <IconHeart size={16} filled={isFav} />
      </button>
      <button
        type="button"
        className="sheet-card tap-soft"
        style={{ width: '100%', color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}
        onClick={() => switchSourceForTrack(track)}
      >
        <span>换源搜索（跨平台试听）</span>
        <IconSwap size={16} />
      </button>

      {cloudPlaylists.length > 0 && (
        <div className="info-panel">
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>添加到云歌单</div>
          {cloudPlaylists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              className="sheet-card tap-soft"
              style={{ width: '100%', color: 'var(--ink)', fontSize: 13.5, marginBottom: 4 }}
              onClick={() => {
                void addTrackToCloudPlaylist(pl.id, track);
                closeSheet();
              }}
            >
              <span>{pl.name}</span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{pl.trackCount} 首</span>
            </button>
          ))}
        </div>
      )}

      {activeCloudPlaylistId && (
        <button
          type="button"
          className="sheet-card tap-soft"
          style={{ width: '100%', color: '#fca5a5', fontSize: 14, fontWeight: 600 }}
          onClick={() => {
            void removeTrackFromActivePlaylist(track.id);
            closeSheet();
          }}
        >
          <span>从当前歌单移除</span>
        </button>
      )}
    </div>
  );
}
