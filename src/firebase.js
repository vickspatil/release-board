import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, OAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { firebaseConfig, microsoftTenantId } from './firebase-config.js';

export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === '1';

const config = usingEmulators
  ? {
      apiKey: 'demo-key',
      authDomain: 'demo-release-board.firebaseapp.com',
      projectId: 'demo-release-board',
      storageBucket: 'demo-release-board.appspot.com',
      appId: 'demo-app',
    }
  : firebaseConfig;

const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Microsoft (company Entra ID). The app registration is single-tenant, so the
// tenant must be named here; only accounts from that tenant can sign in.
export const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.setCustomParameters({ prompt: 'select_account', tenant: microsoftTenantId });

if (usingEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8180);
}
