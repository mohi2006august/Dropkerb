/**
 * Browser-side Vue resolver.
 *
 * Vue's runtime pointer is `el.__vueParentComponent`, an instance whose `type.__file`
 * names the SFC. Note what is NOT there: a line number. Vue attributes to a FILE, and
 * the design's confidence-0.95 "file:line" claim (TDD s5.1) does not hold for Vue at
 * all - locating the element within the file needs a second signal.
 *
 * The walk climbs `parent` because an element rendered by a child component reports
 * that child; for elements passed through slots the owning instance can be further up.
 */
export const VUE_RESOLVER = `(el) => {
  const out = {
    instanceFound: false, file: null, line: null,
    componentName: null, chain: [], fieldsPresent: [], depth: -1,
  };

  // Vue exposes the owning instance on the element under one of two names depending on
  // whether the node is a component root or a plain element inside a template.
  let inst = el.__vueParentComponent || (el.__vnode && el.__vnode.component) || null;
  if (!inst) return out;
  out.instanceFound = true;

  const probe = inst.type || {};
  const candidates = ['__file', '__name', '__hmrId', '__scopeId'];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] in probe) out.fieldsPresent.push(candidates[i] + (probe[candidates[i]] == null ? ':null' : ':set'));
  }

  let depth = 0;
  while (inst && depth < 40) {
    const t = inst.type || {};
    const name = t.__name || t.name || (t.__file ? String(t.__file).split('/').pop().replace(/\\.vue$/, '') : null);
    if (name && out.chain[out.chain.length - 1] !== name) out.chain.push(name);
    if (!out.file && t.__file) {
      out.file = t.__file;
      out.componentName = name;
      out.depth = depth;
    }
    inst = inst.parent;
    depth++;
  }
  return out;
}`;
