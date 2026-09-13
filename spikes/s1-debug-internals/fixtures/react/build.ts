import { build as esbuild } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ReactCell {
  /** Matrix cell name, e.g. "react-19/prod". */
  cell: string;
  major: 17 | 18 | 19;
  mode: 'dev' | 'prod';
  /** Directory to serve. */
  dist: string;
  /** How the fixture source is expected to be named in __source.fileName. */
  reportedAs: string;
  /** Absolute path of the fixture source, for ground truth. */
  sourcePath: string;
  reactVersion: string;
}

const SOURCE = join(HERE, 'src', 'App.jsx');

/**
 * Builds one matrix cell the way a real project would: dev means NODE_ENV=development
 * with the jsxDEV runtime (what every dev server does); prod means NODE_ENV=production,
 * the classic runtime and minification (what ships). Conflating the two would make the
 * spike measure our build config instead of React's behaviour.
 */
export async function buildReactCell(major: 17 | 18 | 19, mode: 'dev' | 'prod'): Promise<ReactCell> {
  const versionDir = join(HERE, `v${major}`);
  const modules = join(versionDir, 'node_modules');
  const reactVersion = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(join(modules, 'react', 'package.json'), 'utf8')),
  ).version as string;

  const genDir = join(HERE, '.gen', `v${major}-${mode}`);
  const dist = join(HERE, 'dist', `v${major}-${mode}`);
  mkdirSync(genDir, { recursive: true });
  mkdirSync(dist, { recursive: true });

  // React 17 mounts with ReactDOM.render; 18 and 19 with createRoot. The entry is
  // plain JS (createElement, no JSX) so it never appears in __source and cannot be
  // mistaken for a fixture node.
  const mount =
    major === 17
      ? `import ReactDOM from 'react-dom';\nReactDOM.render(createElement(App), document.getElementById('root'));`
      : `import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(createElement(App));`;

  writeFileSync(
    join(genDir, 'entry.js'),
    [
      `import { createElement } from 'react';`,
      `import App from '${SOURCE.replace(/\\/g, '/')}';`,
      `import ReactPkg from 'react';`,
      `window.__SPIKE_REACT_VERSION = ${JSON.stringify(reactVersion)};`,
      `window.__SPIKE_REACT_RUNTIME = (ReactPkg && ReactPkg.version) || null;`,
      mount,
      '',
    ].join('\n'),
  );

  await esbuild({
    entryPoints: [join(genDir, 'entry.js')],
    bundle: true,
    outfile: join(dist, 'app.js'),
    absWorkingDir: HERE,
    format: 'iife',
    jsx: 'automatic',
    jsxDev: mode === 'dev',
    jsxImportSource: 'react',
    nodePaths: [modules],
    minify: mode === 'prod',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'dev' ? 'development' : 'production') },
    logLevel: 'silent',
  });

  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>S1 React ${major} ${mode}</title></head><body><div id="root"></div><script src="app.js"></script></body></html>`,
  );

  return {
    cell: `react-${major}/${mode}`,
    major,
    mode,
    dist,
    reportedAs: 'src/App.jsx',
    sourcePath: SOURCE,
    reactVersion,
  };
}
