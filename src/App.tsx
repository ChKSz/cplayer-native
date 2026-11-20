import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FluidBackgroundEngine } from './engine/fluidBackground';
import { DraggableBottomDock, type DockExternalSheetHooks } from './components/DraggableBottomDock';
import { DraggableSheet, type DraggableSheetHandle } from './components/DraggableSheet';
import { PlayerPage } from './components/PlayerPage';
import { PlaylistPage } from './components/PlaylistPage';
import { SearchPage } from './components/SearchPage';
import { getSheetHeaderMeta, SheetContentRenderer } from './components/AppSheets';
import { usePlayerStore } from './stores/usePlayerStore';

export function App() {
  const init = usePlayerStore((s) => s.init);
  const activeSheet = usePlayerStore((s) => s.activeSheet);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queueLen = usePlayerStore((s) => s.queue.length);
  const openSheet = usePlayerStore((s) => s.openSheet);
  const closeSheet = usePlayerStore((s) => s.closeSheet);
  const toastMessage = usePlayerStore((s) => s.toastMessage);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const fluidPalette = usePlayerStore((s) => s.fluidPalette);
  const [queueLocateTick, setQueueLocateTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fluidRef = useRef<FluidBackgroundEngine | null>(null);
  const pagerTrackRef = useRef<HTMLDivElement | null>(null);
  const listScrimRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<DraggableSheetHandle | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Mount exact original CPlayer WebGL Fluid Background
  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new FluidBackgroundEngine(canvasRef.current);
    fluidRef.current = engine;
    return () => {
      engine.dispose();
      fluidRef.current = null;
    };
  }, []);

  useEffect(() => {
    fluidRef.current?.setPlaying(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    fluidRef.current?.setPalette(fluidPalette);
  }, [fluidPalette]);

  // Android system Back gesture bridge (dispatched by MainActivity.kt)
  useEffect(() => {
    const onAndroidBack = (e: Event) => {
      const st = usePlayerStore.getState();
      if (st.activeSheet) {
        st.closeSheet();
        e.preventDefault();
        return;
      }
      if (st.activeTab !== 0) {
        st.setActiveTab(0);
        e.preventDefault();
        return;
      }
      if (st.showLyrics) {
        st.setShowLyrics(false);
        e.preventDefault();
      }
    };
    window.addEventListener('cplayer:android-back', onAndroidBack);
    return () => window.removeEventListener('cplayer:android-back', onAndroidBack);
  }, []);

  // 120fps direct DOM coupling between draggable bottom capsule & 3-page track
  const onVisualProgress = useCallback((continuousTabPos: number) => {
    if (pagerTrackRef.current) {
      pagerTrackRef.current.style.transform = `translate3d(${(-continuousTabPos * (100 / 3)).toFixed(4)}%, 0, 0)`;
    }
    if (listScrimRef.current) {
      listScrimRef.current.style.opacity = String(Math.min(1, Math.max(0, continuousTabPos)));
    }
  }, []);

  const sheetHooks = useMemo<DockExternalSheetHooks>(
    () => ({
      beginExternalDrag: (sheetType, clientY) => {
        openSheet(sheetType);
        sheetRef.current?.beginExternalDrag(clientY);
      },
      moveExternalDrag: (clientY) => {
        sheetRef.current?.moveExternalDrag(clientY);
      },
      endExternalDrag: () => {
        sheetRef.current?.endExternalDrag();
      },
    }),
    [openSheet],
  );

  const sheetMeta = getSheetHeaderMeta();

  return (
    <main className="app-shell">
      <canvas ref={canvasRef} className="fluid-canvas" />
      <div className="bg-scrim" />
      <div ref={listScrimRef} className="bg-scrim-list" />

      <div className={`toast ${toastMessage ? 'show' : ''}`} role="status">
        {toastMessage || ''}
      </div>

      <div className="app-content">
        <div className="pager-viewport">
          <div ref={pagerTrackRef} className="pager-track">
            <PlayerPage />
            <PlaylistPage />
            <SearchPage />
          </div>
        </div>

        <DraggableBottomDock onVisualProgress={onVisualProgress} sheetHooks={sheetHooks} />

        <DraggableSheet
          ref={sheetRef}
          open={activeSheet !== null}
          title={sheetMeta.title}
          subtitle={sheetMeta.subtitle}
          headerAction={
            activeSheet === 'queue' && currentTrack && queueLen > 0 ? (
              <button
                type="button"
                className="pill-btn tap"
                style={{ height: 28, fontSize: 11.5 }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setQueueLocateTick((n) => n + 1)}
              >
                定位在播
              </button>
            ) : undefined
          }
          initialDetent={activeSheet === 'quality' ? 'full' : 'half'}
          onClose={closeSheet}
        >
          <SheetContentRenderer
            locateTick={queueLocateTick}
            onRequestExpand={() => sheetRef.current?.expandToFull()}
          />
        </DraggableSheet>
      </div>
    </main>
  );
}
