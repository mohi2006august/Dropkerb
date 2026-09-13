import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface StaticServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Minimal static server for fixture builds. Deliberately dependency-free: a fixture
 * served through a bundler dev server would confound S1, which is trying to measure
 * what the *build* emits, not what a dev server injects.
 */
export async function serveDir(dir: string): Promise<StaticServer> {
  const server: Server = createServer(async (req, res) => {
    try {
      const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
      // normalize() collapses ../ so a fixture cannot read outside its own dir.
      const rel = normalize(raw).replace(/^[/\\]+/, '');
      let file = join(dir, rel);
      const s = await stat(file).catch(() => null);
      if (!s || s.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('listen failed');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
