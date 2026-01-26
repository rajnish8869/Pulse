import { initializeApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCBSiWbOik2ksVyKcGOjb0_UYrIozyCTN0",
  authDomain: "pulse-b1a30.firebaseapp.com",
  projectId: "pulse-b1a30",
  storageBucket: "pulse-b1a30.firebasestorage.app",
  messagingSenderId: "132301633320",
  appId: "1:132301633320:web:a26589c3e86831645fc21d"
};

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (e) {
    console.error("Failed to initialize firebase", e);
}

// No-ops for compatibility with existing imports
export const saveConfig = (config: any) => {
    console.log("Configuration is hardcoded. Received:", config);
};
export const clearConfig = () => {
    console.warn("Configuration is hardcoded and cannot be cleared.");
};

export { app, auth, db };