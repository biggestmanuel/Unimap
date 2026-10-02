import createApp from './app.js';
import { createPostgresRepo } from './db/postgresRepo.js';
import { createMemoryRepo } from './db/memoryRepo.js';
import { createPostgresGraphRepo, createMemoryGraphRepo } from './graph/graphRepo.js';
import { closePool, getPool } from './db/pool.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 4000);

// Falls back to the in-memory repo so `npm run dev` works on a fresh
// clone with no database, while production requires DATABASE_URL.
const useMemory = !process.env.DATABASE_URL;
const repo = useMemory ? createMemoryRepo() : createPostgresRepo();

/**
 * With no database there is still a usable graph: the OSM extract in
 * `frontend/public/data/walk-graph.json`, if the importer has been run.
 * That keeps routing demonstrable on a clone without Postgres.
 */
function loadGraphFromDisk() {
  const path = fileURLToPath(
    new URL('../../frontend/public/data/walk-graph.json', import.meta.url),
  );
  try {
    const rows = JSON.parse(readFileSync(path, 'utf-8'));
    console.log(`[unimap-api] walk graph from ${path} (${rows.length} edges)`);
    return createMemoryGraphRepo(rows);
  } catch {
    return undefined;
  }
}

const graphRepo = useMemory
  ? loadGraphFromDisk()
  : createPostgresGraphRepo({ pool: getPool() });

const app = createApp({ repo, graphRepo });

const server = app.listen(port, () => {
  console.log(`[unimap-api] listening on http://localhost:${port}`);
  console.log(
    useMemory
      ? '[unimap-api] using in-memory repo — set DATABASE_URL for PostGIS'
      : '[unimap-api] using PostGIS',
  );
  if (!graphRepo) {
    console.log(
      '[unimap-api] no walk graph loaded — routes will fall back to straight lines',
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closePool();
    process.exit(0);
  });
}