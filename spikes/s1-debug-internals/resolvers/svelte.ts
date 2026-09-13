/**
 * Browser-side Svelte resolver.
 *
 * Svelte's dev compiler stamps `__svelte_meta` directly on the DOM element, carrying
 * `loc: { file, line, column }`. Unlike React's fiber or Vue's instance, this needs no
 * walk at all - the element itself holds the answer, which makes it the cleanest of
 * the three signals when it is present.
 *
 * Svelte 5 rewrote the client runtime, so whether the field survived the rewrite is
 * precisely the thing worth measuring rather than assuming.
 */
export const SVELTE_RESOLVER = `(el) => {
  const out = {
    metaFound: false, file: null, line: null, column: null,
    fieldsPresent: [], version: null, ownerFound: false,
  };
  try { out.version = window.__SPIKE_SVELTE || null; } catch (e) {}

  const keys = Object.keys(el).filter((k) => k.indexOf('__svelte') === 0);
  for (let i = 0; i < keys.length; i++) out.fieldsPresent.push(keys[i]);

  const meta = el.__svelte_meta;
  if (meta) {
    out.metaFound = true;
    if (meta.loc) {
      out.file = meta.loc.file != null ? meta.loc.file : null;
      out.line = meta.loc.line != null ? meta.loc.line : null;
      out.column = meta.loc.char != null ? meta.loc.char : (meta.loc.column != null ? meta.loc.column : null);
    }
  }

  // Fallback: some Svelte 5 builds attach ownership metadata instead of loc.
  if (!out.file) {
    for (let i = 0; i < keys.length; i++) {
      const v = el[keys[i]];
      if (v && typeof v === 'object' && v.loc && v.loc.file) {
        out.ownerFound = true;
        out.file = v.loc.file;
        out.line = v.loc.line != null ? v.loc.line : null;
        break;
      }
    }
  }
  return out;
}`;
