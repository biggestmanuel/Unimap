import createApp from './app.js';
import { createPostgresRepo } from './db/postgresRepo.js';
import { createMemoryRepo } from './db/memoryRepo.js';
import { closePool } from './db/pool.js';

const port = Number(process.env.PORT ?? 4000);

// Falls back to the in-memory repo so `npm run dev` works on a fresh
// clone with no database, while production requires DATABASE_URL.
const useMemory = !process.env.DATABASE_URL;
const repo = useMemory ? createMemoryRepo() : createPostgresRepo();

const app = createApp({ repo });

const server = app.listen(port, () => {
  console.log(`[unimap-api] listening on http://localhost:${port}`);
  console.log(
    useMemory
      ? '[unimap-api] using in-memory repo — set DATABASE_URL for PostGIS'
      : '[unimap-api] using PostGIS',
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closePool();
    process.exit(0);
  });
}