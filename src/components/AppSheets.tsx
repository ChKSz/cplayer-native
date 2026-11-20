import { useEffect, useRef, useState } from 'react';
import {
  cpSync,
  getPlayerAuthCredentialSnapshot,
  musicService,
  trackCoverOrFallback,
  usePlayerStore,
} from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf } from '../types/music';
import { IconCheck } from './Icons';

export function SheetContentRenderer({
  onRequestExpand,
  locateTick,
}: {
  onRequestExpand?: () => void;
  locateTick?: number;
}) {
  const activeSheet = usePlayerStore((s) => s.activeSheet);

  switch (activeSheet) {
    case 'queue':
      return <QueueSheetBody locateTick={locateTick || 0} />;
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
        subtitle: `${st.queue.length} 首 · 上下拖拉切换高度`,
      };
    case 'quality':
      return {
        title: '音质选择',
        subtitle: '网易云支持 9 档，自动降级保流畅',
      };
    case 'account':
      return {
        title: st.user ? 'CPlayerSync 账号' : '登录 CPlayerSync',
        subtitle: '成员短票据直连 · 安全隔离',
      };
    case 'importNetease':
      return {
        title: '导入网易云歌单',
        subtitle: '支持歌单 ID 或分享短链',
      };
    case 'createPlaylist':
      return {
        title: '新建云歌单',
        subtitle: '自动同步至 CPlayerSync',
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

function QueueSheetBody({ locateTick }: { locateTick: number }) {
  const queue = usePlayerStore((s) => s.queue);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playTrackList = usePlayerStore((s) => s.playTrackList);
  const closeSheet = usePlayerStore((s) => s.closeSheet);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const activeIdx =
    currentIndex >= 0 && currentIndex < queue.length
      ? currentIndex
      : currentTrack
        ? queue.findIndex((t) => String(t.id) === String(currentTrack.id))
        : -1;

  // Scroll only the parent `.sheet-body` container directly (never scrollIntoView across animated sheets)
  useEffect(() => {
    if (activeIdx < 0) return;
    const timer = setTimeout(() => {
      const row = activeRowRef.current;
      const scroller = listRef.current?.parentElement;
      if (!row || !scroller) return;
      const targetTop = row.offsetTop - scroller.clientHeight * 0.22;
      scroller.scrollTo({
        top: Math.max(0, targetTop),
        behavior: locateTick > 0 ? 'smooth' : 'auto',
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [activeIdx, locateTick, queue.length]);

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
              void playTrackList(queue, idx);
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

function AccountSheetBody({ onRequestExpand }: { onRequestExpand?: () => void }) {
  const user = usePlayerStore((s) => s.user);
  const login = usePlayerStore((s) => s.login);
  const register = usePlayerStore((s) => s.register);
  const logout = usePlayerStore((s) => s.logout);
  const updateEndpoints = usePlayerStore((s) => s.updateEndpoints);
  const showToast = usePlayerStore((s) => s.showToast);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [apiBase, setApiBase] = useState(musicService.baseUrl);
  const [syncApi, setSyncApi] = useState(cpSync.baseUrl);

  const cred = getPlayerAuthCredentialSnapshot();
  const remainingSec = cred ? Math.max(0, Math.floor((cred.expiresAt - Date.now()) / 1000)) : 0;

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

  return (
    <div className="form-stack">
      {user ? (
        <>
          <div className="info-panel">
            <div className="info-row">
              <span>当前账号</span>
              <strong>{user.username}</strong>
            </div>
            <div className="info-row">
              <span>播放凭证 (5 分钟短票)</span>
              <strong style={{ color: cred ? '#34d399' : 'var(--ink-2)' }}>
                {cred ? `有效 · 剩余 ${remainingSec}s` : '播放时自动换票'}
              </strong>
            </div>
            <div className="info-row">
              <span>安全隔离</span>
              <strong>仅发往官方音乐 API</strong>
            </div>
          </div>
          <button
            type="button"
            className="secondary-btn tap"
            onClick={() => void logout()}
          >
            退出当前账号
          </button>
        </>
      ) : (
        <form className="form-stack" onSubmit={submitAuth}>
          <div className="source-segment" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
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
              成员登录
            </button>
            <button
              type="button"
              className={`source-opt ${mode === 'register' ? 'active' : ''}`}
              onClick={() => setMode('register')}
            >
              注册账号
            </button>
          </div>

          <input
            className="field"
            type="text"
            placeholder="CPlayerSync 用户名"
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

      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          className="secondary-btn tap"
          style={{ width: '100%' }}
          onClick={() => {
            const next = !showAdvanced;
            setShowAdvanced(next);
            if (next) onRequestExpand?.();
          }}
        >
          {showAdvanced ? '收起高级接口设置' : '自定义服务地址（可选）'}
        </button>
      </div>

      {showAdvanced && (
        <div className="info-panel">
          <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>音乐 API 地址</label>
          <input
            className="field"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://api.chksz.com/api"
          />
          <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>同步服务地址</label>
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
