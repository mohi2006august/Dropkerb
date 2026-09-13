/**
 * Browser-side React resolver, shipped as a string because it is evaluated in the page.
 *
 * Three signals, reported separately because they degrade independently and the design
 * (TDD s5.1) assigns them different confidences:
 *   - _debugSource -> {fileName, lineNumber} directly. React 17/18 dev only.
 *   - _debugStack  -> an Error captured at the JSX call site. React 19 replaced
 *                     _debugSource with this. The stack points into the BUNDLE, so it
 *                     is only attribution after a source-map lookup - which makes the
 *                     React 19 path structurally identical to TDD s5.2 rather than s5.1.
 *   - _debugOwner  -> a component NAME only, which the symbol graph resolves at ~0.85.
 *
 * The walk climbs `return` rather than stopping at el[fiberKey], because a host node
 * rendered inside a child component carries its own debug data while the owner chain
 * lives further up. A resolver that reads only the element fiber misses most real nodes.
 */
export const REACT_RESOLVER = `(el) => {
  const out = {
    fiberFound: false, fiberKey: null,
    debugSource: null, debugSourceDepth: -1,
    debugStack: null, debugStackDepth: -1,
    ownerName: null, ownerChain: [],
    fieldsPresent: [], reactVersion: null,
  };
  try { out.reactVersion = window.__SPIKE_REACT_VERSION || null; } catch (e) {}

  const key = Object.keys(el).find((k) => k.indexOf('__reactFiber') === 0 || k.indexOf('__reactInternalInstance') === 0);
  if (!key) return out;
  out.fiberFound = true;
  out.fiberKey = key.split('#')[0].slice(0, key.indexOf('$') + 1);

  let f = el[key];
  // "Field absent" and "field present but null" are different failures and the matrix
  // report needs to distinguish them - that is the whole point of this spike.
  if (f) {
    const fields = ['_debugSource', '_debugOwner', '_debugInfo', '_debugTask', '_debugStack', '_debugHookTypes'];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i] in f) out.fieldsPresent.push(fields[i] + (f[fields[i]] == null ? ':null' : ':set'));
    }
  }

  let depth = 0;
  while (f && depth < 60) {
    if (!out.debugSource && f._debugSource && f._debugSource.fileName) {
      out.debugSource = {
        fileName: f._debugSource.fileName,
        lineNumber: f._debugSource.lineNumber,
        columnNumber: f._debugSource.columnNumber,
      };
      out.debugSourceDepth = depth;
    }
    if (!out.debugStack && f._debugStack) {
      var st = null;
      try { st = f._debugStack.stack ? String(f._debugStack.stack) : String(f._debugStack); } catch (e) { st = null; }
      if (st) { out.debugStack = st; out.debugStackDepth = depth; }
    }
    const owner = f._debugOwner;
    if (owner) {
      const n = (owner.type && (owner.type.name || owner.type.displayName)) ||
                (typeof owner.elementType === 'function' && owner.elementType.name) || null;
      if (n && out.ownerChain[out.ownerChain.length - 1] !== n) out.ownerChain.push(n);
      if (!out.ownerName && n) out.ownerName = n;
    }
    f = f.return;
    depth++;
  }
  return out;
}`;
