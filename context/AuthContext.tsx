
import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  User, 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  updateProfile, 
  signOut as firebaseSignOut 
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../services/firebase';

interface AuthContextType {
  user: User | null;
  userData: any | null;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (email: string, pass: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  loading: true,
  login: async () => {},
  register: async () => {},
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
        setLoading(false);
        return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        if (db) {
            const userDocRef = doc(db, 'users', firebaseUser.uid);
            
            try {
                const userSnap = await getDoc(userDocRef);
                let data = userSnap.exists() ? userSnap.data() : {};
                
                // Backfill PIN for existing users if missing
                if (!data.pin) {
                    data.pin = Math.floor(100000 + Math.random() * 900000).toString();
                }

                const updates = {
                    uid: firebaseUser.uid,
                    displayName: firebaseUser.displayName || 'Unknown',
                    email: firebaseUser.email,
                    photoURL: firebaseUser.photoURL || null,
                    lastActive: serverTimestamp(),
                    pin: data.pin // Ensure PIN is persisted/merged
                };

                await setDoc(userDocRef, updates, { merge: true });
                
                // Update local state with the complete data object
                // We use Date.now() for lastActive in local state to avoid serverTimestamp object issues in UI
                setUserData({ ...data, ...updates, lastActive: Date.now() });
            } catch (e) {
                console.error("Error syncing user profile:", e);
                // Fallback: set basic user data if firestore fails
                if (!userData) {
                   setUserData({ 
                       uid: firebaseUser.uid, 
                       displayName: firebaseUser.displayName,
                       email: firebaseUser.email,
                       pin: 'ERROR' 
                   });
                }
            }
        }
      } else {
        setUser(null);
        setUserData(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const login = async (email: string, pass: string) => {
    if (!auth) throw new Error("Firebase Auth not initialized");
    await signInWithEmailAndPassword(auth, email, pass);
  };

  const register = async (email: string, pass: string, name: string) => {
    if (!auth) throw new Error("Firebase Auth not initialized");
    const result = await createUserWithEmailAndPassword(auth, email, pass);
    if (result.user) {
        // Generate random 6 digit pin
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        
        await updateProfile(result.user, { displayName: name });
        setUser({ ...result.user, displayName: name });
        
        if (db) {
            const data = {
                uid: result.user.uid,
                displayName: name,
                email: email,
                photoURL: null,
                pin: pin,
                lastActive: serverTimestamp(),
            };
            await setDoc(doc(db, 'users', result.user.uid), data);
            setUserData(data);
        }
    }
  };

  const signOut = async () => {
    if (!auth) return;
    await firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, userData, loading, login, register, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
