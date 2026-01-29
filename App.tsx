
import React, { useState, useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { useCall, CallProvider } from "./context/CallContext";
import Login from "./pages/Login";
import BottomNav from "./components/BottomNav";
import WalkieTalkie from "./pages/WalkieTalkie";
import { User, LogOut, Copy, UserPlus, Check, X, Mail, ShieldCheck, Zap, Radio, Bell, AlertTriangle, Camera } from "lucide-react";
import { collection, query, where, getDocs, addDoc, onSnapshot, doc, updateDoc, deleteDoc, setDoc, getDoc } from "firebase/firestore";
import { ref, onValue, onDisconnect, set, serverTimestamp } from "firebase/database";
import { db, rtdb } from "./services/firebase";
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
  const [uploading, setUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<'id' | 'add' | 'requests'>('id');
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // 1. Find User
      const uq = query(collection(db, "users"), where("email", "==", addEmail), where("pin", "==", addPin));
      const snap = await getDocs(uq);
      
      if (snap.empty) {
        throw new Error("User not found. Check Email & PIN.");
      }

      const target = snap.docs[0].data();
      if (target.uid === user.uid) {
        throw new Error("You cannot add yourself.");
      }

      // 2. Check if already friends
      // FIXED: Use getDoc instead of query. Querying by ID with where() fails security rules 
      // if the rule checks resource.data but the query doesn't filter on that data.
      const friendshipId1 = [user.uid, target.uid].sort().join("_");
      const friendshipDocRef = doc(db, "friendships", friendshipId1);
      const friendshipSnap = await getDoc(friendshipDocRef);
      
      if (friendshipSnap.exists()) {
        throw new Error("Already connected.");
      }
      
      // 3. Check for existing request
      const existingReq = await getDocs(query(
        collection(db, "friendRequests"), 
        where("fromUid", "==", user.uid), 
        where("toUid", "==", target.uid),
        where("status", "==", "pending")
      ));

      if (!existingReq.empty) {
         throw new Error("Request already sent.");
      }

      // 4. Send Request
      await addDoc(collection(db, "friendRequests"), {
        fromUid: user.uid,
        fromName: user.displayName,
        fromPhoto: userData?.photoURL || user.photoURL,
        toUid: target.uid,
        status: "pending",
        timestamp: Date.now()
      });

      setStatus({ msg: "Signal sent successfully!", type: "success" });
      setAddEmail("");
      setAddPin("");
    } catch (err: any) {
      console.error(err);
      setStatus({ msg: err.message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 512;
          const MAX_HEIGHT = 512;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7)); // Compress to JPEG 70% quality
        };
        img.onerror = (error) => reject(error);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setUploading(true);
      try {
        const base64 = await compressImage(file);
        if (user && db) {
          await updateDoc(doc(db, "users", user.uid), {
            photoURL: base64
          });
          // Optimistic update handled by AuthContext listener eventually, 
          // but we might want a toast here
          setStatus({ msg: "Profile photo updated", type: "success" });
          setTimeout(() => setStatus(null), 2000);
        }
      } catch (err) {
        console.error("Image upload failed", err);
        setStatus({ msg: "Failed to upload image", type: "error" });
      } finally {
        setUploading(false);
      }
    }
  };

  const acceptRequest = async (req: FriendRequest) => {
    if (!db) return;
    try {
      const friendshipId = [req.fromUid, req.toUid].sort().join("_");
      await setDoc(doc(db, "friendships", friendshipId), {
        userA: req.fromUid,
        userB: req.toUid,
        createdAt: Date.now()
      });
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
    if (!userData?.pin) return;
    const text = `Connect with me on Pulse!\nEmail: ${user?.email}\nPIN: ${userData.pin}`;
    navigator.clipboard.writeText(text);
    setStatus({ msg: "ID copied to clipboard", type: "success" });
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 text-white safe-area-top safe-area-bottom overflow-hidden">
      {/* Header */}
      <div className="px-6 py-6 pb-2">
        <h1 className="text-3xl font-black italic tracking-tighter text-white mb-1">
          COMMAND <span className="text-primary">CENTER</span>
        </h1>
        <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">Profile & Network</p>
      </div>

      {/* Tabs */}
      <div className="flex px-6 gap-4 mb-6 mt-4">
        <button 
          onClick={() => setActiveTab('id')}
          className={`flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-wider transition-all border ${activeTab === 'id' ? 'bg-primary border-primary text-white shadow-lg shadow-primary/20' : 'bg-slate-900 border-slate-800 text-slate-400'}`}
        >
          My ID
        </button>
        <button 
          onClick={() => setActiveTab('add')}
          className={`flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-wider transition-all border ${activeTab === 'add' ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'bg-slate-900 border-slate-800 text-slate-400'}`}
        >
          Connect
        </button>
        <button 
          onClick={() => setActiveTab('requests')}
          className={`flex-1 py-3 rounded-2xl text-xs font-black uppercase tracking-wider transition-all border relative ${activeTab === 'requests' ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-500/20' : 'bg-slate-900 border-slate-800 text-slate-400'}`}
        >
          Inbox
          {requests.length > 0 && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-slate-950"></span>}
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto px-6 pb-24">
        
        {/* MY ID TAB */}
        {activeTab === 'id' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
             <div className="relative overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900 rounded-[2rem] p-1 border border-white/10 shadow-2xl">
                <div className="absolute top-0 right-0 p-8 opacity-10">
                   <Radio size={120} />
                </div>
                <div className="bg-slate-950/50 backdrop-blur-md rounded-[1.8rem] p-6">
                   <div className="flex items-center gap-4 mb-8">
                      <div className="relative group cursor-pointer" onClick={() => fileInputRef.current?.click()}>
                        <div className="w-16 h-16 rounded-2xl bg-slate-800 border-2 border-primary/30 overflow-hidden shadow-lg relative">
                           <img 
                              src={userData?.photoURL || user?.photoURL || "https://picsum.photos/200"} 
                              className={`w-full h-full object-cover transition-opacity duration-300 ${uploading ? 'opacity-50' : 'opacity-100'}`} 
                              alt="Profile"
                           />
                           {uploading && (
                             <div className="absolute inset-0 flex items-center justify-center">
                               <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                             </div>
                           )}
                        </div>
                        <div className="absolute -bottom-2 -right-2 bg-slate-700 text-white p-1.5 rounded-lg border border-slate-600 shadow-md group-hover:bg-primary group-hover:border-primary transition-colors">
                           <Camera size={14} />
                        </div>
                        <input 
                           type="file" 
                           ref={fileInputRef} 
                           className="hidden" 
                           accept="image/*"
                           onChange={handleFileChange}
                        />
                      </div>
                      <div>
                         <h2 className="text-xl font-bold text-white">{user?.displayName}</h2>
                         <div className="flex items-center gap-2 mt-1">
                            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                            <span className="text-xs text-green-400 font-mono uppercase tracking-wider">Online</span>
                         </div>
                      </div>
                   </div>
                   
                   <div className="space-y-4">
                      <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5">
                         <label className="text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-1">Frequency Code (PIN)</label>
                         <div className="flex justify-between items-center">
                            <span className="text-3xl font-mono font-bold text-white tracking-[0.2em]">{userData?.pin || "••••"}</span>
                            <button onClick={handleCopyIdentity} className="p-2 bg-primary/20 text-primary rounded-lg hover:bg-primary hover:text-white transition-colors">
                               <Copy size={18} />
                            </button>
                         </div>
                      </div>
                      <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5">
                         <label className="text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-1">Comms Email</label>
                         <span className="text-sm font-mono text-slate-300 break-all">{user?.email}</span>
                      </div>
                   </div>
                </div>
             </div>
             
             <button
              onClick={() => signOut()}
              className="w-full py-4 rounded-2xl bg-slate-900 border border-red-500/20 text-red-400 flex items-center justify-center gap-2 hover:bg-red-500/10 transition-all font-black text-xs uppercase tracking-widest"
            >
              <LogOut size={16} />
              Termniate Session
            </button>
          </div>
        )}

        {/* ADD FRIEND TAB */}
        {activeTab === 'add' && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
             <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
                <div className="flex items-center gap-3 mb-6">
                   <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400">
                      <Zap size={20} />
                   </div>
                   <div>
                      <h3 className="text-lg font-bold text-white">Sync New User</h3>
                      <p className="text-xs text-slate-400">Enter credentials to establish link</p>
                   </div>
                </div>

                <form onSubmit={handleAddFriend} className="space-y-4">
                   <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 ml-3">TARGET EMAIL</label>
                      <input 
                        type="email" 
                        className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 px-5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all placeholder:text-slate-700"
                        placeholder="user@example.com"
                        value={addEmail}
                        onChange={e => setAddEmail(e.target.value)}
                        required
                      />
                   </div>
                   <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-500 ml-3">ACCESS PIN</label>
                      <input 
                        type="text" 
                        inputMode="numeric"
                        maxLength={6}
                        className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 px-5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all placeholder:text-slate-700 font-mono tracking-widest"
                        placeholder="000000"
                        value={addPin}
                        onChange={e => setAddPin(e.target.value.replace(/\D/g, ""))}
                        required
                      />
                   </div>

                   {status && (
                      <div className={`p-3 rounded-xl text-xs font-bold flex items-center gap-2 ${status.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                         {status.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                         {status.msg}
                      </div>
                   )}

                   <button 
                      disabled={loading}
                      className="w-full py-4 mt-2 bg-indigo-600 hover:bg-indigo-500 text-white font-black rounded-2xl shadow-lg shadow-indigo-500/20 active:scale-[0.98] transition-all uppercase tracking-widest text-xs"
                   >
                      {loading ? "SEARCHING..." : "ESTABLISH LINK"}
                   </button>
                </form>
             </div>
          </div>
        )}

        {/* REQUESTS TAB */}
        {activeTab === 'requests' && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
             {requests.length === 0 ? (
                <div className="text-center py-20 opacity-50">
                   <Bell size={48} className="mx-auto mb-4 text-slate-600" />
                   <p className="text-sm font-bold text-slate-500">No incoming signals</p>
                </div>
             ) : (
                <div className="space-y-3">
                   {requests.map(req => (
                      <div key={req.id} className="bg-slate-900 p-4 rounded-3xl border border-slate-800 flex items-center gap-4">
                         <div className="w-12 h-12 rounded-2xl bg-slate-800 overflow-hidden shrink-0">
                           <img src={req.fromPhoto || "https://picsum.photos/100"} className="w-full h-full object-cover" />
                         </div>
                         <div className="flex-1 min-w-0">
                           <h4 className="font-bold text-white truncate">{req.fromName}</h4>
                           <p className="text-xs text-slate-500">Wants to connect</p>
                         </div>
                         <div className="flex gap-2 shrink-0">
                           <button onClick={() => acceptRequest(req)} className="w-10 h-10 bg-emerald-500/10 text-emerald-500 rounded-xl flex items-center justify-center hover:bg-emerald-500 hover:text-white transition-all">
                              <Check size={20} />
                           </button>
                           <button onClick={() => declineRequest(req)} className="w-10 h-10 bg-red-500/10 text-red-500 rounded-xl flex items-center justify-center hover:bg-red-500 hover:text-white transition-all">
                              <X size={20} />
                           </button>
                         </div>
                      </div>
                   ))}
                </div>
             )}
          </div>
        )}

      </div>
      
      {/* Toast Notification if Status set and not on add tab */}
      {status && activeTab === 'id' && (
         <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-4 py-2 rounded-full shadow-xl border border-slate-700 text-xs font-bold animate-in fade-in slide-in-from-bottom-2 z-50">
            {status.msg}
         </div>
      )}
    </div>
  );
};

const AppContent: React.FC = () => {
  const { user, loading } = useAuth();
  const [page, setPage] = useState("ptt");

  // PRESENCE SYSTEM (RTDB)
  useEffect(() => {
    if (!user || !rtdb) return;

    // Reference to the special '.info/connected' path
    const connectedRef = ref(rtdb, '.info/connected');
    const userStatusRef = ref(rtdb, `status/${user.uid}`);

    const unsubscribe = onValue(connectedRef, (snap) => {
       if (snap.val() === true) {
          // When we connect, set up the disconnect hook first
          onDisconnect(userStatusRef).set({
             state: 'offline',
             lastChanged: serverTimestamp()
          }).then(() => {
             // Then set online status
             set(userStatusRef, {
                state: 'online',
                lastChanged: serverTimestamp()
             });
          });
       }
    });

    return () => {
       unsubscribe();
    }
  }, [user]);

  if (loading)
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center">
           <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
           <p className="text-primary font-black italic uppercase tracking-[0.3em] text-xs animate-pulse">Initializing Pulse...</p>
        </div>
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
    <div className="bg-slate-950 h-screen text-white font-sans overflow-hidden">
      <CallProvider>
        <div className="w-full h-full relative">
          <GlobalAudioSink />
          <div className="h-full w-full absolute inset-0 pb-16">
            {renderPage()}
          </div>
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
