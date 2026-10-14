import { compileCustomAggregation } from '@carto/api-client';
import { colorRange } from './defaults';
import type { LayerDoc, Operation, ScaleType } from './mapDoc';

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function h3Expression(op: Operation, column?: string): string {
  if (op === 'count') return 'count(*)';
  if (!column) throw new Error(`${op} needs a column`);
  return `${op}(${quoteIdent(column)})`;
}

// The alias parseMap derives for a custom aggregation; the server must return the value under this name.
export const aggregationAlias = (exp: string) => compileCustomAggregation(exp, {} as never);

// buildAggregationExp is the dataset's aggregationExp for its H3 layers (spec M2 D6).
export function buildAggregationExp(datasetId: string, layers: LayerDoc[]): string {
  const parts = ['1 AS __aggregationValue'];
  const seen = new Set<string>();
  for (const l of layers) {
    const v = l.config.visConfig;
    if (l.type !== 'h3' || l.config.dataId !== datasetId || v.colorAggregation !== 'custom' || !v.colorAggregationExp) continue;
    const alias = aggregationAlias(v.colorAggregationExp);
    if (seen.has(alias)) continue;
    seen.add(alias);
    parts.push(`${v.colorAggregationExp} AS ${alias}`);
  }
  return parts.join(', ');
}

export function fieldType(kind: string): string {
  return ({ number: 'real', string: 'string', boolean: 'boolean', timestamp: 'timestamp' } as Record<string, string>)[kind] ?? 'string';
}

export function setColumnColorBy(layer: LayerDoc, field: { name: string; kind: string }, scale: ScaleType, palette: string, steps: number): LayerDoc {
  return {
    ...layer,
    config: { ...layer.config, visConfig: { ...layer.config.visConfig, colorRange: colorRange(palette, steps) } },
    visualChannels: { ...layer.visualChannels, colorField: { name: field.name, type: fieldType(field.kind) }, colorScale: scale },
  };
}

export function setH3ColorBy(
  layer: LayerDoc, op: Operation, column: string | undefined, scale: ScaleType, palette: string, steps: number, domain: number[] | null,
): LayerDoc {
  return {
    ...layer,
    config: {
      ...layer.config,
      visConfig: {
        ...layer.config.visConfig,
        colorRange: colorRange(palette, steps),
        colorAggregation: 'custom',
        colorAggregationExp: h3Expression(op, column),
        colorAggregationDomain: domain,
      },
    },
    visualChannels: { ...layer.visualChannels, colorField: null, colorScale: scale },
  };
}

export function clearColorBy(layer: LayerDoc): LayerDoc {
  return {
    ...layer,
    config: {
      ...layer.config,
      visConfig: {
        ...layer.config.visConfig,
        colorAggregation: layer.type === 'h3' ? 'sum' : null,
        colorAggregationExp: null,
        colorAggregationDomain: null,
      },
    },
    visualChannels: { ...layer.visualChannels, colorField: null },
  };
}
