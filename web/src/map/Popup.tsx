const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface PopupState {
  x: number;
  y: number;
  title: string;
  rows: { name: string; value: string }[];
}

export function popupRows(object: unknown, fields: string[]): { name: string; value: string }[] {
  const o = (object ?? {}) as { properties?: Record<string, unknown> } & Record<string, unknown>;
  const props = o.properties ?? o;
  return fields
    .filter((f) => f in props)
    .map((f) => {
      const v = props[f];
      return { name: f, value: typeof v === 'number' ? fmt.format(v) : String(v ?? '') };
    });
}

export function Popup({ popup, onClose }: { popup: PopupState | null; onClose: () => void }) {
  if (!popup) return null;
  return (
    <div className="popup" role="dialog" aria-label={popup.title} style={{ left: popup.x + 8, top: popup.y + 8 }}>
      <button aria-label="Close popup" onClick={onClose}>
        ✕
      </button>
      <strong>{popup.title}</strong>
      <dl>
        {popup.rows.map((r) => (
          <div key={r.name}>
            <dt>{r.name}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
