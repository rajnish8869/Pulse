
import React, { useState, useEffect, useRef } from "react";
import { useCall } from "../context/CallContext";
import { CallStatus, UserProfile } from "../types";
import {
  Radio,
  User as UserIcon,
  AlertTriangle,
  UserPlus,
  RefreshCw,
  Mic,
  Volume2,
  Signal,
  WifiOff
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { collection, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { db } from "../services/firebase";
import { DEFAULT_AVATAR } from "../constants";

const WalkieTalkie: React.FC = () => {
  const {
    makeCall,
    endCall,
    toggleTalk,
    activeCall,
    callStatus,
    incomingCall,
    ensureAudioContext,
    answerCall,
  } = useCall();
  const { user } = useAuth();

  const [selectedFriend, setSelectedFriend] = useState<UserProfile | null>(null);
  const [friends, setFriends] = useState<UserProfile[]>([]);
  const [isHoldingButton, setIsHoldingButton] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean>>({});

  const prevFriendIdRef = useRef<string | null>(null);

  // 1. Fetch Friends & Realtime Status
  useEffect(() => {
    if (!db || !user) return;

    const q1 = query(collection(db, "friendships"), where("userA", "==", user.uid));
    const q2 = query(collection(db, "friendships"), where("userB", "==", user.uid));

    const handleFriendSnaps = async (snapshot: any) => {
      const friendIds = snapshot.docs.map((d: any) => {
        const data = d.data();
        return data.userA === user.uid ? data.userB : data.userA;
      });

      const friendProfiles: UserProfile[] = [];
      for (const fid of friendIds) {
        const snap = await getDoc(doc(db, "users", fid));
        if (snap.exists()) {
          friendProfiles.push(snap.data() as UserProfile);
        }
      }
      return friendProfiles;
    };

    // Use a function to reload friends periodically or just listen to friendships
    // For simplicity in this demo, we load profiles once on friendship change.
    // In a real app, you'd listen to 'users' collection for presence updates.
    // Here we will check lastActive periodically.
    
    const updateFriends = async (ids: string[]) => {
       const profiles: UserProfile[] = [];
       for(const id of ids) {
         const snap = await getDoc(doc(db, 'users', id));
         if(snap.exists()) profiles.push(snap.data() as UserProfile);
       }
       return profiles;
    };

    let friendIds = new Set<string>();

    const updateList = async () => {
       const profiles = await updateFriends(Array.from(friendIds));
       setFriends(profiles);
       setLoadingFriends(false);
       
       // Update online status map
       const now = Date.now();
       const statusMap: Record<string, boolean> = {};
       profiles.forEach(p => {
          // Fix TS error: ensure explicit boolean result
          statusMap[p.uid] = !!p.lastActive && (now - p.lastActive < 120000); // 2 mins threshold
       });
       setOnlineStatus(statusMap);
    };

    const unsub1 = onSnapshot(q1, (snap) => {
       snap.docs.forEach(d => friendIds.add(d.data().userB));
       updateList();
    });
    const unsub2 = onSnapshot(q2, (snap) => {
       snap.docs.forEach(d => friendIds.add(d.data().userA));
       updateList();
    });
    
    // Poll for status updates every 30s
    const pollInterval = setInterval(updateList, 30000);

    return () => {
      unsub1();
      unsub2();
      clearInterval(pollInterval);
    };
  }, [user?.uid]);

  // 2. Default selection
  useEffect(() => {
    if (friends.length > 0 && !selectedFriend) {
      setSelectedFriend(friends[0]);
    }
  }, [friends]);

  // 3. Connection Logic
  useEffect(() => {
    if (!selectedFriend || !user || !isReady || connectionError) return;

    const isCurrentSessionWithFriend =
      activeCall &&
      (activeCall.calleeId === selectedFriend.uid || activeCall.callerId === selectedFriend.uid);

    if (activeCall && !isCurrentSessionWithFriend && callStatus !== CallStatus.ENDED) {
      endCall();
      return; 
    }

    if (isCurrentSessionWithFriend && callStatus !== CallStatus.ENDED) return;
    if (incomingCall) return;

    if (selectedFriend.uid !== prevFriendIdRef.current || (!activeCall && callStatus === CallStatus.ENDED)) {
       prevFriendIdRef.current = selectedFriend.uid;
       makeCall(selectedFriend.uid, selectedFriend.displayName)
          .catch(() => setConnectionError(true));
    }
  }, [selectedFriend, isReady, activeCall, callStatus, incomingCall, connectionError]);

  // 4. Auto-Answer
  useEffect(() => {
    if (incomingCall && callStatus === CallStatus.RINGING) answerCall();
  }, [incomingCall, callStatus]);

  const handleManualRetry = () => {
    setConnectionError(false);
    prevFriendIdRef.current = null;
  };

  const isConnected = callStatus === CallStatus.CONNECTED;
  const isConnecting = callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING;
  const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;

  // Determine Main UI State Color
  let stateColor = "text-slate-500";
  let ringColor = "border-slate-800";
  let glowColor = "shadow-none";
  let statusText = "Ready";
  
  if (isHoldingButton) {
     stateColor = "text-rose-500";
     ringColor = "border-rose-500";
     glowColor = "shadow-[0_0_80px_rgba(244,63,94,0.4)]";
     statusText = "TRANSMITTING";
  } else if (isRemoteTalking) {
     stateColor = "text-emerald-500";
     ringColor = "border-emerald-500";
     glowColor = "shadow-[0_0_80px_rgba(16,185,129,0.4)]";
     statusText = "RECEIVING";
  } else if (isConnecting) {
     stateColor = "text-amber-500";
     ringColor = "border-amber-500 border-dashed animate-spin-slow";
     statusText = "TUNING...";
  } else if (connectionError) {
     stateColor = "text-red-500";
     ringColor = "border-red-900";
     statusText = "OFFLINE";
  } else if (isConnected) {
     stateColor = "text-primary";
     ringColor = "border-primary/50";
     statusText = "CHANNEL OPEN";
  }

  const handleTouchStart = () => {
    ensureAudioContext();
    if (!isConnected || isRemoteTalking) return;
    if (navigator.vibrate) navigator.vibrate(50);
    setIsHoldingButton(true);
    toggleTalk(true);
  };

  const handleTouchEnd = () => {
    if (!isHoldingButton) return;
    setIsHoldingButton(false);
    toggleTalk(false);
  };

  const activateApp = async () => {
    setPermissionDenied(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      ensureAudioContext();
      setIsReady(true);
      prevFriendIdRef.current = null;
    } catch (e) {
      setPermissionDenied(true);
    }
  };

  // --- RENDERING ---

  if (!isReady) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-950 text-white">
        <div className="relative mb-12">
           <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full animate-pulse"></div>
           <div className="relative w-32 h-32 bg-slate-900 rounded-[2.5rem] border border-white/10 flex items-center justify-center shadow-2xl">
              <Radio size={48} className="text-primary" />
           </div>
        </div>
        <h1 className="text-4xl font-black mb-2 tracking-tighter italic">PULSE</h1>
        <p className="text-slate-400 text-center mb-12 text-sm max-w-xs leading-relaxed font-medium">
          Instant voice networks. <br/>Tap below to initialize comms.
        </p>
        <button
          onClick={activateApp}
          className="w-full max-w-xs py-4 bg-primary text-white font-black rounded-2xl shadow-[0_0_30px_rgba(59,130,246,0.3)] active:scale-95 transition-all uppercase tracking-widest text-xs"
        >
          Initialize System
        </button>
      </div>
    );
  }

  if (!loadingFriends && friends.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-950 text-center">
        <div className="w-24 h-24 bg-slate-900 rounded-full flex items-center justify-center mb-6 border border-dashed border-slate-700">
          <UserPlus size={32} className="text-slate-600" />
        </div>
        <h3 className="text-lg font-bold text-white mb-2">No Active Channels</h3>
        <p className="text-slate-500 text-sm max-w-xs mb-8">
          Your frequency list is empty. Add friends from your profile to start talking.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 text-white safe-area-top safe-area-bottom overflow-hidden">
      
      {/* Top Channel Bar */}
      <div className="pt-4 pb-2 px-0 bg-slate-950/80 backdrop-blur-md z-10 border-b border-white/5">
         <div className="flex overflow-x-auto px-4 gap-3 pb-2 scrollbar-hide snap-x">
            {friends.map((friend) => {
               const isSelected = selectedFriend?.uid === friend.uid;
               const isOnline = onlineStatus[friend.uid];
               return (
                  <button
                     key={friend.uid}
                     onClick={() => {
                        if (selectedFriend?.uid !== friend.uid) {
                           setSelectedFriend(friend);
                           setConnectionError(false);
                        }
                     }}
                     className={`flex items-center gap-3 p-2 pr-4 rounded-full border transition-all snap-center min-w-max ${
                        isSelected 
                        ? "bg-slate-800 border-primary/50 shadow-lg shadow-black/20" 
                        : "bg-transparent border-transparent opacity-60 hover:bg-slate-900"
                     }`}
                  >
                     <div className="relative w-10 h-10">
                        <img 
                           src={friend.photoURL || DEFAULT_AVATAR} 
                           className={`w-full h-full rounded-full object-cover border-2 ${isSelected ? "border-primary" : "border-slate-700"}`}
                        />
                        <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-slate-950 ${isOnline ? "bg-emerald-500" : "bg-slate-600"}`}></div>
                     </div>
                     <div className="text-left">
                        <p className={`text-xs font-bold leading-none mb-0.5 ${isSelected ? "text-white" : "text-slate-300"}`}>{friend.displayName}</p>
                        <p className="text-[10px] font-mono text-slate-500 uppercase">{isOnline ? "ON-AIR" : "OFF"}</p>
                     </div>
                  </button>
               )
            })}
         </div>
      </div>

      {/* Main PTT Interface */}
      <div className="flex-1 flex flex-col items-center justify-center relative p-6">
         
         {/* Status Header */}
         <div className="absolute top-8 w-full text-center">
             <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-900 border border-white/5 shadow-xl">
                 {connectionError ? <WifiOff size={14} className="text-red-500" /> : <Signal size={14} className={isConnected ? "text-primary" : "text-slate-600"} />}
                 <span className={`text-[10px] font-black tracking-widest uppercase ${isConnected ? "text-white" : "text-slate-500"}`}>
                    {connectionError ? "LINK FAILED" : isConnected ? "LINK ESTABLISHED" : "SEARCHING..."}
                 </span>
             </div>
         </div>

         {/* PTT BUTTON */}
         <div className="relative group">
            {/* Outer Glow/Ripple */}
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full transition-all duration-500 ${glowColor} opacity-50 blur-3xl pointer-events-none`}></div>
            
            {/* Status Ring */}
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 rounded-full border-[3px] transition-all duration-300 ${ringColor} opacity-50 pointer-events-none`}></div>

            {/* The Button */}
            <button
               className={`relative w-64 h-64 rounded-full transition-all duration-200 active:scale-95 flex items-center justify-center shadow-2xl z-20 overflow-hidden ${isHoldingButton ? "bg-rose-500" : isRemoteTalking ? "bg-emerald-600" : "bg-slate-800"}`}
               onMouseDown={handleTouchStart}
               onMouseUp={handleTouchEnd}
               onMouseLeave={handleTouchEnd}
               onTouchStart={handleTouchStart}
               onTouchEnd={handleTouchEnd}
               style={{ WebkitTapHighlightColor: 'transparent' }}
            >
               {/* Background Texture */}
               <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>
               
               {/* Inner Content */}
               <div className="relative z-10 flex flex-col items-center gap-2">
                  {isHoldingButton ? (
                     <Mic size={48} className="text-white animate-pulse" />
                  ) : isRemoteTalking ? (
                     <Volume2 size={48} className="text-white animate-bounce" />
                  ) : (
                     <div className="text-slate-600 font-bold text-center">
                        <div className="w-16 h-16 rounded-full border-4 border-slate-700 flex items-center justify-center mb-2 mx-auto">
                           <div className="w-10 h-10 bg-slate-700 rounded-full"></div>
                        </div>
                     </div>
                  )}
                  
                  {activeCall?.callerPhoto || selectedFriend?.photoURL ? (
                     <div className={`absolute inset-0 opacity-30 transition-opacity duration-300 ${isHoldingButton || isRemoteTalking ? "opacity-10" : "opacity-40"}`}>
                        <img src={activeCall?.callerPhoto || selectedFriend?.photoURL || ""} className="w-full h-full object-cover" />
                     </div>
                  ) : null}
               </div>

               {/* Inner Shadow Gradient */}
               <div className="absolute inset-0 rounded-full shadow-[inset_0_10px_20px_rgba(0,0,0,0.5),inset_0_-10px_20px_rgba(255,255,255,0.1)] pointer-events-none"></div>
            </button>
         </div>

         {/* Instructions / Status Text */}
         <div className="mt-12 text-center h-16">
            <h2 className={`text-2xl font-black italic tracking-tighter uppercase transition-colors duration-200 ${stateColor}`}>
               {statusText}
            </h2>
            <p className="text-xs font-medium text-slate-500 mt-2 uppercase tracking-[0.2em]">
               {isHoldingButton ? "Release to Listen" : isRemoteTalking ? selectedFriend?.displayName : isConnected ? "Hold to Broadcast" : connectionError ? <button onClick={handleManualRetry} className="underline text-primary">Retry Link</button> : "Syncing Frequency"}
            </p>
         </div>

      </div>
    </div>
  );
};

export default WalkieTalkie;
