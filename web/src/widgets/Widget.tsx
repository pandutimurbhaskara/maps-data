import { addFilter, FilterType, removeFilter, type Filters, type SpatialFilter, type WidgetSource } from '@carto/api-client';
import { useEffect, useState } from 'react';
import type { WidgetDoc } from '../lib/mapDoc';
import type { LoadedDataset } from '../map/prepareMap';

type Opts = { filters: Filters; filterOwner: string; spatialFilter?: SpatialFilter };
type Category = { name: string | null; value: number };
export type WidgetData =
  | { kind: 'formula'; value: number | null }
  | { kind: 'category'; rows: Category[] }
  | { kind: 'histogram'; ticks: number[]; values: number[] }
  | { kind: 'range'; min: number | null; max: number | null }
  | { kind: 'table'; rows: Record<string, unknown>[]; total: number }
  | { kind: 'timeseries'; rows: { name: number; value: number }[] };

// the SDK types range bounds and series names loosely (number | string); mapsd always sends numbers
const toNum = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function equalTicks(min: number, max: number, buckets: number): number[] {
  if (!(max > min)) return [];
  return Array.from({ length: buckets - 1 }, (_, i) => +(min + ((i + 1) * (max - min)) / buckets).toPrecision(12));
}

export async function loadWidget(w: WidgetDoc, ws: WidgetSource, opts: Opts): Promise<WidgetData> {
  switch (w.type) {
    case 'formula': {
      const r = await ws.getFormula({ ...opts, column: w.operation === 'count' ? '*' : w.column, operation: w.operation });
      return { kind: 'formula', value: r.value ?? null };
    }
    case 'category': {
      const rows = await ws.getCategories({ ...opts, column: w.column, operation: w.operation, operationColumn: w.operationColumn ?? w.column });
      return { kind: 'category', rows: rows as Category[] };
    }
    case 'histogram': {
      const r = await ws.getRange({ ...opts, column: w.column });
      const ticks = w.ticks ?? equalTicks(toNum(r?.min) ?? 0, toNum(r?.max) ?? 0, 10);
      if (!ticks.length) return { kind: 'histogram', ticks, values: [] };
      const values = await ws.getHistogram({ ...opts, column: w.column, operation: 'count', ticks });
      return { kind: 'histogram', ticks, values };
    }
    case 'range': {
      const r = await ws.getRange({ ...opts, column: w.column });
      return { kind: 'range', min: toNum(r?.min), max: toNum(r?.max) };
    }
    case 'table': {
      const r = await ws.getTable({ ...opts, columns: w.columns ?? [w.column], limit: 10 });
      return { kind: 'table', rows: r.rows as Record<string, unknown>[], total: r.totalCount };
    }
    case 'timeseries': {
      const r = await ws.getTimeSeries({ ...opts, column: w.column, stepSize: w.stepSize ?? 'day', operation: w.operation, operationColumn: w.operationColumn ?? w.column });
      return { kind: 'timeseries', rows: r.rows.map((row) => ({ name: toNum(row.name) ?? 0, value: row.value })) };
    }
  }
}

export function toggleCategory(filters: Filters, w: WidgetDoc, name: string): Filters {
  const next = structuredClone(filters);
  const mine = next[w.column]?.[FilterType.IN];
  const current = mine?.owner === w.id ? ((mine.values as string[]) ?? []) : [];
  const values = current.includes(name) ? current.filter((v) => v !== name) : [...current, name];
  removeFilter(next, { column: w.column, owner: w.id });
  if (values.length) addFilter(next, { column: w.column, type: FilterType.IN, values, owner: w.id });
  return next;
}

function clearOwn(filters: Filters, w: WidgetDoc): Filters {
  const next = structuredClone(filters);
  removeFilter(next, { column: w.column, owner: w.id });
  return next;
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface WidgetProps {
  widget: WidgetDoc;
  dataset?: LoadedDataset;
  filters: Filters;
  spatialFilter?: SpatialFilter;
  onFilter?: (filters: Filters) => void;
}

export function Widget({ widget, dataset, filters, spatialFilter, onFilter }: WidgetProps) {
  const [data, setData] = useState<WidgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([widget, filters, spatialFilter, dataset?.data.tiles?.[0]]);

  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    loadWidget(widget, dataset.data.widgetSource, { filters, filterOwner: widget.id, spatialFilter }).then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
    // key captures every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!dataset) return <p className="muted">Source not loaded</p>;
  if (error)
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (!data) return <p className="muted">Loading…</p>;

  switch (data.kind) {
    case 'formula':
      return <p className="formula">{data.value === null ? '–' : fmt.format(data.value)}</p>;
    case 'range':
      return <p className="formula">{data.min === null ? '–' : `${fmt.format(data.min)} – ${fmt.format(data.max ?? data.min)}`}</p>;
    case 'category': {
      const max = Math.max(1, ...data.rows.map((r) => r.value ?? 0));
      const mine = filters[widget.column]?.[FilterType.IN];
      const selected = mine?.owner === widget.id ? (mine.values as string[]) : [];
      return (
        <div>
          <ul className="bars">
            {data.rows.map((r) => {
              const name = r.name ?? 'null';
              return (
                <li key={name}>
                  <button className="bar-row" aria-pressed={selected.includes(name)} onClick={() => onFilter?.(toggleCategory(filters, widget, name))}>
                    <span>{name}</span>
                    <span>{fmt.format(r.value)}</span>
                    <i style={{ width: `${(100 * (r.value ?? 0)) / max}%` }} />
                  </button>
                </li>
              );
            })}
          </ul>
          {selected.length > 0 && <button onClick={() => onFilter?.(clearOwn(filters, widget))}>Clear</button>}
        </div>
      );
    }
    case 'histogram':
    case 'timeseries': {
      const values = data.kind === 'histogram' ? data.values : data.rows.map((r) => r.value);
      const labels =
        data.kind === 'histogram' ? ['<', ...data.ticks.map((t) => `≥${fmt.format(t)}`)] : data.rows.map((r) => new Date(r.name).toISOString().slice(0, 10));
      const max = Math.max(1, ...values);
      return (
        <ul className="columns" aria-label={widget.title}>
          {values.map((v, i) => (
            <li key={i} title={`${labels[i] ?? ''}: ${fmt.format(v)}`}>
              <i style={{ height: `${(100 * v) / max}%` }} />
            </li>
          ))}
        </ul>
      );
    }
    case 'table':
      return (
        <table className="widget-table">
          <thead>
            <tr>
              {(widget.columns ?? [widget.column]).map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>
                {(widget.columns ?? [widget.column]).map((c) => (
                  <td key={c}>{String(r[c] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <caption>{fmt.format(data.total)} rows</caption>
        </table>
      );
  }
}
