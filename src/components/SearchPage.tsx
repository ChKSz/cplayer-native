import { useRef } from 'react';
import { trackCoverOrFallback, usePlayerStore } from '../stores/usePlayerStore';
import { SOURCE_META, songSourceOf, type MusicSource } from '../types/music';
import { IconClose, IconMore, IconSearch, IconTrash } from './Icons';

const SOURCES: MusicSource[] = ['wy', 'qq', 'kg'];

export function SearchPage() {
  const searchSource = usePlayerStore((s) => s.searchSource);
  const searchQuery = usePlayerStore((s) => s.searchQuery);
  const searchResults = usePlayerStore((s) => s.searchResults);
  const searchHistory = usePlayerStore((s) => s.searchHistory);
  const searching = usePlayerStore((s) => s.searching);
  const searchError = usePlayerStore((s) => s.searchError);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const setSearchSource = usePlayerStore((s) => s.setSearchSource);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);
  const executeSearch = usePlayerStore((s) => s.executeSearch);
  const removeSearchHistory = usePlayerStore((s) => s.removeSearchHistory);
  const clearAllSearchHistory = usePlayerStore((s) => s.clearAllSearchHistory);
  const playTrackNow = usePlayerStore((s) => s.playTrackNow);
  const openSheet = usePlayerStore((s) => s.openSheet);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSourceIndex = Math.max(0, SOURCES.indexOf(searchSource));

  const onInputChange = (val: string) => {
    setSearchQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void executeSearch(val);
    }, 360);
  };

  const runHistoryTerm = (term: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchQuery(term);
    void executeSearch(term);
  };

  return (
    <section className="page" data-page="2">
      <div className="page-header">
        <h2 className="page-title">搜索</h2>
      </div>

      <form
        className="search-shell"
        onSubmit={(e) => {
          e.preventDefault();
          if (debounceRef.current) clearTimeout(debounceRef.current);
          void executeSearch();
        }}
      >
        <IconSearch size={16} />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={`在${SOURCE_META[searchSource].name}搜索歌曲、歌手或 ID...`}
          autoComplete="off"
        />
        {searchQuery && (
          <button
            type="button"
            className="icon-btn ghost tap"
            style={{ width: 26, height: 26, fontSize: 13 }}
            aria-label="清空搜索词"
            onClick={() => {
              setSearchQuery('');
              void executeSearch('');
            }}
          >
            ✕
          </button>
        )}
      </form>

      {/* Sliding Segmented Source Switcher */}
      <div className="source-segment">
        <div
          className="source-thumb"
          style={{ transform: `translate3d(${activeSourceIndex * 100}%, 0, 0)` }}
        />
        {SOURCES.map((src) => (
          <button
            key={src}
            type="button"
            className={`source-opt ${searchSource === src ? 'active' : ''}`}
            onClick={() => setSearchSource(src)}
          >
            {SOURCE_META[src].name}
          </button>
        ))}
      </div>

      {/* Results & Recent History */}
      <div className="track-list">
        {searching ? (
          <div className="empty-box">
            <span className="spinner" />
            <span>正在搜索 {SOURCE_META[searchSource].name}...</span>
          </div>
        ) : searchError ? (
          <div className="empty-box">
            <span>{searchError}</span>
            {searchError.includes('登录') && (
              <button
                type="button"
                className="primary-btn tap"
                onClick={() => openSheet('account')}
              >
                去登录 CPlayerSync
              </button>
            )}
          </div>
        ) : searchResults.length > 0 ? (
          searchResults.map((track, i) => {
            const isCur = currentTrack && String(currentTrack.id) === String(track.id);
            const src = songSourceOf(track.id);
            return (
              <div
                key={`${track.id}-${i}`}
                className={`track-row tap-soft ${isCur ? 'playing' : ''}`}
                onClick={() => void playTrackNow(track)}
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
        ) : !searchQuery.trim() && searchHistory.length > 0 ? (
          <div className="history-section">
            <div className="history-head">
              <span className="history-title">最近搜索</span>
              <button
                type="button"
                className="icon-btn ghost tap"
                style={{ width: 'auto', height: 26, padding: '0 8px', gap: 4, fontSize: 11.5 }}
                onClick={() => clearAllSearchHistory()}
              >
                <IconTrash size={13} />
                <span>清空</span>
              </button>
            </div>
            <div className="history-chips">
              {searchHistory.map((term) => (
                <div key={term} className="history-chip">
                  <button
                    type="button"
                    className="history-chip-label tap"
                    onClick={() => runHistoryTerm(term)}
                  >
                    {term}
                  </button>
                  <button
                    type="button"
                    className="history-chip-del tap"
                    aria-label={`删除搜索历史 ${term}`}
                    onClick={() => removeSearchHistory(term)}
                  >
                    <IconClose size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="empty-box">
            <span>输入关键词或网易云歌曲 ID</span>
            <span style={{ fontSize: 12, opacity: 0.65 }}>
              支持网易云 / QQ 音乐 / 酷狗多源检索
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
