import React, { useState, useEffect, useRef } from 'react';
import { useCall } from '../context/CallContext';
import { CallStatus, CallType, UserProfile } from '../types';
import { Radio, Volume2, User as UserIcon, Loader2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { collection, query, limit, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { DEFAULT_AVATAR } from '../constants';

const WalkieTalkie: React.FC = () => {
    const { 
        makeCall, endCall, toggleTalk, activeCall, 
        callStatus, incomingCall, ensureAudioContext 
    } = useCall();
    const { user } = useAuth();
    
    const [selectedFriend, setSelectedFriend] = useState<UserProfile | null>(null);
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [isHoldingButton, setIsHoldingButton] = useState(false);
    const [isReady, setIsReady] = useState(false); 
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [isInitiating, setIsInitiating] = useState(false);
    const lastCalledId = useRef<string | null>(null);

    useEffect(() => {
        if (!db) return;
        const fetchUsers = async () => {
            console.log("[PULSE-DEBUG] Fetching user list...");
            const q = query(collection(db, 'users'), limit(20));
            const snap = await getDocs(q);
            const list: UserProfile[] = [];
            snap.forEach(d => {
                const u = d.data() as UserProfile;
                if (u.uid !== user?.uid) list.push(u);
            });
            setUsers(list);
            if (list.length > 0 && !selectedFriend) setSelectedFriend(list[0]);
        };
        fetchUsers();
    }, [user]);

    useEffect(() => {
        if (!selectedFriend || !user || !isReady || isInitiating) return;

        const isConnectedToFriend = activeCall && 
            (activeCall.calleeId === selectedFriend.uid || activeCall.callerId === selectedFriend.uid) &&
            (callStatus === CallStatus.CONNECTED || callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING);

        if (activeCall && !isConnectedToFriend && callStatus !== CallStatus.ENDED) {
             console.log("[PULSE-DEBUG] Switching friends, ending current call");
             endCall();
             setIsInitiating(false);
             lastCalledId.current = null;
             return;
        }

        if (!isConnectedToFriend && !incomingCall && callStatus === CallStatus.ENDED) {
            if (lastCalledId.current === selectedFriend.uid && Date.now() - (activeCall?.endedAt || 0) < 3000) {
                console.log("[PULSE-DEBUG] Throttling auto-connect for friend:", selectedFriend.displayName);
                return;
            }

            console.log("[PULSE-DEBUG] Triggering auto-connect for:", selectedFriend.displayName);
            setIsInitiating(true);
            lastCalledId.current = selectedFriend.uid;
            
            makeCall(selectedFriend.uid, selectedFriend.displayName, CallType.PTT)
                .finally(() => {
                    setIsInitiating(false);
                    console.log("[PULSE-DEBUG] Auto-connect request complete");
                });
        }
    }, [selectedFriend, isReady, activeCall, callStatus, incomingCall]);

    const isConnected = callStatus === CallStatus.CONNECTED;
    const isConnecting = callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING;
    const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;
    const isLocalTalking = isHoldingButton; 

    const currentFriendId = activeCall ? (activeCall.callerId === user?.uid ? activeCall.calleeId : activeCall.callerId) : selectedFriend?.uid;
    const activeFriend = users.find(u => u.uid === currentFriendId) || selectedFriend;

    const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
        e.preventDefault();
        console.log("[PULSE-DEBUG] Button pressed. isConnected:", isConnected, "isRemoteTalking:", isRemoteTalking);
        if (!isConnected || isRemoteTalking) return;
        if (navigator.vibrate) navigator.vibrate(50);
        setIsHoldingButton(true);
        toggleTalk(true);
    };

    const handleTouchEnd = (e: React.TouchEvent | React.MouseEvent) => {
        e.preventDefault();
        console.log("[PULSE-DEBUG] Button released.");
        if (!isHoldingButton) return;
        setIsHoldingButton(false);
        toggleTalk(false);
    };

    const activateApp = async () => {
        console.log("[PULSE-DEBUG] User clicked 'Connect'. Activating app...");
        setPermissionDenied(false);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("[PULSE-DEBUG] Permission granted.");
            stream.getTracks().forEach(track => track.stop());
            ensureAudioContext();
            setIsReady(true);
        } catch (e) {
            console.error("[PULSE-DEBUG] Permission check failed:", e);
            setPermissionDenied(true);
        }
    };

    if (!isReady) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-8 bg-dark relative z-50">
                <div className="w-32 h-32 rounded-full bg-secondary flex items-center justify-center mb-8 animate-pulse shadow-[0_0_50px_rgba(59,130,246,0.5)]">
                    <Radio size={48} className="text-primary" />
                </div>
                <h2 className="text-2xl font-bold mb-4">Pulse</h2>
                <p className="text-gray-400 text-center mb-8">Ready to go online? Pulse needs microphone access to start.</p>
                {permissionDenied && (
                    <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 w-full max-w-xs">
                        <AlertTriangle className="text-red-500 shrink-0 mt-0.5" size={20} />
                        <div>
                            <p className="text-red-200 font-bold text-sm">Access Denied</p>
                            <p className="text-red-300 text-xs mt-1">Please enable microphone permissions in your browser.</p>
                        </div>
                    </div>
                )}
                <button onClick={activateApp} className="w-full max-w-xs py-4 bg-primary text-white font-bold rounded-2xl shadow-lg active:scale-95 transition-transform">
                    Go Online
                </button>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-dark overflow-hidden safe-area-top safe-area-bottom">
            <div className="pt-4 pb-2 px-4 bg-secondary/30 backdrop-blur-sm border-b border-gray-800">
                <div className="flex overflow-x-auto space-x-4 pb-2 scrollbar-hide snap-x">
                    {users.map(friend => {
                        const isSelected = selectedFriend?.uid === friend.uid;
                        return (
                            <button key={friend.uid} onClick={() => setSelectedFriend(friend)} className={`flex flex-col items-center space-y-1 min-w-[70px] snap-center transition-opacity ${isSelected ? 'opacity-100' : 'opacity-50 grayscale'}`}>
                                <div className={`w-14 h-14 rounded-full p-0.5 ${isSelected ? 'bg-gradient-to-tr from-primary to-accent' : 'bg-gray-700'}`}>
                                    <img src={friend.photoURL || DEFAULT_AVATAR} className="w-full h-full rounded-full object-cover border-2 border-dark"/>
                                </div>
                                <span className="text-[10px] font-bold truncate max-w-[70px]">{friend.displayName}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="flex-1 relative flex flex-col items-center justify-center p-6">
                <div className="absolute top-10 flex items-center space-x-2">
                    {isLocalTalking ? (
                        <span className="text-accent font-black tracking-widest animate-pulse flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-accent"></div> TRANSMITTING
                        </span>
                    ) : isRemoteTalking ? (
                        <span className="text-green-500 font-black tracking-widest animate-pulse flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500"></div> RECEIVING
                        </span>
                    ) : isConnecting ? (
                        <span className="text-blue-400 font-bold tracking-widest text-xs flex items-center gap-2">
                            <Loader2 size={12} className="animate-spin"/> CONNECTING...
                        </span>
                    ) : isConnected ? (
                        <span className="text-gray-500 font-bold tracking-widest text-xs">READY • HOLD TO TALK</span>
                    ) : (
                         <span className="text-gray-600 font-bold tracking-widest text-xs">OFFLINE</span>
                    )}
                </div>
                <div className="relative mb-8">
                    {(isLocalTalking || isRemoteTalking) && (
                        <>
                            <div className={`absolute inset-0 rounded-full animate-ping opacity-20 ${isRemoteTalking ? 'bg-green-500' : 'bg-accent'}`}></div>
                            <div className={`absolute -inset-4 rounded-full animate-pulse opacity-10 ${isRemoteTalking ? 'bg-green-500' : 'bg-accent'}`}></div>
                        </>
                    )}
                    <div className={`w-64 h-64 rounded-[3rem] overflow-hidden border-8 shadow-2xl transition-all duration-200 ${isLocalTalking ? 'border-accent scale-105' : isRemoteTalking ? 'border-green-500 scale-105' : 'border-gray-800'}`}>
                        {activeFriend ? (
                            <img src={activeFriend.photoURL || DEFAULT_AVATAR} className="w-full h-full object-cover" draggable={false}/>
                        ) : (
                            <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                <UserIcon size={64} className="text-gray-600" />
                            </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
                        <div className="absolute bottom-6 left-0 right-0 text-center">
                             <h2 className="text-3xl font-black text-white drop-shadow-lg">{activeFriend?.displayName || "Select Friend"}</h2>
                        </div>
                    </div>
                </div>
                {isConnected && (
                    <div className="absolute inset-0 z-10 cursor-pointer" onMouseDown={handleTouchStart} onMouseUp={handleTouchEnd} onMouseLeave={handleTouchEnd} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}></div>
                )}
                <div className="mt-auto mb-10 text-gray-500 flex items-center gap-2 pointer-events-none">
                     <Volume2 size={16} />
                     <span className="text-xs font-mono">SPEAKER ON</span>
                </div>
            </div>
        </div>
    );
};

export default WalkieTalkie;