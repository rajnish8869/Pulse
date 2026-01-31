import React, { useState, useEffect, useRef } from "react";
import { useCall } from "../context/CallContext";
import { CallStatus, UserProfile } from "../types";
import {
  UserPlus,
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
    isMediaReady
  } = useCall();
  const { user } = useAuth();

  const [selectedFriend, setSelectedFriend] = useState<UserProfile | null>(null);
  const [friends, setFriends] = useState<UserProfile[]>([]);
  const [isHoldingButton, setIsHoldingButton] = useState(false);
  const [loadingFriends, setLoadingFriends] = useState(true);
  
  // Connection Error State (UI)
  const [connectionError, setConnectionError] = useState(false);
  
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean>>({});
  
  // Track holding state to transmit as soon as connected
  const isHoldingButtonRef = useRef(false);

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

  // 2. Handle manual selection change
  const handleFriendSelect = (friend: UserProfile) => {
      if (selectedFriend?.uid === friend.uid) return;
      
      console.log("Pulse: Selected channel", friend.displayName);
      
      // If currently connected to someone else, end it? 
      // "Ten Ten" keeps last channel active.
      // If we switch channels, we should probably disconnect the current one to save battery/data
      // unless we want to monitor multiple (not supported yet).
      if (activeCall && callStatus === CallStatus.CONNECTED) {
          endCall();
      }
      
      setConnectionError(false);
      setSelectedFriend(friend);
  };

  const handleManualRetry = () => {
      console.log("Pulse: Manual Retry");
      setConnectionError(false);
      // PTT press will trigger connection
  };

  // 3. Transmit on Connect if Holding
  useEffect(() => {
      if (callStatus === CallStatus.CONNECTED && isHoldingButtonRef.current && !activeCall?.activeSpeakerId) {
          console.log("Pulse: Connected while holding PTT. Transmitting...");
          toggleTalk(true);
      }
  }, [callStatus]);


  // --- UI ---

  const isConnected = callStatus === CallStatus.CONNECTED;
  const isConnecting = callStatus === CallStatus.OFFERING || 
                       callStatus === CallStatus.RINGING || 
                       callStatus === CallStatus.CONNECTING;
                       
  const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;

  let stateColor = "text-slate-500";
  let ringColor = "border-slate-800";
  let glowColor = "shadow-none";
  let statusText = "Ready";
  let showRetry = false;
  let statusSubtext = "Hold to Speak";
  
  if (isHoldingButton) {
     stateColor = "text-rose-500";
     ringColor = "border-rose-500";
     glowColor = "shadow-[0_0_80px_rgba(244,63,94,0.4)]";
     statusText = isConnected ? "TRANSMITTING" : "OPENING CHANNEL...";
     statusSubtext = isConnected ? "Release to Listen" : "Please Wait";
  } else if (isRemoteTalking) {
     stateColor = "text-emerald-500";
     ringColor = "border-emerald-500";
     glowColor = "shadow-[0_0_80px_rgba(16,185,129,0.4)]";
     statusText = "RECEIVING";
     statusSubtext = selectedFriend?.displayName || "Unknown";
  } else if (isConnecting) {
     stateColor = "text-amber-500";
     ringColor = "border-amber-500 border-dashed animate-spin-slow";
     statusText = "TUNING...";
     statusSubtext = "Syncing Frequency";
  } else if (connectionError) {
     stateColor = "text-red-500";
     ringColor = "border-red-900";
     statusText = "LINK FAILED";
     showRetry = true;
  } else if (isConnected) {
     stateColor = "text-primary";
     ringColor = "border-primary/50";
     statusText = "CHANNEL OPEN";
     statusSubtext = "Hold to Broadcast";
  } else if (!selectedFriend) {
     stateColor = "text-slate-600";
     ringColor = "border-slate-800";
     statusText = "STANDBY";
     statusSubtext = "Select a Channel";
  } else {
     statusText = "READY";
  }

  const handleTouchStart = async () => {
    ensureAudioContext();
    if (!selectedFriend) return;
    
    if (navigator.vibrate) navigator.vibrate(50);
    setIsHoldingButton(true);
    isHoldingButtonRef.current = true;

    // Wake-on-Signal Logic:
    // If not connected, we initiate the call (Signal)
    if (!isConnected && !isConnecting) {
        console.log("Pulse: PTT pressed while idle. Signaling...");
        try {
            await makeCall(selectedFriend.uid, selectedFriend.displayName);
            // The useEffect will catch the transition to CONNECTED and trigger toggleTalk
        } catch (e) {
            console.error("Pulse: Signaling failed", e);
            setConnectionError(true);
            setIsHoldingButton(false);
            isHoldingButtonRef.current = false;
        }
    } else if (isConnected && !isRemoteTalking) {
        toggleTalk(true);
    }
  };

  const handleTouchEnd = () => {
    setIsHoldingButton(false);
    isHoldingButtonRef.current = false;
    
    if (isConnected) {
        toggleTalk(false);
    }
    // Note: We do NOT end the call here. 
    // The "Ten Ten" style is to keep the channel open for a while or until the user leaves/switches.
    // However, to strictly follow "Wake-on-Signal" for battery, we *could* disconnect after a timeout.
    // For now, we leave it open as per standard PTT session behavior, assuming the user might reply.
  };

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
                        <p className="text--[10px] font-mono text-slate-500 uppercase">{isOnline ? "ON-AIR" : "OFF"}</p>
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
                    {connectionError ? "LINK FAILED" : isConnected ? "LINK ESTABLISHED" : !selectedFriend ? "STANDBY" : isConnecting ? "SEARCHING..." : "READY"}
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
            <div className="mt-2 text-xs font-medium text-slate-500 uppercase tracking-[0.2em]">
               {showRetry ? (
                   <button onClick={handleManualRetry} className="underline text-primary hover:text-white transition-colors">Retry Connection</button>
               ) : (
                   statusSubtext
               )}
            </div>
         </div>

      </div>
    </div>
  );
};

export default WalkieTalkie;