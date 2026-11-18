// Firebase web config for the "production-management-console" project.
// These values are public by design: they identify the project, they don't
// grant access. Access is enforced by firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyAQsGy8TXH-ur4pQ9A2IjxguROqeVgfa_c',
  authDomain: 'production-management-console.firebaseapp.com',
  projectId: 'production-management-console',
  storageBucket: 'production-management-console.firebasestorage.app',
  messagingSenderId: '9001037663',
  appId: '1:9001037663:web:1111677657384d800790ea',
};

// Microsoft Entra ID tenant (directory) ID of the company tenant. Not a secret.
// Filled in after the Entra app registration is created.
export const microsoftTenantId = 'REPLACE_ME';
