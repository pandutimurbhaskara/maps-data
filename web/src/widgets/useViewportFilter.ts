import { createViewportSpatialFilter, type SpatialFilter } from '@carto/api-client';
import { useEffect, useState } from 'react';
import type { Viewport } from '../map/MapView';

export function useViewportFilter(viewport: Viewport | null, delayMs = 300): SpatialFilter | undefined {
  const [filter, setFilter] = useState<SpatialFilter | undefined>(undefined);
  const key = viewport ? [viewport.west, viewport.south, viewport.east, viewport.north].map((v) => v.toFixed(5)).join(',') : '';
  useEffect(() => {
    if (!viewport) return;
    const t = setTimeout(() => setFilter(createViewportSpatialFilter([viewport.west, viewport.south, viewport.east, viewport.north])), delayMs);
    return () => clearTimeout(t);
    // the key is the viewport bounds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return filter;
}
