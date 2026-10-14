import { getColumnNameFromGeoColumn } from '@carto/api-client';
import { useState, type Dispatch } from 'react';
import { newWidget } from '../lib/defaults';
import type { DatasetDoc, Operation, WidgetDoc, WidgetType } from '../lib/mapDoc';
import type { LoadedDataset } from '../map/prepareMap';
import type { Action } from './state';

const TYPES: WidgetType[] = ['formula', 'category', 'histogram', 'range', 'table', 'timeseries'];
const OPS: Operation[] = ['count', 'sum', 'avg', 'min', 'max'];

export function WidgetsPanel({ widgets, datasets, loaded, dispatch }: { widgets: WidgetDoc[]; datasets: DatasetDoc[]; loaded: LoadedDataset[]; dispatch: Dispatch<Action> }) {
  const [type, setType] = useState<WidgetType>('formula');
  const [source, setSource] = useState('');
  const [column, setColumn] = useState('');
  const [operation, setOperation] = useState<Operation>('count');
  const ds = loaded.find((d) => d.id === source);
  const spatial = ds ? getColumnNameFromGeoColumn(ds.geoColumn) : null;
  const columns = (ds?.data.schema ?? []).filter((c) => c.name !== spatial && c.type !== 'geometry');
  const needsColumn = !(type === 'formula' && operation === 'count');

  return (
    <section className="panel">
      <h2>Widgets</h2>
      <ul className="panel-list">
        {widgets.map((w) => (
          <li key={w.id}>
            <div className="row">
              <input aria-label={`Title of ${w.title}`} value={w.title} onChange={(e) => dispatch({ type: 'updateWidget', id: w.id, patch: { title: e.target.value } })} />
              <button aria-label={`Remove ${w.title}`} onClick={() => dispatch({ type: 'removeWidget', id: w.id })}>
                ✕
              </button>
            </div>
            <small>
              {w.type} · {datasets.find((d) => d.id === w.dataSource)?.label ?? '?'} · {w.operation} {w.column}
            </small>
          </li>
        ))}
      </ul>
      <h3>Add a widget</h3>
      <label>
        Type{' '}
        <select aria-label="Widget type" value={type} onChange={(e) => setType(e.target.value as WidgetType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Source{' '}
        <select aria-label="Widget source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose…</option>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {(type === 'formula' || type === 'category' || type === 'timeseries') && (
        <label>
          Operation{' '}
          <select aria-label="Widget operation" value={operation} onChange={(e) => setOperation(e.target.value as Operation)}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      )}
      {needsColumn && (
        <label>
          Column{' '}
          <select aria-label="Widget column" value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="">Choose…</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        disabled={!source || (needsColumn && !column)}
        onClick={() => {
          const w = { ...newWidget(type, source, needsColumn ? column : '*'), operation };
          dispatch({ type: 'addWidget', widget: w });
        }}
      >
        Add widget
      </button>
    </section>
  );
}
