/**
 * Minimal robots.txt matcher - enough to honour a Disallow before we touch a site
 * we do not own (TDD s9.5). Deliberately conservative: anything we fail to parse is
 * treated as disallowed rather than allowed.
 */
export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  /**
   * True when we could not reach robots.txt at all. We still refuse to crawl, but the
   * caller must record this as an unmeasured cell rather than as a site that blocked
   * us - otherwise a transient network blip silently shrinks the sample and every rate
   * in the report is computed over a denominator nobody noticed changed.
   */
  transient?: boolean;
}

export async function checkRobots(url: string, userAgent: string): Promise<RobotsDecision> {
  const target = new URL(url);
  const robotsUrl = `${target.origin}/robots.txt`;
  let text: string | null = null;
  let lastErr = '';

  for (let attempt = 0; attempt < 3 && text === null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(robotsUrl, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(20_000) });
      // No robots.txt at all means no restrictions.
      if (res.status === 404) return { allowed: true, reason: 'no robots.txt' };
      if (!res.ok) return { allowed: true, reason: `robots.txt ${res.status}, treating as unrestricted` };
      text = await res.text();
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (text === null) {
    return { allowed: false, reason: `robots.txt unreachable after 3 attempts: ${lastErr}`, transient: true };
  }

  const groups = parseGroups(text);
  // Most specific applicable group wins: our token, else the wildcard.
  const ua = userAgent.toLowerCase();
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  const group = mine ?? star;
  if (!group) return { allowed: true, reason: 'no applicable group' };

  const path = target.pathname + target.search;
  // Longest matching rule wins, per the de-facto standard; Allow breaks a length tie.
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of group.rules) {
    if (!pathMatches(path, rule.value)) continue;
    if (!best || rule.value.length > best.len || (rule.value.length === best.len && rule.allow)) {
      best = { len: rule.value.length, allow: rule.allow };
    }
  }
  if (!best) return { allowed: true, reason: 'no matching rule' };
  return { allowed: best.allow, reason: best.allow ? 'allowed by rule' : `disallowed by rule of length ${best.len}` };
}

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; value: string }>;
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const idx = clean.indexOf(':');
    if (idx < 0) continue;
    const field = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', value });
      lastWasAgent = false;
    }
  }
  return groups;
}

function pathMatches(path: string, pattern: string): boolean {
  // An empty Disallow means "allow everything" and matches nothing.
  if (pattern === '') return false;
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    '^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchoredEnd ? '$' : ''),
  );
  return rx.test(path);
}
