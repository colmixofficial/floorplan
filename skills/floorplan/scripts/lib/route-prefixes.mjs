// architecture.json "routePrefixes": where a file's routers are mounted when the scan can't follow it.
// A plugin registry that hands each module a router at run time (`new Hono().basePath(`/api/m/${key}`)`, then
// `ctx.routes` inside the module) puts every module's routes under a path built from a value only known while
// the app runs. A rule names the files and the prefix: { "paths": "server/modules/*/**", "prefix": "/api/m/$1" },
// where $1, $2 … are what the 1st, 2nd … wildcard matched. It only applies to routes no mount reaches.

import { globProblem } from './common.mjs';

const MAX_RULES = 50, MAX_PATHS = 20;
const CONTROL = /[\x00-\x1f\x7f]/;

/** One glob of a rule as a RegExp with a capture per wildcard. Only `*` (within one name) and a trailing `/**`. */
function captureGlob(glob) {
  if (glob.startsWith('/')) return { problem: 'its paths are relative to the codebase root, so they must not start with /' };
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  if (/[?{}[\]]/.test(g)) return { problem: 'its paths may use only * and ** as wildcards' };
  const general = globProblem(g);
  if (general) return { problem: `its paths are not usable: ${general}` };
  const deep = g.endsWith('/**') ? 1 : 0;
  const head = deep ? g.slice(0, -3) : g;
  if (!head || head.includes('**')) return { problem: 'its paths may use ** only at the end, as "/**"' };
  if (head.split('/').some((seg) => (seg.match(/\*/g) || []).length > 1)) return { problem: 'its paths may use at most one * per folder name' };
  const re = head.split('*').map((s) => s.replace(/[.+^$()|\\]/g, '\\$&')).join('([^/]*)') + (deep ? '(?:/(.*))?' : '');
  return { re: new RegExp('^' + re + '$'), wildcards: (head.match(/\*/g) || []).length + deep };
}

/**
 * Reads the field as written in architecture.json. Returns { rules, problems }: each rule is
 * { label, prefix, prefixFor(path) → string | null }, each problem a sentence naming the entry that was skipped.
 */
export function parseRoutePrefixes(list) {
  const rules = [], problems = [];
  if (list == null) return { rules, problems };
  if (!Array.isArray(list)) return { rules, problems: ['routePrefixes is not a list, so it was left out'] };
  list.slice(0, MAX_RULES).forEach((item, i) => {
    const where = `routePrefixes[${i}]`;
    const paths = typeof item?.paths === 'string' ? [item.paths] : item?.paths;
    if (!item || typeof item !== 'object' || !Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p) || typeof item.prefix !== 'string') {
      problems.push(`${where} skipped: it needs paths and prefix, e.g. { "paths": "server/modules/*/**", "prefix": "/api/m/$1" }`);
      return;
    }
    if (CONTROL.test(item.prefix) || paths.some((p) => CONTROL.test(p))) { problems.push(`${where} skipped: it has control characters`); return; }
    if (paths.length > MAX_PATHS) { problems.push(`${where} skipped: it has ${paths.length} paths; at most ${MAX_PATHS} are allowed`); return; }
    if (!item.prefix.startsWith('/')) { problems.push(`${where} skipped: its prefix must start with /`); return; }
    if (/\$(?:0|\d\d)/.test(item.prefix)) { problems.push(`${where} skipped: its prefix may use only $1 to $9`); return; }
    const globs = paths.map(captureGlob);
    const bad = globs.find((x) => x.problem);
    if (bad) { problems.push(`${where} skipped: ${bad.problem}`); return; }
    const used = Math.max(0, ...[...item.prefix.matchAll(/\$(\d)/g)].map((m) => +m[1]));
    const fewest = Math.min(...globs.map((x) => x.wildcards));
    if (used > fewest) { problems.push(`${where} skipped: its prefix uses $${used}, but its paths have only ${fewest} wildcard${fewest === 1 ? '' : 's'}`); return; }
    rules.push({
      label: `${paths.join(', ')} -> ${item.prefix}`.slice(0, 300),
      prefix: item.prefix,
      prefixFor(path) {
        for (const { re } of globs) {
          const m = re.exec(path);
          if (m) return item.prefix.replace(/\$(\d)/g, (_, n) => m[+n] || '');
        }
        return null;
      },
    });
  });
  if (list.length > MAX_RULES) problems.push(`routePrefixes has ${list.length} rules; only the first ${MAX_RULES} were used`);
  return { rules, problems };
}
