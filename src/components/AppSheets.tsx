import { useEffect, useRef, useState } from 'react';
import {
  cpSync,
  musicService,
  trackCoverOrFallback,
  usePlayerStore,
  type SleepTimerMode,
} from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf } from '../types/music';
import { IconCheck } from './Icons';

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
      return <AccountSheetBody onRequestExpand={onRequestExpand} />;
    case 'importNetease':
      return <ImportNeteaseSheetBody />;
    case 'createPlaylist':
      return <CreatePlaylistSheetBody />;
    case 'trackAction':
      return <TrackActionSheetBody />;
    default:
      return null;
  }
}

export function getSheetHeaderMeta(): { title: string; subtitle: string } {
  const st = usePlayerStore.getState();
  switch (st.activeSheet) {
    case 'queue':
      return {
        title: '当前播放队列',
        subtitle:
          st.playMode === 'random'
            ? `${st.queue.length} 首 · 随机打乱队列`
            : `${st.queue.length} 首`,
      };
    case 'quality':
      return {
        title: '音质选择',
        subtitle: '网易云支持多档音质切换',
      };
    case 'account':
      return {
        title: st.user ? '我的与设置' : '登录账号',
        subtitle: '云歌单与播放偏好',
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
    case 'trackAction':
      return {
        title: st.sheetTrackTarget?.name || '歌曲操作',
        subtitle: st.sheetTrackTarget?.artist || '',
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
  const closeSheet = usePlayerStore((s) => s.closeSheet);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const activeIdx =
    currentIndex >= 0 && currentIndex < queue.length
      ? currentIndex
      : currentTrack
        ? queue.findIndex((t) => String(t.id) === String(currentTrack.id))
        : -1;

  // Automatically locate the currently playing track when Queue sheet opens
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
      {playMode === 'random' && queue.length > 1 && (
        <div
          className="sheet-card"
          data-testid="shuffle-queue-hint"
          style={{
            marginBottom: 10,
            padding: '9px 12px',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4 }}>
            随机播放已打乱当前队列，左右滑唱片将按此顺序切歌
          </span>
          <button
            type="button"
            className="pill-btn tap"
            style={{ height: 28, padding: '0 10px', fontSize: 11.5, flexShrink: 0 }}
            onClick={() => reshuffleQueue()}
          >
            重新洗牌
          </button>
        </div>
      )}
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
          </div>
        );
      })}
    </div>
  );
}

function QualitySheetBody() {
  const quality = usePlayerStore((s) => s.quality);
  const setQuality = usePlayerStore((s) => s.setQuality);

  return (
    <div role="radiogroup" aria-label="音质选择">
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

const SLEEP_OPTIONS: { mode: SleepTimerMode; label: string }[] = [
  { mode: 'off', label: '关闭' },
  { mode: '15', label: '15分' },
  { mode: '30', label: '30分' },
  { mode: '60', label: '60分' },
  { mode: 'track', label: '播完本首' },
];

function formatCountdown(endsAt: number | null): string {
  if (!endsAt) return '';
  const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

function AccountSheetBody({ onRequestExpand }: { onRequestExpand?: () => void }) {
  const user = usePlayerStore((s) => s.user);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const login = usePlayerStore((s) => s.login);
  const register = usePlayerStore((s) => s.register);
  const logout = usePlayerStore((s) => s.logout);
  const refreshCloudPlaylists = usePlayerStore((s) => s.refreshCloudPlaylists);
  const updateEndpoints = usePlayerStore((s) => s.updateEndpoints);
  const showToast = usePlayerStore((s) => s.showToast);

  const showVerbatim = usePlayerStore((s) => s.showVerbatim);
  const showTranslation = usePlayerStore((s) => s.showTranslation);
  const showRomaji = usePlayerStore((s) => s.showRomaji);
  const fluidMotion = usePlayerStore((s) => s.fluidMotion);
  const setPreference = usePlayerStore((s) => s.setPreference);

  const sleepTimerMode = usePlayerStore((s) => s.sleepTimerMode);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [, setClockTick] = useState(0);

  // Hidden Easter Egg: tap version footer 5 times to unlock developer endpoints
  const [eggClicks, setEggClicks] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [apiBase, setApiBase] = useState(musicService.baseUrl);
  const [syncApi, setSyncApi] = useState(cpSync.baseUrl);

  useEffect(() => {
    if (!sleepTimerEndsAt) return;
    const id = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt]);

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

  return (
    <div className="form-stack" style={{ gap: 12, paddingBottom: 18 }}>
      {/* 1. Account Card */}
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
                已同步 {cloudPlaylists.length} 个云歌单
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

      {/* 2. Sleep Timer Card */}
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
      </div>

      {/* 3. Lyrics & Appearance Card */}
      <div className="miuix-card" style={{ gap: 2, padding: '8px 10px' }}>
        <div style={{ padding: '6px 6px 4px', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
          歌词与视效
        </div>
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
        <ToggleRow
          title="动态流体背景"
          subtitle="CPlayer 原版流光背景，关闭可省电"
          checked={fluidMotion}
          onChange={(v) => setPreference('fluidMotion', v)}
        />
      </div>

      {/* 4. Hidden Easter Egg Footer (tap 5 times to reveal custom API inputs) */}
      <button
        type="button"
        className="version-footer"
        data-testid="version-footer"
        onClick={onVersionTap}
      >
        CPlayer v1.0.0
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

function TrackActionSheetBody() {
  const track = usePlayerStore((s) => s.sheetTrackTarget);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const activeCloudPlaylistId = usePlayerStore((s) => s.activeCloudPlaylistId);
  const playTrackNow = usePlayerStore((s) => s.playTrackNow);
  const playNextInQueue = usePlayerStore((s) => s.playNextInQueue);
  const addTrackToCloudPlaylist = usePlayerStore((s) => s.addTrackToCloudPlaylist);
  const removeTrackFromActivePlaylist = usePlayerStore((s) => s.removeTrackFromActivePlaylist);
  const closeSheet = usePlayerStore((s) => s.closeSheet);

  if (!track) return null;

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
