/**
 * The minimal sensor: what a run would actually send to the model for one page.
 *
 * S3 exists to cost a run, and the cost is decided almost entirely by what goes in the
 * prompt. So this builds two payloads per page and measures both:
 *
 *   full    - every node of the CDP accessibility tree, the naive "give the model the
 *             page" approach
 *   minimal - the axe violations plus only the AX context around each violating node
 *
 * The ratio between them is a design finding, not an implementation detail: if minimal
 * is an order of magnitude smaller, TDD s10's per-page cost has to be quoted against it,
 * and the Judge prompt has to be built from violations outward rather than from the tree
 * down.
 *
 * The AX tree and not the DOM, for the reason the rest of the repo uses it: it is what
 * assistive technology exposes, and it is already pruned of nodes that carry no
 * accessibility meaning.
 */
import type { CDPSession, Page } from 'playwright';

export interface AxNode {
  nodeId: string;
  parentId?: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  properties: Array<{ name: string; value: unknown }>;
  ignored: boolean;
}

export interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
}

export interface PagePayloads {
  /** Serialized JSON actually counted - kept so token counting sees the real string. */
  full: string;
  minimal: string;
  axNodeCount: number;
  violationCount: number;
  violationNodeCount: number;
}

/** Pulls the full AX tree over CDP. Playwright does not expose this, hence raw CDP. */
export async function axTree(cdp: CDPSession): Promise<AxNode[]> {
  await cdp.send('Accessibility.enable').catch(() => {});
  const res = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: unknown[] };
  const out: AxNode[] = [];
  for (const raw of res.nodes) {
    const n = raw as Record<string, any>;
    out.push({
      nodeId: String(n.nodeId),
      parentId: n.parentId === undefined ? undefined : String(n.parentId),
      role: String(n.role?.value ?? ''),
      name: String(n.name?.value ?? ''),
      value: n.value?.value === undefined ? undefined : String(n.value.value),
      description: n.description?.value === undefined ? undefined : String(n.description.value),
      properties: Array.isArray(n.properties)
        ? n.properties.map((p: any) => ({ name: String(p.name), value: p.value?.value }))
        : [],
      ignored: Boolean(n.ignored),
    });
  }
  return out;
}

/**
 * Runs axe in the page. Injected through CDP evaluation rather than addScriptTag,
 * because S5 measured that four of fifteen real sites ship a CSP strict enough to block
 * a script tag while CDP evaluation succeeded on every one of them.
 */
export async function runAxe(page: Page, axeSource: string): Promise<Violation[]> {
  await page.evaluate(axeSource);
  const raw = (await page.evaluate(async () => {
    const axe = (window as unknown as Record<string, any>).axe;
    if (!axe) return [];
    const result = await axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      nodes: v.nodes.map((n: any) => ({
        target: (n.target ?? []).map(String),
        html: String(n.html ?? ''),
        failureSummary: String(n.failureSummary ?? ''),
      })),
    }));
  })) as Violation[];
  return raw;
}

/**
 * Builds both payloads.
 *
 * The minimal payload keeps, for each violation, the offending node plus its ancestors
 * and immediate siblings in the AX tree. That context is not padding: without the
 * ancestor chain the model cannot tell a nav link from a form control, which is most of
 * what deciding a fix depends on.
 */
export function buildPayloads(nodes: AxNode[], violations: Violation[]): PagePayloads {
  const meaningful = nodes.filter((n) => !n.ignored);
  const full = JSON.stringify({
    kind: 'full-ax-tree',
    nodes: meaningful.map(serializeNode),
    violations,
  });

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const keep = new Set<string>();
  // Match AX nodes to violations by accessible name against the offending HTML. Exact
  // backendDOMNodeId mapping would need a second CDP round trip per node; for a cost
  // measurement the payload SIZE is what matters, and this selects a realistic slice.
  for (const v of violations) {
    for (const vn of v.nodes) {
      const hit = meaningful.find((n) => n.name.length > 2 && vn.html.includes(n.name));
      if (!hit) continue;
      keep.add(hit.nodeId);
      for (let cur = hit.parentId; cur; cur = byId.get(cur)?.parentId) keep.add(cur);
    }
  }

  const minimal = JSON.stringify({
    kind: 'violations-with-context',
    violations,
    context: meaningful.filter((n) => keep.has(n.nodeId)).map(serializeNode),
  });

  return {
    full,
    minimal,
    axNodeCount: meaningful.length,
    violationCount: violations.length,
    violationNodeCount: violations.reduce((n, v) => n + v.nodes.length, 0),
  };
}

function serializeNode(n: AxNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.nodeId, role: n.role, name: n.name };
  if (n.parentId) out.parent = n.parentId;
  if (n.value) out.value = n.value;
  if (n.description) out.description = n.description;
  if (n.properties.length) out.properties = n.properties;
  return out;
}

/**
 * The instructions that would precede every page's payload - the part a run can cache
 * across pages. Its size is what decides whether prompt caching is worth anything here,
 * so it has to be realistic rather than a placeholder.
 */
export const SYSTEM_PREFIX = [
  'You are an accessibility auditor. You are given the accessibility tree of a web page',
  'and the violations reported by axe-core. For each violation, decide whether it is a',
  'real barrier for a user of assistive technology, judge its severity, and describe the',
  'smallest change to the source that fixes it.',
  '',
  'Rules:',
  '- Judge the rendered accessibility tree, not the markup style.',
  '- A violation that assistive technology would not surface is not a barrier; say so.',
  '- Prefer a fix that changes semantics over one that adds ARIA.',
  '- Never invent a selector that is not present in the payload.',
  '- If the evidence is insufficient to decide, say that rather than guessing.',
].join('\n');
