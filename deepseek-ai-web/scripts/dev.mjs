process.env.API_PORT ||= '3001';

const { server } = await import('../server.mjs');
const { createServer } = await import('vite');
const vite = await createServer();

try {
  await vite.listen();
  vite.printUrls();
} catch (error) {
  server.close();
  throw error;
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await vite.close();
  server.close();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
