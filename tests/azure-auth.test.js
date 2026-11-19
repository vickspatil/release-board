import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(),
  getAllAccounts: vi.fn(),
  acquireTokenSilent: vi.fn(),
  acquireTokenPopup: vi.fn(),
}));
vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: class { constructor() { Object.assign(this, mocks); } },
  InteractionRequiredAuthError: class extends Error {},
}));
vi.stubGlobal('location', { origin: 'https://example.com' });
const storage = new Map();
vi.stubGlobal('sessionStorage', {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
});
const { azureToken } = await import('../src/azure-auth.js');
const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
const user = { uid: 'firebase-1', email: 'dev@example.com' };
const account = { homeAccountId: 'work-1' };

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  mocks.getAllAccounts.mockReturnValue([account]);
});

test('first sign-in requires explicit consent rather than an automatic popup', async () => {
  expect(await azureToken(user)).toBeNull();
  expect(mocks.acquireTokenPopup).not.toHaveBeenCalled();
});

test('connection requests Azure DevOps scope and binds only this Firebase user', async () => {
  mocks.acquireTokenPopup.mockResolvedValue({ account, accessToken: 'test-token' });
  expect(await azureToken(user, true)).toBe('test-token');
  expect(mocks.acquireTokenPopup).toHaveBeenCalledWith(expect.objectContaining({
    scopes: ['499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'],
    loginHint: user.email,
  }));
  expect(storage.get('release-board.azure-account.firebase-1')).toBe('work-1');
  expect([...storage.values()]).not.toContain('test-token');
  expect(await azureToken({ uid: 'firebase-2', email: 'other@example.com' })).toBeNull();
});

test('subsequent sign-in silently refreshes the explicitly connected account', async () => {
  storage.set('release-board.azure-account.firebase-1', 'work-1');
  mocks.acquireTokenSilent.mockResolvedValue({ accessToken: 'refreshed' });
  expect(await azureToken(user)).toBe('refreshed');
  expect(mocks.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ account }));
  expect(mocks.acquireTokenPopup).not.toHaveBeenCalled();
});

test('expired consent falls back to connect without unsolicited popups', async () => {
  storage.set('release-board.azure-account.firebase-1', 'work-1');
  mocks.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError());
  expect(await azureToken(user)).toBeNull();
  expect(mocks.acquireTokenPopup).not.toHaveBeenCalled();
});

test('unexpected authentication failures are surfaced, not treated as no PRs', async () => {
  storage.set('release-board.azure-account.firebase-1', 'work-1');
  mocks.acquireTokenSilent.mockRejectedValue(new Error('Network unavailable'));
  await expect(azureToken(user)).rejects.toThrow('Network unavailable');
});
