import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser';
import { microsoftTenantId } from './firebase-config.js';

const client = new PublicClientApplication({
  auth: {
    clientId: '5286cb8d-842d-4b3b-a6fa-178404ab7832',
    authority: `https://login.microsoftonline.com/${microsoftTenantId}`,
    redirectUri: new URL('azure-auth.html', new URL(import.meta.env.BASE_URL, location.origin)).href,
  },
  cache: { cacheLocation: 'sessionStorage' },
});
const initialized = client.initialize();
const scopes = ['499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'];
const bindingKey = (uid) => `release-board.azure-account.${uid}`;

export async function azureToken(user, interactive = false) {
  await initialized;
  const accountId = sessionStorage.getItem(bindingKey(user.uid));
  const account = client.getAllAccounts().find((a) => a.homeAccountId === accountId);
  if (account) {
    try {
      return (await client.acquireTokenSilent({ account, scopes })).accessToken;
    } catch (e) {
      if (!(e instanceof InteractionRequiredAuthError)) throw e;
    }
  }
  if (!interactive) return null;
  const result = await client.acquireTokenPopup({
    scopes,
    ...(account ? { account } : { loginHint: user.email, prompt: 'select_account' }),
  });
  sessionStorage.setItem(bindingKey(user.uid), result.account.homeAccountId);
  return result.accessToken;
}
