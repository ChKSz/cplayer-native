import { useEffect, useMemo, useRef, useState } from 'react';
import { trackCoverOrFallback, usePlayerStore } from '../stores/usePlayerStore';
import { songSourceOf } from '../types/music';
import {
  IconClose,
  IconCloud,
  IconEdit,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
} from './Icons';

const PAGE_CHUNK = 80;

export function PlaylistPage() {
  const user = usePlayerStore((s) => s.user);
  const syncStatus = usePlayerStore((s) => s.syncStatus);
  const sleepTimerMode = usePlayerStore((s) => s.sleepTimerMode);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const activePlaylistKey = usePlayerStore((s) => s.activePlaylistKey);
  const activePlaylistName = usePlayerStore((s) => s.activePlaylistName);
  const activePlaylistTracks = usePlayerStore((s) => s.activePlaylistTracks);
  const activeCloudPlaylistId = usePlayerStore((s) => s.activeCloudPlaylistId);
  const activeNeteasePlaylistId = usePlayerStore((s) => s.activeNeteasePlaylistId);
  const loadingPlaylist = usePlayerStore((s) => s.loadingPlaylist);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const selectCloudPlaylist = usePlayerStore((s) => s.selectCloudPlaylist);
  const saveNeteasePlaylistToCloud = usePlayerStore((s) => s.saveNeteasePlaylistToCloud);
  const playTrackList = usePlayerStore((s) => s.playTrackList);
  const openSheet = usePlayerStore((s) => s.openSheet);

  const [filterQuery, setFilterQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_CHUNK);
  const [savingToCloud, setSavingToCloud] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFilterQuery('');
    setVisibleCount(PAGE_CHUNK);
  }, [activePlaylistKey]);

  const filteredEntries = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const mapped = activePlaylistTracks.map((track, originalIndex) => ({
      track,
      originalIndex,
    }));
    if (!q) return mapped;
    return mapped.filter(
      ({ track }) =>
        track.name.toLowerCase().includes(q) ||
        track.artist.toLowerCase().includes(q) ||
        (track.album && track.album.toLowerCase().includes(q)),
    );
  }, [activePlaylistTracks, filterQuery]);

  // Expand progressive window if active track is below initial chunk so auto-scroll finds it
  useEffect(() => {
    if (!currentTrack || filterQuery.trim()) return;
    const idx = filteredEntries.findIndex(
      ({ track }) => String(track.id) === String(currentTrack.id),
    );
    if (idx >= visibleCount) {
      setVisibleCount(Math.min(filteredEntries.length, idx + 40));
    }
  }, [currentTrack?.id, filteredEntries, visibleCount, filterQuery]);

  // Automatically locate the currently playing track when opening/switching a playlist
  useEffect(() => {
    if (!currentTrack || filterQuery.trim()) return;
    const t = setTimeout(() => {
      const scroller = listRef.current;
      const row = activeRowRef.current;
      if (!scroller || !row) return;
      const targetTop = row.offsetTop - scroller.clientHeight * 0.25;
      scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    }, 60);
    return () => clearTimeout(t);
  }, [activePlaylistKey, activePlaylistTracks.length, currentTrack?.id, filterQuery]);

  const visibleEntries = useMemo(
    () => filteredEntries.slice(0, visibleCount),
    [filteredEntries, visibleCount],
  );

  const handleListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (visibleCount < filteredEntries.length) {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < 360) {
        setVisibleCount((prev) => Math.min(filteredEntries.length, prev + PAGE_CHUNK));
      }
    }
  };

  const onSaveNetease = async () => {
    setSavingToCloud(true);
    try {
      await saveNeteasePlaylistToCloud();
    } finally {
      setSavingToCloud(false);
    }
  };

  const statusText = !user
    ? '点击登录'
    : syncStatus === 'syncing'
      ? '同步中...'
      : syncStatus === 'offline'
        ? '离线镜像'
        : '云端已同步';

  return (
    <section className="page" data-page="1">
      <div className="page-header">
        <h2 className="page-title">歌单</h2>
        <div className="top-bar-actions">
          <button
            type="button"
            className="pill-btn tap"
            onClick={() => openSheet('account')}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: !user
                  ? 'rgba(255,255,255,0.4)'
                  : syncStatus === 'offline'
                    ? '#f59e0b'
                    : '#34d399',
              }}
            />
            <span>{statusText}</span>
          </button>

          <button
            type="button"
            className="icon-btn tap"
            aria-label="应用设置"
            onClick={() => openSheet('settings')}
          >
            <IconSettings size={18} />
            {sleepTimerMode !== 'off' && <span className="timer-dot" />}
          </button>
        </div>
      </div>

      {/* Horizontal Cloud Playlist & NetEase ID Import Chips */}
      <div className="chip-row">
        {cloudPlaylists.map((pl) => {
          const isAct = activePlaylistKey === `cloud:${pl.id}`;
          return (
            <button
              key={pl.id}
              type="button"
              className={`chip tap ${isAct ? 'active' : ''}`}
              onClick={() => void selectCloudPlaylist(pl.id)}
            >
              <span>{pl.name}</span>
              <span style={{ opacity: 0.65, fontSize: 11 }}>{pl.trackCount}</span>
            </button>
          );
        })}

        <button
          type="button"
          className="chip tap"
          onClick={() => openSheet('importNetease')}
        >
          <IconPlus size={14} />
          <span>网易云 ID</span>
        </button>

        <button
          type="button"
          className="chip tap"
          onClick={() => openSheet('createPlaylist')}
        >
          <IconPlus size={14} />
          <span>新建云歌单</span>
        </button>
      </div>

      {/* In-Playlist Filter & Management Toolbar */}
      {activePlaylistTracks.length > 0 && !loadingPlaylist && (
        <div className="playlist-toolbar">
          <div className="filter-input-wrap">
            <IconSearch size={14} />
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => {
                setFilterQuery(e.target.value);
                setVisibleCount(PAGE_CHUNK);
              }}
              placeholder={`筛选「${activePlaylistName}」(${activePlaylistTracks.length})...`}
              autoComplete="off"
            />
            {filterQuery && (
              <button
                type="button"
                className="icon-btn ghost tap"
                style={{ width: 22, height: 22 }}
                aria-label="清空筛选"
                onClick={() => setFilterQuery('')}
              >
                <IconClose size={12} />
              </button>
            )}
          </div>

          {activeCloudPlaylistId && (
            <button
              type="button"
              className="pill-btn tap"
              style={{ height: 32, flexShrink: 0 }}
              onClick={() => openSheet('playlistManage')}
            >
              <IconEdit size={13} />
              <span>管理</span>
            </button>
          )}

          {activeNeteasePlaylistId && (
            <button
              type="button"
              className="pill-btn tap"
              style={{ height: 32, flexShrink: 0 }}
              disabled={savingToCloud}
              onClick={() => void onSaveNetease()}
            >
              <IconCloud size={14} />
              <span>{savingToCloud ? '保存中...' : '存为云歌单'}</span>
            </button>
          )}
        </div>
      )}

      {/* Track List */}
      <div
        ref={listRef}
        className="track-list"
        style={{ position: 'relative' }}
        onScroll={handleListScroll}
      >
        {loadingPlaylist ? (
          <div className="empty-box">
            <span className="spinner" />
            <span>正在加载歌单...</span>
          </div>
        ) : visibleEntries.length > 0 ? (
          <>
            {visibleEntries.map(({ track, originalIndex }) => {
              const isCur = currentTrack && String(currentTrack.id) === String(track.id);
              const src = songSourceOf(track.id);
              return (
                <div
                  key={`${track.id}-${originalIndex}`}
                  ref={isCur ? activeRowRef : null}
                  className={`track-row tap-soft ${isCur ? 'playing' : ''}`}
                  onClick={() =>
                    void playTrackList(activePlaylistTracks, originalIndex, {
                      kind: activeCloudPlaylistId ? 'cloud' : 'netease',
                      playlistId: activeCloudPlaylistId,
                    })
                  }
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
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {track.name}
                      </span>
                    </div>
                    <div className="track-sub">
                      {track.artist}
                      {track.album ? ` · ${track.album}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn ghost tap"
                    aria-label="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSheet('trackAction', track);
                    }}
                  >
                    <IconMore size={16} />
                  </button>
                </div>
              );
            })}

            {visibleCount < filteredEntries.length && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
                <button
                  type="button"
                  className="pill-btn tap"
                  onClick={() =>
                    setVisibleCount((prev) => Math.min(filteredEntries.length, prev + PAGE_CHUNK))
                  }
                >
                  已显示 {visibleEntries.length} / {filteredEntries.length} 首 · 加载更多
                </button>
              </div>
            )}
          </>
        ) : activePlaylistTracks.length > 0 && filterQuery.trim() ? (
          <div className="empty-box">
            <span>未找到匹配「{filterQuery.trim()}」的歌曲</span>
            <button
              type="button"
              className="pill-btn tap"
              onClick={() => setFilterQuery('')}
            >
              清空筛选
            </button>
          </div>
        ) : (
          <div className="empty-box">
            <span>{activePlaylistName || '暂无歌单'}</span>
            <span style={{ fontSize: 12, opacity: 0.72 }}>
              {user
                ? '输入网易云歌单 ID 或新建云歌单开始听歌'
                : '登录 CPlayerSync 账号以同步云歌单并解锁无损播放'}
            </span>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              {!user ? (
                <button
                  type="button"
                  className="primary-btn tap"
                  onClick={() => openSheet('account')}
                >
                  登录 CPlayerSync
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-btn tap"
                  onClick={() => openSheet('importNetease')}
                >
                  导入网易云歌单
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
