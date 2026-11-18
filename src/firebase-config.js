// Firebase web config for the "production-management-console" project.
// These values are public by design: they identify the project, they don't
// grant access. Access is enforced by firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyAQsGy8TXH-ur4pQ9A2IjxguROqeVgfa_c',
  authDomain: 'production-management-console.firebaseapp.com',
  projectId: 'production-management-console',
  storageBucket: 'production-management-console.firebasestorage.app',
  messagingSenderId: '9001037663',
  appId: '1:9001037663:web:1111677657384d800790ea',
};

// Microsoft Entra ID tenant (directory) ID of the company tenant. Not a secret.
// Entra app "Production Management Console" (client ID 46fe96f5-6042-4c91-b321-287fc47db802), single tenant.
export const microsoftTenantId = '9dcf29f7-206e-4201-848f-6d4e392d4ca7';
