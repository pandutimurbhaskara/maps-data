import { useEffect, useMemo, useReducer, useState } from 'react';
import { useParams } from 'react-router';
import { builderReducer, initState, type BuilderState } from '../builder/state';
import { useRenderedMap } from '../builder/useRenderedMap';
import { normalizeConfig } from '../lib/defaults';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { getDatasets, getMap, getPublicMap } from '../lib/workspaceApi';
import { MapSurface } from '../map/MapSurface';
import type { Viewport } from '../map/MapView';
import { ParamControls } from '../map/ParamControls';
import { useViewportFilter } from '../widgets/useViewportFilter';
import { WidgetsColumn } from '../widgets/WidgetsColumn';

type Loaded = { doc: MapDoc; datasets: DatasetDoc[] };

export async function loadPrivate(id: string): Promise<Loaded> {
  const [doc, datasets] = await Promise.all([getMap(id), getDatasets(id)]);
  return { doc: { ...doc, keplerMapConfig: normalizeConfig(doc.keplerMapConfig) }, datasets };
}

export async function loadPublic(id: string): Promise<Loaded> {
  const { datasets, ...doc } = await getPublicMap(id);
  return { doc: { ...doc, keplerMapConfig: normalizeConfig(doc.keplerMapConfig) }, datasets };
}

// M1/M2 dev auth ignores the token; M3 switches to authMode: 'session'.
export const renderContext = () => ({ apiBaseUrl: window.location.origin, accessToken: 'dev' });

export function ViewerPage({ load }: { load: (id: string) => Promise<Loaded> }) {
  const { id = '' } = useParams();
  const [initial, setInitial] = useState<BuilderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    load(id).then(
      (l) => !cancelled && setInitial(initState(l.doc, l.datasets)),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [id, load]);
  if (error) return <p role="alert">{error}</p>;
  if (!initial) return <p className="loading">Loading…</p>;
  return <Viewer key={id} initial={initial} />;
}

// Viewer reuses the builder reducer for local interaction (filters, parameter values) but never saves.
function Viewer({ initial }: { initial: BuilderState }) {
  const [state, dispatch] = useReducer(builderReducer, initial);
  const ctx = useMemo(renderContext, []);
  const rendered = useRenderedMap(state, ctx);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const spatialFilter = useViewportFilter(viewport);
  const c = state.map.keplerMapConfig.config;
  const showParams = c.mapSettings.sqlParameterControls && c.sqlParameters.length > 0;
  return (
    <div className="viewer">
      <header>
        <h1>{state.map.title}</h1>
      </header>
      <div className="viewer-body">
        {showParams && (
          <aside className="viewer-side">
            <ParamControls params={c.sqlParameters} onChange={(param) => dispatch({ type: 'updateSqlParameter', param })} />
          </aside>
        )}
        <MapSurface config={c} layers={rendered.layers} descriptors={rendered.prepared?.parsed.layers ?? []} onViewportChange={setViewport} />
        {c.widgets.length > 0 && (
          <aside className="viewer-side">
            <WidgetsColumn
              widgets={c.widgets}
              datasets={rendered.prepared?.datasets ?? []}
              filters={c.filters}
              spatialFilter={spatialFilter}
              onFilter={(datasetId, filters) => dispatch({ type: 'setFilters', datasetId, filters })}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
