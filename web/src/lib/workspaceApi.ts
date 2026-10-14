import type { DatasetDoc, MapDoc, MapSummary, Privacy } from './mapDoc';

export const WORKSPACE = '/api/workspace';

export interface PageMeta {
  total: number;
  current: number;
  pageSize: number;
  totalPages: number;
}

export interface MapPage {
  data: MapSummary[];
  meta: { page: PageMeta };
}

export interface ListMapsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  orderBy?: 'updated_at' | 'title';
  orderDirection?: 'ASC' | 'DESC';
  privacy?: Privacy;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Fetch = typeof fetch;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // body was not JSON; keep the status text
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export function listMapsUrl(p: ListMapsParams = {}): string {
  const q = new URLSearchParams({
    page: String(p.page ?? 1),
    page_size: String(p.pageSize ?? 12),
    order_by: p.orderBy ?? 'updated_at',
    order_direction: p.orderDirection ?? 'DESC',
  });
  if (p.search) q.set('search', p.search);
  if (p.privacy) q.set('privacy', p.privacy);
  return `${WORKSPACE}/maps?${q}`;
}

export async function listMaps(p: ListMapsParams = {}, f: Fetch = fetch): Promise<MapPage> {
  return json<MapPage>(await f(listMapsUrl(p)));
}

export async function createMap(body: Partial<Pick<MapDoc, 'title' | 'description' | 'keplerMapConfig'>> = {}, f: Fetch = fetch): Promise<MapDoc> {
  return json<MapDoc>(
    await f(`${WORKSPACE}/maps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  );
}

export async function getMap(id: string, f: Fetch = fetch): Promise<MapDoc> {
  return json<MapDoc>(await f(`${WORKSPACE}/maps/${encodeURIComponent(id)}`));
}

export async function getDatasets(id: string, f: Fetch = fetch): Promise<DatasetDoc[]> {
  return json<DatasetDoc[]>(await f(`${WORKSPACE}/maps/${encodeURIComponent(id)}/datasets`));
}

export async function getPublicMap(id: string, f: Fetch = fetch): Promise<MapDoc & { datasets: DatasetDoc[] }> {
  return json<MapDoc & { datasets: DatasetDoc[] }>(await f(`/v3/maps/public/${encodeURIComponent(id)}`));
}
