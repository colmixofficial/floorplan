// Hono module routers: a plugin registry hands each module a router at run time (`const r = ctx.routes`,
// `function registerExtra(r: Hono<Env>)`), mounted under a path built from the module's name
// (`new Hono().basePath(`/api/m/${key}`)`). The scan reads routes on those routers, and architecture.json's
// "routePrefixes" says where the files' routers are mounted when the scan can't follow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, scanAndBuild, readGraph, readJson, cleanup } from './helpers.mjs';
import path from 'node:path';

const { extract } = await lib('extract.mjs');

const PKG = JSON.stringify({ name: 'hub', type: 'module', dependencies: { hono: '^4.6.0' } });

const APP = `import { Hono } from 'hono';
import { modules } from './modules.js';
const app = new Hono();
const api = new Hono();
api.get('/health', (c) => c.text('ok'));
// module routers are looked up per request
api.all('/m/:key/*', (c) => modules.router(c.req.param('key')).fetch(c.req.raw));
app.route('/api', api);
export default app;
`;

const REGISTRY = `import { Hono } from 'hono';
export function contextFor(key) {
  const routes = new Hono().basePath(\`/api/m/\${key}\`);
  return { key, routes };
}
`;

const NOTES = `import { registerExtra } from './extra.js';
export default {
  register(ctx) {
    const r = ctx.routes;
    r.get('/items', (c) => c.json([]));
    r.post('/items', (c) => c.json({}, 201));
    registerExtra(r);
  },
};
`;

const EXTRA = `import type { Hono } from 'hono';
export function registerExtra(r: Hono<Env>, deps: Deps): void {
  r.delete('/items/:id', (c) => c.body(null, 204));
}
`;

const WEB = `export const addItem = () => fetch('/api/m/notes/items', { method: 'POST' });
export const removeItem = (id) => fetch(\`/api/m/notes/items/\${id}\`, { method: 'DELETE' });
`;

const files = {
  'hub/package.json': PKG,
  'hub/server/app.ts': APP,
  'hub/server/modules.ts': REGISTRY,
  'hub/server/modules/notes/server.ts': NOTES,
  'hub/server/modules/notes/extra.ts': EXTRA,
  'hub/web/api.ts': WEB,
};

const arch = (extra = {}) => ({
  project: { name: 'hub', summary: 'Test fixture.' },
  nodes: [
    { id: 'server', label: 'Server', kind: 'service', summary: 'The server.', paths: ['hub/server/**'] },
    { id: 'web', label: 'Web app', kind: 'ui', summary: 'The web app.', paths: ['hub/web/**'] },
  ],
  ...extra,
});

const PREFIXES = { routePrefixes: [{ paths: 'hub/server/modules/*/**', prefix: '/api/m/$1' }] };

function mapOf(a) {
  const root = makeProject(files, { arch: a });
  try {
    const out = scanAndBuild(root);
    return { graph: readGraph(root), out };
  } finally {
    cleanup(root);
  }
}

test('Hono: a router taken from a property named like one (const r = ctx.routes) serves routes', () => {
  const routes = extract(NOTES, 'typescript').routes.map((r) => `${r.method} ${r.path} ${r.var} :${r.line}`);
  assert.deepEqual(routes, ['GET /items r :5', 'POST /items r :6']);
});

test('Hono: a parameter typed as a router (r: Hono<Env>) serves routes', () => {
  const routes = extract(EXTRA, 'typescript').routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(routes, ['DELETE /items/:id']);
});

test('not routers: a property that is not named like one, a call result, a value of another type', () => {
  const src = `const r = draft.result;
r.get('/a');
const s = service.raw(id);
s.post('/b');
const t = this.routes.length;
t.get('/c');
function f(u: Map<string, string>) { u.get('/d'); }
`;
  assert.deepEqual(extract(src, 'typescript').routes, []);
});

test('routePrefixes: module routes get the prefix their registry mounts them under, and calls match them', () => {
  const { graph } = mapOf(arch(PREFIXES));
  const routes = graph.routes.map((r) => `${r.m} ${r.p} <- ${r.f}`).sort();
  assert.deepEqual(routes, [
    'ALL /api/m/:key/* <- hub/server/app.ts',
    'DELETE /api/m/notes/items/:id <- hub/server/modules/notes/extra.ts',
    'GET /api/health <- hub/server/app.ts',
    'GET /api/m/notes/items <- hub/server/modules/notes/server.ts',
    'POST /api/m/notes/items <- hub/server/modules/notes/server.ts',
  ]);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a} -> ${l.b}`);
  assert.ok(http.some((l) => l.startsWith('f:hub/web/api.ts') && l.includes('hub/server/modules/notes/server.ts')), JSON.stringify(http));
  assert.ok(http.some((l) => l.startsWith('f:hub/web/api.ts') && l.includes('hub/server/modules/notes/extra.ts')), JSON.stringify(http));
  assert.ok(!http.some((l) => l.startsWith('f:hub/web/api.ts') && l.includes('hub/server/app.ts')), `the catch-all should lose to the module route: ${JSON.stringify(http)}`);
});

test('routePrefixes: without it, module routes keep their own paths', () => {
  const { graph } = mapOf(arch());
  const own = graph.routes.filter((r) => r.f.startsWith('hub/server/modules/')).map((r) => `${r.m} ${r.p}`).sort();
  assert.deepEqual(own, ['DELETE /items/:id', 'GET /items', 'POST /items']);
});

test('routePrefixes: a file a mount already reaches keeps the mount, the rule does not add to it', () => {
  const extraFiles = { ...files, 'hub/server/modules/notes/server.ts': `import { Hono } from 'hono';\nconst notes = new Hono();\nnotes.get('/items', (c) => c.json([]));\nexport default notes;\n`, 'hub/server/app.ts': APP.replace("app.route('/api', api);", "app.route('/api', api);\nimport notes from './modules/notes/server.js';\napi.route('/notes', notes);") };
  const root = makeProject(extraFiles, { arch: arch(PREFIXES) });
  try {
    scanAndBuild(root);
    const routes = readGraph(root).routes.filter((r) => r.f === 'hub/server/modules/notes/server.ts').map((r) => `${r.m} ${r.p}`);
    assert.deepEqual(routes, ['GET /api/notes/items']);
  } finally {
    cleanup(root);
  }
});

test('routePrefixes: a rule that cannot be used is named and skipped, the scan goes on', () => {
  const bad = { routePrefixes: [{ paths: 'hub/server/modules/{a,b}/**', prefix: '/api/m/$1' }, { paths: 'hub/server/modules/*/**', prefix: 'api/m/$1' }, { paths: 'hub/server/modules/*/**', prefix: '/api/m/$3' }, 'nope'] };
  const root = makeProject(files, { arch: arch(bad) });
  try {
    const out = run('scan.mjs', root);
    assert.match(out, /routePrefixes\[0\].*only \* and \*\*/);
    assert.match(out, /routePrefixes\[1\].*start with \//);
    assert.match(out, /routePrefixes\[2\].*\$3, but its paths have only 2 wildcards/);
    assert.match(out, /routePrefixes\[3\].*paths and prefix/);
    const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.ok(scan.routes.some((r) => r.path === '/items'), 'module routes still read, without a prefix');
  } finally {
    cleanup(root);
  }
});

test('routePrefixes: the scan says how many routes a rule placed', () => {
  const root = makeProject(files, { arch: arch(PREFIXES) });
  try {
    const out = run('scan.mjs', root);
    assert.match(out, /ROUTE PREFIXES\s+hub\/server\/modules\/\*\/\*\* -> \/api\/m\/\$1: 3 routes/);
  } finally {
    cleanup(root);
  }
});

// Health: who may call the module routes. The guards live where the module registers them.
// extra.ts adds an open DELETE of its own; the Health tests leave it out
const NO_EXTRA = 'export function registerExtra() {}\n';

const GUARDED = `import { requireScope, denyService } from '../../auth.js';
export default {
  register(ctx) {
    const r = ctx.routes;
    const edit = requireScope('edit');
    const person = [denyService, requireScope('edit')] as const;
    r.post('/items', edit, (c) => c.json({}, 201));
    r.patch('/items/:id', ...person, (c) => c.json({}));
    r.delete('/items/:id', (c) => c.body(null, 204));
    r.use('/admin/*', requireScope('admin'));
    r.post('/admin/reset', (c) => c.json({}));
  },
};
`;

test('Health: a guard held in a local constant protects the routes it is handed to; a route without one is still open', () => {
  const root = makeProject({ ...files, 'hub/server/modules/notes/server.ts': GUARDED, 'hub/server/modules/notes/extra.ts': NO_EXTRA }, { arch: arch(PREFIXES) });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    const open = graph.health.issues
      .filter((i) => i.kind === 'unprotected-endpoint')
      .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
      .map((r) => `${r.m} ${r.p}`).filter((k) => k.includes('/api/m/notes/')).sort();
    assert.deepEqual(open, ['DELETE /api/m/notes/items/:id']);
  } finally {
    cleanup(root);
  }
});

// Review fixes (Opus 5.5, 2026-11-24)
const healthOpen = (src) => {
  const root = makeProject({ ...files, 'hub/server/modules/notes/server.ts': src, 'hub/server/modules/notes/extra.ts': NO_EXTRA }, { arch: arch(PREFIXES) });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    return graph.health.issues
      .filter((i) => i.kind === 'unprotected-endpoint')
      .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
      .map((r) => `${r.m} ${r.p}`).filter((k) => k.includes('/api/m/notes/')).sort();
  } finally {
    cleanup(root);
  }
};

test('Health: a constant is a guard only by what it calls, not by a word inside it (a schema field named token)', () => {
  const open = healthOpen(`import { zValidator } from '@hono/zod-validator';
export default { register(ctx) {
  const r = ctx.routes;
  const body = z.object({ token: z.string(), userId: z.string() });
  const opts = withOptions({ requireAuth: false });
  r.post('/items/import', zValidator('json', body), (c) => c.json({}));
  r.post('/other', opts, (c) => c.json({}));
} };
`);
  assert.deepEqual(open, ['POST /api/m/notes/items/import', 'POST /api/m/notes/other']);
});

test('Health: the declaration above the route counts, not one of the same name elsewhere', () => {
  const open = healthOpen(`export default { register(ctx) {
  const r = ctx.routes;
  function a() { const check = requireAuth; return check; }
  const check = (c, next) => next();
  r.post('/open', check, (c) => c.json({}));
} };
`);
  assert.deepEqual(open, ['POST /api/m/notes/open']);
});

test('routePrefixes: a router the ruled file mounts inside itself gets the prefix and the scoped guard', () => {
  const root = makeProject({ ...files, 'hub/server/modules/notes/server.ts': `import { Hono } from 'hono';
export default { register(ctx) {
  const r = ctx.routes;
  const admin = new Hono();
  admin.get('/x', (c) => c.json({}));
  r.use('/admin/*', requireScope('admin'));
  r.route('/admin', admin);
} };
` }, { arch: arch(PREFIXES) });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    const keys = graph.routes.filter((r) => r.f === 'hub/server/modules/notes/server.ts').map((r) => `${r.m} ${r.p}`);
    assert.deepEqual(keys, ['GET /api/m/notes/admin/x']);
    const open = graph.health.issues.filter((i) => i.kind === 'unprotected-endpoint').flatMap((i) => i.items);
    const idx = graph.routes.findIndex((r) => r.p === '/api/m/notes/admin/x');
    assert.ok(!open.includes(`r:${idx}`), 'the scoped requireScope guards it');
  } finally {
    cleanup(root);
  }
});

test('routePrefixes: limits on rule globs and placeholders', async () => {
  const { parseRoutePrefixes } = await lib('route-prefixes.mjs');
  const one = (rule) => parseRoutePrefixes([rule]).problems[0] || '';
  assert.match(one({ paths: 'a/' + '*x'.repeat(12) + 'y/**', prefix: '/p' }), /one \* per folder|wildcards/);
  assert.match(one({ paths: 'a/*/**', prefix: '/p/$0' }), /\$1 to \$9/);
  assert.match(one({ paths: 'a/*/**', prefix: '/p/$10' }), /\$1 to \$9/);
  assert.match(one({ paths: '/a/*/**', prefix: '/p/$1' }), /relative to the codebase root/);
  assert.match(one({ paths: '', prefix: '/p' }), /needs paths/);
  assert.match(one({ paths: 'a/*/**', prefix: '/p\n\x1b[31m' }), /control characters/);
  const t0 = Date.now();
  parseRoutePrefixes([{ paths: 'a/*x*x*x*x*x*x*x*x*x*x*x*x/**', prefix: '/p' }]).rules.forEach((r) => r.prefixFor('a/' + 'x'.repeat(40)));
  assert.ok(Date.now() - t0 < 500, 'no slow glob');
  const two = parseRoutePrefixes([{ paths: ['a/*/**', 'b/*/**'], prefix: '/p/$1' }, { paths: 'a/**', prefix: '/q' }]).rules;
  assert.equal(two[0].prefixFor('b/notes/x.ts'), '/p/notes');
  assert.equal(two[0].prefixFor('a/notes/x.ts'), '/p/notes');
});

test('not routers: a field typed as a router inside an interface or type', () => {
  const src = `interface Deps {\n  api: Express;\n}\ntype T = {\n  client: Router;\n};\napi.get('/users');\nclient.get('/x');\n`;
  assert.deepEqual(extract(src, 'typescript').routes.map((r) => r.path), []);
});
