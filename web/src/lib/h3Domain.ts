import { _getHexagonResolution, getColumnNameFromGeoColumn } from '@carto/api-client';
import type { LoadedDataset, RenderContext } from '../map/prepareMap';
import { quoteIdent } from './aggregation';
import type { ScaleType } from './mapDoc';

const TILE_SIZE = 512;

export interface H3DomainRequest {
  dataset: LoadedDataset;
  expression: string;
  scale: ScaleType;
  steps: number;
  viewport: { zoom: number; latitude: number };
  ctx: RenderContext;
  fetcher?: typeof fetch;
}

// h3ColorDomain fixes the colour domain of an aggregated H3 layer from the per-cell values at the current
// display resolution (CARTO stores the same thing as visConfig.colorAggregationDomain).
export async function h3ColorDomain({ dataset, expression, scale, steps, viewport, ctx, fetcher = fetch }: H3DomainRequest): Promise<number[] | null> {
  const tileUrl = new URL(dataset.data.tiles[0].replace('{i}', '0'));
  const level = Number(tileUrl.searchParams.get('aggregationResLevel') ?? 4);
  const dataRes = (dataset.data.maxresolution ?? 15 - level) + level;
  const res = Math.min(dataRes, _getHexagonResolution(viewport, TILE_SIZE) + level);
  const col = quoteIdent(getColumnNameFromGeoColumn(dataset.geoColumn) ?? 'h3');
  const from = dataset.type === 'table' ? quoteIdent(dataset.source) : `(${dataset.source})`;
  const q = `SELECT h3_cell_to_parent(${col}, ${res}) AS __cell, ${expression} AS __value FROM ${from} AS __q GROUP BY 1`;
  const params = new URLSearchParams({ q });
  if (dataset.queryParameters) params.set('queryParameters', JSON.stringify(dataset.queryParameters));
  const res2 = await fetcher(`${ctx.apiBaseUrl}/v3/stats/${dataset.connectionName ?? 'osm'}/__value?${params}`, {
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  });
  if (!res2.ok) throw new Error(`stats failed: ${res2.status}`);
  const s = (await res2.json()) as { min?: number; max?: number; quantiles?: Record<string, number[]> };
  if (s.min === undefined || s.min === null) return null;
  if (scale === 'quantile' && s.quantiles?.[String(steps)]) return s.quantiles[String(steps)];
  return [s.min, s.max ?? s.min];
}
