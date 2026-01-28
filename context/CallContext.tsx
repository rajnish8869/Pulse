
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
  
  // Audio handling
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize Remote Audio Element
  useEffect(() => {
    remoteAudioRef.current = new Audio();
    remoteAudioRef.current.autoplay = true;
    return () => {
        if(remoteAudioRef.current) {
            remoteAudioRef.current.pause();
            remoteAudioRef.current = null;
        }
    }
  }, []);

  const ensureAudioContext = () => {
      if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume();
      }
      // Play silent buffer to unlock audio on iOS/Android WebViews
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

  // Initialize WebRTC helper
  useEffect(() => {
    rtcRef.current = new WebRTCService();
    
    rtcRef.current.onRemoteStream((stream) => {
      setRemoteStream(stream);
      // Attach to persistent audio element
      if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(e => console.error("Autoplay blocked", e));
      }
    });

    return () => {
      if (rtcRef.current) rtcRef.current.close();
    };
  }, []);

  // Listen for incoming calls
  useEffect(() => {
    if (!user || !db) return;

    const q = query(
      collection(db, COLLECTIONS.CALLS),
      where('calleeId', '==', user.uid),
      where('status', '==', CallStatus.OFFERING)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as CallSession;
          // Only accept if we aren't already in a call
          if (callStatus === CallStatus.ENDED) {
            setIncomingCall(data);
            setCallStatus(CallStatus.RINGING);
          } else {
             // Auto-reject busy
             if (db) {
                updateDoc(doc(db, COLLECTIONS.CALLS, data.callId), { status: 'BUSY' });
             }
          }
        }
      });
    }, (error) => {
        console.error("Error listening for incoming calls:", error);
    });

    return () => unsubscribe();
  }, [user, callStatus]);

  // Auto-Answer PTT Calls
  useEffect(() => {
    if (incomingCall && incomingCall.type === CallType.PTT && callStatus === CallStatus.RINGING) {
        console.log("Auto-answering PTT call from", incomingCall.callerName);
        playTone('ON');
        answerCall();
    }
  }, [incomingCall, callStatus]);

  // Handle Active Call Signaling
  useEffect(() => {
    if (!activeCall || !db || !rtcRef.current || !user) return;

    const callDocRef = doc(db, COLLECTIONS.CALLS, activeCall.callId);

    // 1. Listen to Call Status Changes (End, Hangup, Speaker State)
    const unsubStatus = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        // Remote user answered (Caller view)
        if (data.status === CallStatus.CONNECTED && callStatus === CallStatus.OFFERING) {
            setCallStatus(CallStatus.CONNECTED);
            if (activeCall.type === CallType.PTT) playTone('ON');
        }

        // Active Speaker Visual State
        if (data.activeSpeakerId !== undefined) {
             setActiveCall(prev => prev ? ({ ...prev, activeSpeakerId: data.activeSpeakerId }) : null);
        }

        // Call Ended
        if (data.status === CallStatus.ENDED || data.status === CallStatus.REJECTED || data.status === 'BUSY') {
             if (activeCall.type === CallType.PTT && callStatus === CallStatus.CONNECTED) playTone('OFF');
             cleanupCall();
        }

        // Handle Answer SDP (Caller Only)
        if (activeCall.callerId === user.uid && data.answer) {
             await rtcRef.current?.addAnswer(data.answer);
        }
    });

    // 2. Handle ICE Candidates
    let unsubCandidates = () => {};

    if (activeCall.callerId === user.uid) {
        // I am Caller: Listen for Answer Candidates (from Callee)
        unsubCandidates = onSnapshot(collection(callDocRef, 'answerCandidates'), (snapshot) => {
           snapshot.docChanges().forEach((change) => {
               if (change.type === 'added') {
                 rtcRef.current?.addIceCandidate(change.doc.data() as RTCIceCandidateInit);
               }
           });
        });
    } else {
        // I am Callee: Listen for Offer Candidates (from Caller)
        unsubCandidates = onSnapshot(collection(callDocRef, 'offerCandidates'), (snapshot) => {
           snapshot.docChanges().forEach((change) => {
               if (change.type === 'added') {
                 rtcRef.current?.addIceCandidate(change.doc.data() as RTCIceCandidateInit);
               }
           });
        });
    }
    
    callUnsubRef.current = () => {
        unsubStatus();
        unsubCandidates();
    };
    
    return () => {
        if(callUnsubRef.current) callUnsubRef.current();
    }
  }, [activeCall?.callId, user?.uid]); // Only re-subscribe if call ID changes

  const makeCall = async (calleeId: string, calleeName: string, type: CallType) => {
    if (!user || !db || !rtcRef.current) return;

    ensureAudioContext();

    try {
        // 1. Get Local Stream
        const stream = await rtcRef.current.startLocalStream(type === CallType.VIDEO);
        setLocalStream(stream);

        if (type === CallType.PTT) {
           rtcRef.current.toggleAudio(false);
        } else {
           playTone('ON');
        }

        // 2. Create Offer
        const offer = await rtcRef.current.createOffer();

        // 3. Create Call Document
        const callDocRef = doc(collection(db, COLLECTIONS.CALLS));
        const callId = callDocRef.id;
        
        const callData: CallSession = {
          callId,
          callerId: user.uid,
          callerName: user.displayName || 'Unknown',
          callerPhoto: user.photoURL || undefined, 
          calleeId,
          calleeName,
          type,
          status: CallStatus.OFFERING,
          startedAt: Date.now(),
          activeSpeakerId: null,
        };

        // Prepare Firestore operations
        await setDoc(callDocRef, {
            ...callData,
            offer: { type: offer.type, sdp: offer.sdp }
        });

        // Setup local candidate listener
        rtcRef.current.onIceCandidate(async (candidate) => {
            if (db) {
                await addDoc(collection(db, COLLECTIONS.CALLS, callId, 'offerCandidates'), candidate.toJSON());
            }
        });

        setActiveCall(callData);
        setCallStatus(CallStatus.OFFERING);
    } catch (e) {
        console.error("Failed to start call:", e);
        setCallStatus(CallStatus.ENDED);
        setLocalStream(null);
    }
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !db || !rtcRef.current) return;

    ensureAudioContext();

    try {
        // 1. Get Local Stream
        const stream = await rtcRef.current.startLocalStream(incomingCall.type === CallType.VIDEO);
        setLocalStream(stream);

        if (incomingCall.type === CallType.PTT) {
            rtcRef.current.toggleAudio(false);
        }

        // 2. Fetch Offer
        const callDocRef = doc(db, COLLECTIONS.CALLS, incomingCall.callId);
        const callDoc = await getDoc(callDocRef);
        const callData = callDoc.data();
        
        if (callData && callData.offer) {
            // 3. Create Answer
            const answer = await rtcRef.current.createAnswer(callData.offer);
            
            await updateDoc(callDocRef, {
                status: CallStatus.CONNECTED,
                answer: { type: answer.type, sdp: answer.sdp }
            });

            // Setup local candidate listener
            rtcRef.current.onIceCandidate(async (candidate) => {
                if (db) {
                    await addDoc(collection(db, COLLECTIONS.CALLS, incomingCall.callId, 'answerCandidates'), candidate.toJSON());
                }
            });

            // Signaling listener for candidates is handled in the useEffect via setActiveCall
            setActiveCall(incomingCall);
            setIncomingCall(null);
            setCallStatus(CallStatus.CONNECTED);
        }
    } catch (e) {
        console.error("Failed to answer call:", e);
        setIncomingCall(null);
        setCallStatus(CallStatus.ENDED);
        setLocalStream(null);
    }
  };

  const toggleTalk = async (isTalking: boolean) => {
      if (!rtcRef.current || !activeCall || !db || !user) return;
      
      if (localStream) {
          rtcRef.current.toggleAudio(isTalking);
      }

      try {
          // Use updateDoc only if call is still active/valid
          const callRef = doc(db, COLLECTIONS.CALLS, activeCall.callId);
          await updateDoc(callRef, {
              activeSpeakerId: isTalking ? user.uid : null
          });
      } catch (e) {
          console.error("Error signaling talk state", e);
      }
  };

  const cleanupCall = () => {
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
        // Re-attach persistent audio logic
        rtcRef.current.onRemoteStream((stream) => {
            setRemoteStream(stream);
            if (remoteAudioRef.current) {
                remoteAudioRef.current.srcObject = stream;
                remoteAudioRef.current.play().catch(console.error);
            }
        });
    }
  };

  const endCall = async () => {
    if (activeCall?.type === CallType.PTT) playTone('OFF');
    
    if (activeCall && db) {
        const duration = Math.floor((Date.now() - activeCall.startedAt) / 1000);
        try {
            await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
                status: CallStatus.ENDED,
                endedAt: Date.now(),
                duration: duration
            });
        } catch (e) {
            console.error("Error updating end call stat", e);
        }
    }
    cleanupCall();
  };

  const rejectCall = async () => {
      if (incomingCall && db) {
        try {
            await updateDoc(doc(db, COLLECTIONS.CALLS, incomingCall.callId), {
                status: CallStatus.REJECTED,
                endedAt: Date.now(),
                duration: 0
            });
        } catch (e) {
            console.error("Error rejecting call", e);
        }
      }
      setIncomingCall(null);
      setCallStatus(CallStatus.ENDED);
  }

  return (
    <CallContext.Provider value={{
      activeCall,
      incomingCall,
      callStatus,
      makeCall,
      answerCall,
      rejectCall,
      endCall,
      toggleTalk,
      remoteStream,
      localStream,
      playTone,
      ensureAudioContext
    }}>
      {children}
    </CallContext.Provider>
  );
};
