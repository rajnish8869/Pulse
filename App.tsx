
import React, { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { CallProvider, useCall } from "./context/CallContext";
import Login from "./pages/Login";
import BottomNav from "./components/BottomNav";
import WalkieTalkie from "./pages/WalkieTalkie";
import { User, LogOut, Copy, UserPlus, Check, X, Mail, ShieldCheck } from "lucide-react";
import { collection, query, where, getDocs, addDoc, onSnapshot, doc, updateDoc, deleteDoc, setDoc } from "firebase/firestore";
import { db } from "./services/firebase";
import { FriendRequest } from "./types";

const GlobalAudioSink: React.FC = () => {
  const { remoteAudioRef } = useCall();

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = 1.0;
    }
  }, []);

  return (
    <audio
      ref={remoteAudioRef}
      autoPlay
      playsInline
      muted={false}
      crossOrigin="anonymous"
      className="hidden"
      aria-hidden="true"
      style={{ visibility: "hidden", width: "0", height: "0" }}
    />
  );
};

const ProfilePage: React.FC = () => {
  const { user, userData, signOut } = useAuth();
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [addEmail, setAddEmail] = useState("");
  const [addPin, setAddPin] = useState("");
  const [status, setStatus] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user || !db) return;
    const q = query(collection(db, "friendRequests"), where("toUid", "==", user.uid), where("status", "==", "pending"));
    return onSnapshot(q, (snap) => {
      setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() } as FriendRequest)));
    });
  }, [user?.uid]);

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !db) return;
    setLoading(true);
    setStatus(null);

    try {
      const uq = query(collection(db, "users"), where("email", "==", addEmail), where("pin", "==", addPin));
      const snap = await getDocs(uq);
      
      if (snap.empty) {
        throw new Error("Invalid Email or PIN combination.");
      }

      const target = snap.docs[0].data();
      if (target.uid === user.uid) {
        throw new Error("You cannot add yourself.");
      }

      await addDoc(collection(db, "friendRequests"), {
        fromUid: user.uid,
        fromName: user.displayName,
        fromPhoto: user.photoURL,
        toUid: target.uid,
        status: "pending",
        timestamp: Date.now()
      });

      setStatus({ msg: "Request sent successfully!", type: "success" });
      setAddEmail("");
      setAddPin("");
    } catch (err: any) {
      setStatus({ msg: err.message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const acceptRequest = async (req: FriendRequest) => {
    if (!db) return;
    try {
      // Create friendship doc
      const friendshipId = [req.fromUid, req.toUid].sort().join("_");
      await setDoc(doc(db, "friendships", friendshipId), {
        userA: req.fromUid,
        userB: req.toUid,
        createdAt: Date.now()
      });
      // Delete request doc
      await deleteDoc(doc(db, "friendRequests", req.id));
    } catch (e) {
      console.error(e);
    }
  };

  const declineRequest = async (req: FriendRequest) => {
    if (!db) return;
    await deleteDoc(doc(db, "friendRequests", req.id));
  };

  const handleCopyIdentity = () => {
    if (!userData?.pin) {
      alert("Syncing profile... please try again in a moment.");
      return;
    }
    const text = `Email: ${user?.email}\nPIN: ${userData.pin}`;
    navigator.clipboard.writeText(text).then(() => {
      alert("Identity copied to clipboard!");
    }).catch(() => {
      alert("Failed to copy.");
    });
  };

  return (
    <div className="p-6 pt-16 h-full overflow-y-auto pb-32">
      <div className="text-center mb-8">
        <div className="w-24 h-24 bg-gray-700 rounded-full mx-auto mb-4 flex items-center justify-center overflow-hidden border-4 border-primary/20 shadow-xl">
          {user?.photoURL ? (
            <img src={user.photoURL} className="w-full h-full object-cover" />
          ) : (
            <User size={40} className="text-gray-400" />
          )}
        </div>
        <h2 className="text-2xl font-black text-white uppercase italic tracking-tighter">{user?.displayName}</h2>
        <p className="text-sm text-gray-500 mb-2">{user?.email}</p>
      </div>

      {/* Identity Card */}
      <div className="bg-secondary p-6 rounded-3xl border border-white/5 mb-8 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <ShieldCheck className="text-primary" size={20} />
          <h3 className="text-xs font-black uppercase tracking-widest text-gray-400">Your Pulse ID</h3>
        </div>
        <div className="flex justify-between items-center bg-dark/50 p-4 rounded-2xl border border-white/5">
          <div>
            <p className="text-[10px] uppercase font-black text-gray-500 tracking-tighter mb-1">Pass-Code</p>
            <p className="text-2xl font-black tracking-[0.3em] text-primary">{userData?.pin || "••••••"}</p>
          </div>
          <button 
            onClick={handleCopyIdentity}
            className="p-3 bg-gray-800 rounded-xl text-gray-400 active:scale-95 transition-all hover:bg-gray-700 hover:text-white"
          >
            <Copy size={20} />
          </button>
        </div>
        <p className="text-[10px] text-gray-500 mt-4 leading-relaxed italic">
          Share your Email and PIN with friends so they can add you to their network.
        </p>
      </div>

      {/* Add Friend Form */}
      <div className="bg-secondary p-6 rounded-3xl border border-white/5 mb-8 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <UserPlus className="text-primary" size={20} />
          <h3 className="text-xs font-black uppercase tracking-widest text-gray-400">Link New Friend</h3>
        </div>
        <form onSubmit={handleAddFriend} className="space-y-4">
          <div className="relative">
            <Mail className="absolute left-4 top-3.5 text-gray-600" size={18} />
            <input 
              type="email" 
              placeholder="Friend's Email"
              className="w-full bg-dark/50 border border-white/5 rounded-2xl py-3.5 pl-12 pr-4 text-sm focus:ring-2 focus:ring-primary outline-none transition-all"
              value={addEmail}
              onChange={e => setAddEmail(e.target.value)}
              required
            />
          </div>
          <div className="relative">
            <ShieldCheck className="absolute left-4 top-3.5 text-gray-600" size={18} />
            <input 
              type="text" 
              inputMode="numeric"
              maxLength={6}
              placeholder="6-Digit PIN"
              className="w-full bg-dark/50 border border-white/5 rounded-2xl py-3.5 pl-12 pr-4 text-sm focus:ring-2 focus:ring-primary outline-none transition-all"
              value={addPin}
              onChange={e => setAddPin(e.target.value.replace(/\D/g, ""))}
              required
            />
          </div>
          {status && (
            <p className={`text-xs font-bold ${status.type === 'error' ? 'text-red-500' : 'text-green-500'}`}>
              {status.msg}
            </p>
          )}
          <button 
            disabled={loading}
            className="w-full py-4 bg-primary text-white font-black rounded-2xl shadow-lg active:scale-95 transition-all uppercase tracking-widest text-xs italic disabled:opacity-50"
          >
            {loading ? "SEARCHING..." : "SEND REQUEST"}
          </button>
        </form>
      </div>

      {/* Pending Requests */}
      {requests.length > 0 && (
        <div className="mb-8">
          <h3 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4 px-2">Incoming Requests</h3>
          <div className="space-y-3">
            {requests.map(req => (
              <div key={req.id} className="bg-secondary p-4 rounded-3xl flex items-center justify-between border border-primary/20 shadow-xl">
                <div className="flex items-center gap-3">
                   <div className="w-10 h-10 rounded-full bg-gray-700 overflow-hidden">
                     <img src={req.fromPhoto || "https://picsum.photos/100"} className="w-full h-full object-cover" />
                   </div>
                   <div>
                     <p className="text-xs font-black text-white uppercase italic">{req.fromName}</p>
                     <p className="text-[10px] text-gray-500">Wants to talk</p>
                   </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => acceptRequest(req)} className="p-2 bg-green-500/20 text-green-500 rounded-xl hover:bg-green-500/30">
                    <Check size={20} />
                  </button>
                  <button onClick={() => declineRequest(req)} className="p-2 bg-red-500/20 text-red-500 rounded-xl hover:bg-red-500/30">
                    <X size={20} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => signOut()}
        className="w-full py-4 rounded-2xl bg-gray-900 text-gray-500 flex items-center justify-center gap-2 hover:bg-red-900/20 hover:text-red-400 transition-colors font-black text-xs uppercase italic"
      >
        <LogOut size={16} />
        Sign Out Pulse
      </button>
    </div>
  );
};

const AppContent: React.FC = () => {
  const { user, loading } = useAuth();
  const [page, setPage] = useState("ptt");

  if (loading)
    return (
      <div className="h-screen flex items-center justify-center bg-dark text-white font-sans font-black italic uppercase tracking-widest animate-pulse">
        Syncing Pulse...
      </div>
    );
  if (!user) return <Login />;

  const renderPage = () => {
    switch (page) {
      case "ptt":
        return <WalkieTalkie />;
      case "profile":
        return <ProfilePage />;
      default:
        return <WalkieTalkie />;
    }
  };

  return (
    <div className="bg-dark h-screen text-white font-sans overflow-hidden">
      <CallProvider>
        <div className="w-full h-full relative">
          <GlobalAudioSink />
          {renderPage()}
          <BottomNav currentPage={page} onNavigate={setPage} />
        </div>
      </CallProvider>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
