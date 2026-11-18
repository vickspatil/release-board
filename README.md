# Release Board

A small internal page for production releases. Each release shows its version, status and date, has one release-notes `.docx` attached, and lists the PRs that went into it: who raised each one, the link, and a line on what it does.

- **Hosting:** GitHub Pages (static Vite build, deployed by `.github/workflows/pages.yml` on every push to `main`).
- **Backend:** Firebase on the free Spark plan: Firebase Auth (Google, and Microsoft for the company Entra tenant), Firestore for releases, PR entries, members and the `.docx` files (stored as chunks of up to 900 KiB, because Cloud Storage would need the paid Blaze plan).
- **Access:** only Google accounts on the allowlist (`members` collection) can sign in.
  - **admin:** creates, edits and deletes releases, uploads or replaces release notes, manages members, can fix any PR entry.
  - **dev:** adds PR entries and edits or deletes their own.

All of that is enforced by [`firestore.rules`](firestore.rules), not only by the UI. Release notes must be `.docx`, 5 MB at most. Microsoft sign-ins are accepted only for `@digitalpetro.ai` addresses (they still need to be on the allowlist).

## Data model

| Path | Fields |
| --- | --- |
| `members/{email}` (lower-case) | `role` (`admin` / `dev`), `name`, `addedBy`, `addedAt` |
| `releases/{version}` | `version`, `status` (`planned` / `qa` / `released`), `releaseDate` (`YYYY-MM-DD` or empty), `notes` (`{uploadId, chunks, name, size, uploadedBy, uploadedAt}` or null), `createdBy`, `createdAt`, `updatedAt` |
| `releases/{version}/entries/{id}` | `devName`, `prUrl`, `summary`, `ownerUid`, `ownerEmail`, `createdAt`, `updatedAt` |
| `releases/{version}/noteChunks/{uploadId}_{n}` | `data` (bytes): piece `n` of the release-notes `.docx` |

## Local development

Requires Node 22 and Java 21+ (for the emulators).

```bash
npm install
npm run emulators        # terminal 1: Auth and Firestore emulators (UI on :4410)
npm run seed:emu         # terminal 2: allowlists admin@example.com, dev@example.com, ms.dev@digitalpetro.ai
npm run dev:emu          # app on http://localhost:5173 against the emulators
```

In emulator mode the sign-in page has a "sign in as a fake account" box (Google or Microsoft). It exists only in emulator builds.

Security-rules tests (start their own emulators):

```bash
npm run test:rules
```

## Firebase project setup (one time)

1. Create the Firebase project (the free Spark plan is enough).
2. **Authentication → Sign-in method:**
   - Enable **Google**.
   - Enable **Microsoft** with the Application (client) ID and a client secret from the Entra app registration below.
   - Under **Settings → Authorised domains** add `<user>.github.io`.
3. **Microsoft Entra ID → App registrations → New registration** (in the company tenant):
   - Supported account types: **this organisational directory only** (single tenant).
   - Redirect URI (Web): `https://<project-id>.firebaseapp.com/__/auth/handler`.
   - Create a client secret under **Certificates & secrets** and paste it straight into Firebase. Note when it expires.
   - Put the tenant's **Directory (tenant) ID** in `microsoftTenantId` in [`src/firebase-config.js`](src/firebase-config.js).
4. **Firestore:** create the default database (production mode).
5. Register a **Web app** and paste its config into [`src/firebase-config.js`](src/firebase-config.js). These values are public by design.
6. Publish [`firestore.rules`](firestore.rules): paste it into **Firestore → Rules**, or run `npx firebase login`, then `npx firebase deploy --only firestore:rules`.
7. Add the first admin by hand in **Firestore → Data**: collection `members`, document id = the admin's lower-case email, fields `role` = `admin`, `name` (string), `addedBy` = `console`, `addedAt` (timestamp). Everyone else is added from the app's **Members** page.
