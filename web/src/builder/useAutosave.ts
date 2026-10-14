import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { dirtyDatasets, hasChanges, type Action, type BuilderState } from './state';

export interface SaveApi {
  patchMap(id: string, body: Pick<MapDoc, 'title' | 'keplerMapConfig'>): Promise<unknown>;
  saveDataset(mapId: string, doc: DatasetDoc): Promise<unknown>;
  deleteDataset(mapId: string, datasetId: string): Promise<unknown>;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// useAutosave saves delayMs after the last change, never runs two saves at once, and acknowledges
// only the revisions it sent, so edits made during a save are saved by the next round.
export function useAutosave(state: BuilderState, dispatch: Dispatch<Action>, api: SaveApi, delayMs = 800): SaveStatus {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const latest = useRef(state);
  latest.current = state;
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const apiRef = useRef(api);
  apiRef.current = api;

  const schedule = useRef<() => void>(() => {});
  schedule.current = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, delayMs);
  };

  async function run() {
    if (inFlight.current) {
      schedule.current();
      return;
    }
    const s = latest.current;
    if (!hasChanges(s)) return;
    inFlight.current = true;
    setStatus('saving');
    const mapRev = s.rev.map;
    const datasets = dirtyDatasets(s);
    const revs = Object.fromEntries(datasets.map((d) => [d.id, s.rev.datasets[d.id] ?? 0]));
    const deleted = [...s.deleted];
    try {
      if (mapRev > s.saved.map) await apiRef.current.patchMap(s.map.id, { title: s.map.title, keplerMapConfig: s.map.keplerMapConfig });
      for (const d of datasets) await apiRef.current.saveDataset(s.map.id, d);
      for (const id of deleted) await apiRef.current.deleteDataset(s.map.id, id);
      dispatch({ type: 'saved', map: mapRev, datasets: revs, deleted });
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }

  useEffect(() => {
    if (hasChanges(state)) schedule.current();
  }, [state]);

  useEffect(() => {
    // Leaving the page with unsaved edits: ask first (the browser shows its own prompt) and start the save.
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!hasChanges(latest.current)) return;
      e.preventDefault();
      void run();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      // Unmounting (Preview, Maps) must not drop the last edit: save now rather than after the debounce.
      // run() issues its first request synchronously, before the next page loads the map; while a save is
      // in flight, the pending timer is kept so the remainder is saved after it.
      if (!hasChanges(latest.current)) clearTimeout(timer.current);
      else if (!inFlight.current) {
        clearTimeout(timer.current);
        void run();
      }
    };
    // run and latest are refs/closures over refs; registering once is intended
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return status;
}
