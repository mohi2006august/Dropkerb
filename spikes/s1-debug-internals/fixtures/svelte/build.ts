import { build as esbuild, type Plugin } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');

export interface SvelteCell {
  cell: string;
  major: 4 | 5;
  mode: 'dev' | 'prod';
  dist: string;
  sources: Array<{ absPath: string; reportedAs: string }>;
  svelteVersion: string;
}

/**
 * Svelte 4 and 5 differ in both the compiler option name for the client target and the
 * mount API, so the entry is generated per major. Everything else - including the
 * fixture markup - is shared, which is what makes the two cells comparable.
 */
export async function buildSvelteCell(major: 4 | 5, mode: 'dev' | 'prod'): Promise<SvelteCell> {
  const versionDir = join(HERE, `v${major}`);
  const modules = join(versionDir, 'node_modules');
  const req = createRequire(join(modules, 'noop.js'));
  const compiler = req('svelte/compiler') as { compile: (src: string, opts: Record<string, unknown>) => { js: { code: string } } };
  const svelteVersion = JSON.parse(readFileSync(join(modules, 'svelte', 'package.json'), 'utf8')).version as string;

  const genDir = join(HERE, '.gen', `v${major}-${mode}`);
  const dist = join(HERE, 'dist', `v${major}-${mode}`);
  mkdirSync(genDir, { recursive: true });
  mkdirSync(dist, { recursive: true });

  const appPath = join(SRC, 'App.svelte').replace(/\\/g, '/');
  const entry =
    major === 4
      ? [
          `import App from '${appPath}';`,
          `window.__SPIKE_SVELTE = ${JSON.stringify(svelteVersion)};`,
          `new App({ target: document.getElementById('app') });`,
        ]
      : [
          `import { mount } from 'svelte';`,
          `import App from '${appPath}';`,
          `window.__SPIKE_SVELTE = ${JSON.stringify(svelteVersion)};`,
          `mount(App, { target: document.getElementById('app') });`,
        ];
  writeFileSync(join(genDir, 'entry.js'), entry.join('\n') + '\n');

  await esbuild({
    entryPoints: [join(genDir, 'entry.js')],
    bundle: true,
    outfile: join(dist, 'app.js'),
    absWorkingDir: HERE,
    format: 'iife',
    nodePaths: [modules],
    minify: mode === 'prod',
    sourcemap: true,
    conditions: ['svelte', 'browser', 'import'],
    mainFields: ['svelte', 'browser', 'module', 'main'],
    plugins: [sveltePlugin(compiler, major, mode)],
    define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'dev' ? 'development' : 'production') },
    logLevel: 'silent',
  });

  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>S1 Svelte ${major} ${mode}</title></head><body><div id="app"></div><script src="app.js"></script></body></html>`,
  );

  return {
    cell: `svelte-${major}/${mode}`,
    major,
    mode,
    dist,
    sources: [
      { absPath: join(SRC, 'App.svelte'), reportedAs: 'src/App.svelte' },
      { absPath: join(SRC, 'Card.svelte'), reportedAs: 'src/Card.svelte' },
    ],
    svelteVersion,
  };
}

function sveltePlugin(
  compiler: { compile: (src: string, opts: Record<string, unknown>) => { js: { code: string } } },
  major: 4 | 5,
  mode: 'dev' | 'prod',
): Plugin {
  return {
    name: 'svelte',
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        const rel = relative(HERE, args.path).replace(/\\/g, '/');
        const opts: Record<string, unknown> = {
          filename: rel,
          // dev:true is what emits __svelte_meta. Turning it off for the prod cell is
          // exactly the production behaviour we need to measure, not a shortcut.
          dev: mode === 'dev',
          ...(major === 4 ? { generate: 'dom', css: 'injected' } : { generate: 'client' }),
        };
        const { js } = compiler.compile(source, opts);
        return { contents: js.code, loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}
