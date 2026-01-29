
import React, { useState, useEffect, useRef } from "react";
import { useCall } from "../context/CallContext";
import { CallStatus, UserProfile } from "../types";
import {
  Radio,
  User as UserIcon,
  AlertTriangle,
  UserPlus,
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
  
  const initializingRef = useRef(false);

  useEffect(() => {
    if (!db || !user) return;

    // Listen to confirmed friendships where current user is userA or userB
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

    let unsub1 = onSnapshot(q1, async (snap1) => {
       const profilesA = await handleFriendSnaps(snap1);
       setFriends(prev => {
         const combined = [...prev, ...profilesA];
         const unique = combined.filter((v, i, a) => a.findIndex(t => t.uid === v.uid) === i);
         return unique;
       });
       setLoadingFriends(false);
    });

    let unsub2 = onSnapshot(q2, async (snap2) => {
       const profilesB = await handleFriendSnaps(snap2);
       setFriends(prev => {
         const combined = [...prev, ...profilesB];
         const unique = combined.filter((v, i, a) => a.findIndex(t => t.uid === v.uid) === i);
         return unique;
       });
       setLoadingFriends(false);
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (friends.length > 0 && !selectedFriend) {
      setSelectedFriend(friends[0]);
    }
  }, [friends]);

  useEffect(() => {
    if (!selectedFriend || !user || !isReady || initializingRef.current) return;

    const isCurrentSessionWithFriend =
      activeCall &&
      (activeCall.calleeId === selectedFriend.uid ||
        activeCall.callerId === selectedFriend.uid);

    if (activeCall && !isCurrentSessionWithFriend && callStatus !== CallStatus.ENDED) {
      endCall();
      return;
    }

    if (!activeCall && !incomingCall && callStatus === CallStatus.ENDED) {
      initializingRef.current = true;
      const timer = setTimeout(() => {
        makeCall(selectedFriend.uid, selectedFriend.displayName).finally(() => {
          initializingRef.current = false;
        });
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [selectedFriend?.uid, isReady, activeCall?.callId, callStatus, incomingCall?.callId]);

  useEffect(() => {
    if (incomingCall && callStatus === CallStatus.RINGING) {
      answerCall();
    }
  }, [incomingCall, callStatus]);

  const isConnected = callStatus === CallStatus.CONNECTED;
  const isConnecting = callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING;
  const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;

  const activeFriend = friends.find((u) => {
    if (!activeCall) return false;
    const otherId = activeCall.callerId === user?.uid ? activeCall.calleeId : activeCall.callerId;
    return u.uid === otherId;
  }) || selectedFriend;

  const handleTouchStart = (e: any) => {
    ensureAudioContext();
    if (!isConnected || isRemoteTalking) return;
    if (navigator.vibrate) navigator.vibrate(50);
    setIsHoldingButton(true);
    toggleTalk(true);
  };

  const handleTouchEnd = (e: any) => {
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
    } catch (e) {
      setPermissionDenied(true);
    }
  };

  if (!isReady) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-dark">
        <div className="w-32 h-32 rounded-full bg-secondary flex items-center justify-center mb-8 animate-pulse shadow-[0_0_50px_rgba(59,130,246,0.3)]">
          <Radio size={48} className="text-primary" />
        </div>
        <h2 className="text-3xl font-black mb-4 tracking-tighter uppercase italic">Pulse Online</h2>
        <p className="text-gray-400 text-center mb-12 text-sm max-w-xs leading-relaxed">
          The ultimate walkie-talkie. <br/>Tap to sync and start talking.
        </p>
        {permissionDenied && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 w-full max-w-xs">
            <AlertTriangle className="text-red-500 shrink-0 mt-0.5" size={20} />
            <p className="text-red-300 text-xs">Mic access required.</p>
          </div>
        )}
        <button
          onClick={activateApp}
          className="w-full max-w-xs py-5 bg-primary text-white font-black rounded-2xl shadow-2xl active:scale-95 transition-all shadow-blue-500/20 uppercase tracking-widest italic"
        >
          GO LIVE
        </button>
      </div>
    );
  }

  if (!loadingFriends && friends.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-dark text-center">
        <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mb-6">
          <UserPlus size={40} className="text-gray-500" />
        </div>
        <h3 className="text-xl font-bold mb-2 uppercase italic tracking-tighter">Quiet Airwaves</h3>
        <p className="text-gray-500 text-sm max-w-xs mb-8">
          You haven't added any friends yet. Go to the Profile tab to add friends using their Email and PIN.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-dark overflow-hidden safe-area-top safe-area-bottom">
      <div className="pt-6 pb-4 px-4 bg-secondary/10 border-b border-white/5">
        <div className="flex overflow-x-auto space-x-6 pb-2 scrollbar-hide snap-x">
          {friends.map((friend) => {
            const isSelected = selectedFriend?.uid === friend.uid;
            return (
              <button
                key={friend.uid}
                onClick={() => setSelectedFriend(friend)}
                className={`flex flex-col items-center space-y-2 min-w-[80px] snap-center transition-all ${isSelected ? "opacity-100 scale-110" : "opacity-30 grayscale"}`}
              >
                <div className={`w-16 h-16 rounded-full p-0.5 ${isSelected ? "bg-primary shadow-[0_0_20px_rgba(59,130,246,0.6)]" : "bg-gray-700"}`}>
                  <img
                    src={friend.photoURL || DEFAULT_AVATAR}
                    className="w-full h-full rounded-full object-cover border-4 border-dark"
                    draggable={false}
                    alt=""
                  />
                </div>
                <span className="text-[10px] font-black uppercase tracking-tighter truncate max-w-[80px]">
                  {friend.displayName}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 relative flex flex-col items-center justify-center p-6 bg-gradient-to-b from-dark via-secondary/5 to-dark">
        <div className="mb-10 h-10 flex items-center">
          {isHoldingButton ? (
            <div className="bg-accent text-white px-8 py-2 rounded-full text-[11px] font-black animate-pulse flex items-center gap-2 shadow-[0_0_20px_rgba(244,63,94,0.4)]">
              TRANSMITTING
            </div>
          ) : isRemoteTalking ? (
            <div className="bg-green-500 text-white px-8 py-2 rounded-full text-[11px] font-black animate-pulse flex items-center gap-2 shadow-[0_0_20px_rgba(34,197,94,0.4)]">
              RECEIVING
            </div>
          ) : isConnecting ? (
            <div className="text-primary text-[11px] font-black tracking-[0.4em] animate-pulse uppercase italic">
              Linking...
            </div>
          ) : (
            <div className="text-gray-600 text-[10px] font-black tracking-[0.3em] uppercase opacity-30 italic">
              Signal Ready
            </div>
          )}
        </div>

        <div
          className={`relative w-80 h-80 flex items-center justify-center transition-all duration-500 ${isHoldingButton ? "scale-105" : ""}`}
          style={{ touchAction: "none" }}
          onMouseDown={handleTouchStart}
          onMouseUp={handleTouchEnd}
          onMouseLeave={handleTouchEnd}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {(isHoldingButton || isRemoteTalking) && (
            <div className={`absolute -inset-12 rounded-full border-4 ${isRemoteTalking ? "border-green-500/20" : "border-accent/20"} animate-[ping_2s_infinite]`}></div>
          )}

          <div
            className={`w-full h-full rounded-[5rem] overflow-hidden border-[12px] shadow-2xl transition-all duration-700 bg-gray-900 ${isHoldingButton ? "border-accent shadow-accent/40" : isRemoteTalking ? "border-green-500 shadow-green-500/40" : isConnected ? "border-primary/20" : "border-gray-800"}`}
          >
            {activeFriend ? (
              <img
                src={activeFriend.photoURL || DEFAULT_AVATAR}
                className="w-full h-full object-cover select-none pointer-events-none brightness-75 transition-all duration-700"
                draggable={false}
                alt=""
              />
            ) : (
              <div className="w-full h-full bg-gray-800 flex items-center justify-center text-gray-700">
                <UserIcon size={100} />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent"></div>
            <div className="absolute bottom-12 left-0 right-0 text-center">
              <h2 className="text-3xl font-black text-white px-6 tracking-tighter drop-shadow-2xl uppercase italic">
                {activeFriend?.displayName || "Pick Friend"}
              </h2>
            </div>
          </div>
        </div>

        <div className="mt-16 flex flex-col items-center gap-6">
          <p className="text-[10px] text-gray-400 font-black uppercase tracking-[0.5em] italic">
            {isHoldingButton
              ? "Transmitting voice"
              : isRemoteTalking
                ? "Incoming Audio"
                : isConnected
                  ? "Hold to Speak"
                  : "Syncing Signals..."}
          </p>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className={`w-1.5 h-6 rounded-full transition-all duration-300 ${isHoldingButton || isRemoteTalking ? (i % 2 === 0 ? "bg-accent animate-bounce" : "bg-primary animate-bounce delay-150") : "bg-gray-800"}`}
                style={{ animationDelay: `${i * 100}ms` }}
              ></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalkieTalkie;
