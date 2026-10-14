import { useState, type Dispatch } from 'react';
import { newId } from '../lib/defaults';
import type { SqlParameter } from '../lib/mapDoc';
import { ParamControls } from '../map/ParamControls';
import type { Action } from './state';

export function slugify(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return 'param';
  if (/^[0-9]/.test(s)) s = 'p' + s;
  if (s.startsWith('p_')) s = 'param_' + s.replace(/^p_+/, 'p_');
  return s;
}

function usage(p: SqlParameter): string {
  return p.type === 'Category' || p.type === 'Numeric' ? `{{${p.item.sqlName}}}` : `{{${p.start.sqlName}}} … {{${p.end.sqlName}}}`;
}

type Kind = SqlParameter['type'];

export function ParamsPanel({ params, dispatch }: { params: SqlParameter[]; dispatch: Dispatch<Action> }) {
  const [type, setType] = useState<Kind>('Category');
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(100);
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');

  function add() {
    const sql = slugify(name);
    const base = { id: newId(), name: name.trim() };
    let param: SqlParameter;
    if (type === 'Category') {
      const list = values.split(',').map((v) => v.trim()).filter(Boolean);
      param = { ...base, type, item: { sqlName: sql, value: list }, values: list, selectionMode: 'multi' };
    } else if (type === 'Numeric') {
      param = { ...base, type, item: { sqlName: sql, value: min }, min, max, step: 1 };
    } else if (type === 'NumericRange') {
      param = { ...base, type, start: { sqlName: `${sql}_from`, value: min }, end: { sqlName: `${sql}_to`, value: max }, min, max, step: 1 };
    } else {
      param = { ...base, type, start: { sqlName: `${sql}_from`, value: from }, end: { sqlName: `${sql}_to`, value: to } };
    }
    dispatch({ type: 'addSqlParameter', param });
    setName('');
    setValues('');
  }

  return (
    <section className="panel">
      <h2>SQL parameters</h2>
      <p className="muted">
        Reference a parameter in a source query, e.g. <code>WHERE amenity IN {'{{amenity_kinds}}'}</code>.
      </p>
      <ul className="panel-list">
        {params.map((p) => (
          <li key={p.id}>
            <div className="row">
              <strong>{p.name}</strong>
              <code>{usage(p)}</code>
              <button aria-label={`Remove ${p.name}`} onClick={() => dispatch({ type: 'removeSqlParameter', id: p.id })}>
                ✕
              </button>
            </div>
            <ParamControls params={[p]} onChange={(param) => dispatch({ type: 'updateSqlParameter', param })} />
          </li>
        ))}
      </ul>
      <h3>Add a parameter</h3>
      <label>
        Type{' '}
        <select aria-label="Parameter type" value={type} onChange={(e) => setType(e.target.value as Kind)}>
          <option value="Category">Category</option>
          <option value="Numeric">Number</option>
          <option value="NumericRange">Number range</option>
          <option value="DateRange">Date range</option>
        </select>
      </label>
      <label>
        Name <input aria-label="Parameter name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {type === 'Category' && (
        <label>
          Values <input aria-label="Values (comma separated)" value={values} onChange={(e) => setValues(e.target.value)} />
        </label>
      )}
      {(type === 'Numeric' || type === 'NumericRange') && (
        <div className="row">
          <label>
            Min <input type="number" aria-label="Minimum" value={min} onChange={(e) => setMin(Number(e.target.value))} />
          </label>
          <label>
            Max <input type="number" aria-label="Maximum" value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </label>
        </div>
      )}
      {type === 'DateRange' && (
        <div className="row">
          <label>
            From <input type="date" aria-label="Default from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To <input type="date" aria-label="Default to" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      )}
      <button disabled={!name.trim() || (type === 'Category' && !values.trim())} onClick={add}>
        Add parameter
      </button>
    </section>
  );
}
