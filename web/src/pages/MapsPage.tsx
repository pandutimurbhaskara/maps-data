import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MapSummary } from '../lib/mapDoc';
import { createMap, listMaps, type ListMapsParams } from '../lib/workspaceApi';

type Sort = 'updated_at:DESC' | 'title:ASC';
type Permission = 'all' | 'shared' | 'public';

function query(page: number, search: string, sort: Sort, permission: Permission): ListMapsParams {
  const [orderBy, orderDirection] = sort.split(':') as [ListMapsParams['orderBy'], ListMapsParams['orderDirection']];
  return { page, pageSize: 12, search: search || undefined, orderBy, orderDirection, privacy: permission === 'all' ? undefined : permission };
}

export function MapsPage({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated_at:DESC');
  const [permission, setPermission] = useState<Permission>('all');
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMaps(query(1, search, sort, permission), fetcher).then(
      (res) => {
        if (cancelled) return;
        setMaps(res.data);
        setPage(1);
        setTotalPages(res.meta.page.totalPages);
        setTotal(res.meta.page.total);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [search, sort, permission, fetcher]);

  async function loadMore() {
    try {
      const res = await listMaps(query(page + 1, search, sort, permission), fetcher);
      setMaps((prev) => [...prev, ...res.data]);
      setPage(res.meta.page.current);
      setTotalPages(res.meta.page.totalPages);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onCreate() {
    try {
      const m = await createMap({}, fetcher);
      navigate(`/builder/${m.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const unfiltered = !search && permission === 'all';
  return (
    <main className="maps-page">
      <header>
        <h1>Maps</h1>
        <button onClick={onCreate}>New map</button>
      </header>
      <div className="toolbar">
        <input aria-label="Search maps" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="updated_at:DESC">Last updated</option>
          <option value="title:ASC">A-Z</option>
        </select>
        <select aria-label="Permissions" value={permission} onChange={(e) => setPermission(e.target.value as Permission)}>
          <option value="all">All</option>
          <option value="shared">Shared</option>
          <option value="public">Public</option>
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {total === 0 && unfiltered ? (
        <section className="empty">
          <p>You haven't created any maps yet</p>
          <button onClick={onCreate}>Create your first map</button>
        </section>
      ) : (
        <ul className="map-grid">
          {maps.map((m) => (
            <li key={m.id}>
              <MapCard map={m} />
            </li>
          ))}
        </ul>
      )}
      {page < totalPages && <button onClick={loadMore}>Load more</button>}
    </main>
  );
}

function MapCard({ map }: { map: MapSummary }) {
  return (
    <Link className="map-card" to={`/builder/${map.id}`}>
      <div className="thumb" style={map.thumbnailUrl ? { backgroundImage: `url(${map.thumbnailUrl})` } : undefined} />
      <div className="meta">
        <strong>{map.title}</strong>
        <span className="badge">{map.privacy}</span>
      </div>
      <div className="meta">
        <small>Updated {new Date(map.updatedAt).toLocaleDateString()}</small>
      </div>
    </Link>
  );
}
