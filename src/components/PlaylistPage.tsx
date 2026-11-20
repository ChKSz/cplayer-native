import { useRef } from 'react';
import { trackCoverOrFallback, usePlayerStore } from '../stores/usePlayerStore';
import { songSourceOf } from '../types/music';
import { IconMore, IconPlus } from './Icons';

export function PlaylistPage() {
  const user = usePlayerStore((s) => s.user);
  const syncStatus = usePlayerStore((s) => s.syncStatus);
  const cloudPlaylists = usePlayerStore((s) => s.cloudPlaylists);
  const activePlaylistKey = usePlayerStore((s) => s.activePlaylistKey);
  const activePlaylistName = usePlayerStore((s) => s.activePlaylistName);
  const activePlaylistTracks = usePlayerStore((s) => s.activePlaylistTracks);
  const activeCloudPlaylistId = usePlayerStore((s) => s.activeCloudPlaylistId);
  const loadingPlaylist = usePlayerStore((s) => s.loadingPlaylist);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const selectCloudPlaylist = usePlayerStore((s) => s.selectCloudPlaylist);
  const playTrackList = usePlayerStore((s) => s.playTrackList);
  const openSheet = usePlayerStore((s) => s.openSheet);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  const hasCurrentInList =
    currentTrack !== null &&
    activePlaylistTracks.some((t) => String(t.id) === String(currentTrack.id));

  const locateCurrentTrack = () => {
    const scroller = listRef.current;
    const row = activeRowRef.current;
    if (!scroller || !row) return;
    const targetTop = row.offsetTop - scroller.clientHeight * 0.35;
    scroller.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasCurrentInList && (
            <button
              type="button"
              className="pill-btn tap"
              onClick={locateCurrentTrack}
            >
              定位在播
            </button>
          )}
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
        </div>
      </div>

      {/* Horizontal Cloud Playlist & NetEase ID Import Chips (NO local JSON import) */}
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

      {/* Track List */}
      <div ref={listRef} className="track-list" style={{ position: 'relative' }}>
        {loadingPlaylist ? (
          <div className="empty-box">
            <span className="spinner" />
            <span>正在加载歌单...</span>
          </div>
        ) : activePlaylistTracks.length > 0 ? (
          activePlaylistTracks.map((track, index) => {
            const isCur = currentTrack && String(currentTrack.id) === String(track.id);
            const src = songSourceOf(track.id);
            return (
              <div
                key={`${track.id}-${index}`}
                ref={isCur ? activeRowRef : null}
                className={`track-row tap-soft ${isCur ? 'playing' : ''}`}
                onClick={() =>
                  void playTrackList(activePlaylistTracks, index, {
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
          })
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
