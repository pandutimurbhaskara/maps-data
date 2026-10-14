import type { DatasetDoc, KeplerMapConfig, LayerDoc, RGB } from './mapDoc';

export type RGBA = [number, number, number, number];

export interface LayerStyle {
  fillColor: RGBA;
  lineColor: RGBA;
  filled: boolean;
  stroked: boolean;
  pointRadius: number;
  lineWidth: number;
}

export interface SourceArgs {
  type: 'table' | 'query';
  source: string;
  spatialDataColumn: string;
  columns?: string[];
  queryParameters?: Record<string, unknown>;
}

export type LayerDescriptor =
  | { kind: 'vector'; id: string; source: SourceArgs; style: LayerStyle }
  | { kind: 'h3'; id: string; source: SourceArgs & { aggregationExp: string; aggregationResLevel: number }; style: LayerStyle };

export const DEFAULT_COLOR: RGB = [18, 147, 154];
const DEFAULT_OPACITY = 0.8;

// M1 subset: tileset (vector) and h3 layers with a single colour (spec §4.4).
export function layersFromDoc(doc: KeplerMapConfig, datasets: DatasetDoc[]): { layers: LayerDescriptor[]; warnings: string[] } {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const layers: LayerDescriptor[] = [];
  const warnings: string[] = [];
  for (const layer of doc.config.visState?.layers ?? []) {
    if (layer.config.isVisible === false) continue;
    const ds = byId.get(layer.config.dataId);
    if (!ds) {
      warnings.push(`layer ${layer.id}: dataset ${layer.config.dataId} not found`);
      continue;
    }
    const isH3 = ds.spatialIndex === 'h3';
    const source: SourceArgs = {
      type: ds.type,
      source: ds.source,
      spatialDataColumn: ds.geoColumn ?? (isH3 ? 'h3' : 'geom'),
      ...(ds.columns?.length ? { columns: ds.columns } : {}),
      ...(ds.queryParameters ? { queryParameters: ds.queryParameters } : {}),
    };
    const style = styleOf(layer);
    if (layer.type === 'tileset' && !isH3) {
      layers.push({ kind: 'vector', id: layer.id, source, style });
    } else if (layer.type === 'h3' && isH3) {
      layers.push({
        kind: 'h3',
        id: layer.id,
        source: { ...source, aggregationExp: ds.aggregationExp ?? '1 AS __aggregationValue', aggregationResLevel: ds.aggregationResLevel ?? 4 },
        style,
      });
    } else {
      warnings.push(`layer ${layer.id}: type ${layer.type} over a ${isH3 ? 'h3' : 'geo'} dataset is not supported yet`);
    }
  }
  // kepler lists the top layer first; deck.gl draws later layers on top
  return { layers: layers.reverse(), warnings };
}

function styleOf(layer: LayerDoc): LayerStyle {
  const vis = layer.config.visConfig ?? {};
  const [r, g, b] = layer.config.color ?? DEFAULT_COLOR;
  const [sr, sg, sb] = vis.strokeColor ?? [r, g, b];
  return {
    fillColor: [r, g, b, Math.round((vis.opacity ?? DEFAULT_OPACITY) * 255)],
    lineColor: [sr, sg, sb, 255],
    filled: vis.filled ?? true,
    stroked: vis.stroked ?? false,
    pointRadius: vis.radius ?? 4,
    lineWidth: vis.thickness ?? 1,
  };
}
