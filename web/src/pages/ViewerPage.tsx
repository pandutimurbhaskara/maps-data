import { MapboxOverlay } from '@deck.gl/mapbox';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { layersFromDoc } from '../lib/layersFromDoc';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';
import { getDatasets, getMap, getPublicMap } from '../lib/workspaceApi';
import { basemapStyle, OSM_ATTRIBUTION } from '../map/basemaps';
import { toDeckLayer } from '../map/deckLayers';

type Loaded = { doc: MapDoc; datasets: DatasetDoc[] };

export async function loadPrivate(id: string): Promise<Loaded> {
  const [doc, datasets] = await Promise.all([getMap(id), getDatasets(id)]);
  return { doc, datasets };
}

export async function loadPublic(id: string): Promise<Loaded> {
  const { datasets, ...doc } = await getPublicMap(id);
  return { doc, datasets };
}

export function ViewerPage({ load }: { load: (id: string) => Promise<Loaded> }) {
  const { id = '' } = useParams();
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load(id).then(setState, (e: Error) => setError(e.message));
  }, [id, load]);

  useEffect(() => {
    if (!state || !container.current) return;
    const { mapState, basemapConfig } = state.doc.keplerMapConfig.config;
    const map = new MapLibreMap({
      container: container.current,
      style: basemapStyle(basemapConfig?.styleId),
      center: [mapState.longitude, mapState.latitude],
      zoom: mapState.zoom,
      pitch: mapState.pitch ?? 0,
      bearing: mapState.bearing ?? 0,
      attributionControl: { compact: false, customAttribution: OSM_ATTRIBUTION },
    });
    const { layers, warnings } = layersFromDoc(state.doc.keplerMapConfig, state.datasets);
    warnings.forEach((w) => console.warn('[viewer]', w));
    map.addControl(new MapboxOverlay({ layers: layers.map(toDeckLayer) }));
    return () => map.remove();
  }, [state]);

  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="viewer">
      <header>
        <h1>{state?.doc.title ?? 'Loading…'}</h1>
      </header>
      <div ref={container} className="viewer-map" />
    </div>
  );
}
