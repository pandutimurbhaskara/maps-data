import type { LayerDescriptor } from '@carto/api-client';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { useRef, useState } from 'react';
import type { MapConfig } from '../lib/mapDoc';
import { GeocoderBox } from './GeocoderBox';
import { Legend } from './Legend';
import { MapView, type FlyTo, type Viewport } from './MapView';
import { Popup, popupRows, type PopupState } from './Popup';

export interface MapSurfaceProps {
  config: MapConfig;
  layers: Layer[];
  descriptors: (LayerDescriptor | undefined)[];
  onViewportChange?: (v: Viewport) => void;
  fetcher?: typeof fetch;
}

// MapSurface is the map as both builder and viewer show it: basemap + layers + search + legend + click popup.
export function MapSurface({ config, layers, descriptors, onViewportChange, fetcher }: MapSurfaceProps) {
  const fly = useRef<FlyTo | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);

  function onClick(info: PickingInfo) {
    const layer = info.object && info.layer ? config.visState.layers.find((l) => l.id === info.layer!.id) : undefined;
    const fields = layer ? (config.popupSettings.layers[layer.id]?.click?.fields ?? []).map((f) => f.name) : [];
    if (!layer || !fields.length) {
      setPopup(null);
      return;
    }
    setPopup({ x: info.x, y: info.y, title: layer.config.label, rows: popupRows(info.object, fields) });
  }

  return (
    <MapView
      styleId={config.basemapConfig.styleId}
      initialViewState={config.mapState}
      layers={layers}
      onViewportChange={onViewportChange}
      onClick={onClick}
      onLoad={(api) => (fly.current = api.flyTo)}
    >
      <GeocoderBox fetcher={fetcher} onSelect={(p) => fly.current?.(p.longitude, p.latitude, 15)} />
      <Legend layers={config.visState.layers} descriptors={descriptors} />
      <Popup popup={popup} onClose={() => setPopup(null)} />
    </MapView>
  );
}
