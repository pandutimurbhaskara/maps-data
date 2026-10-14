import type { SqlParameter } from '../lib/mapDoc';

export function ParamControls({ params, onChange }: { params: SqlParameter[]; onChange: (p: SqlParameter) => void }) {
  if (!params.length) return null;
  return (
    <div className="param-controls">
      {params.map((p) => (
        <ParamControl key={p.id} param={p} onChange={onChange} />
      ))}
    </div>
  );
}

function ParamControl({ param: p, onChange }: { param: SqlParameter; onChange: (p: SqlParameter) => void }) {
  switch (p.type) {
    case 'Category':
      return (
        <fieldset>
          <legend>{p.name}</legend>
          {p.values.map((v) => {
            const checked = p.item.value.includes(v);
            const next = p.selectionMode === 'single' ? [v] : checked ? p.item.value.filter((x) => x !== v) : [...p.item.value, v];
            return (
              <label key={v}>
                <input
                  type={p.selectionMode === 'single' ? 'radio' : 'checkbox'}
                  name={p.id}
                  aria-label={`${p.name}: ${v}`}
                  checked={checked}
                  onChange={() => onChange({ ...p, item: { ...p.item, value: next } })}
                />{' '}
                {v}
              </label>
            );
          })}
        </fieldset>
      );
    case 'Numeric':
      return (
        <label>
          {p.name}{' '}
          <input
            type="range"
            aria-label={p.name}
            min={p.min}
            max={p.max}
            step={p.step}
            value={p.item.value}
            onChange={(e) => onChange({ ...p, item: { ...p.item, value: Number(e.target.value) } })}
          />{' '}
          <output>{p.item.value}</output>
        </label>
      );
    case 'NumericRange':
      return (
        <fieldset>
          <legend>{p.name}</legend>
          <input
            type="number"
            aria-label={`${p.name} from`}
            min={p.min}
            max={p.max}
            step={p.step}
            value={p.start.value}
            onChange={(e) => onChange({ ...p, start: { ...p.start, value: Number(e.target.value) } })}
          />
          {' – '}
          <input
            type="number"
            aria-label={`${p.name} to`}
            min={p.min}
            max={p.max}
            step={p.step}
            value={p.end.value}
            onChange={(e) => onChange({ ...p, end: { ...p.end, value: Number(e.target.value) } })}
          />
        </fieldset>
      );
    case 'DateRange':
      return (
        <fieldset>
          <legend>{p.name}</legend>
          <input type="date" aria-label={`${p.name} from`} value={p.start.value} onChange={(e) => onChange({ ...p, start: { ...p.start, value: e.target.value } })} />
          {' – '}
          <input type="date" aria-label={`${p.name} to`} value={p.end.value} onChange={(e) => onChange({ ...p, end: { ...p.end, value: e.target.value } })} />
        </fieldset>
      );
  }
}
