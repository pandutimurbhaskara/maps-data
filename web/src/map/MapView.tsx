import type { Layer, PickingInfo } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, type ReactNode } from 'react';
import type { MapState } from '../lib/mapDoc';
import { basemapStyle, OSM_ATTRIBUTION } from './basemaps';
import './maplibreWorker';

export interface Viewport {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
  latitude: number;
  longitude: number;
  pitch: number;
  bearing: number;
}

export interface MapViewProps {
  styleId?: string;
  initialViewState: MapState;
  layers: Layer[];
  onViewportChange?: (v: Viewport) => void;
  onClick?: (info: PickingInfo) => void;
  onLoad?: (api: { flyTo: FlyTo }) => void;
  children?: ReactNode;
}

// MapView owns one MapLibre map + deck.gl overlay for its lifetime; props update them in place.
export function MapView({ styleId, initialViewState, layers, onViewportChange, onClick, onLoad, children }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const style = useRef(styleId);
  const onViewport = useRef(onViewportChange);
  const onPick = useRef(onClick);
  onViewport.current = onViewportChange;
  onPick.current = onClick;

  useEffect(() => {
    if (!container.current) return;
    const m = new MapLibreMap({
      container: container.current,
      style: basemapStyle(style.current),
      center: [initialViewState.longitude, initialViewState.latitude],
      zoom: initialViewState.zoom,
      pitch: initialViewState.pitch ?? 0,
      bearing: initialViewState.bearing ?? 0,
      attributionControl: { compact: false, customAttribution: OSM_ATTRIBUTION },
    });
    const o = new MapboxOverlay({ layers: [], onClick: (info) => onPick.current?.(info) });
    m.addControl(o);
    const report = () => {
      const b = m.getBounds();
      const c = m.getCenter();
      onViewport.current?.({
        west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(),
        zoom: m.getZoom(), latitude: c.lat, longitude: c.lng, pitch: m.getPitch(), bearing: m.getBearing(),
      });
    };
    m.on('moveend', report);
    m.once('load', report);
    map.current = m;
    overlay.current = o;
    onLoad?.({ flyTo: (lng, lat, zoom = 15) => m.flyTo({ center: [lng, lat], zoom }) });
    return () => {
      map.current = null;
      overlay.current = null;
      m.remove();
    };
    // the map is created once; initialViewState only seeds it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    overlay.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    if (styleId !== style.current) {
      style.current = styleId;
      map.current?.setStyle(basemapStyle(styleId));
    }
  }, [styleId]);

  return (
    <div className="map-view">
      <div ref={container} className="map-canvas" />
      {children}
    </div>
  );
}

/** flyTo is exposed for the geocoder (Task 16). */
export type FlyTo = (lng: number, lat: number, zoom?: number) => void;
