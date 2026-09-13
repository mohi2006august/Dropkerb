/**
 * Template clustering: how many of a site's pages actually need looking at?
 *
 * The cost model in TDD s10 assumes a run does not pay per page, because most pages of a
 * real site are the same template with different text - audit one product page and you
 * have audited nine hundred. This measures whether that holds, and by how much.
 *
 * Signature is structure only, never text: the multiset of role paths through the
 * accessibility tree. Two pages of the same template have near-identical role paths and
 * completely different names, so including names would put every page in its own cluster
 * and make the saving look like zero.
 */
import type { AxNode } from './sensor.ts';

/** Depth beyond which structure stops distinguishing templates and starts echoing content. */
const MAX_DEPTH = 6;

/**
 * Roles that carry text rather than structure. They are excluded from the signature on
 * principle, not by tuning: a page with four paragraphs and a page with nine are the
 * same template, but their StaticText paths differ, so including them measures how much
 * prose a page has and calls the answer "a different template".
 */
const CONTENT_ROLES = new Set(['StaticText', 'InlineTextBox', 'text', 'LineBreak']);

export function signature(nodes: AxNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const shingles = new Set<string>();
  for (const n of nodes) {
    if (n.ignored) continue;
    if (CONTENT_ROLES.has(n.role)) continue;
    const path: string[] = [];
    let cur: AxNode | undefined = n;
    let depth = 0;
    while (cur && depth < MAX_DEPTH) {
      path.push(cur.role);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      depth++;
    }
    shingles.add(path.reverse().join('>'));
  }
  return shingles;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface Cluster {
  representative: string;
  members: string[];
}

/**
 * Greedy single-pass clustering: each page joins the first cluster whose representative
 * it resembles above `threshold`, or starts a new one.
 *
 * Greedy makes the result order-dependent, which is the honest trade here - the
 * alternative is quadratic agglomerative clustering over a sample this small, whose
 * extra precision would be swamped by the choice of threshold anyway. Which is why the
 * caller sweeps several thresholds and reports the curve rather than one number.
 */
export function cluster(
  pages: Array<{ url: string; sig: Set<string> }>,
  threshold: number,
): Cluster[] {
  const clusters: Array<Cluster & { sig: Set<string> }> = [];
  for (const page of pages) {
    const hit = clusters.find((c) => jaccard(c.sig, page.sig) >= threshold);
    if (hit) hit.members.push(page.url);
    else clusters.push({ representative: page.url, members: [page.url], sig: page.sig });
  }
  return clusters.map(({ representative, members }) => ({ representative, members }));
}
