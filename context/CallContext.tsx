
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import {
  ref,
  query,
  orderByChild,
  equalTo,
  onValue,
  update,
  off,
} from "firebase/database";
import { rtdb } from "../services/firebase";
import { useAuth } from "./AuthContext";
import { CallSession, CallStatus, CallType } from "../types";
import { WebRTCService } from "../services/WebRTCService";

interface CallContextType {
  activeCall: CallSession | null;
  incomingCall: CallSession | null;
  callStatus: CallStatus;
  makeCall: (
    calleeId: string,
    calleeName: string,
  ) => Promise<void>;
  answerCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleTalk: (isTalking: boolean) => void;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  playTone: (type: "ON" | "OFF") => void;
  ensureAudioContext: () => void;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
  isMediaReady: boolean;
}

const CallContext = createContext<CallContextType>({} as CallContextType);

export const useCall = () => useContext(CallContext);

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallSession | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.ENDED);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMediaReady, setIsMediaReady] = useState(false);

  // We persist the service instance for the lifecycle of the provider
  const rtcRef = useRef<WebRTCService>(new WebRTCService());
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // RTDB Listener references for cleanup
  const incomingListenerRef = useRef<{ ref: any, cb: any } | null>(null);
  const activeCallListenerRef = useRef<{ ref: any, cb: any } | null>(null);

  const statusRef = useRef<CallStatus>(CallStatus.ENDED);
  const activeCallRef = useRef<CallSession | null>(null);

  useEffect(() => {
    statusRef.current = callStatus;
  }, [callStatus]);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  // One-time Media Setup on Mount
  useEffect(() => {
    let mounted = true;
    const setup = async () => {
       try {
         const stream = await rtcRef.current.acquireMedia();
         if (mounted) {
            setLocalStream(stream);
            setIsMediaReady(true);
            stream.getAudioTracks().forEach(t => t.enabled = false); // Mute initially
         }
       } catch (e) {
         console.error("Pulse: Failed to acquire media on startup", e);
       }
    };
    setup();
    
    return () => {
      mounted = false;
      rtcRef.current.releaseMedia();
    };
  }, []);

  const ensureAudioContext = () => {
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (
          window.AudioContext || (window as any).webkitAudioContext
        )();
      } catch (e) {
        console.error("Failed to create AudioContext:", e);
        return;
      }
    }

    const ctx = audioContextRef.current;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(err => console.error("AudioContext resume failed:", err));
    }
  };

  const playTone = (type: "ON" | "OFF") => {
    ensureAudioContext();
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(type === "ON" ? 600 : 400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      type === "ON" ? 900 : 300,
      ctx.currentTime + 0.1,
    );
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  };

  // LISTEN FOR INCOMING CALLS (RTDB)
  useEffect(() => {
    if (!user || !rtdb) return;
    
    const callsRef = query(
        ref(rtdb, 'calls'), 
        orderByChild('calleeId'), 
        equalTo(user.uid)
    );

    const cb = onValue(callsRef, (snapshot) => {
       const calls = snapshot.val();
       if (!calls) return;

       Object.values(calls).forEach((data: any) => {
          if (data.status === 'OFFERING') {
             // Only accept if we are free OR if it's the same call ID we are managing
             if (statusRef.current === CallStatus.ENDED && !activeCallRef.current) {
                setIncomingCall(data as CallSession);
                setCallStatus(CallStatus.RINGING);
             }
          }
       });
    });

    incomingListenerRef.current = { ref: callsRef, cb };

    return () => {
       off(callsRef, 'value', cb);
    };
  }, [user?.uid]);

  // MONITOR ACTIVE CALL (RTDB)
  useEffect(() => {
    // Clear previous listener if any
    if (activeCallListenerRef.current) {
        off(activeCallListenerRef.current.ref, 'value', activeCallListenerRef.current.cb);
        activeCallListenerRef.current = null;
    }

    if (!activeCall || !rtdb) return;
    
    const callRef = ref(rtdb, `calls/${activeCall.callId}`);
    const cb = onValue(callRef, (snapshot) => {
      const data = snapshot.val();
      
      if (!data) {
        // Call disappeared (ended remotely and cleaned up)
        cleanupCall();
        return;
      }

      if (data.status === 'CONNECTED' && statusRef.current !== CallStatus.CONNECTED) {
        setCallStatus(CallStatus.CONNECTED);
        playTone("ON");
      }

      // CRITICAL FIX: Handle activeSpeakerId updates correctly.
      // In RTDB, setting a value to null removes the key.
      // So if 'activeSpeakerId' is undefined in 'data', it means it was set to null (stopped talking).
      // We must explicitly default to null in that case to clear the state.
      setActiveCall((prev) =>
        prev ? { ...prev, activeSpeakerId: data.activeSpeakerId || null } : null,
      );

      if (["ENDED", "REJECTED"].includes(data.status)) {
        cleanupCall();
      }
    });

    activeCallListenerRef.current = { ref: callRef, cb };
    return () => { 
        if (activeCallListenerRef.current) {
            off(activeCallListenerRef.current.ref, 'value', activeCallListenerRef.current.cb);
        }
    };
  }, [activeCall?.callId]);

  const makeCall = async (calleeId: string, calleeName: string) => {
    if (!user || !rtdb) return;
    
    // Safety check: ensure previous call is fully cleared
    if (statusRef.current !== CallStatus.ENDED) {
        console.warn("Attempted to make call while not ENDED");
        await endCall();
    }
    
    ensureAudioContext();

    try {
      // Ensure media is ready and MUTED for PTT
      const stream = await rtcRef.current.acquireMedia();
      stream.getAudioTracks().forEach(t => t.enabled = false);

      // Setup PeerConnection with fresh event handlers
      rtcRef.current.createPeerConnection((remoteStream) => {
        setRemoteStream(remoteStream);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
      });

      const callId = await rtcRef.current.createCall(
        user.uid,
        calleeId,
        {
          callerName: user.displayName || "Unknown",
          callerPhoto: user.photoURL || null,
          calleeName,
        },
      );

      const callData: CallSession = {
        callId,
        callerId: user.uid,
        callerName: user.displayName || "Unknown",
        callerPhoto: user.photoURL || null,
        calleeId,
        calleeName,
        type: CallType.PTT,
        status: CallStatus.OFFERING,
        startedAt: Date.now(),
        activeSpeakerId: null,
      };

      setActiveCall(callData);
      setCallStatus(CallStatus.OFFERING);
    } catch (e) {
      console.error("Error making walkie call:", e);
      cleanupCall();
      throw e;
    }
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !rtdb) return;
    ensureAudioContext();

    try {
      // Ensure media is ready and MUTED for PTT
      const stream = await rtcRef.current.acquireMedia();
      stream.getAudioTracks().forEach(t => t.enabled = false);

      rtcRef.current.createPeerConnection((remoteStream) => {
        setRemoteStream(remoteStream);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
      });

      await rtcRef.current.answerCall(incomingCall.callId);

      setActiveCall(incomingCall);
      setIncomingCall(null);
      setCallStatus(CallStatus.CONNECTED);
    } catch (e) {
      console.error("Error answering walkie call:", e);
      cleanupCall();
    }
  };

  const toggleTalk = async (isTalking: boolean) => {
    if (!activeCall || !rtdb || !user) return;
    ensureAudioContext();

    if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
            track.enabled = isTalking;
        });
    }

    if (remoteAudioRef.current && remoteAudioRef.current.srcObject) {
      remoteAudioRef.current.play().catch(() => {});
    }

    try {
      const callRef = ref(rtdb, `calls/${activeCall.callId}`);
      await update(callRef, {
        activeSpeakerId: isTalking ? user.uid : null,
      });
    } catch (e) {
      console.error("Toggle talk update error:", e);
    }
  };

  const cleanupCall = () => {
    statusRef.current = CallStatus.ENDED;
    activeCallRef.current = null;

    setCallStatus(CallStatus.ENDED);
    setActiveCall(null);
    setIncomingCall(null);
    // Don't nullify localStream, we keep it for next call
    setRemoteStream(null);

    // Clean up signaling but keep media stream
    rtcRef.current.endCurrentSession(activeCall?.callId || null);
  };

  const endCall = async () => {
    if (activeCall && rtdb) {
      const callRef = ref(rtdb, `calls/${activeCall.callId}`);
      try {
        await update(callRef, { status: "ENDED" });
      } catch (e) {}
    }
    cleanupCall();
  };

  const rejectCall = async () => {
    if (incomingCall && rtdb) {
      const callRef = ref(rtdb, `calls/${incomingCall.callId}`);
      try {
        await update(callRef, { status: "REJECTED" });
      } catch (e) {}
    }
    setIncomingCall(null);
    setCallStatus(CallStatus.ENDED);
  };

  return (
    <CallContext.Provider
      value={{
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
        ensureAudioContext,
        remoteAudioRef,
        isMediaReady
      }}
    >
      {children}
    </CallContext.Provider>
  );
};
