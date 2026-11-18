// Seeds the local Firestore emulator with two allowlisted test accounts.
// Usage: npm run emulators   (in one terminal), then   npm run seed:emu
// In the emulator's Google sign-in popup, "Add new account" with one of these emails.
const base = 'http://127.0.0.1:8180/v1/projects/demo-release-board/databases/(default)/documents';
const members = [
  ['admin@example.com', 'admin', 'Test Admin'],
  ['dev@example.com', 'dev', 'Test Dev'],
];
for (const [email, role, name] of members) {
  const res = await fetch(`${base}/members/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        role: { stringValue: role },
        name: { stringValue: name },
        addedBy: { stringValue: 'seed' },
        addedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  console.log(res.ok ? `seeded ${email} (${role})` : `failed ${email}: ${res.status} ${await res.text()}`);
}
