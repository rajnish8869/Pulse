
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
  
  // Watchdog Timers
  const offeringTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const ringingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // PHASE 3: RECEIVER-SIDE AUDIO GATE
  // Strictly control the audio element mute state based on who is talking
  useEffect(() => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl || !user) return;

    // Check if we are in a valid connected state
    const isConnected = callStatus === CallStatus.CONNECTED;
    
    // Check if the ACTIVE SPEAKER is the remote person
    // We only unmute if activeSpeakerId exists AND it is NOT us.
    const isRemoteSpeaker = activeCall?.activeSpeakerId && activeCall.activeSpeakerId !== user.uid;

    if (isConnected && isRemoteSpeaker) {
        // UNMUTE
        audioEl.muted = false;
        // Ensure playback is active
        if (audioEl.paused) {
            audioEl.play().catch(e => console.warn("Audio play interrupted", e));
        }
    } else {
        // MUTE (Default state)
        audioEl.muted = true;
    }
  }, [activeCall?.activeSpeakerId, callStatus, user?.uid]);

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

      // 1. STATE: RINGING (Caller side, awaiting answer)
      if (data.status === 'RINGING' && statusRef.current === CallStatus.OFFERING) {
        setCallStatus(CallStatus.RINGING);
        // Clear offering watchdog
        if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
        // Start ringing watchdog (Wait for CONNECTING)
        ringingTimeoutRef.current = setTimeout(() => {
             console.log("Pulse: Call timed out waiting for answer");
             endCall();
        }, 15000);
      }

      // 2. STATE: CONNECTING (Key Exchange)
      if (data.status === 'CONNECTING' && statusRef.current === CallStatus.RINGING) {
        setCallStatus(CallStatus.CONNECTING);
        // Clear ringing watchdog
        if (ringingTimeoutRef.current) clearTimeout(ringingTimeoutRef.current);
      }

      // 3. STATE: CONNECTED
      if (data.status === 'CONNECTED' && statusRef.current !== CallStatus.CONNECTED) {
        setCallStatus(CallStatus.CONNECTED);
        playTone("ON");
        // Ensure watchdogs are clear
        if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
        if (ringingTimeoutRef.current) clearTimeout(ringingTimeoutRef.current);
      }

      // Active Speaker Logic
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
    
    if (statusRef.current !== CallStatus.ENDED) {
        await endCall();
    }
    
    ensureAudioContext();

    try {
      // Ensure media is ready and MUTED
      const stream = await rtcRef.current.acquireMedia();
      stream.getAudioTracks().forEach(t => t.enabled = false);

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

      // Start Watchdog: If state doesn't change from OFFERING in 10s, abort
      if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
      offeringTimeoutRef.current = setTimeout(() => {
          if (statusRef.current === CallStatus.OFFERING) {
              console.log("Pulse: Call timed out in OFFERING");
              endCall();
          }
      }, 10000);

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
      // Ensure media is ready and MUTED
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
      // We set local status to CONNECTING immediately as we have sent the answer
      setCallStatus(CallStatus.CONNECTING);
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
    // Clear Timers
    if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
    if (ringingTimeoutRef.current) clearTimeout(ringingTimeoutRef.current);
    offeringTimeoutRef.current = null;
    ringingTimeoutRef.current = null;

    statusRef.current = CallStatus.ENDED;
    activeCallRef.current = null;

    setCallStatus(CallStatus.ENDED);
    setActiveCall(null);
    setIncomingCall(null);
    setRemoteStream(null);

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
