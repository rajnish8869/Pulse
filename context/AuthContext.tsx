import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInAnonymously, updateProfile, getAuth } from 'firebase/auth';
import { doc, setDoc, serverTimestamp, getFirestore } from 'firebase/firestore';
import { auth, db } from '../services/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signInAnon: (name: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signInAnon: async () => {},
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
        setLoading(false);
        return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        // Update presence
        if (db) {
            try {
                await setDoc(doc(db, 'users', firebaseUser.uid), {
                    uid: firebaseUser.uid,
                    displayName: firebaseUser.displayName || 'Anonymous',
                    email: firebaseUser.email,
                    photoURL: firebaseUser.photoURL,
                    lastActive: serverTimestamp(),
                }, { merge: true });
            } catch (e) {
                console.error("Error updating presence:", e);
            }
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const signInAnon = async (name: string) => {
    if (!auth) throw new Error("Firebase Auth not initialized");
    try {
        const result = await signInAnonymously(auth);
        if (result.user) {
            await updateProfile(result.user, { displayName: name });
            setUser({ ...result.user, displayName: name }); // Force update local state to reflect name immediately
        }
    } catch (e) {
        console.error("Error signing in", e);
        throw e;
    }
  };

  const signOut = async () => {
    if (!auth) return;
    await auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInAnon, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};