import { useState, type FormEvent } from 'react';

export interface Place {
  name: string;
  kind: string;
  longitude: number;
  latitude: number;
}

export function GeocoderBox({ onSelect, fetcher = fetch }: { onSelect: (p: Place) => void; fetcher?: typeof fetch }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setError(null);
    const res = await fetcher(`/v3/lds/geocoding/geocode?address=${encodeURIComponent(q.trim())}&limit=5`);
    if (!res.ok) {
      setError('Search failed');
      return;
    }
    setResults(((await res.json()) as { rows: Place[] }).rows);
  }

  return (
    <form className="geocoder" role="search" onSubmit={search}>
      <input aria-label="Search places" placeholder="Search places" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {results && (
        <ul>
          {results.length === 0 && <li className="muted">No places found</li>}
          {results.map((p, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => {
                  onSelect(p);
                  setResults(null);
                }}
              >
                {p.name} <small>{p.kind}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
