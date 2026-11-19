import './style.css';
import { azureToken } from './azure-auth.js';
import { azureProject, fetchMyPullRequests } from './azure-devops.js';
import { auth, db, googleProvider, microsoftProvider, usingEmulators } from './firebase.js';
import { GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut } from 'firebase/auth';
import {
  addDoc,
  Bytes,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_DOCX = 5 * 1024 * 1024; // must match firestore.rules
const CHUNK_BYTES = 900 * 1024; // Firestore documents max out at 1 MiB
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const STATUSES = { planned: 'Planned', qa: 'In QA', released: 'Released' };

const app = document.getElementById('app');

const state = {
  phase: 'loading', // loading | signed-out | not-allowed | ready
  user: null,
  member: null,
  releases: [],
  entries: [], // all entries, each with releaseId
  members: [],
  editingEntryId: null,
  editingRelease: false,
  busy: '',
  flash: null, // { kind: 'error'|'ok', text }
};

let azure = { status: 'disconnected', prs: [], account: '', error: '' };
let azureRequest;
let azureGeneration = 0;

function resetAzure() {
  azureGeneration++;
  azureRequest?.abort();
  azure = { status: 'disconnected', prs: [], account: '', error: '' };
}

async function loadAzurePrs(interactive = false) {
  if (!state.user || !state.member || usingEmulators || azure.status === 'loading') return;
  const user = state.user;
  const generation = azureGeneration;
  azureRequest = new AbortController();
  const signal = azureRequest.signal;
  azure = { status: 'loading', prs: [], account: '', error: '' };
  render();
  try {
    const token = await azureToken(user, interactive);
    if (generation !== azureGeneration || signal.aborted) return;
    if (!token) {
      azure.status = 'disconnected';
    } else {
      const result = await fetchMyPullRequests(token, { signal });
      if (generation !== azureGeneration || signal.aborted) return;
      azure = { ...result, status: 'ready', error: '' };
    }
  } catch (e) {
    if (generation !== azureGeneration || signal.aborted) return;
    azure = { status: 'error', prs: [], account: '', error: e.message || 'Could not connect to Azure DevOps.' };
  }
  render();
}

function azurePanel(picker = false) {
  const loading = azure.status === 'loading';
  return `<div class="azure-prs">
    <b>My Azure DevOps PRs</b>
    <p class="muted">${esc(azureProject.project)} · all repositories</p>
    ${usingEmulators ? '<p class="muted">Azure DevOps is unavailable for local test accounts. Enter a PR manually.</p>' : `
      ${azure.account ? `<p>Connected as ${esc(azure.account)}</p>` : ''}
      ${azure.error ? `<p role="alert">${esc(azure.error)}</p>` : ''}
      ${loading ? '<p role="status">Loading your PRs…</p>' : ''}
      ${azure.status === 'disconnected' ? '<p class="muted">Connect your work Microsoft account to choose your PRs.</p>' : ''}
      <button type="button" class="ghost" data-act="azure-connect" ${loading ? 'disabled' : ''}>${azure.status === 'ready' ? 'Refresh PRs' : 'Connect Azure DevOps'}</button>
      ${azure.status === 'ready' && !azure.prs.length ? '<p>No PRs found for your connected account in this project.</p>' : ''}
      ${picker && azure.prs.length ? `<label>Choose a PR<select id="azure-pr-picker" data-act="azure-select"><option value="">Select a PR to fill the form</option>${azure.prs.map((pr) => `<option value="${esc(pr.key)}">${esc(pr.repository)} · #${pr.id} · ${esc(pr.title)} (${esc(pr.status)})</option>`).join('')}</select></label>` : ''}
    `}
  </div>`;
}

let listeners = [];
const stopListeners = () => {
  listeners.forEach((u) => u());
  listeners = [];
};

// ---------- helpers ----------------------------------------------------------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const myEmail = () => (state.user?.email || '').toLowerCase();
const isAdmin = () => state.member?.role === 'admin';
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtTs = (t) => (t?.toDate ? t.toDate().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
const prLabel = (u) => {
  const m = String(u).match(/pull(?:request)?s?\/(\d+)/i);
  if (m) return `PR ${m[1]}`;
  try {
    const url = new URL(u);
    return url.host + url.pathname.replace(/\/$/, '').slice(0, 40);
  } catch {
    return u;
  }
};
const friendlyError = (e) => {
  const code = e?.code || '';
  if (code.includes('permission-denied') || code.includes('unauthorized')) return "You don't have permission to do that.";
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  if (code === 'auth/unauthorized-domain') return 'This site is not an authorised domain for sign-in yet.';
  if (code === 'auth/account-exists-with-different-credential')
    return 'This email already signs in with the other button (Google or Microsoft). Please use that one.';
  if (code === 'auth/operation-not-allowed') return 'That sign-in method is not switched on yet.';
  return e?.message || String(e);
};

function flash(kind, text) {
  if (!text) return;
  state.flash = { kind, text };
  render();
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    state.flash = null;
    render();
  }, kind === 'error' ? 7000 : 3000);
}

async function run(label, fn, okText) {
  state.busy = label;
  render();
  try {
    await fn();
    if (okText) flash('ok', okText);
  } catch (e) {
    console.error(e);
    flash('error', friendlyError(e));
  } finally {
    state.busy = '';
    render();
  }
}

// ---------- routing ----------------------------------------------------------
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('r/')) return { name: 'release', id: h.slice(2) };
  if (h === 'members') return { name: 'members' };
  return { name: 'board' };
}
window.addEventListener('hashchange', () => {
  state.editingEntryId = null;
  state.editingRelease = false;
  render();
  window.scrollTo(0, 0);
});

// ---------- auth & data ------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  stopListeners();
  resetAzure();
  state.user = user;
  state.member = null;
  state.releases = [];
  state.entries = [];
  state.members = [];
  if (!user) {
    state.phase = 'signed-out';
    render();
    return;
  }
  state.phase = 'loading';
  render();
  const meRef = doc(db, 'members', (user.email || '').toLowerCase());
  listeners.push(
    onSnapshot(
      meRef,
      (snap) => {
        const wasMember = !!state.member;
        state.member = snap.exists() ? snap.data() : null;
        if (state.member && !wasMember) {
          startData();
          loadAzurePrs();
        }
        if (!state.member) {
          // Removed from the allowlist (or never on it): drop data listeners.
          resetAzure();
          listeners.splice(1).forEach((u) => u());
          state.phase = 'not-allowed';
        } else {
          state.phase = 'ready';
        }
        render();
      },
      () => {
        resetAzure();
        state.phase = 'not-allowed';
        render();
      },
    ),
  );
});

function startData() {
  const onErr = (e) => flash('error', friendlyError(e));
  listeners.push(
    onSnapshot(
      collection(db, 'releases'),
      (snap) => {
        state.releases = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      },
      onErr,
    ),
    onSnapshot(
      collectionGroup(db, 'entries'),
      (snap) => {
        state.entries = snap.docs.map((d) => ({ id: d.id, releaseId: d.ref.parent.parent.id, ...d.data() }));
        render();
      },
      onErr,
    ),
    onSnapshot(
      collection(db, 'members'),
      (snap) => {
        state.members = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
        render();
      },
      onErr,
    ),
  );
}

const sortedReleases = () =>
  [...state.releases].sort((a, b) => {
    // Newest release date first; undated (planned) ones at the top.
    const ad = a.releaseDate || '9999';
    const bd = b.releaseDate || '9999';
    if (ad !== bd) return ad < bd ? 1 : -1;
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  });
const entriesFor = (releaseId) =>
  state.entries
    .filter((e) => e.releaseId === releaseId)
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? Infinity) - (b.createdAt?.toMillis?.() ?? Infinity));
// Forms are re-rendered while a request runs, so clear fields by id, not via the (detached) form.
const clearFields = (...ids) => ids.forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.value = '';
});
const defaultDevName = () => state.member?.name || state.user?.displayName || '';

// ---------- actions ----------------------------------------------------------
async function createRelease(form) {
  const version = form.version.value.trim();
  if (!VERSION_RE.test(version)) {
    flash('error', 'Version: letters, digits, dot, dash or underscore, up to 40 characters (e.g. v2.14.0).');
    return;
  }
  await run('create-release', async () => {
    const r = doc(db, 'releases', version);
    if ((await getDoc(r)).exists()) throw new Error(`Release ${version} already exists.`);
    await setDoc(r, {
      version,
      status: form.status.value,
      releaseDate: form.releaseDate.value || '',
      notes: null,
      createdBy: state.user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    clearFields('nr-version', 'nr-date');
    location.hash = `#/r/${encodeURIComponent(version)}`;
  }, `Release ${version} created.`);
}

async function saveRelease(release, form) {
  await run('save-release', async () => {
    await updateDoc(doc(db, 'releases', release.id), {
      status: form.status.value,
      releaseDate: form.releaseDate.value || '',
      updatedAt: serverTimestamp(),
    });
    state.editingRelease = false;
  }, 'Release updated.');
}

async function deleteRelease(release) {
  const n = entriesFor(release.id).length;
  if (!confirm(`Delete release ${release.version}, its ${n} PR entr${n === 1 ? 'y' : 'ies'} and its release notes? This can't be undone.`)) return;
  await run('delete-release', async () => {
    const [entrySnap, chunkSnap] = await Promise.all([
      getDocs(collection(db, 'releases', release.id, 'entries')),
      getDocs(collection(db, 'releases', release.id, 'noteChunks')),
    ]);
    const batch = writeBatch(db);
    entrySnap.forEach((d) => batch.delete(d.ref));
    chunkSnap.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, 'releases', release.id));
    await batch.commit();
    location.hash = '#/';
  }, `Release ${release.version} deleted.`);
}

// Release notes live in Firestore (free Spark plan, no Cloud Storage): the .docx
// bytes are split into chunks at releases/{id}/noteChunks/{uploadId}_{n}, and
// release.notes records the upload id and chunk count. A replacement writes a
// new upload id first, then switches release.notes, then deletes the old chunks,
// so a failed upload never breaks the notes already attached.
const chunkRef = (releaseId, uploadId, i) => doc(db, 'releases', releaseId, 'noteChunks', `${uploadId}_${i}`);

async function deleteChunks(releaseId, notes) {
  if (!notes?.uploadId) return;
  await Promise.all(
    Array.from({ length: notes.chunks || 0 }, (_, i) => deleteDoc(chunkRef(releaseId, notes.uploadId, i)).catch(() => {})),
  );
}

async function uploadNotes(release, file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.docx')) {
    flash('error', 'Release notes must be a .docx file.');
    return;
  }
  if (file.size === 0 || file.size > MAX_DOCX) {
    flash('error', file.size ? `That file is over the ${MAX_DOCX / 1024 / 1024} MB limit (${(file.size / 1024 / 1024).toFixed(2)} MB).` : 'That file is empty.');
    return;
  }
  if (release.notes && !confirm(`Replace ${release.notes.name} with ${file.name}?`)) return;
  await run('upload', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploadId = crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36).padStart(7, '0'), '');
    const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
    const fresh = { uploadId, chunks };
    try {
      for (let i = 0; i < chunks; i++) {
        state.busy = `upload:${i + 1}/${chunks}`;
        render();
        await setDoc(chunkRef(release.id, uploadId, i), {
          data: Bytes.fromUint8Array(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
        });
      }
      await updateDoc(doc(db, 'releases', release.id), {
        notes: {
          uploadId,
          chunks,
          name: file.name.slice(0, 200),
          size: bytes.length,
          uploadedBy: myEmail(),
          uploadedAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      await deleteChunks(release.id, fresh);
      throw e;
    }
    await deleteChunks(release.id, release.notes);
  }, 'Release notes uploaded.');
}

async function downloadNotes(release) {
  const notes = release.notes;
  await run('download', async () => {
    const parts = await Promise.all(
      Array.from({ length: notes.chunks }, async (_, i) => {
        const snap = await getDoc(chunkRef(release.id, notes.uploadId, i));
        if (!snap.exists()) throw new Error('Part of this file is missing; ask an admin to upload it again.');
        return snap.data().data.toUint8Array();
      }),
    );
    const blob = new Blob(parts, { type: DOCX_TYPE });
    if (blob.size !== notes.size) throw new Error('The downloaded file is incomplete; please try again.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = notes.name || `${release.version}-release-notes.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

async function removeNotes(release) {
  if (!confirm(`Remove ${release.notes.name} from ${release.version}?`)) return;
  const old = release.notes;
  await run('remove-notes', async () => {
    await updateDoc(doc(db, 'releases', release.id), { notes: null, updatedAt: serverTimestamp() });
    await deleteChunks(release.id, old);
  }, 'Release notes removed.');
}

function readEntryForm(form) {
  const v = {
    devName: form.devName.value.trim(),
    prUrl: form.prUrl.value.trim(),
    summary: form.summary.value.trim(),
  };
  if (!v.devName || !v.summary) throw new Error('Name and “what it does” are required.');
  if (!/^https?:\/\/\S+$/i.test(v.prUrl)) throw new Error('PR link must be a full http(s) URL.');
  return v;
}

async function addEntry(release, form) {
  let v;
  try {
    v = readEntryForm(form);
  } catch (e) {
    flash('error', e.message);
    return;
  }
  await run('add-entry', async () => {
    await addDoc(collection(db, 'releases', release.id, 'entries'), {
      ...v,
      ownerUid: state.user.uid,
      ownerEmail: myEmail(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    clearFields('add-entry-prUrl-new', 'add-entry-summary-new');
  }, 'PR added.');
}

async function saveEntry(entry, form) {
  let v;
  try {
    v = readEntryForm(form);
  } catch (e) {
    flash('error', e.message);
    return;
  }
  await run('save-entry', async () => {
    await updateDoc(doc(db, 'releases', entry.releaseId, 'entries', entry.id), { ...v, updatedAt: serverTimestamp() });
    state.editingEntryId = null;
  }, 'PR updated.');
}

async function deleteEntry(entry) {
  if (!confirm(`Delete ${prLabel(entry.prUrl)} by ${entry.devName}?`)) return;
  await run('delete-entry', () => deleteDoc(doc(db, 'releases', entry.releaseId, 'entries', entry.id)), 'PR deleted.');
}

async function addMember(form) {
  const email = form.email.value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    flash('error', 'Enter a valid email address.');
    return;
  }
  await run('add-member', async () => {
    const r = doc(db, 'members', email);
    if ((await getDoc(r)).exists()) throw new Error(`${email} is already a member.`);
    await setDoc(r, {
      role: form.role.value,
      name: form.name.value.trim().slice(0, 80),
      addedBy: myEmail(),
      addedAt: serverTimestamp(),
    });
    clearFields('m-email', 'm-name');
  }, `${email} added.`);
}

async function setRole(email, role) {
  await run('role', () => updateDoc(doc(db, 'members', email), { role }), 'Role updated.');
}

async function removeMember(email) {
  if (!confirm(`Remove ${email}? They will lose access immediately. Their PR entries stay.`)) return;
  await run('remove-member', () => deleteDoc(doc(db, 'members', email)), `${email} removed.`);
}

// ---------- views ------------------------------------------------------------
const statusBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(STATUSES[s] || s)}</span>`;

function header() {
  const u = state.user;
  const r = route();
  return `
  <header class="topbar">
    <a class="brand" href="#/"><span class="logo" aria-hidden="true"></span>Release Board</a>
    <nav>
      <a href="#/" class="${r.name !== 'members' ? 'active' : ''}">Releases</a>
      ${isAdmin() ? `<a href="#/members" class="${r.name === 'members' ? 'active' : ''}">Members</a>` : ''}
    </nav>
    <div class="who">
      ${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <span class="who-text"><b>${esc(u.displayName || u.email)}</b><small>${esc(u.email)}${isAdmin() ? ' · admin' : ''}</small></span>
      <button class="ghost" data-act="sign-out">Sign out</button>
    </div>
  </header>`;
}

function boardView() {
  const releases = sortedReleases();
  const counts = {};
  state.entries.forEach((e) => (counts[e.releaseId] = (counts[e.releaseId] || 0) + 1));
  const newForm = isAdmin()
    ? `<form class="card new-release" data-form="create-release">
        <h3>New release</h3>
        <label>Version<input name="version" id="nr-version" placeholder="v2.14.0" maxlength="40" required autocomplete="off" /></label>
        <div class="row">
          <label>Status<select name="status" id="nr-status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>Release date<input type="date" name="releaseDate" id="nr-date" /></label>
        </div>
        <button class="primary" ${state.busy ? 'disabled' : ''}>Create release</button>
      </form>`
    : '';
  const cards = releases
    .map(
      (r) => `
      <a class="card release" href="#/r/${encodeURIComponent(r.id)}">
        <div class="release-top">${statusBadge(r.status)}<span class="date">${esc(fmtDate(r.releaseDate)) || 'No date'}</span></div>
        <h2 class="version">${esc(r.version)}</h2>
        <div class="release-meta">
          <span>${counts[r.id] || 0} PR${counts[r.id] === 1 ? '' : 's'}</span>
          <span class="${r.notes ? 'has-notes' : 'no-notes'}">${r.notes ? 'Notes attached' : 'No notes yet'}</span>
        </div>
      </a>`,
    )
    .join('');
  return `
    <section class="page">
      <div class="page-head"><h1>Production releases</h1><p>${releases.length} release${releases.length === 1 ? '' : 's'}. Open one to add your PRs.</p></div>
      ${azurePanel()}
      <div class="grid">${newForm}${cards}</div>
      ${!releases.length && !isAdmin() ? '<p class="empty">No releases yet. An admin creates them.</p>' : ''}
    </section>`;
}

function entryForm(kind, e = {}) {
  return `
    <form class="entry-form" data-form="${kind}" ${e.id ? `data-id="${esc(e.id)}"` : ''}>
      ${kind === 'add-entry' ? azurePanel(true) : ''}
      <div class="row">
        <label>Developer<input name="devName" id="${kind}-devName-${esc(e.id || 'new')}" maxlength="80" required value="${esc(e.devName ?? defaultDevName())}" /></label>
        <label class="grow">PR link<input name="prUrl" id="${kind}-prUrl-${esc(e.id || 'new')}" type="url" maxlength="500" required placeholder="https://dev.azure.com/…/pullrequest/12345" value="${esc(e.prUrl || '')}" /></label>
      </div>
      <label>What it does<textarea name="summary" id="${kind}-summary-${esc(e.id || 'new')}" maxlength="500" rows="2" required placeholder="One or two lines on what the PR changes">${esc(e.summary || '')}</textarea></label>
      <div class="actions">
        <button class="primary" ${state.busy ? 'disabled' : ''}>${kind === 'add-entry' ? 'Add PR' : 'Save'}</button>
        ${kind === 'edit-entry' ? '<button type="button" class="ghost" data-act="cancel-edit">Cancel</button>' : ''}
      </div>
    </form>`;
}

function releaseView(id) {
  const r = state.releases.find((x) => x.id === id);
  if (!r) {
    return `<section class="page"><p class="empty">${state.releases.length ? `Release “${esc(id)}” was not found.` : 'Loading…'}</p><a href="#/">← All releases</a></section>`;
  }
  const entries = entriesFor(r.id);
  const admin = isAdmin();
  const uid = state.user.uid;

  const meta = state.editingRelease
    ? `<form class="inline-edit" data-form="save-release">
        <label>Status<select name="status" id="er-status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Release date<input type="date" name="releaseDate" id="er-date" value="${esc(r.releaseDate)}" /></label>
        <button class="primary" ${state.busy ? 'disabled' : ''}>Save</button>
        <button type="button" class="ghost" data-act="cancel-release-edit">Cancel</button>
      </form>`
    : `<div class="release-line">${statusBadge(r.status)}<span>${esc(fmtDate(r.releaseDate)) || 'No release date'}</span>
        ${admin ? '<button class="link" data-act="edit-release">Edit</button><button class="link danger" data-act="delete-release">Delete release</button>' : ''}</div>`;

  const notes = r.notes
    ? `<div class="notes-file">
        <span class="docx-icon" aria-hidden="true">W</span>
        <div><b>${esc(r.notes.name)}</b><small>${fmtSize(r.notes.size)} · uploaded ${esc(fmtTs(r.notes.uploadedAt))} by ${esc(r.notes.uploadedBy)}</small></div>
        <button class="primary" data-act="download" ${state.busy ? 'disabled' : ''}>${state.busy === 'download' ? 'Downloading…' : 'Download'}</button>
      </div>`
    : `<p class="muted">No release notes attached yet.</p>`;
  const notesAdmin = admin
    ? `<div class="notes-admin">
        <label class="file-btn ${state.busy ? 'disabled' : ''}">${state.busy.startsWith('upload') ? `Uploading ${state.busy.slice(7)}…` : r.notes ? 'Replace .docx' : 'Upload .docx'}
          <input type="file" data-act="upload" accept=".docx,${DOCX_TYPE}" ${state.busy ? 'disabled' : ''} /></label>
        ${r.notes ? '<button class="link danger" data-act="remove-notes">Remove</button>' : ''}
        <small class="muted">.docx only, up to 5 MB.</small>
      </div>`
    : '';

  const rows = entries
    .map((e) => {
      if (state.editingEntryId === e.id) return `<li class="entry editing">${entryForm('edit-entry', e)}</li>`;
      const canEdit = admin || e.ownerUid === uid;
      return `
      <li class="entry">
        <div class="entry-main">
          <div class="entry-head"><b>${esc(e.devName)}</b><a href="${esc(safeUrl(e.prUrl))}" target="_blank" rel="noopener noreferrer">${esc(prLabel(e.prUrl))} ↗</a></div>
          <p>${esc(e.summary)}</p>
          <small class="muted">${esc(e.ownerEmail)} · ${esc(fmtTs(e.updatedAt) || 'just now')}</small>
        </div>
        ${canEdit ? `<div class="entry-actions"><button class="link" data-act="edit-entry" data-id="${esc(e.id)}">Edit</button><button class="link danger" data-act="delete-entry" data-id="${esc(e.id)}">Delete</button></div>` : ''}
      </li>`;
    })
    .join('');

  return `
    <section class="page">
      <a class="back" href="#/">← All releases</a>
      <div class="release-head"><h1>${esc(r.version)}</h1>${meta}</div>
      <div class="detail-grid">
        <div class="card">
          <h3>PRs in this release <span class="count">${entries.length}</span></h3>
          ${entries.length ? `<ul class="entries">${rows}</ul>` : '<p class="muted">No PRs yet. Add yours below.</p>'}
          <h3 class="add-title">Add your PR</h3>
          ${entryForm('add-entry')}
        </div>
        <div class="card notes">
          <h3>Release notes</h3>
          ${notes}
          ${notesAdmin}
        </div>
      </div>
    </section>`;
}

function membersView() {
  if (!isAdmin()) return `<section class="page"><p class="empty">Only admins can manage members.</p></section>`;
  const me = myEmail();
  const rows = [...state.members]
    .sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'admin' ? -1 : 1))
    .map(
      (m) => `
      <tr>
        <td><b>${esc(m.name || '—')}</b><small>${esc(m.email)}</small></td>
        <td>${
          m.email === me
            ? `${m.role} <small class="muted">(you)</small>`
            : `<select data-act="role" data-email="${esc(m.email)}">${['dev', 'admin'].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`
        }</td>
        <td class="muted">${esc(m.addedBy)}<br />${esc(fmtTs(m.addedAt))}</td>
        <td>${m.email === me ? '' : `<button class="link danger" data-act="remove-member" data-email="${esc(m.email)}">Remove</button>`}</td>
      </tr>`,
    )
    .join('');
  return `
    <section class="page">
      <div class="page-head"><h1>Members</h1><p>Only these accounts can sign in, with Google or with a company Microsoft account (@digitalpetro.ai). Admins manage releases, release notes and members; developers add and edit their own PRs.</p></div>
      <form class="card add-member" data-form="add-member">
        <label class="grow">Email (Google or @digitalpetro.ai)<input name="email" id="m-email" type="email" required autocomplete="off" placeholder="name@company.com" /></label>
        <label>Name<input name="name" id="m-name" maxlength="80" placeholder="Optional" /></label>
        <label>Role<select name="role" id="m-role"><option value="dev">dev</option><option value="admin">admin</option></select></label>
        <button class="primary" ${state.busy ? 'disabled' : ''}>Add member</button>
      </form>
      <div class="card table-card">
        <table class="members"><thead><tr><th>Member</th><th>Role</th><th>Added by</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </section>`;
}

function signedOutView() {
  return `
    <main class="center">
      <div class="signin card">
        <span class="logo big" aria-hidden="true"></span>
        <h1>Release Board</h1>
        <p>Production releases, the PRs that go into them, and their release notes.</p>
        <div class="signin-buttons">
          <button class="primary google" data-act="sign-in">Sign in with Google</button>
          <button class="ghost microsoft" data-act="sign-in-ms"><span class="ms-logo" aria-hidden="true"></span>Sign in with Microsoft</button>
        </div>
        <p class="muted small">Use your company Microsoft account (@digitalpetro.ai) or Google. An admin has to add your email first.</p>
        ${usingEmulators ? `<form class="emu-signin" data-form="emu-sign-in">
          <p class="muted small">Local emulator mode: sign in as a fake Google account</p>
          <div class="row"><input name="email" id="emu-email" type="email" value="admin@example.com" /><select name="provider" id="emu-provider"><option value="google.com">Google</option><option value="microsoft.com">Microsoft</option></select><button class="ghost">Go</button></div>
        </form>` : ''}
      </div>
    </main>`;
}

function notAllowedView() {
  return `
    <main class="center">
      <div class="signin card">
        <h1>Not on the list yet</h1>
        <p><b>${esc(state.user.email)}</b> isn't on this board's allowlist. Ask an admin to add this exact Google account; this page opens the board as soon as you're added.</p>
        <button class="ghost" data-act="sign-out">Sign out</button>
      </div>
    </main>`;
}

// ---------- render -----------------------------------------------------------
function render() {
  // Keep what the user is typing across live re-renders.
  const kept = {};
  app.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => {
    if (el.type !== 'file') kept[el.id] = el.value;
  });
  const active = document.activeElement?.id;
  const sel = active && document.activeElement.selectionStart != null
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
    : null;

  let html;
  if (state.phase === 'loading') html = '<p class="boot">Loading…</p>';
  else if (state.phase === 'signed-out') html = signedOutView();
  else if (state.phase === 'not-allowed') html = notAllowedView();
  else {
    const r = route();
    const body = r.name === 'release' ? releaseView(r.id) : r.name === 'members' ? membersView() : boardView();
    html = header() + body;
  }
  if (state.flash) html += `<div class="toast ${state.flash.kind}" role="status">${esc(state.flash.text)}</div>`;
  app.innerHTML = html;

  for (const [id, v] of Object.entries(kept)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
  if (active) {
    const el = document.getElementById(active);
    if (el) {
      el.focus();
      if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {}
    }
  }
}

const currentRelease = () => state.releases.find((x) => x.id === route().id);

app.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT') return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const entry = id && state.entries.find((e) => e.id === id);
  switch (act) {
    case 'sign-in':
      signInWithPopup(auth, googleProvider).catch((e) => flash('error', friendlyError(e)));
      break;
    case 'sign-in-ms':
      signInWithPopup(auth, microsoftProvider).catch((e) => flash('error', friendlyError(e)));
      break;
    case 'azure-connect':
      loadAzurePrs(true);
      break;
    case 'sign-out':
      resetAzure();
      signOut(auth);
      location.hash = '#/';
      break;
    case 'edit-release':
      state.editingRelease = true;
      render();
      break;
    case 'cancel-release-edit':
      state.editingRelease = false;
      render();
      break;
    case 'delete-release':
      deleteRelease(currentRelease());
      break;
    case 'download':
      downloadNotes(currentRelease());
      break;
    case 'remove-notes':
      removeNotes(currentRelease());
      break;
    case 'edit-entry':
      state.editingEntryId = id;
      render();
      break;
    case 'cancel-edit':
      state.editingEntryId = null;
      render();
      break;
    case 'delete-entry':
      if (entry) deleteEntry(entry);
      break;
    case 'remove-member':
      removeMember(btn.dataset.email);
      break;
  }
});

app.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'azure-select') {
    const pr = azure.prs.find((p) => p.key === el.value);
    const form = el.closest('form');
    if (pr && form) {
      form.elements.prUrl.value = pr.url;
      form.elements.summary.value = pr.title.slice(0, 500);
    }
  }
  if (el.dataset.act === 'upload') uploadNotes(currentRelease(), el.files?.[0]);
  if (el.dataset.act === 'role') setRole(el.dataset.email, el.value);
});

app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  switch (form.dataset.form) {
    case 'create-release':
      createRelease(form);
      break;
    case 'save-release':
      saveRelease(currentRelease(), form);
      break;
    case 'add-entry':
      addEntry(currentRelease(), form);
      break;
    case 'edit-entry': {
      const entry = state.entries.find((e) => e.id === form.dataset.id);
      if (entry) saveEntry(entry, form);
      break;
    }
    case 'add-member':
      addMember(form);
      break;
    case 'emu-sign-in':
      // Emulator only: the Auth emulator accepts unsigned Google ID tokens.
      if (usingEmulators) {
        const email = form.email.value.trim();
        const ms = form.provider.value === 'microsoft.com';
        // Microsoft tokens often arrive without email_verified; mimic that here.
        const token = JSON.stringify({ sub: `emu-${ms ? 'ms' : 'g'}-${email}`, email, email_verified: !ms, name: email.split('@')[0] });
        const cred = ms ? new OAuthProvider('microsoft.com').credential({ idToken: token }) : GoogleAuthProvider.credential(token);
        signInWithCredential(auth, cred).catch((e) => flash('error', friendlyError(e)));
      }
      break;
  }
});

render();
