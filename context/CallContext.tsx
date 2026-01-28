import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { 
  collection, doc, addDoc, updateDoc, onSnapshot, 
  query, where, serverTimestamp, setDoc, getDoc, deleteDoc 
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

  useEffect(() => {
    console.log("[PULSE-DEBUG] CallProvider Mounting");
    remoteAudioRef.current = new Audio();
    remoteAudioRef.current.autoplay = true;
    
    // We'll init the RTC service on demand or keep one warm
    rtcRef.current = new WebRTCService();
    
    rtcRef.current.onRemoteStream((stream) => {
      console.log("[PULSE-DEBUG] Remote stream track received in context");
      setRemoteStream(stream);
      if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(e => console.warn("[PULSE-DEBUG] Audio play deferred:", e));
      }
    });

    return () => {
        console.log("[PULSE-DEBUG] CallProvider Unmounting");
        if(remoteAudioRef.current) remoteAudioRef.current.pause();
        if(rtcRef.current) rtcRef.current.close();
    };
  }, []);

  const ensureAudioContext = () => {
      if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          console.log("[PULSE-DEBUG] AudioContext Created");
      }
      if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().then(() => console.log("[PULSE-DEBUG] AudioContext Resumed"));
      }
      // Unlock audio on touch devices
      const buffer = audioContextRef.current.createBuffer(1, 1, 22050);
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      source.start(0);
  };

  const playTone = (type: 'ON' | 'OFF') => {
      ensureAudioContext();
      const ctx = audioContextRef.current;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'ON') {
          osc.frequency.setValueAtTime(800, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
      } else {
          osc.frequency.setValueAtTime(1200, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.1);
      }
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
  };

  // Incoming Call Listener
  useEffect(() => {
    if (!user || !db) return;
    console.log("[PULSE-DEBUG] Subscribing to incoming calls for:", user.displayName);
    const q = query(
      collection(db, COLLECTIONS.CALLS),
      where('calleeId', '==', user.uid),
      where('status', '==', CallStatus.OFFERING)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as CallSession;
          console.log("[PULSE-DEBUG] Detected incoming call offering:", data.callId);
          if (callStatus === CallStatus.ENDED) {
            setIncomingCall(data);
            setCallStatus(CallStatus.RINGING);
          } else {
             console.log("[PULSE-DEBUG] User busy, auto-rejecting call:", data.callId);
             updateDoc(doc(db, COLLECTIONS.CALLS, data.callId), { status: 'BUSY' });
          }
        }
      });
    });
    return () => unsubscribe();
  }, [user?.uid, callStatus]);

  // Signaling Orchestrator
  useEffect(() => {
    if (!activeCall || !db || !rtcRef.current || !user) return;
    console.log("[PULSE-DEBUG] Signaling Orchestrator active for:", activeCall.callId);

    const callDocRef = doc(db, COLLECTIONS.CALLS, activeCall.callId);

    const unsubStatus = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;
        
        console.log("[PULSE-DEBUG] Remote status change:", data.status);

        if (data.status === CallStatus.CONNECTED && callStatus === CallStatus.OFFERING) {
            console.log("[PULSE-DEBUG] Connection confirmed by peer");
            setCallStatus(CallStatus.CONNECTED);
            if (activeCall.type === CallType.PTT) playTone('ON');
        }

        if (data.activeSpeakerId !== undefined) {
             setActiveCall(prev => prev ? ({ ...prev, activeSpeakerId: data.activeSpeakerId }) : null);
        }

        if (['ENDED', 'REJECTED', 'BUSY'].includes(data.status)) {
             console.log("[PULSE-DEBUG] Call terminated via signaling state:", data.status);
             cleanupCall();
        }

        // Caller side: process answer SDP
        if (activeCall.callerId === user.uid && data.answer) {
             console.log("[PULSE-DEBUG] Processing Answer SDP from peer");
             await rtcRef.current?.addAnswer(data.answer);
        }
    });

    const candidatesPath = activeCall.callerId === user.uid ? 'answerCandidates' : 'offerCandidates';
    console.log("[PULSE-DEBUG] Listening for candidates in:", candidatesPath);
    
    const unsubCandidates = onSnapshot(collection(callDocRef, candidatesPath), (snapshot) => {
       snapshot.docChanges().forEach((change) => {
           if (change.type === 'added') {
             console.log("[PULSE-DEBUG] Remote ICE candidate received");
             rtcRef.current?.addIceCandidate(change.doc.data() as RTCIceCandidateInit);
           }
       });
    });
    
    callUnsubRef.current = () => {
        unsubStatus();
        unsubCandidates();
    };
    
    return () => { if(callUnsubRef.current) callUnsubRef.current(); };
  }, [activeCall?.callId, user?.uid]);

  const makeCall = async (calleeId: string, calleeName: string, type: CallType) => {
    if (!user || !db || !rtcRef.current) return;
    console.log("[PULSE-DEBUG] Initializing makeCall to:", calleeName);
    ensureAudioContext();

    try {
        const stream = await rtcRef.current.startLocalStream(type === CallType.VIDEO);
        setLocalStream(stream);

        if (type === CallType.PTT) rtcRef.current.toggleAudio(false);
        else playTone('ON');

        const offer = await rtcRef.current.createOffer();
        const callDocRef = doc(collection(db, COLLECTIONS.CALLS));
        const callId = callDocRef.id;
        
        // CRITICAL FIX: Ensure no field is undefined for Firestore
        const callData: CallSession = {
          callId,
          callerId: user.uid,
          callerName: user.displayName || 'Unknown',
          callerPhoto: user.photoURL || null, // FIX: Firestore does not allow undefined
          calleeId,
          calleeName,
          type,
          status: CallStatus.OFFERING,
          startedAt: Date.now(),
          activeSpeakerId: null,
        };

        console.log("[PULSE-DEBUG] Writing offer document to Firestore...");
        await setDoc(callDocRef, { 
            ...callData, 
            offer: { type: offer.type, sdp: offer.sdp } 
        });

        rtcRef.current.onIceCandidate(async (candidate) => {
            console.log("[PULSE-DEBUG] Sending local ICE candidate to peer");
            await addDoc(collection(db, COLLECTIONS.CALLS, callId, 'offerCandidates'), candidate.toJSON());
        });

        setActiveCall(callData);
        setCallStatus(CallStatus.OFFERING);
    } catch (e) {
        console.error("[PULSE-DEBUG] Call initiation failed:", e);
        cleanupCall();
    }
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !db || !rtcRef.current) return;
    console.log("[PULSE-DEBUG] Answering call:", incomingCall.callId);
    ensureAudioContext();

    try {
        const stream = await rtcRef.current.startLocalStream(incomingCall.type === CallType.VIDEO);
        setLocalStream(stream);
        if (incomingCall.type === CallType.PTT) rtcRef.current.toggleAudio(false);

        const callDocRef = doc(db, COLLECTIONS.CALLS, incomingCall.callId);
        const callDoc = await getDoc(callDocRef);
        const callData = callDoc.data();
        
        if (callData?.offer) {
            console.log("[PULSE-DEBUG] Offer found, creating answer...");
            const answer = await rtcRef.current.createAnswer(callData.offer);
            await updateDoc(callDocRef, {
                status: CallStatus.CONNECTED,
                answer: { type: answer.type, sdp: answer.sdp }
            });

            rtcRef.current.onIceCandidate(async (candidate) => {
                console.log("[PULSE-DEBUG] Sending local answer candidate");
                await addDoc(collection(db, COLLECTIONS.CALLS, incomingCall.callId, 'answerCandidates'), candidate.toJSON());
            });

            setActiveCall(incomingCall);
            setIncomingCall(null);
            setCallStatus(CallStatus.CONNECTED);
        } else {
            console.error("[PULSE-DEBUG] Offer document missing in Firestore");
        }
    } catch (e) {
        console.error("[PULSE-DEBUG] Failed to answer call:", e);
        cleanupCall();
    }
  };

  const toggleTalk = async (isTalking: boolean) => {
      if (!rtcRef.current || !activeCall || !db || !user) return;
      console.log("[PULSE-DEBUG] Talk button toggled:", isTalking);
      if (localStream) rtcRef.current.toggleAudio(isTalking);

      try {
          await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
              activeSpeakerId: isTalking ? user.uid : null
          });
      } catch (e) {
          console.error("[PULSE-DEBUG] Failed to update speaker state:", e);
      }
  };

  const cleanupCall = () => {
    console.log("[PULSE-DEBUG] Executing cleanup for call session");
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
        rtcRef.current = new WebRTCService();
        rtcRef.current.onRemoteStream((stream) => {
            setRemoteStream(stream);
            if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        });
    }
  };

  const endCall = async () => {
    console.log("[PULSE-DEBUG] Manual hangup requested");
    if (activeCall?.type === CallType.PTT) playTone('OFF');
    if (activeCall && db) {
        await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
            status: CallStatus.ENDED,
            endedAt: Date.now()
        }).catch(e => console.error("[PULSE-DEBUG] Failed to signal end call:", e));
    }
    cleanupCall();
  };

  const rejectCall = async () => {
      console.log("[PULSE-DEBUG] Call rejection requested");
      if (incomingCall && db) {
        await updateDoc(doc(db, COLLECTIONS.CALLS, incomingCall.callId), {
            status: CallStatus.REJECTED
        }).catch(e => console.error("[PULSE-DEBUG] Failed to signal reject call:", e));
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