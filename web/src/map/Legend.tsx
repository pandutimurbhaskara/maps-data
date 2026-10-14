import type { LayerDescriptor } from '@carto/api-client';
import { rgbToHex } from '../lib/color';
import type { LayerDoc } from '../lib/mapDoc';

type Scale = { type: string; domain?: unknown[]; range?: string[] };
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function legendEntries(layer: LayerDoc, descriptor?: LayerDescriptor) {
  const title = layer.config.label;
  const vis = layer.config.visConfig;
  if (vis.colorAggregation === 'custom' && vis.colorAggregationExp && !vis.colorAggregationDomain) return { title, entries: [], empty: true };
  const scale = (descriptor?.scales as Record<string, Scale> | undefined)?.fillColor;
  if (!scale) return { title, entries: [{ label: title, color: rgbToHex(layer.config.color) }], empty: false };
  const range = scale.range ?? [];
  const domain = scale.domain ?? [];
  if (!range.length || !domain.length) return { title, entries: [], empty: true };
  if (scale.type === 'ordinal') {
    return { title, entries: domain.slice(0, range.length).map((d, i) => ({ label: String(d ?? 'null'), color: range[i] })), empty: false };
  }
  const nums = domain.map(Number);
  const lowers =
    scale.type === 'quantile' && nums.length >= range.length
      ? nums.slice(0, range.length)
      : range.map((_, i) => nums[0] + (i * (nums[nums.length - 1] - nums[0])) / range.length);
  return { title, entries: range.map((color, i) => ({ label: `≥ ${fmt.format(lowers[i])}`, color })), empty: false };
}

export function Legend({ layers, descriptors }: { layers: LayerDoc[]; descriptors: (LayerDescriptor | undefined)[] }) {
  const visible = layers.filter((l) => l.config.isVisible);
  if (!visible.length) return null;
  return (
    <div className="legend" aria-label="Legend">
      {visible.map((l) => {
        const { title, entries, empty } = legendEntries(l, descriptors.find((d) => (d?.props as { id?: string } | undefined)?.id === l.id));
        return (
          <section key={l.id}>
            <h4>{title}</h4>
            {empty ? (
              <p className="muted">No data</p>
            ) : (
              <ul>
                {entries.map((e, i) => (
                  <li key={i}>
                    <i style={{ background: e.color }} /> {e.label}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
