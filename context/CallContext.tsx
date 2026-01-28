import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { 
  collection, doc, addDoc, updateDoc, onSnapshot, 
  query, where, setDoc, getDoc 
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from './AuthContext';
import { CallSession, CallStatus, CallType } from '../types';
import { WebRTCService } from '../services/WebRTCService';
import { COLLECTIONS } from '../constants';

interface CallContextType {
  activeCall: CallSession | null;
  incomingCall: CallSession | null;
  callStatus: CallStatus;
  makeCall: (calleeId: string, calleeName: string, type: CallType) => Promise<void>;
  answerCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleTalk: (isTalking: boolean) => void;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  playTone: (type: 'ON' | 'OFF') => void;
  ensureAudioContext: () => void;
}

const CallContext = createContext<CallContextType>({} as CallContextType);

export const useCall = () => useContext(CallContext);

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallSession | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.ENDED);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const rtcRef = useRef<WebRTCService | null>(null);
  const callUnsubRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  
  // Refs for synchronous state checks in handlers
  const statusRef = useRef<CallStatus>(CallStatus.ENDED);
  const activeCallRef = useRef<CallSession | null>(null);

  useEffect(() => {
    statusRef.current = callStatus;
  }, [callStatus]);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    console.log("[PULSE-DEBUG] CallProvider Mounting");
    remoteAudioRef.current = new Audio();
    remoteAudioRef.current.autoplay = true;
    
    rtcRef.current = new WebRTCService();
    
    rtcRef.current.onRemoteStream((stream) => {
      console.log("[PULSE-DEBUG] Context received remote stream");
      setRemoteStream(stream);
      if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(e => console.warn("[PULSE-DEBUG] Audio play deferred:", e));
      }
    });

    return () => {
        console.log("[PULSE-DEBUG] CallProvider Unmounting");
        if(rtcRef.current) rtcRef.current.close();
    };
  }, []);

  const ensureAudioContext = () => {
      if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          console.log("[PULSE-DEBUG] AudioContext Created");
      }
      if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume();
      }
  };

  const playTone = (type: 'ON' | 'OFF') => {
      ensureAudioContext();
      const ctx = audioContextRef.current;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      const freq = type === 'ON' ? 800 : 1200;
      const endFreq = type === 'ON' ? 1200 : 800;
      
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + 0.1);
      
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
  };

  // Improved Incoming Call Listener with Conflict Resolution
  useEffect(() => {
    if (!user || !db) return;
    
    const q = query(
      collection(db, COLLECTIONS.CALLS),
      where('calleeId', '==', user.uid),
      where('status', '==', CallStatus.OFFERING)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as CallSession;
          console.log("[PULSE-DEBUG] Detected incoming call offering:", data.callId);
          
          const currentStatus = statusRef.current;
          const currentActive = activeCallRef.current;

          // Conflict logic: Tie-break based on UID
          if ((currentStatus === CallStatus.OFFERING || currentStatus === CallStatus.RINGING) && currentActive?.calleeId === data.callerId) {
             console.log("[PULSE-DEBUG] Conflict detected: Simultaneous calling. Resolving...");
             if (data.callerId < user.uid) {
                // I lose the tie-breaker, answer theirs
                console.log("[PULSE-DEBUG] I lose tie-breaker. Transitioning to answer theirs.");
                if (currentActive) {
                    await updateDoc(doc(db, COLLECTIONS.CALLS, currentActive.callId), { status: 'ENDED' });
                }
                setIncomingCall(data);
                setCallStatus(CallStatus.RINGING);
                return;
             } else {
                // I win the tie-breaker, reject theirs
                console.log("[PULSE-DEBUG] I win tie-breaker. Keeping my offer.");
                await updateDoc(doc(db, COLLECTIONS.CALLS, data.callId), { status: 'BUSY' });
                return;
             }
          }

          if (currentStatus === CallStatus.ENDED) {
            setIncomingCall(data);
            setCallStatus(CallStatus.RINGING);
          } else {
             console.log("[PULSE-DEBUG] Busy state (Status: " + currentStatus + "). Auto-rejecting incoming call.");
             await updateDoc(doc(db, COLLECTIONS.CALLS, data.callId), { status: 'BUSY' });
          }
        }
      });
    });
    return () => unsubscribe();
  }, [user?.uid]);

  // Signaling Orchestrator
  useEffect(() => {
    if (!activeCall || !db || !rtcRef.current || !user) return;
    console.log("[PULSE-DEBUG] Signaling active for:", activeCall.callId);

    const callDocRef = doc(db, COLLECTIONS.CALLS, activeCall.callId);

    const unsubStatus = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;
        
        console.log("[PULSE-DEBUG] Signaling Status Update:", data.status);

        if (data.status === CallStatus.CONNECTED && statusRef.current !== CallStatus.CONNECTED) {
            setCallStatus(CallStatus.CONNECTED);
            if (activeCall.type === CallType.PTT) playTone('ON');
        }

        if (data.activeSpeakerId !== undefined) {
             setActiveCall(prev => prev ? ({ ...prev, activeSpeakerId: data.activeSpeakerId }) : null);
        }

        if (['ENDED', 'REJECTED', 'BUSY'].includes(data.status)) {
             cleanupCall();
        }

        if (activeCall.callerId === user.uid && data.answer) {
             console.log("[PULSE-DEBUG] Signaling received answer SDP");
             await rtcRef.current?.addAnswer(data.answer);
        }
    });

    const candidatesPath = activeCall.callerId === user.uid ? 'answerCandidates' : 'offerCandidates';
    const unsubCandidates = onSnapshot(collection(callDocRef, candidatesPath), (snapshot) => {
       snapshot.docChanges().forEach((change) => {
           if (change.type === 'added') {
             rtcRef.current?.addIceCandidate(change.doc.data() as RTCIceCandidateInit);
           }
       });
    });
    
    callUnsubRef.current = () => { unsubStatus(); unsubCandidates(); };
    return () => { if(callUnsubRef.current) callUnsubRef.current(); };
  }, [activeCall?.callId, user?.uid]);

  const makeCall = async (calleeId: string, calleeName: string, type: CallType) => {
    if (!user || !db || !rtcRef.current || statusRef.current !== CallStatus.ENDED) return;
    
    console.log("[PULSE-DEBUG] Initiating makeCall to:", calleeName);
    ensureAudioContext();

    try {
        const stream = await rtcRef.current.startLocalStream(type === CallType.VIDEO);
        setLocalStream(stream);

        if (type === CallType.PTT) {
            rtcRef.current.toggleAudio(false);
        } else {
            playTone('ON');
        }

        const offer = await rtcRef.current.createOffer();
        const callDocRef = doc(collection(db, COLLECTIONS.CALLS));
        const callId = callDocRef.id;
        
        const callData: CallSession = {
          callId,
          callerId: user.uid,
          callerName: user.displayName || 'Unknown',
          callerPhoto: user.photoURL || null,
          calleeId,
          calleeName,
          type,
          status: CallStatus.OFFERING,
          startedAt: Date.now(),
          activeSpeakerId: null,
        };

        await setDoc(callDocRef, { ...callData, offer: { type: offer.type, sdp: offer.sdp } });

        rtcRef.current.onIceCandidate(async (candidate) => {
            await addDoc(collection(db, COLLECTIONS.CALLS, callId, 'offerCandidates'), candidate.toJSON());
        });

        setActiveCall(callData);
        setCallStatus(CallStatus.OFFERING);
    } catch (e) {
        console.error("[PULSE-DEBUG] Call initiation error:", e);
        cleanupCall();
    }
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !db || !rtcRef.current) return;
    console.log("[PULSE-DEBUG] Answering incoming call:", incomingCall.callId);
    ensureAudioContext();

    try {
        const stream = await rtcRef.current.startLocalStream(incomingCall.type === CallType.VIDEO);
        setLocalStream(stream);
        
        if (incomingCall.type === CallType.PTT) {
            rtcRef.current.toggleAudio(false);
        }

        const callDocRef = doc(db, COLLECTIONS.CALLS, incomingCall.callId);
        const callDoc = await getDoc(callDocRef);
        const callData = callDoc.data();
        
        if (callData?.offer) {
            const answer = await rtcRef.current.createAnswer(callData.offer);
            await updateDoc(callDocRef, {
                status: CallStatus.CONNECTED,
                answer: { type: answer.type, sdp: answer.sdp }
            });

            rtcRef.current.onIceCandidate(async (candidate) => {
                await addDoc(collection(db, COLLECTIONS.CALLS, incomingCall.callId, 'answerCandidates'), candidate.toJSON());
            });

            setActiveCall(incomingCall);
            setIncomingCall(null);
            setCallStatus(CallStatus.CONNECTED);
        }
    } catch (e) {
        console.error("[PULSE-DEBUG] Failed to answer call:", e);
        cleanupCall();
    }
  };

  const toggleTalk = async (isTalking: boolean) => {
      if (!rtcRef.current || !activeCall || !db || !user) return;
      rtcRef.current.toggleAudio(isTalking);
      try {
          await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
              activeSpeakerId: isTalking ? user.uid : null
          });
      } catch (e) {
          console.error("[PULSE-DEBUG] Failed to update speaker status:", e);
      }
  };

  const cleanupCall = () => {
    console.log("[PULSE-DEBUG] Running call cleanup");
    setCallStatus(CallStatus.ENDED);
    setActiveCall(null);
    setIncomingCall(null);
    setRemoteStream(null);
    setLocalStream(null);
    
    if (callUnsubRef.current) {
        callUnsubRef.current();
        callUnsubRef.current = null;
    }

    if (rtcRef.current) {
        rtcRef.current.close();
        // Re-initialize for next use
        rtcRef.current = new WebRTCService();
        rtcRef.current.onRemoteStream((stream) => {
            setRemoteStream(stream);
            if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        });
    }
  };

  const endCall = async () => {
    console.log("[PULSE-DEBUG] Ending call session");
    if (activeCall?.type === CallType.PTT) playTone('OFF');
    if (activeCall && db) {
        await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
            status: CallStatus.ENDED,
            endedAt: Date.now()
        }).catch(e => console.error("End call signal failed", e));
    }
    cleanupCall();
  };

  const rejectCall = async () => {
      if (incomingCall && db) {
        await updateDoc(doc(db, COLLECTIONS.CALLS, incomingCall.callId), {
            status: CallStatus.REJECTED
        }).catch(e => console.error("Reject call signal failed", e));
      }
      setIncomingCall(null);
      setCallStatus(CallStatus.ENDED);
  }

  return (
    <CallContext.Provider value={{
      activeCall, incomingCall, callStatus,
      makeCall, answerCall, rejectCall, endCall,
      toggleTalk, remoteStream, localStream, playTone, ensureAudioContext
    }}>
      {children}
    </CallContext.Provider>
  );
};