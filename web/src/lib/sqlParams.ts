import type { SqlParameter } from './mapDoc';

export class CompileError extends Error {}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER = /{{\s*([^}]*?)\s*}}/g;

type Binding = { kind: 'list' | 'scalar' | 'date'; value: unknown };

function bindings(params: SqlParameter[]): Map<string, Binding> {
  const out = new Map<string, Binding>();
  const add = (sqlName: string, b: Binding) => {
    if (!NAME.test(sqlName) || sqlName.startsWith('p__')) throw new CompileError(`invalid parameter name "${sqlName}"`);
    out.set(sqlName, b);
  };
  for (const p of params) {
    switch (p.type) {
      case 'Category':
        add(p.item.sqlName, { kind: 'list', value: p.item.value });
        break;
      case 'Numeric':
        add(p.item.sqlName, { kind: 'scalar', value: p.item.value });
        break;
      case 'NumericRange':
        add(p.start.sqlName, { kind: 'scalar', value: p.start.value });
        add(p.end.sqlName, { kind: 'scalar', value: p.end.value });
        break;
      case 'DateRange':
        add(p.start.sqlName, { kind: 'date', value: p.start.value });
        add(p.end.sqlName, { kind: 'date', value: p.end.value });
        break;
    }
  }
  return out;
}

export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

// compileQuery turns a {{name}} query template into DuckDB SQL with named parameters (spec M2 D5).
export function compileQuery(template: string, params: SqlParameter[]): { source: string; queryParameters: Record<string, unknown> | null } {
  const b = bindings(params);
  const used: Record<string, unknown> = {};
  const source = template.replace(PLACEHOLDER, (_m, name: string) => {
    const binding = b.get(name);
    if (!binding) throw new CompileError(`unknown parameter {{${name}}}`);
    used[name] = binding.value;
    if (binding.kind === 'list') return `(SELECT unnest(CAST(CAST($${name} AS JSON) AS VARCHAR[])))`;
    if (binding.kind === 'date') return `CAST($${name} AS DATE)`;
    return `$${name}`;
  });
  return { source, queryParameters: Object.keys(used).length ? used : null };
}
