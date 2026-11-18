// Security-rules tests. Run with `npm run test:rules` (starts the Firestore,
// Storage and Auth emulators, then runs this file with vitest).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';

const PROJECT = 'demo-release-board';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ts = () => firebase.firestore.FieldValue.serverTimestamp();

const ADMIN = { uid: 'u-admin', email: 'admin@example.com' };
const DEV = { uid: 'u-dev', email: 'dev@example.com' };
const DEV2 = { uid: 'u-dev2', email: 'dev2@example.com' };
const STRANGER = { uid: 'u-x', email: 'stranger@example.com' };

let env;

const as = (u, extra = {}) =>
  env.authenticatedContext(u.uid, { email: u.email, email_verified: true, ...extra });
const db = (u, extra) => as(u, extra).firestore();
const bucket = (u) => as(u).storage();

const release = (uid, over = {}) => ({
  version: 'v1.0.0',
  status: 'planned',
  releaseDate: '2026-12-01',
  notes: null,
  createdBy: uid,
  createdAt: ts(),
  updatedAt: ts(),
  ...over,
});
const entry = (u, over = {}) => ({
  devName: 'Dev One',
  prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/1',
  summary: 'Fixes the thing',
  ownerUid: u.uid,
  ownerEmail: u.email,
  createdAt: ts(),
  updatedAt: ts(),
  ...over,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});
afterAll(() => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    const now = firebase.firestore.Timestamp.now();
    await f.doc('members/admin@example.com').set({ role: 'admin', name: 'Admin', addedBy: 'seed', addedAt: now });
    await f.doc('members/dev@example.com').set({ role: 'dev', name: 'Dev', addedBy: 'seed', addedAt: now });
    await f.doc('members/dev2@example.com').set({ role: 'dev', name: 'Dev2', addedBy: 'seed', addedAt: now });
    await f.doc('releases/v1.0.0').set({ ...release('u-admin'), createdAt: now, updatedAt: now });
    await f.doc('releases/v1.0.0/entries/e-dev').set({ ...entry(DEV), createdAt: now, updatedAt: now });
  });
});

describe('access', () => {
  test('signed-out users read nothing', async () => {
    const f = env.unauthenticatedContext().firestore();
    await assertFails(f.doc('releases/v1.0.0').get());
    await assertFails(f.collection('releases').get());
  });

  test('non-allowlisted Google accounts read nothing but can check themselves', async () => {
    const f = db(STRANGER);
    await assertFails(f.collection('releases').get());
    await assertFails(f.doc('releases/v1.0.0').get());
    await assertFails(f.collectionGroup('entries').get());
    await assertFails(f.collection('members').get());
    await assertSucceeds(f.doc('members/stranger@example.com').get());
    await assertFails(f.doc('members/dev@example.com').get());
  });

  test('unverified email is refused even if allowlisted', async () => {
    await assertFails(db(DEV, { email_verified: false }).collection('releases').get());
  });

  test('email match is case-insensitive', async () => {
    const f = db({ uid: 'u-dev', email: 'Dev@Example.com' });
    await assertSucceeds(f.collection('releases').get());
  });

  test('members read releases, entries (incl. collection group) and members', async () => {
    const f = db(DEV);
    await assertSucceeds(f.collection('releases').get());
    await assertSucceeds(f.collection('releases/v1.0.0/entries').get());
    await assertSucceeds(f.collectionGroup('entries').get());
    await assertSucceeds(f.collection('members').get());
  });

  test('strangers cannot add themselves to the allowlist', async () => {
    await assertFails(
      db(STRANGER).doc('members/stranger@example.com').set({ role: 'admin', name: '', addedBy: STRANGER.email, addedAt: ts() }),
    );
  });
});

describe('members', () => {
  const m = (by, over = {}) => ({ role: 'dev', name: 'New', addedBy: by, addedAt: ts(), ...over });

  test('admin adds, changes and removes members', async () => {
    const f = db(ADMIN);
    await assertSucceeds(f.doc('members/new@example.com').set(m(ADMIN.email)));
    await assertSucceeds(f.doc('members/new@example.com').update({ role: 'admin' }));
    await assertSucceeds(f.doc('members/new@example.com').delete());
  });

  test('member ids must be lower-case emails', async () => {
    await assertFails(db(ADMIN).doc('members/New@example.com').set(m(ADMIN.email)));
    await assertFails(db(ADMIN).doc('members/not-an-email').set(m(ADMIN.email)));
  });

  test('roles are limited and extra fields rejected', async () => {
    await assertFails(db(ADMIN).doc('members/new@example.com').set(m(ADMIN.email, { role: 'owner' })));
    await assertFails(db(ADMIN).doc('members/new@example.com').set(m(ADMIN.email, { extra: 1 })));
  });

  test('admin cannot demote or delete themselves', async () => {
    await assertFails(db(ADMIN).doc('members/admin@example.com').update({ role: 'dev' }));
    await assertFails(db(ADMIN).doc('members/admin@example.com').delete());
  });

  test('devs cannot manage members or promote themselves', async () => {
    await assertFails(db(DEV).doc('members/new@example.com').set(m(DEV.email)));
    await assertFails(db(DEV).doc('members/dev@example.com').update({ role: 'admin' }));
    await assertFails(db(DEV).doc('members/dev2@example.com').delete());
  });
});

describe('releases', () => {
  test('admin creates a release keyed by its version', async () => {
    await assertSucceeds(db(ADMIN).doc('releases/v2.0.0').set(release(ADMIN.uid, { version: 'v2.0.0' })));
  });

  test('version must equal the document id and be a safe slug', async () => {
    await assertFails(db(ADMIN).doc('releases/v2.0.0').set(release(ADMIN.uid, { version: 'v9' })));
    await assertFails(db(ADMIN).doc('releases/bad version').set(release(ADMIN.uid, { version: 'bad version' })));
  });

  test('status and date are validated', async () => {
    await assertFails(db(ADMIN).doc('releases/v2').set(release(ADMIN.uid, { version: 'v2', status: 'done' })));
    await assertFails(db(ADMIN).doc('releases/v2').set(release(ADMIN.uid, { version: 'v2', releaseDate: '1/12/26' })));
    await assertSucceeds(db(ADMIN).doc('releases/v2').set(release(ADMIN.uid, { version: 'v2', releaseDate: '' })));
  });

  test('admin cannot overwrite an existing release by re-creating it', async () => {
    await assertFails(db(ADMIN).doc('releases/v1.0.0').set(release(ADMIN.uid)));
  });

  test('admin edits status/date and attaches notes metadata', async () => {
    const f = db(ADMIN);
    await assertSucceeds(f.doc('releases/v1.0.0').update({ status: 'released', releaseDate: '2026-12-05', updatedAt: ts() }));
    const notes = { path: 'release-notes/v1.0.0/notes.docx', name: 'Release v1.docx', size: 1234, uploadedBy: ADMIN.email, uploadedAt: ts() };
    await assertSucceeds(f.doc('releases/v1.0.0').update({ notes, updatedAt: ts() }));
    await assertFails(f.doc('releases/v1.0.0').update({ notes: { ...notes, path: 'elsewhere/x.docx' }, updatedAt: ts() }));
    await assertFails(f.doc('releases/v1.0.0').update({ notes: { ...notes, name: 'evil.exe' }, updatedAt: ts() }));
  });

  test('devs cannot create, edit or delete releases', async () => {
    await assertFails(db(DEV).doc('releases/v2').set(release(DEV.uid, { version: 'v2' })));
    await assertFails(db(DEV).doc('releases/v1.0.0').update({ status: 'released', updatedAt: ts() }));
    await assertFails(db(DEV).doc('releases/v1.0.0').delete());
  });

  test('admin deletes a release', async () => {
    await assertSucceeds(db(ADMIN).doc('releases/v1.0.0').delete());
  });
});

describe('PR entries', () => {
  const col = 'releases/v1.0.0/entries';

  test('a dev adds an entry as themselves', async () => {
    await assertSucceeds(db(DEV2).collection(col).add(entry(DEV2)));
  });

  test('a dev cannot add an entry owned by someone else', async () => {
    await assertFails(db(DEV2).collection(col).add(entry(DEV)));
    await assertFails(db(DEV2).collection(col).add(entry(DEV2, { ownerEmail: DEV.email })));
  });

  test('entries need an existing release and valid fields', async () => {
    await assertFails(db(DEV).collection('releases/nope/entries').add(entry(DEV)));
    await assertFails(db(DEV).collection(col).add(entry(DEV, { prUrl: 'javascript:alert(1)' })));
    await assertFails(db(DEV).collection(col).add(entry(DEV, { summary: '' })));
    await assertFails(db(DEV).collection(col).add(entry(DEV, { summary: 'x'.repeat(501) })));
    await assertFails(db(DEV).collection(col).add(entry(DEV, { extra: true })));
  });

  test('strangers cannot add entries', async () => {
    await assertFails(db(STRANGER).collection(col).add(entry(STRANGER)));
  });

  test('owner edits and deletes their own entry', async () => {
    const f = db(DEV);
    await assertSucceeds(f.doc(`${col}/e-dev`).update({ summary: 'Updated', updatedAt: ts() }));
    await assertSucceeds(f.doc(`${col}/e-dev`).delete());
  });

  test('owner cannot hand the entry to someone else', async () => {
    await assertFails(db(DEV).doc(`${col}/e-dev`).update({ ownerUid: DEV2.uid, updatedAt: ts() }));
  });

  test("another dev cannot edit or delete someone else's entry", async () => {
    await assertFails(db(DEV2).doc(`${col}/e-dev`).update({ summary: 'Hijack', updatedAt: ts() }));
    await assertFails(db(DEV2).doc(`${col}/e-dev`).delete());
  });

  test('admin can fix or delete any entry', async () => {
    await assertSucceeds(db(ADMIN).doc(`${col}/e-dev`).update({ summary: 'Fixed by admin', updatedAt: ts() }));
    await assertSucceeds(db(ADMIN).doc(`${col}/e-dev`).delete());
  });
});

describe('release-notes storage', () => {
  const path = 'release-notes/v1.0.0/notes.docx';
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

  test('admin uploads and replaces a .docx; members download it', async () => {
    await assertSucceeds(bucket(ADMIN).ref(path).put(bytes, { contentType: DOCX }));
    await assertSucceeds(bucket(ADMIN).ref(path).put(bytes, { contentType: DOCX }));
    await assertSucceeds(bucket(DEV).ref(path).getMetadata());
  });

  test('strangers and signed-out users cannot download', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref(path).put(bytes, { contentType: DOCX }));
    await assertFails(bucket(STRANGER).ref(path).getMetadata());
    await assertFails(env.unauthenticatedContext().storage().ref(path).getMetadata());
  });

  test('devs cannot upload or delete notes', async () => {
    await assertFails(bucket(DEV).ref(path).put(bytes, { contentType: DOCX }));
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref(path).put(bytes, { contentType: DOCX }));
    await assertFails(bucket(DEV).ref(path).delete());
  });

  test('only .docx content type, under 10 MB, for an existing release', async () => {
    await assertFails(bucket(ADMIN).ref(path).put(bytes, { contentType: 'application/pdf' }));
    await assertFails(bucket(ADMIN).ref(path).put(new Uint8Array(10 * 1024 * 1024 + 1), { contentType: DOCX }));
    await assertFails(bucket(ADMIN).ref('release-notes/nope/notes.docx').put(bytes, { contentType: DOCX }));
  });

  test('no other paths are writable', async () => {
    await assertFails(bucket(ADMIN).ref('release-notes/v1.0.0/other.docx').put(bytes, { contentType: DOCX }));
    await assertFails(bucket(ADMIN).ref('anything.txt').put(bytes, { contentType: 'text/plain' }));
  });

  test('admin deletes notes', async () => {
    await env.withSecurityRulesDisabled((ctx) => ctx.storage().ref(path).put(bytes, { contentType: DOCX }));
    await assertSucceeds(bucket(ADMIN).ref(path).delete());
  });
});
