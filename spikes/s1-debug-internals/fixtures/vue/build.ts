import { build as esbuild, type Plugin } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');

/**
 * Structural type for the slice of @vue/compiler-sfc we use. Declared locally rather
 * than imported, because the package lives in the FIXTURE's node_modules - the root
 * tree deliberately has no copy of Vue, so `typeof import(...)` cannot resolve here.
 */
interface SfcCompiler {
  parse: (source: string, opts: { filename: string }) => { descriptor: SfcDescriptor };
  compileScript: (d: SfcDescriptor, opts: { id: string; genDefaultAs?: string }) => { content: string; bindings?: unknown };
  compileTemplate: (opts: {
    source: string;
    filename: string;
    id: string;
    compilerOptions?: { bindingMetadata?: unknown };
  }) => { code: string };
}

interface SfcDescriptor {
  template: { content: string } | null;
}

export interface VueCell {
  cell: string;
  mode: 'dev' | 'prod';
  dist: string;
  /** Ground truth spans two SFCs, so the caller needs both. */
  sources: Array<{ absPath: string; reportedAs: string }>;
  vueVersion: string;
}

/**
 * Compiles the SFC fixtures the way vite-plugin-vue does in dev, including the
 * `__file` assignment - because `__file` is not something Vue computes at runtime, it
 * is something the build tool stamps on. That distinction is most of what this cell
 * of the matrix is measuring: the signal exists only if the toolchain put it there.
 */
export async function buildVueCell(mode: 'dev' | 'prod'): Promise<VueCell> {
  const versionDir = join(HERE, 'v3');
  const modules = join(versionDir, 'node_modules');
  const req = createRequire(join(modules, 'noop.js'));
  const sfc = req('@vue/compiler-sfc') as SfcCompiler;
  const vueVersion = JSON.parse(readFileSync(join(modules, 'vue', 'package.json'), 'utf8')).version as string;

  const dist = join(HERE, 'dist', mode);
  mkdirSync(dist, { recursive: true });

  await esbuild({
    entryPoints: [join(SRC, 'main.js')],
    bundle: true,
    outfile: join(dist, 'app.js'),
    absWorkingDir: HERE,
    format: 'iife',
    nodePaths: [modules],
    minify: mode === 'prod',
    sourcemap: true,
    plugins: [vuePlugin(sfc, mode)],
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'dev' ? 'development' : 'production'),
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    logLevel: 'silent',
  });

  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>S1 Vue 3 ${mode}</title></head><body><div id="app"></div><script src="app.js"></script></body></html>`,
  );

  return {
    cell: `vue-3/${mode}`,
    mode,
    dist,
    sources: [
      { absPath: join(SRC, 'App.vue'), reportedAs: 'src/App.vue' },
      { absPath: join(SRC, 'Card.vue'), reportedAs: 'src/Card.vue' },
    ],
    vueVersion,
  };
}

function vuePlugin(sfc: SfcCompiler, mode: 'dev' | 'prod'): Plugin {
  return {
    name: 'sfc',
    setup(build) {
      build.onLoad({ filter: /\.vue$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        const filename = args.path;
        const { descriptor } = sfc.parse(source, { filename });
        const id = Buffer.from(relative(HERE, filename)).toString('base64').slice(0, 12);

        const script = sfc.compileScript(descriptor, { id, genDefaultAs: '_sfc_main' });
        const template = sfc.compileTemplate({
          source: descriptor.template?.content ?? '',
          filename,
          id,
          compilerOptions: { bindingMetadata: script.bindings },
        });

        const rel = relative(HERE, filename).replace(/\\/g, '/');
        const parts = [
          script.content,
          template.code.replace(/export function render/, 'function render'),
          `_sfc_main.render = render;`,
          // Dev builds stamp __file; production builds do not. Mirroring that is the point.
          mode === 'dev' ? `_sfc_main.__file = ${JSON.stringify(rel)};` : '',
          `export default _sfc_main;`,
        ];
        return { contents: parts.filter(Boolean).join('\n'), loader: 'js', resolveDir: dirname(filename) };
      });
    },
  };
}
