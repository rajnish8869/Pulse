
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
import { ref, onValue, off } from "firebase/database";
import { db, rtdb } from "../services/firebase";
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
    isMediaReady
  } = useCall();
  const { user } = useAuth();

  const [selectedFriend, setSelectedFriend] = useState<UserProfile | null>(null);
  const [friends, setFriends] = useState<UserProfile[]>([]);
  const [isHoldingButton, setIsHoldingButton] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean>>({});
  
  // Track the target friend to ensure we don't start call for old selection
  const targetFriendIdRef = useRef<string | null>(null);

  // Track previous status to detect call failures (OFFERING -> ENDED)
  const prevStatusRef = useRef<CallStatus>(CallStatus.ENDED);
  // Track if we are intentionally switching channels to ignore expected disconnects
  const isSwitchingRef = useRef(false);

  // 1. Fetch Friends & Status
  useEffect(() => {
    if (!db || !user || !rtdb) return;

    const q1 = query(collection(db, "friendships"), where("userA", "==", user.uid));
    const q2 = query(collection(db, "friendships"), where("userB", "==", user.uid));

    const updateFriends = async (ids: string[]) => {
       const profiles: UserProfile[] = [];
       for(const id of ids) {
         const snap = await getDoc(doc(db, 'users', id));
         if(snap.exists()) profiles.push(snap.data() as UserProfile);
       }
       return profiles;
    };

    let friendIds = new Set<string>();
    const statusUnsubscribes: (() => void)[] = [];

    const updateList = async () => {
       const profiles = await updateFriends(Array.from(friendIds));
       setFriends(profiles);
       setLoadingFriends(false);
       
       statusUnsubscribes.forEach(unsub => unsub());
       statusUnsubscribes.length = 0;

       profiles.forEach(p => {
           const statusRef = ref(rtdb, `status/${p.uid}`);
           const unsub = onValue(statusRef, (snap) => {
               const val = snap.val();
               const isOnline = val?.state === 'online';
               setOnlineStatus(prev => ({ ...prev, [p.uid]: isOnline }));
           });
           statusUnsubscribes.push(() => off(statusRef, 'value', unsub));
       });
    };

    const unsub1 = onSnapshot(q1, (snap) => {
       snap.docs.forEach(d => friendIds.add(d.data().userB));
       updateList();
    });
    const unsub2 = onSnapshot(q2, (snap) => {
       snap.docs.forEach(d => friendIds.add(d.data().userA));
       updateList();
    });
    
    return () => {
      unsub1();
      unsub2();
      statusUnsubscribes.forEach(unsub => unsub());
    };
  }, [user?.uid]);

  // 2. Default selection
  useEffect(() => {
    if (friends.length > 0 && !selectedFriend) {
      setSelectedFriend(friends[0]);
      targetFriendIdRef.current = friends[0].uid;
    }
  }, [friends]);

  // 3. Main Switcher Logic
  useEffect(() => {
    if (!selectedFriend || !user || !isMediaReady) return;

    // Handle incoming calls implicitly via auto-answer if needed (handled in other effect)
    if (incomingCall) return;

    const currentActiveId = activeCall ? (activeCall.callerId === user.uid ? activeCall.calleeId : activeCall.callerId) : null;
    const desiredId = selectedFriend.uid;

    if (currentActiveId === desiredId) {
        // Already connected to the right person. If we were in error state, clear it once connected.
        if (connectionError && callStatus === CallStatus.CONNECTED) {
            setConnectionError(false);
        }
        return;
    }

    // If we are connected to someone else, end it
    if (activeCall && currentActiveId !== desiredId) {
        console.log("Switching: Ending previous call");
        isSwitchingRef.current = true; // Mark as intentional switch
        endCall();
        return; // Wait for state to become ENDED
    }

    // If no active call and status is ended, start new call
    if (!activeCall && callStatus === CallStatus.ENDED) {
        // Check connectionError to prevent infinite loops
        if (targetFriendIdRef.current === desiredId && !connectionError) {
            console.log("Switching: Starting new call to", desiredId);
            makeCall(desiredId, selectedFriend.displayName)
                .catch((e) => {
                    console.error("Connection failed", e);
                    setConnectionError(true);
                });
        }
    }
  }, [selectedFriend, isMediaReady, activeCall, callStatus, incomingCall, connectionError]);

  // 4. Error Detector: Prevent Infinite Loops
  useEffect(() => {
     // Check if we were previously trying to connect
     const wasConnecting = prevStatusRef.current === CallStatus.OFFERING || 
                           prevStatusRef.current === CallStatus.RINGING || 
                           prevStatusRef.current === CallStatus.CONNECTING;
     
     const isEnded = callStatus === CallStatus.ENDED || callStatus === CallStatus.REJECTED;

     if (wasConnecting && isEnded) {
         if (isSwitchingRef.current) {
             // We intentionally ended the call to switch channels. This is normal.
             isSwitchingRef.current = false;
         } else {
             // The call ended without us initiating a switch (Timeout, Reject, Error).
             // Set error state to halt the auto-retry loop.
             console.log("Pulse: Call connection failed (Timeout/Rejected). Halting retry loop.");
             setConnectionError(true);
         }
     }
     prevStatusRef.current = callStatus;
  }, [callStatus]);

  // Handle manual selection change
  const handleFriendSelect = (friend: UserProfile) => {
      if (selectedFriend?.uid === friend.uid) return;
      
      setConnectionError(false);
      isSwitchingRef.current = false; // Reset switch flag
      setSelectedFriend(friend);
      targetFriendIdRef.current = friend.uid;
      
      // If we are already calling someone else, the main effect handles the teardown
  };

  // 5. Auto-Answer
  useEffect(() => {
    if (incomingCall && callStatus === CallStatus.RINGING) answerCall();
  }, [incomingCall, callStatus]);

  const handleManualRetry = () => {
    setConnectionError(false);
    // Force re-trigger of effect via state change if needed, but clearing error is usually enough
    // due to dependency array.
  };

  const isConnected = callStatus === CallStatus.CONNECTED;
  const isConnecting = callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING;
  const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;

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

  // --- RENDERING ---

  if (!isMediaReady) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-slate-950 text-white">
        <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-slate-400 text-xs tracking-widest uppercase">Initializing Systems...</p>
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
                     onClick={() => handleFriendSelect(friend)}
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
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full transition-all duration-500 ${glowColor} opacity-50 blur-3xl pointer-events-none`}></div>
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 rounded-full border-[3px] transition-all duration-300 ${ringColor} opacity-50 pointer-events-none`}></div>

            <button
               className={`relative w-64 h-64 rounded-full transition-all duration-200 active:scale-95 flex items-center justify-center shadow-2xl z-20 overflow-hidden ${isHoldingButton ? "bg-rose-500" : isRemoteTalking ? "bg-emerald-600" : "bg-slate-800"}`}
               onMouseDown={handleTouchStart}
               onMouseUp={handleTouchEnd}
               onMouseLeave={handleTouchEnd}
               onTouchStart={handleTouchStart}
               onTouchEnd={handleTouchEnd}
               style={{ WebkitTapHighlightColor: 'transparent' }}
            >
               <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>
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
