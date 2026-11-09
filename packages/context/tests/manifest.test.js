/**
 * Tests for FF-011 context ingestion and manifests.
 *
 * Each block maps to the acceptance criterion "version-pinned scoped
 * references" and the E11 workstream guidance: source hashes + project
 * ACL, secret redaction, task-scoped manifests (never giant raw dumps).
 *
 * Run: `npm test` inside packages/context (node --test, stdlib only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSources,
  attemptIsCurrent,
  bindTask,
  ContextError,
  createManifest,
  ingestSource,
  manifestForTask,
  MAX_FILE_BYTES,
  MAX_SOURCES_PER_TASK,
  refreshEvent,
  validateSource,
  verifyManifest,
} from '../src/index.js';
import { redactSecrets } from '../src/index.js';

const md = (name, bytes, extra = {}) => ingestSource({ name, mediaType: 'text/markdown', bytes, ...extra });

describe('validateSource: per-file states', () => {
  it('marks text kinds ready', () => {
    for (const mediaType of ['text/markdown', 'text/plain', 'application/json', 'application/yaml', 'text/csv']) {
      const v = validateSource({ name: 'spec.md', mediaType, byteSize: 100 });
      assert.equal(v.status, 'ready', mediaType);
    }
  });

  it('marks binaries pending_extraction (links only, never raw bytes)', () => {
    for (const mediaType of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) {
      const v = validateSource({ name: 'diagram.png', mediaType, byteSize: 100 });
      assert.equal(v.status, 'pending_extraction', mediaType);
    }
  });

  it('normalizes media types with params and casing', () => {
    const v = validateSource({ name: 'a.md', mediaType: 'Text/Markdown; charset=utf-8', byteSize: 1 });
    assert.equal(v.status, 'ready');
    assert.equal(v.mediaType, 'text/markdown');
  });

  it('rejects secret-bearing filenames', () => {
    for (const name of ['.env', '.env.local', 'config/.env.production', 'deploy.pem', 'tls.key',
      'cert.p12', 'store.pfx', 'id_rsa', 'id_ed25519', '.npmrc', 'secrets.json', 'credentials.json']) {
      const v = validateSource({ name, mediaType: 'text/plain', byteSize: 10 });
      assert.equal(v.status, 'rejected', name);
      assert.ok(v.reasons.includes('BLOCKED_FILENAME'), name);
    }
  });

  it('does not block public key halves or docs about secrets', () => {
    assert.equal(validateSource({ name: 'id_rsa.pub', mediaType: 'text/plain', byteSize: 10 }).status, 'ready');
    assert.equal(validateSource({ name: 'docs/secrets-handling.md', mediaType: 'text/markdown', byteSize: 10 }).status, 'ready');
  });

  it('rejects traversal, absolute paths, and repo internals', () => {
    for (const name of ['../escape.md', '/etc/passwd', 'a/../../b.md', '.git/config', 'x/node_modules/y.md']) {
      const v = validateSource({ name, mediaType: 'text/plain', byteSize: 10 });
      assert.equal(v.status, 'rejected', name);
      assert.ok(v.reasons.includes('BLOCKED_PATH'), name);
    }
  });

  it('rejects oversize, unsupported, and malformed inputs', () => {
    assert.ok(validateSource({ name: 'big.md', mediaType: 'text/markdown', byteSize: MAX_FILE_BYTES + 1 }).reasons.includes('FILE_TOO_LARGE'));
    assert.ok(validateSource({ name: 'f.mp4', mediaType: 'video/mp4', byteSize: 10 }).reasons.includes('UNSUPPORTED_MEDIA_TYPE'));
    assert.ok(validateSource({ name: 'f.zip', mediaType: 'application/zip', byteSize: 10 }).reasons.includes('UNSUPPORTED_MEDIA_TYPE'));
    assert.ok(validateSource({ name: 'f.md', mediaType: '', byteSize: 10 }).reasons.includes('UNSUPPORTED_MEDIA_TYPE'));
    assert.ok(validateSource({ name: 'f.md', mediaType: 'text/markdown', byteSize: -1 }).reasons.includes('INVALID_SIZE'));
    assert.ok(validateSource({ name: '', mediaType: 'text/markdown', byteSize: 10 }).reasons.includes('INVALID_SOURCE'));
  });
});

describe('redactSecrets: fail closed before model handoff', () => {
  it('redacts a private key block', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const { text, redactions } = redactSecrets(`deploy notes\n${key}\ndone`);
    assert.ok(!text.includes('BEGIN'), text);
    assert.ok(text.includes('[REDACTED:private-key]'));
    assert.deepEqual(redactions, [{ kind: 'private-key', occurrences: 1 }]);
  });

  it('redacts AWS keys, GitHub tokens, and bearer tokens', () => {
    const { text, redactions } = redactSecrets(
      'key AKIAIOSFODNN7EXAMPLE and ghp_abc123DEF456ghi789jkl and Bearer eyJhbGciOiJIUzI1NiJ9',
    );
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), text);
    assert.ok(!text.includes('ghp_abc123DEF456ghi789jkl'), text);
    assert.ok(text.includes('[REDACTED:aws-access-key]'));
    assert.ok(text.includes('[REDACTED:github-token]'));
    assert.ok(text.includes('[REDACTED:bearer-token]'));
    assert.equal(redactions.length, 3);
  });

  it('redacts credential values but keeps the key name readable', () => {
    const { text, redactions } = redactSecrets('config: password = hunter2\napi_key: "abc-123"');
    assert.ok(!text.includes('hunter2'), text);
    assert.ok(!text.includes('abc-123'), text);
    assert.ok(text.includes('password ='), text);
    assert.ok(text.includes('api_key:'), text);
    assert.ok(text.includes('[REDACTED:credential]'), text);
    const kinds = Object.fromEntries(redactions.map((r) => [r.kind, r.occurrences]));
    assert.equal(kinds['credential-assignment'], 1);
    assert.equal(kinds['credential-header'], 1);
  });

  it('leaves clean prose untouched, even with scary words', () => {
    const prose = 'The secret santa password policy is documented below. No tokens here.';
    const { text, redactions } = redactSecrets(prose);
    assert.equal(text, prose);
    assert.deepEqual(redactions, []);
  });

  it('rejects non-string input', () => {
    assert.throws(() => redactSecrets(null), TypeError);
  });
});

describe('ingestSource: hash pinning and excerpts', () => {
  it('pins identical bytes to identical hashes and store keys', () => {
    const a = md('prd.md', '# hello');
    const b = md('renamed.md', '# hello');
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.storeKey, `ctx/${a.sha256}`);
    assert.equal(a.sourceId, b.sourceId);
  });

  it('treats the hash as provenance: redacted excerpt, original pin', () => {
    const s = md('notes.md', 'login with password = hunter2');
    assert.ok(!s.excerpt.includes('hunter2'), s.excerpt);
    assert.equal(s.redactions.length, 1);
    assert.equal(s.visibility, 'project');
  });

  it('bounds excerpts and flags truncation', () => {
    const s = md('long.md', 'x'.repeat(20000));
    assert.ok(s.excerpt.length <= 8000);
    assert.equal(s.excerptTruncated, true);
    const short = md('short.md', 'tiny');
    assert.equal(short.excerptTruncated, false);
  });

  it('keeps binaries reference-only: no excerpt, pending extraction', () => {
    const s = ingestSource({ name: 'scan.pdf', mediaType: 'application/pdf', bytes: Buffer.alloc(100) });
    assert.equal(s.extraction, 'pending_extraction');
    assert.equal(s.excerpt, null);
    assert.deepEqual(s.redactions, []);
  });

  it('never stores-then-rejects: blocked and oversize inputs throw', () => {
    assert.throws(() => md('.env', 'K=V'), (e) => e instanceof ContextError && e.code === 'BLOCKED_FILENAME');
    assert.throws(
      () => ingestSource({ name: 'big.md', mediaType: 'text/plain', bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }),
      (e) => e instanceof ContextError && e.code === 'FILE_TOO_LARGE',
    );
  });

  it('rejects invalid caller-supplied sourceIds', () => {
    assert.throws(() => md('a.md', 'x', { sourceId: 'has space' }), (e) => e.code === 'INVALID_SOURCE');
  });

  it('returns frozen records', () => {
    const s = md('a.md', 'x');
    assert.ok(Object.isFrozen(s));
    assert.throws(() => { s.excerpt = 'tampered'; }, TypeError);
  });
});

describe('createManifest/verifyManifest: immutable version pins', () => {
  const sources = () => [md('b.md', 'bee', { sourceId: 's-b' }), md('a.md', 'aye', { sourceId: 's-a' })];

  it('is deterministic: source order does not change the revision', () => {
    const m1 = createManifest({ projectId: 'proj-a', goalRevision: 'goal-v1', sources: sources() });
    const m2 = createManifest({ projectId: 'proj-a', goalRevision: 'goal-v1', sources: [...sources()].reverse() });
    assert.equal(m1.revision, m2.revision);
    assert.ok(/^ctx-[0-9a-f]{16}$/.test(m1.revision), m1.revision);
    assert.deepEqual(m1.sources.map((s) => s.sourceId), ['s-a', 's-b']);
    assert.equal(verifyManifest(m1), true);
  });

  it('any content change yields a new revision', () => {
    const m1 = createManifest({ projectId: 'proj-a', goalRevision: 'goal-v1', sources: sources() });
    const m2 = createManifest({ projectId: 'proj-a', goalRevision: 'goal-v2', sources: sources() });
    assert.notEqual(m1.revision, m2.revision);
  });

  it('detects tampering and structural damage', () => {
    const m = createManifest({ projectId: 'proj-a', goalRevision: 'goal-v1', sources: sources() });
    const tampered = JSON.parse(JSON.stringify(m));
    tampered.revision = 'ctx-0000000000000000';
    assert.throws(() => verifyManifest(tampered), (e) => e.code === 'REVISION_MISMATCH');
    assert.throws(() => verifyManifest({ ...m, kind: 'other/v9' }), (e) => e.code === 'INVALID_MANIFEST');
    const dupes = JSON.parse(JSON.stringify(m));
    dupes.sources.push(dupes.sources[0]);
    assert.throws(() => verifyManifest(dupes), (e) => e.code === 'DUPLICATE_SOURCE_ID');
  });

  it('rejects duplicates, malformed sources, and bad ids at build time', () => {
    assert.throws(
      () => createManifest({ projectId: 'proj-a', goalRevision: 'g', sources: [md('a.md', 'x', { sourceId: 's' }), md('b.md', 'y', { sourceId: 's' })] }),
      (e) => e.code === 'DUPLICATE_SOURCE_ID',
    );
    assert.throws(
      () => createManifest({ projectId: 'proj-a', goalRevision: 'g', sources: [{ sourceId: 's' }] }),
      (e) => e.code === 'INVALID_SOURCE',
    );
    assert.throws(() => createManifest({ projectId: '', goalRevision: 'g' }), (e) => e.code === 'INVALID_MANIFEST');
    assert.throws(() => createManifest({ projectId: 'p' }), (e) => e.code === 'INVALID_MANIFEST');
  });

  it('returns frozen manifests', () => {
    const m = createManifest({ projectId: 'p', goalRevision: 'g', sources: sources() });
    assert.ok(Object.isFrozen(m) && Object.isFrozen(m.sources));
    assert.throws(() => { m.goalRevision = 'forged'; }, TypeError);
  });
});

describe('bindTask/addSources: explicit refresh, never in-place mutation', () => {
  const base = () => createManifest({
    projectId: 'proj-a',
    goalRevision: 'goal-v1',
    sources: [md('a.md', 'aye', { sourceId: 's-a' }), md('b.md', 'bee', { sourceId: 's-b' })],
  });

  it('binding bumps the revision and leaves the base untouched', () => {
    const m = base();
    const bound = bindTask(m, { taskKey: 'auth-ui', sourceIds: ['s-a'] });
    assert.notEqual(bound.revision, m.revision);
    assert.equal(m.taskBindings.length, 0);
    assert.equal(bound.taskBindings.length, 1);
    assert.equal(attemptIsCurrent(m, m.revision), true);
    assert.equal(attemptIsCurrent(bound, m.revision), false);
    assert.equal(attemptIsCurrent(bound, bound.revision), true);
  });

  it('rebinding the same task replaces the binding (per-task refresh)', () => {
    const m = bindTask(base(), { taskKey: 't', sourceIds: ['s-a'] });
    const m2 = bindTask(m, { taskKey: 't', sourceIds: ['s-a', 's-b'] });
    assert.equal(m2.taskBindings.length, 1);
    assert.deepEqual(m2.taskBindings[0].sourceIds, ['s-a', 's-b']);
    assert.notEqual(m2.revision, m.revision);
  });

  it('addSources verifies the base and preserves bindings', () => {
    const m = bindTask(base(), { taskKey: 't', sourceIds: ['s-a'] });
    const grown = addSources(m, [md('c.md', 'cee', { sourceId: 's-c' })]);
    assert.equal(grown.sources.length, 3);
    assert.equal(grown.taskBindings.length, 1);
    assert.notEqual(grown.revision, m.revision);
    assert.throws(() => addSources({ ...m, revision: 'ctx-ffffffffffffffff' }, [md('d.md', 'x', { sourceId: 's-d' })]),
      (e) => e.code === 'REVISION_MISMATCH');
  });

  it('rejects unknown sources, empty binds, and giant task dumps', () => {
    const m = base();
    assert.throws(() => bindTask(m, { taskKey: 't', sourceIds: ['nope'] }), (e) => e.code === 'UNKNOWN_SOURCE');
    assert.throws(() => bindTask(m, { taskKey: 't', sourceIds: [] }), (e) => e.code === 'INVALID_TASK');
    assert.throws(() => bindTask(m, { taskKey: '', sourceIds: ['s-a'] }), (e) => e.code === 'INVALID_TASK');
    const many = Array.from({ length: MAX_SOURCES_PER_TASK + 1 }, (_, i) => `s-${i}`);
    const wide = createManifest({
      projectId: 'p', goalRevision: 'g',
      sources: many.map((id) => md(`${id}.md`, id, { sourceId: id })),
    });
    assert.throws(() => bindTask(wide, { taskKey: 't', sourceIds: many }), (e) => e.code === 'TOO_MANY_TASK_SOURCES');
  });

  it('rejects re-pinning a sourceId to different bytes', () => {
    const m = base();
    assert.throws(
      () => addSources(m, [md('other.md', 'different-bytes', { sourceId: 's-a' })]),
      (e) => e.code === 'DUPLICATE_SOURCE_ID',
    );
  });
});

describe('manifestForTask: version-pinned scoped references + project ACL', () => {
  const manifest = () => {
    const m = createManifest({
      projectId: 'proj-a',
      goalRevision: 'goal-v1',
      sources: [
        md('prd.md', 'product', { sourceId: 'prd' }),
        md('other.md', 'unrelated', { sourceId: 'other' }),
      ],
    });
    return bindTask(m, { taskKey: 'auth-ui', sourceIds: ['prd'] });
  };

  it('returns only the bound sources, pinned to the manifest revision', () => {
    const m = manifest();
    const view = manifestForTask(m, 'auth-ui', { id: 'w-1', role: 'worker', projects: ['proj-a'] }, { authorization: { verdict: 'allow', policyVersion: '0.1.0' } });
    assert.equal(view.revision, m.revision);
    assert.equal(view.taskKey, 'auth-ui');
    assert.deepEqual(view.sources.map((s) => s.sourceId), ['prd']);
    assert.ok(Object.isFrozen(view));
  });

  it('denies cross-project retrieval, allows the owner to span projects', () => {
    const m = manifest();
    const allow = { authorization: { verdict: 'allow', policyVersion: '0.1.0' } };
    assert.throws(
      () => manifestForTask(m, 'auth-ui', { id: 'w-1', role: 'worker', projects: ['proj-b'] }, allow),
      (e) => e.code === 'CROSS_PROJECT_DENIED',
    );
    assert.throws(
      () => manifestForTask(m, 'auth-ui', { id: 'w-1', role: 'worker' }, allow),
      (e) => e.code === 'CROSS_PROJECT_DENIED',
    );
    const ownerView = manifestForTask(m, 'auth-ui', { id: 'owner', role: 'owner' }, allow);
    assert.equal(ownerView.revision, m.revision);
  });

  it('rejects unauthenticated actors and unbound tasks', () => {
    const m = manifest();
    assert.throws(
      () => manifestForTask(m, 'auth-ui', { id: 'x' }),
      (e) => e.code === 'UNKNOWN_ACTOR',
    );
    assert.throws(
      () => manifestForTask(m, 'nope', { id: 'w-1', role: 'worker', projects: ['proj-a'] }, { authorization: { verdict: 'allow' } }),
      (e) => e.code === 'TASK_NOT_BOUND',
    );
  });
});

describe('refreshEvent: explicit context-refresh trail', () => {
  it('links previous and current revisions with reason and actor', () => {
    const m = createManifest({ projectId: 'p', goalRevision: 'g', sources: [md('a.md', 'x', { sourceId: 's-a' })] });
    const m2 = addSources(m, [md('b.md', 'y', { sourceId: 's-b' })]);
    const ev = refreshEvent({ manifest: m2, prevRevision: m.revision, reason: 'spec updated', actorId: 'owner' });
    assert.equal(ev.type, 'context.refreshed');
    assert.equal(ev.prevRevision, m.revision);
    assert.equal(ev.revision, m2.revision);
    assert.ok(Object.isFrozen(ev));
  });

describe('coordinator review regressions: adversarial secrets (all values FAKE)', () => {
  // Vendor-style tokens are assembled at runtime so this file never holds a
  // realistic token-shaped literal; every value below is fake by construction.
  const SK_PROJ = ['sk', 'proj', 'FAKE0123456789abcdefghij'].join('-');
  const SK_BARE = ['sk', 'FAKE7f3a9c2e1b4d6f8a0c2e5b7d9f1a3c5e'].join('-');
  const ADVERSARIAL = [
    `OPENAI_API_KEY=${SK_PROJ}`,
    `standalone ${SK_PROJ} token`,
    `bare ${SK_BARE} token`,
    'https://bot:FAKE-PASSWORD-123@internal.example/hooks',
    'X-Api-Key: FAKE-HEADER-VALUE-789',
    'BACKUP_API_KEY=plain-fake-value-123',
  ].join('\n');

  it('redacts prefixed env names, standalone vendor tokens, URL userinfo, headers', () => {
    const { text, redactions } = redactSecrets(ADVERSARIAL);
    for (const secret of [SK_PROJ, SK_BARE, 'FAKE-PASSWORD-123', 'FAKE-HEADER-VALUE-789', 'plain-fake-value-123']) {
      assert.ok(!text.includes(secret), `leaked: ${secret}\n${text}`);
    }
    assert.ok(!text.includes('bot:FAKE'), text);
    assert.ok(redactions.length >= 4, JSON.stringify(redactions));
  });

  it('entropy screen catches random-looking tokens the patterns miss', () => {
    const token = 'xQ9vZ2mK8nB4pL7rT5wY3sD6fH1jQw';
    const { text, redactions } = redactSecrets(`id ${token} end`);
    assert.ok(!text.includes(token), text);
    assert.ok(redactions.some((r) => r.kind === 'high-entropy-secret'));
  });

  it('does not redact hex shas or long ordinary words in excerpts', () => {
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const { text, redactions } = redactSecrets(`pin ${sha} and antidisestablishmentarianism noted`);
    assert.ok(text.includes(sha), text);
    assert.ok(text.includes('antidisestablishmentarianism'), text);
    assert.deepEqual(redactions, []);
  });

  it('ingested excerpts never carry raw adversarial secrets', () => {
    const s = ingestSource({ name: 'notes.md', mediaType: 'text/markdown', bytes: ADVERSARIAL });
    for (const secret of [SK_PROJ, SK_BARE, 'FAKE-PASSWORD-123', 'FAKE-HEADER-VALUE-789', 'plain-fake-value-123']) {
      assert.ok(!s.excerpt.includes(secret), s.excerpt);
    }
  });
});

describe('coordinator review regressions: Windows paths stay rejected', () => {
  it('rejects backslash traversal, drive paths, and UNC shares', () => {
    for (const name of ['..\\escape.md', 'a\\..\\b.md', 'C:\\secrets\\x.md', '\\\\server\\share\\x.md']) {
      const v = validateSource({ name, mediaType: 'text/plain', byteSize: 10 });
      assert.equal(v.status, 'rejected', name);
      assert.ok(v.reasons.includes('BLOCKED_PATH'), name);
    }
  });
});

describe('coordinator review regressions: no serving without E07 policy', () => {
  const bound = () => bindTask(
    createManifest({ projectId: 'proj-a', goalRevision: 'g', sources: [md('a.md', 'x', { sourceId: 's-a' })] }),
    { taskKey: 't', sourceIds: ['s-a'] },
  );
  const actor = { id: 'w-1', role: 'worker', projects: ['proj-a'] };

  it('refuses to serve without an E07 allow-decision', () => {
    assert.throws(() => manifestForTask(bound(), 't', actor), (e) => e instanceof ContextError && e.code === 'POLICY_REQUIRED');
  });

  it('refuses to serve on a non-allow policy verdict', () => {
    assert.throws(
      () => manifestForTask(bound(), 't', actor, { authorization: { verdict: 'deny' } }),
      (e) => e instanceof ContextError && e.code === 'POLICY_DENIED',
    );
  });

  it('serves with an E07 allow-decision plus project scope', () => {
    const view = manifestForTask(bound(), 't', actor, { authorization: { verdict: 'allow', policyVersion: '0.1.0' } });
    assert.deepEqual(view.sources.map((s) => s.sourceId), ['s-a']);
  });
});

  it('refuses no-op and incomplete refresh events', () => {
    const m = createManifest({ projectId: 'p', goalRevision: 'g', sources: [] });
    assert.throws(
      () => refreshEvent({ manifest: m, prevRevision: m.revision, reason: 'x', actorId: 'o' }),
      (e) => e.code === 'NO_CHANGE',
    );
    assert.throws(
      () => refreshEvent({ manifest: m, prevRevision: 'ctx-aaaa', reason: '', actorId: 'o' }),
      (e) => e.code === 'INVALID_MANIFEST',
    );
  });
});
