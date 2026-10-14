import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    apiBaseUrl: string;
  }
}

const serverDir = resolve(import.meta.dirname, '../../server');

// Builds mapsd, seeds a fresh data DB and serves it on a random port for the contract tests.
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'osm-maps-contract-'));
  const bin = join(dir, 'mapsd');
  execFileSync('go', ['build', '-o', bin, './cmd/mapsd'], { cwd: serverDir, stdio: 'inherit' });
  execFileSync('go', ['run', './cmd/seed', '-out', join(dir, 'data.duckdb')], { cwd: serverDir, stdio: 'inherit' });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-data', join(dir, 'data.duckdb'), '-meta', join(dir, 'meta.duckdb')], {
    stdio: 'inherit',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealthy(`${base}/healthz`, 60_000);
  project.provide('apiBaseUrl', base);
  return () => {
    proc.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  };
}

async function waitForHealthy(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`mapsd did not become healthy at ${url}`);
}
