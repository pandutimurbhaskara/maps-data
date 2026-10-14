import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { deleteDataset, getDatasets, getMap, patchMap, saveDataset } from '../lib/workspaceApi';
import { MapSurface } from '../map/MapSurface';
import type { Viewport } from '../map/MapView';
import { renderContext } from '../pages/ViewerPage';
import { LayersPanel } from './LayersPanel';
import { ParamsPanel } from './ParamsPanel';
import { SourcesPanel } from './SourcesPanel';
import { WidgetsPanel } from './WidgetsPanel';
import { WidgetsColumn } from '../widgets/WidgetsColumn';
import { useViewportFilter } from '../widgets/useViewportFilter';
import { builderReducer, initState, type BuilderState } from './state';
import { useAutosave, type SaveApi, type SaveStatus } from './useAutosave';
import { useRenderedMap } from './useRenderedMap';

export type BuilderTab = 'sources' | 'layers' | 'widgets' | 'parameters';

const defaultApi: SaveApi = { patchMap, saveDataset, deleteDataset };

const STATUS: Record<SaveStatus, string> = { idle: 'All changes saved', saving: 'Saving…', saved: 'Saved', error: 'Not saved — retrying on next change' };

export function BuilderPage({ api = defaultApi, fetcher = fetch, autosaveDelayMs = 800 }: { api?: SaveApi; fetcher?: typeof fetch; autosaveDelayMs?: number }) {
  const { id = '' } = useParams();
  const [initial, setInitial] = useState<BuilderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getMap(id, fetcher), getDatasets(id, fetcher)]).then(
      ([map, datasets]: [MapDoc, DatasetDoc[]]) => !cancelled && setInitial(initState(map, datasets)),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [id, fetcher]);
  if (error) return <p role="alert">{error}</p>;
  if (!initial) return <p className="loading">Loading…</p>;
  return <Builder key={id} initial={initial} api={api} fetcher={fetcher} autosaveDelayMs={autosaveDelayMs} />;
}

function Builder({ initial, api, fetcher, autosaveDelayMs }: { initial: BuilderState; api: SaveApi; fetcher: typeof fetch; autosaveDelayMs: number }) {
  const [state, dispatch] = useReducer(builderReducer, initial);
  const status = useAutosave(state, dispatch, api, autosaveDelayMs);
  const ctx = useMemo(renderContext, []);
  const rendered = useRenderedMap(state, ctx);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const spatialFilter = useViewportFilter(viewport);
  const [tab, setTab] = useState<BuilderTab>('sources');
  const c = state.map.keplerMapConfig.config;

  function onViewportChange(v: Viewport) {
    setViewport(v);
    dispatch({ type: 'setMapState', mapState: { latitude: v.latitude, longitude: v.longitude, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing } });
  }

  const tabs: [BuilderTab, string][] = [
    ['sources', 'Sources'],
    ['layers', 'Layers'],
    ['widgets', 'Widgets'],
    ['parameters', 'Parameters'],
  ];
  return (
    <div className="builder">
      <header className="builder-header">
        <Link to="/maps">Maps</Link>
        <input aria-label="Map title" value={state.map.title} onChange={(e) => dispatch({ type: 'renameMap', title: e.target.value })} />
        <span className="save-status">{STATUS[status]}</span>
        {rendered.error && (
          <span role="alert" className="error">
            {rendered.error}
          </span>
        )}
        <Link to={`/viewer/${state.map.id}`}>Preview</Link>
      </header>
      <aside className="builder-left">
        <nav role="tablist" className="tabs">
          {tabs.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        {tab === 'sources' && <SourcesPanel datasets={state.datasets} errors={state.errors} layerCount={c.visState.layers.length} dispatch={dispatch} fetcher={fetcher} />}
        {tab === 'layers' && (
          <LayersPanel
            layers={c.visState.layers}
            datasets={state.datasets}
            loaded={rendered.prepared?.datasets ?? []}
            popupSettings={c.popupSettings}
            dispatch={dispatch}
            viewport={viewport}
            ctx={ctx}
            fetcher={fetcher}
          />
        )}
        {tab === 'widgets' && <WidgetsPanel widgets={c.widgets} datasets={state.datasets} loaded={rendered.prepared?.datasets ?? []} dispatch={dispatch} />}
        {tab === 'parameters' && <ParamsPanel params={c.sqlParameters} dispatch={dispatch} />}
      </aside>
      <main className="builder-map">
        <MapSurface config={c} layers={rendered.layers} descriptors={rendered.prepared?.parsed.layers ?? []} onViewportChange={onViewportChange} fetcher={fetcher} />
      </main>
      <aside className="builder-right">
        <WidgetsColumn
          widgets={c.widgets}
          datasets={rendered.prepared?.datasets ?? []}
          filters={c.filters}
          spatialFilter={spatialFilter}
          onFilter={(datasetId, filters) => dispatch({ type: 'setFilters', datasetId, filters })}
        />
      </aside>
    </div>
  );
}
