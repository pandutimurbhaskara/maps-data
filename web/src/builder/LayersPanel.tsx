import { getColumnNameFromGeoColumn } from '@carto/api-client';
import { useState, type Dispatch } from 'react';
import { clearColorBy, h3Expression, setColumnColorBy, setH3ColorBy } from '../lib/aggregation';
import { hexToRgb, rgbToHex } from '../lib/color';
import { newLayer, PALETTES } from '../lib/defaults';
import { h3ColorDomain } from '../lib/h3Domain';
import type { DatasetDoc, LayerDoc, MapConfig, Operation, ScaleType } from '../lib/mapDoc';
import type { Viewport } from '../map/MapView';
import type { LoadedDataset, RenderContext } from '../map/prepareMap';
import type { Action } from './state';

const OPS: Operation[] = ['sum', 'avg', 'min', 'max'];

export function parseH3Expression(exp: string | null): { op: Operation; column?: string } | null {
  if (!exp) return null;
  if (exp === 'count(*)') return { op: 'count' };
  const m = exp.match(/^(sum|avg|min|max)\("((?:[^"]|"")*)"\)$/);
  return m ? { op: m[1] as Operation, column: m[2].replaceAll('""', '"') } : null;
}

export interface LayersPanelProps {
  layers: LayerDoc[];
  datasets: DatasetDoc[];
  loaded: LoadedDataset[];
  popupSettings: MapConfig['popupSettings'];
  dispatch: Dispatch<Action>;
  viewport: Viewport | null;
  ctx: RenderContext;
  fetcher?: typeof fetch;
}

export function LayersPanel({ layers, datasets, loaded, popupSettings, dispatch, viewport, ctx, fetcher = fetch }: LayersPanelProps) {
  const [newSource, setNewSource] = useState('');
  return (
    <section className="panel">
      <h2>Layers</h2>
      <ul className="panel-list">
        {layers.map((layer, i) => (
          <LayerItem
            key={layer.id}
            layer={layer}
            dataset={loaded.find((d) => d.id === layer.config.dataId)}
            popupFields={(popupSettings.layers[layer.id]?.click?.fields ?? []).map((f) => f.name)}
            isFirst={i === 0}
            isLast={i === layers.length - 1}
            dispatch={dispatch}
            viewport={viewport}
            ctx={ctx}
            fetcher={fetcher}
          />
        ))}
      </ul>
      <div className="row">
        <select aria-label="New layer source" value={newSource} onChange={(e) => setNewSource(e.target.value)}>
          <option value="">Choose a source…</option>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <button
          disabled={!newSource}
          onClick={() => {
            const ds = datasets.find((d) => d.id === newSource)!;
            dispatch({ type: 'addLayer', layer: newLayer(ds.geoColumn.startsWith('h3:') ? 'h3' : 'tileset', ds, layers.length) });
          }}
        >
          Add layer
        </button>
      </div>
      <p className="credit">Colors: CARTOColors (CC BY 4.0)</p>
    </section>
  );
}

interface LayerItemProps {
  layer: LayerDoc;
  dataset?: LoadedDataset;
  popupFields: string[];
  isFirst: boolean;
  isLast: boolean;
  dispatch: Dispatch<Action>;
  viewport: Viewport | null;
  ctx: RenderContext;
  fetcher: typeof fetch;
}

function LayerItem({ layer, dataset, popupFields, isFirst, isLast, dispatch, viewport, ctx, fetcher }: LayerItemProps) {
  const [error, setError] = useState<string | null>(null);
  const label = layer.config.label;
  const vis = layer.config.visConfig;
  const vc = layer.visualChannels;
  const update = (fn: (l: LayerDoc) => LayerDoc) => dispatch({ type: 'updateLayer', id: layer.id, update: fn });
  const spatial = dataset ? getColumnNameFromGeoColumn(dataset.geoColumn) : null;
  const fields = (dataset?.data.schema ?? []).filter((c) => c.name !== spatial && c.type !== 'geometry' && c.name !== '_carto_feature_id');
  const numeric = fields.filter((f) => f.type === 'number');
  const isH3 = layer.type === 'h3';
  const h3 = isH3 ? parseH3Expression(vis.colorAggregationExp) : null;
  const colorValue = isH3 ? (h3 ? `${h3.op}:${h3.column ?? ''}` : '') : (vc.colorField?.name ?? '');
  const palette = vis.colorRange.name;
  const steps = vis.colorRange.colors.length;

  async function restyle(next: { value?: string; palette?: string; scale?: ScaleType; steps?: number }) {
    const value = next.value ?? colorValue;
    const pal = next.palette ?? palette;
    const st = next.steps ?? steps;
    setError(null);
    if (!value) {
      update(clearColorBy);
      return;
    }
    if (!isH3) {
      const field = fields.find((f) => f.name === value)!;
      const scale: ScaleType = field.type === 'string' ? 'ordinal' : (next.scale ?? (vc.colorScale === 'ordinal' ? 'quantize' : vc.colorScale));
      const p = field.type === 'string' && !next.palette && vc.colorField?.name !== value ? 'Bold' : pal;
      update((l) => setColumnColorBy(l, { name: field.name, kind: field.type }, scale, p, st));
      return;
    }
    const [op, column] = value.split(':') as [Operation, string];
    const scale: ScaleType = next.scale ?? (vc.colorScale === 'ordinal' ? 'quantize' : vc.colorScale);
    const expression = h3Expression(op, column || undefined);
    let domain: number[] | null = null;
    if (dataset && viewport) {
      try {
        domain = await h3ColorDomain({ dataset, expression, scale, steps: st, viewport, ctx, fetcher });
      } catch (e) {
        setError((e as Error).message);
      }
    }
    update((l) => setH3ColorBy(l, op, column || undefined, scale, pal, st, domain));
  }

  return (
    <li>
      <div className="row">
        <label>
          <input
            type="checkbox"
            aria-label={`Show ${label}`}
            checked={layer.config.isVisible}
            onChange={(e) => {
              const isVisible = e.target.checked; // read now: the update runs later, inside the reducer
              update((l) => ({ ...l, config: { ...l.config, isVisible } }));
            }}
          />{' '}
          <input aria-label={`Name of ${label}`} value={label} onChange={(e) => {
              const name = e.target.value;
              update((l) => ({ ...l, config: { ...l.config, label: name } }));
            }} />
        </label>
        <span>
          <button aria-label={`Move ${label} up`} disabled={isFirst} onClick={() => dispatch({ type: 'moveLayer', id: layer.id, delta: -1 })}>
            ↑
          </button>
          <button aria-label={`Move ${label} down`} disabled={isLast} onClick={() => dispatch({ type: 'moveLayer', id: layer.id, delta: 1 })}>
            ↓
          </button>
          <button aria-label={`Remove ${label}`} onClick={() => dispatch({ type: 'removeLayer', id: layer.id })}>
            ✕
          </button>
        </span>
      </div>
      <div className="row">
        <label>
          Fill{' '}
          <input
            type="color"
            aria-label={`Fill color of ${label}`}
            value={rgbToHex(layer.config.color)}
            onChange={(e) => {
              const color = hexToRgb(e.target.value);
              update((l) => ({ ...l, config: { ...l.config, color } }));
            }}
          />
        </label>
        <label>
          Opacity{' '}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            aria-label={`Opacity of ${label}`}
            value={vis.opacity}
            onChange={(e) => {
              const opacity = Number(e.target.value);
              update((l) => ({ ...l, config: { ...l.config, visConfig: { ...l.config.visConfig, opacity } } }));
            }}
          />
        </label>
        {!isH3 && (
          <label>
            Radius{' '}
            <input
              type="number"
              min={1}
              max={50}
              aria-label={`Radius of ${label}`}
              value={vis.radius}
              onChange={(e) => {
                const radius = Number(e.target.value);
                update((l) => ({ ...l, config: { ...l.config, visConfig: { ...l.config.visConfig, radius } } }));
              }}
            />
          </label>
        )}
      </div>
      <label>
        Color based on{' '}
        <select aria-label={`Color ${label} by`} value={colorValue} onChange={(e) => restyle({ value: e.target.value })}>
          <option value="">None (single color)</option>
          {isH3 ? (
            <>
              <option value="count:">Count of rows</option>
              {numeric.flatMap((f) =>
                OPS.map((op) => (
                  <option key={`${op}:${f.name}`} value={`${op}:${f.name}`}>
                    {`${op} of ${f.name}`}
                  </option>
                )),
              )}
            </>
          ) : (
            fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))
          )}
        </select>
      </label>
      {colorValue && (
        <div className="row">
          <select aria-label={`Palette of ${label}`} value={palette} onChange={(e) => restyle({ palette: e.target.value })}>
            {PALETTES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {vc.colorScale !== 'ordinal' && (
            <select aria-label={`Scale of ${label}`} value={vc.colorScale} onChange={(e) => restyle({ scale: e.target.value as ScaleType })}>
              <option value="quantize">Equal intervals</option>
              <option value="quantile">Quantiles</option>
            </select>
          )}
          <select aria-label={`Steps of ${label}`} value={steps} onChange={(e) => restyle({ steps: Number(e.target.value) })}>
            {[3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} steps
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {fields.length > 0 && (
        <details>
          <summary>Popup fields</summary>
          {fields.map((f) => (
            <label key={f.name}>
              <input
                type="checkbox"
                aria-label={`Popup: ${f.name}`}
                checked={popupFields.includes(f.name)}
                onChange={(e) =>
                  dispatch({ type: 'setPopupFields', layerId: layer.id, fields: e.target.checked ? [...popupFields, f.name] : popupFields.filter((n) => n !== f.name) })
                }
              />{' '}
              {f.name}
            </label>
          ))}
        </details>
      )}
    </li>
  );
}
