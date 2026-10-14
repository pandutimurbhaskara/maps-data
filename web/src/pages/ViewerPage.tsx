import type { Layer } from '@deck.gl/core';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { normalizeConfig } from '../lib/defaults';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { getDatasets, getMap, getPublicMap } from '../lib/workspaceApi';
import { MapView } from '../map/MapView';
import { prepareMap } from '../map/prepareMap';
import { toDeckLayers } from '../map/toDeckLayers';

type Loaded = { doc: MapDoc; datasets: DatasetDoc[] };

export async function loadPrivate(id: string): Promise<Loaded> {
  const [doc, datasets] = await Promise.all([getMap(id), getDatasets(id)]);
  return { doc: { ...doc, keplerMapConfig: normalizeConfig(doc.keplerMapConfig) }, datasets };
}

export async function loadPublic(id: string): Promise<Loaded> {
  const { datasets, ...doc } = await getPublicMap(id);
  return { doc: { ...doc, keplerMapConfig: normalizeConfig(doc.keplerMapConfig) }, datasets };
}

// M1 dev auth ignores the token; M3 switches to authMode: 'session'.
export const renderContext = () => ({ apiBaseUrl: window.location.origin, accessToken: 'dev' });

export function ViewerPage({ load }: { load: (id: string) => Promise<Loaded> }) {
  const { id = '' } = useParams();
  const [state, setState] = useState<Loaded | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load(id).then(
      async (loaded) => {
        const { parsed } = await prepareMap(loaded.doc, loaded.datasets, renderContext());
        if (cancelled) return;
        setState(loaded);
        setLayers(toDeckLayers(parsed.layers));
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [id, load]);

  if (error) return <p role="alert">{error}</p>;
  if (!state) return <p className="loading">Loading…</p>;
  const { config } = state.doc.keplerMapConfig;
  return (
    <div className="viewer">
      <header>
        <h1>{state.doc.title}</h1>
      </header>
      <MapView styleId={config.basemapConfig.styleId} initialViewState={config.mapState} layers={layers} />
    </div>
  );
}
