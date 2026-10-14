import { useState, type Dispatch } from 'react';
import { newDataset, newLayer } from '../lib/defaults';
import type { DatasetDoc } from '../lib/mapDoc';
import { listResources, type Resource } from '../lib/workspaceApi';
import type { Action } from './state';

export interface SourcesPanelProps {
  datasets: DatasetDoc[];
  errors: Record<string, string>;
  layerCount: number;
  dispatch: Dispatch<Action>;
  fetcher?: typeof fetch;
}

export function SourcesPanel({ datasets, errors, layerCount, dispatch, fetcher = fetch }: SourcesPanelProps) {
  const [adding, setAdding] = useState(false);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sql, setSql] = useState('');
  const [spatialColumn, setSpatialColumn] = useState('geom');
  const [isH3, setIsH3] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  function add(dataset: DatasetDoc) {
    dispatch({ type: 'addDataset', dataset });
    dispatch({ type: 'addLayer', layer: newLayer(dataset.geoColumn.startsWith('h3:') ? 'h3' : 'tileset', dataset, layerCount) });
    setAdding(false);
  }

  function openAdd() {
    setAdding(true);
    listResources('osm', fetcher).then(setResources, (e: Error) => setLoadError(e.message));
  }

  return (
    <section className="panel">
      <h2>Sources</h2>
      <ul className="panel-list">
        {datasets.map((d) => (
          <li key={d.id}>
            <div className="row">
              <strong>{d.label}</strong>
              <small>
                {d.type === 'table' ? d.source : 'SQL query'}
                {d.geoColumn.startsWith('h3:') ? ' · H3' : ''}
              </small>
            </div>
            {errors[d.id] && (
              <p role="alert" className="error">
                {errors[d.id]}
              </p>
            )}
            <div className="row">
              {d.type === 'query' && (
                <button aria-label={`Edit SQL of ${d.label}`} onClick={() => setEditing({ id: d.id, text: d.queryTemplate ?? d.source })}>
                  Edit SQL
                </button>
              )}
              <button aria-label={`Remove ${d.label}`} onClick={() => dispatch({ type: 'removeDataset', id: d.id })}>
                Remove
              </button>
            </div>
            {editing?.id === d.id && (
              <div className="sql-editor">
                <textarea aria-label={`SQL of ${d.label}`} value={editing.text} onChange={(e) => setEditing({ id: d.id, text: e.target.value })} rows={6} />
                <button
                  onClick={() => {
                    dispatch({ type: 'updateDataset', id: d.id, patch: { queryTemplate: editing.text, source: editing.text } });
                    setEditing(null);
                  }}
                >
                  Apply
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!adding && <button onClick={openAdd}>Add source</button>}
      {adding && (
        <div className="add-source">
          <h3>Tables in osm</h3>
          {loadError && (
            <p role="alert" className="error">
              {loadError}
            </p>
          )}
          {!resources && !loadError && <p>Loading tables…</p>}
          <ul className="panel-list">
            {resources?.map((r) => (
              <li key={r.name} className="row">
                <span>{r.name}</span>
                <button aria-label={`Add ${r.name}`} onClick={() => add(newDataset({ type: 'table', source: r.name, geoColumn: r.geoColumn, label: r.name }))}>
                  Add
                </button>
                {r.h3Column && !r.geoColumn.startsWith('h3:') && (
                  <button
                    aria-label={`Add ${r.name} as H3`}
                    onClick={() => add(newDataset({ type: 'table', source: r.name, geoColumn: `h3:${r.h3Column}`, label: `${r.name} (H3)` }))}
                  >
                    As H3
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h3>Custom SQL</h3>
          <textarea aria-label="SQL query" value={sql} onChange={(e) => setSql(e.target.value)} rows={5} placeholder="SELECT * FROM osm_points WHERE amenity = 'cafe'" />
          <label>
            Spatial column <input aria-label="Spatial column" value={spatialColumn} onChange={(e) => setSpatialColumn(e.target.value)} />
          </label>
          <label>
            <input type="checkbox" aria-label="H3 index" checked={isH3} onChange={(e) => setIsH3(e.target.checked)} /> H3 index
          </label>
          <div className="row">
            <button
              disabled={!sql.trim()}
              onClick={() =>
                add(
                  newDataset({
                    type: 'query',
                    source: sql,
                    queryTemplate: sql,
                    geoColumn: isH3 ? `h3:${spatialColumn}` : spatialColumn,
                    label: `Query ${datasets.length + 1}`,
                  }),
                )
              }
            >
              Add query
            </button>
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
