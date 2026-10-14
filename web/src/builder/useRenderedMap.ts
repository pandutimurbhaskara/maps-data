import type { Layer } from '@deck.gl/core';
import { useEffect, useMemo, useState } from 'react';
import { prepareMap, type PreparedMap, type RenderContext } from '../map/prepareMap';
import { toDeckLayers } from '../map/toDeckLayers';
import type { BuilderState } from './state';

// useRenderedMap re-runs the CARTO pipeline when anything that affects rendering changes (not on pan/zoom).
export function useRenderedMap(state: BuilderState, ctx: RenderContext, delayMs = 300) {
  const [out, setOut] = useState<{ prepared: PreparedMap | null; layers: Layer[]; error: string | null }>({ prepared: null, layers: [], error: null });
  const c = state.map.keplerMapConfig.config;
  const datasets = useMemo(() => state.datasets.filter((d) => !state.errors[d.id]), [state.datasets, state.errors]);
  const key = JSON.stringify([c.visState.layers, c.filters, c.popupSettings, datasets]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      prepareMap(state.map, datasets, ctx).then(
        (prepared) => !cancelled && setOut({ prepared, layers: toDeckLayers(prepared.parsed.layers), error: null }),
        (e: Error) => !cancelled && setOut((o) => ({ ...o, error: e.message })),
      );
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // key captures everything rendering depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return out;
}
