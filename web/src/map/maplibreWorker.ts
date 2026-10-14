// maplibre-gl 6 builds its worker URL at runtime (new URL(name, import.meta.url)), which Vite cannot see,
// so production builds ship without it. Bundle the worker explicitly and hand MapLibre its URL.
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
