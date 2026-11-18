# Release Board

A small internal page for production releases. Each release shows its version, status and date, has one release-notes `.docx` attached, and lists the PRs that went into it: who raised each one, the link, and a line on what it does.

- **Hosting:** GitHub Pages (static Vite build, deployed by `.github/workflows/pages.yml` on every push to `main`).
- **Backend:** Firebase: Google sign-in (Firebase Auth), Firestore for releases, PR entries and members, Cloud Storage for the `.docx` files.
- **Access:** only Google accounts on the allowlist (`members` collection) can sign in.
  - **admin:** creates, edits and deletes releases, uploads or replaces release notes, manages members, can fix any PR entry.
  - **dev:** adds PR entries and edits or deletes their own.

All of that is enforced by [`firestore.rules`](firestore.rules) and [`storage.rules`](storage.rules), not only by the UI. Uploads must be `.docx`, 10 MB at most.

## Data model

| Path | Fields |
| --- | --- |
| `members/{email}` (lower-case) | `role` (`admin` / `dev`), `name`, `addedBy`, `addedAt` |
| `releases/{version}` | `version`, `status` (`planned` / `qa` / `released`), `releaseDate` (`YYYY-MM-DD` or empty), `notes` (`{path, name, size, uploadedBy, uploadedAt}` or null), `createdBy`, `createdAt`, `updatedAt` |
| `releases/{version}/entries/{id}` | `devName`, `prUrl`, `summary`, `ownerUid`, `ownerEmail`, `createdAt`, `updatedAt` |
| Storage `release-notes/{version}/notes.docx` | the release notes file |

## Local development

Requires Node 22 and Java 11+ (for the emulators).

```bash
npm install
npm run emulators        # terminal 1: Auth, Firestore, Storage emulators (UI on :4410)
npm run seed:emu         # terminal 2: allowlists admin@example.com and dev@example.com
npm run dev:emu          # app on http://localhost:5173 against the emulators
```

In emulator mode the sign-in page has a "sign in as a fake Google account" box. It exists only in emulator builds.

Security-rules tests (start their own emulators):

```bash
npm run test:rules
```

## Firebase project setup (one time)

1. Create the Firebase project and upgrade it to the **Blaze** plan (Cloud Storage needs it; normal use stays in the free quota).
2. **Authentication → Sign-in method:** enable **Google**. Under **Settings → Authorised domains** add `<user>.github.io`.
3. **Firestore:** create the default database (production mode).
4. **Storage:** create the default bucket.
5. Register a **Web app** and paste its config into [`src/firebase-config.js`](src/firebase-config.js). These values are public by design.
6. Deploy the rules: `npx firebase login`, then `npx firebase deploy --only firestore:rules,storage --project <project-id>`.
7. Allow the site to download notes from the bucket (CORS): `gcloud storage buckets update gs://<bucket> --cors-file=cors.json`.
8. Add the first admin by hand in **Firestore → Data**: collection `members`, document id = the admin's lower-case email, fields `role` = `admin`, `name` (string), `addedBy` = `console`, `addedAt` (timestamp). Everyone else is added from the app's **Members** page.
