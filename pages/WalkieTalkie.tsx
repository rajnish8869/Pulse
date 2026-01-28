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
        callStatus, incomingCall, ensureAudioContext, answerCall 
    } = useCall();
    const { user } = useAuth();
    
    const [selectedFriend, setSelectedFriend] = useState<UserProfile | null>(null);
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [isHoldingButton, setIsHoldingButton] = useState(false);
    const [isReady, setIsReady] = useState(false); 
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [isInitiating, setIsInitiating] = useState(false);

    // Load available friends
    useEffect(() => {
        if (!db || !user) return;
        const fetchUsers = async () => {
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

    // Handle Auto-Connect logic for PTT
    useEffect(() => {
        if (!selectedFriend || !user || !isReady || isInitiating) return;

        const isCurrentSessionWithFriend = activeCall && 
            (activeCall.calleeId === selectedFriend.uid || activeCall.callerId === selectedFriend.uid);

        // If switching friends, end existing call
        if (activeCall && !isCurrentSessionWithFriend && callStatus !== CallStatus.ENDED) {
             endCall();
             return;
        }

        // Auto-connect when idle
        if (!activeCall && !incomingCall && callStatus === CallStatus.ENDED) {
            setIsInitiating(true);
            const delay = 500 + (Math.random() * 500); // Random offset to avoid simultaneous signaling
            const timer = setTimeout(() => {
                makeCall(selectedFriend.uid, selectedFriend.displayName, CallType.PTT)
                    .finally(() => setIsInitiating(false));
            }, delay);
            return () => clearTimeout(timer);
        }
    }, [selectedFriend, isReady, activeCall, callStatus, incomingCall]);

    // Handle Auto-Answer logic for PTT
    useEffect(() => {
        if (incomingCall && incomingCall.type === CallType.PTT && callStatus === CallStatus.RINGING) {
            console.log("[PULSE-DEBUG] Auto-answering incoming PTT");
            answerCall();
        }
    }, [incomingCall, callStatus]);

    const isConnected = callStatus === CallStatus.CONNECTED;
    const isConnecting = callStatus === CallStatus.OFFERING || callStatus === CallStatus.RINGING;
    const isRemoteTalking = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user?.uid;
    
    const activeFriend = users.find(u => {
        if (!activeCall) return false;
        const otherId = activeCall.callerId === user?.uid ? activeCall.calleeId : activeCall.callerId;
        return u.uid === otherId;
    }) || selectedFriend;

    const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
        e.preventDefault();
        if (!isConnected || isRemoteTalking) return;
        if (navigator.vibrate) navigator.vibrate(50);
        setIsHoldingButton(true);
        toggleTalk(true);
    };

    const handleTouchEnd = (e: React.TouchEvent | React.MouseEvent) => {
        e.preventDefault();
        if (!isHoldingButton) return;
        setIsHoldingButton(false);
        toggleTalk(false);
    };

    const activateApp = async () => {
        setPermissionDenied(false);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            ensureAudioContext();
            setIsReady(true);
        } catch (e) {
            setPermissionDenied(true);
        }
    };

    if (!isReady) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-8 bg-dark relative z-50">
                <div className="w-32 h-32 rounded-full bg-secondary flex items-center justify-center mb-8 animate-pulse shadow-[0_0_50px_rgba(59,130,246,0.3)]">
                    <Radio size={48} className="text-primary" />
                </div>
                <h2 className="text-2xl font-bold mb-4">Pulse Walkie</h2>
                <p className="text-gray-400 text-center mb-8">Go online to hear and talk to your friends instantly.</p>
                {permissionDenied && (
                    <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 w-full max-w-xs">
                        <AlertTriangle className="text-red-500 shrink-0 mt-0.5" size={20} />
                        <p className="text-red-300 text-xs">Microphone access is required for Pulse.</p>
                    </div>
                )}
                <button onClick={activateApp} className="w-full max-w-xs py-4 bg-primary text-white font-bold rounded-2xl shadow-lg active:scale-95 transition-transform">
                    Initialize Walkie
                </button>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-dark overflow-hidden safe-area-top safe-area-bottom">
            <div className="pt-4 pb-2 px-4 bg-secondary/30 border-b border-gray-800">
                <div className="flex overflow-x-auto space-x-4 pb-2 scrollbar-hide snap-x">
                    {users.map(friend => {
                        const isSelected = selectedFriend?.uid === friend.uid;
                        return (
                            <button key={friend.uid} onClick={() => setSelectedFriend(friend)} className={`flex flex-col items-center space-y-1 min-w-[70px] snap-center transition-all ${isSelected ? 'opacity-100 scale-110' : 'opacity-40 grayscale'}`}>
                                <div className={`w-14 h-14 rounded-full p-0.5 ${isSelected ? 'bg-primary shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'bg-gray-700'}`}>
                                    <img src={friend.photoURL || DEFAULT_AVATAR} className="w-full h-full rounded-full object-cover border-2 border-dark" draggable={false}/>
                                </div>
                                <span className="text-[10px] font-bold truncate max-w-[70px]">{friend.displayName}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            
            <div className="flex-1 relative flex flex-col items-center justify-center p-6">
                <div className="mb-6 h-6">
                    {isHoldingButton ? (
                        <div className="bg-accent/20 text-accent px-4 py-1 rounded-full text-[10px] font-black animate-pulse flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-accent"></div> LIVE TRANSMISSION
                        </div>
                    ) : isRemoteTalking ? (
                        <div className="bg-green-500/20 text-green-500 px-4 py-1 rounded-full text-[10px] font-black animate-pulse flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div> RECEIVING AUDIO
                        </div>
                    ) : isConnecting ? (
                        <div className="text-gray-400 text-[10px] font-bold flex items-center gap-2">
                            <Loader2 size={12} className="animate-spin"/> SYNCHRONIZING CHANNEL...
                        </div>
                    ) : (
                        <div className="text-gray-600 text-[10px] font-bold tracking-[0.2em] uppercase">Channel Standby</div>
                    )}
                </div>

                <div 
                    className={`relative w-80 h-80 flex items-center justify-center transition-all duration-300 ${isHoldingButton ? 'scale-[1.02]' : ''}`}
                    onMouseDown={handleTouchStart} 
                    onMouseUp={handleTouchEnd} 
                    onMouseLeave={handleTouchEnd} 
                    onTouchStart={handleTouchStart} 
                    onTouchEnd={handleTouchEnd}
                >
                    {/* Pulsing Visualizer Rings */}
                    {(isHoldingButton || isRemoteTalking) && (
                        <>
                            <div className={`absolute inset-0 rounded-full animate-ping opacity-20 ${isRemoteTalking ? 'bg-green-500' : 'bg-accent'}`}></div>
                            <div className={`absolute -inset-10 rounded-full animate-pulse opacity-5 ${isRemoteTalking ? 'bg-green-500' : 'bg-accent'}`}></div>
                        </>
                    )}
                    
                    <div className={`w-full h-full rounded-[5rem] overflow-hidden border-[12px] shadow-2xl transition-all duration-500 bg-gray-900 ${isHoldingButton ? 'border-accent shadow-accent/20' : isRemoteTalking ? 'border-green-500 shadow-green-500/20' : isConnected ? 'border-primary/40' : 'border-gray-800'}`}>
                        {activeFriend ? (
                            <img src={activeFriend.photoURL || DEFAULT_AVATAR} className="w-full h-full object-cover select-none pointer-events-none" draggable={false}/>
                        ) : (
                            <div className="w-full h-full bg-gray-800 flex items-center justify-center text-gray-700">
                                <UserIcon size={100} />
                            </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent"></div>
                        <div className="absolute bottom-12 left-0 right-0 text-center">
                             <h2 className="text-3xl font-black text-white px-4 tracking-tight drop-shadow-lg">{activeFriend?.displayName || "Select Partner"}</h2>
                        </div>
                    </div>
                    
                    {/* Interaction Hint Overlay */}
                    {!isConnected && !isConnecting && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="bg-dark/80 backdrop-blur-md px-4 py-2 rounded-xl text-xs font-bold border border-gray-700">Connecting...</div>
                        </div>
                    )}
                </div>

                <div className="mt-14 flex flex-col items-center gap-3">
                     <div className="flex items-center gap-2 text-gray-500 opacity-50">
                        <Volume2 size={16} />
                        <span className="text-[10px] font-mono tracking-widest uppercase">{isConnected ? 'Encrypted Link Active' : 'Offline'}</span>
                     </div>
                     <p className="text-[11px] text-gray-400 font-medium text-center max-w-[200px]">
                        {isHoldingButton ? 'Talk now...' : isRemoteTalking ? `${activeFriend?.displayName} is talking` : isConnected ? 'Hold avatar to speak' : 'Finding channel...'}
                     </p>
                </div>
            </div>
        </div>
    );
};

export default WalkieTalkie;