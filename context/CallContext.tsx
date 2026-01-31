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
import { KeepAwake } from "@capacitor-community/keep-awake";
import { AudioToggle } from "@anuradev/capacitor-audio-toggle";
import { NativeAudio } from "@capacitor-community/native-audio";

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

  // Lazy initialization of the service to prevent reconstruction on every render
  const rtcRef = useRef<WebRTCService | null>(null);
  if (!rtcRef.current) {
    rtcRef.current = new WebRTCService();
  }

  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // RTDB Listener references for cleanup
  const incomingListenerRef = useRef<{ ref: any, cb: any } | null>(null);
  const activeCallListenerRef = useRef<{ ref: any, cb: any } | null>(null);
  
  // Watchdog Timers
  const offeringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
         const service = rtcRef.current!;
         const stream = await service.acquireMedia();
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
      if (rtcRef.current) {
        rtcRef.current.releaseMedia();
      }
    };
  }, []);

  // PHASE 3: Audio Management & Keep Alive
  useEffect(() => {
      const initAudioService = async () => {
          try {
              // 1. Start Silent Loop to keep AudioContext active in background
              // Note: Ensure 'silent.mp3' exists in public/assets/ or public/
              await NativeAudio.preload({
                  assetId: 'keep_alive',
                  assetPath: 'silent.mp3',
                  audioChannelNum: 1,
                  isUrl: false
              });
              await NativeAudio.loop({
                  assetId: 'keep_alive',
                  volume: 0.01 // Minimal volume to keep channel open without being audible
              });
              console.log("Pulse: Silent audio loop started");
          } catch (e) {
              console.warn("Pulse: Silent Audio Loop failed (Check assets/silent.mp3):", e);
          }
      };
      initAudioService();
  }, []);

  // Monitor Call Status for Native Audio Mode & Wake Lock
  useEffect(() => {
      const handleCallState = async () => {
          if (callStatus === CallStatus.CONNECTED) {
              // Connected: Acquire WakeLock & Switch to Voice Call Audio Mode
              console.log("Pulse: Enabling Voice Call Mode & WakeLock");
              try {
                  await KeepAwake.keepAwake();
                  // Switch Android Audio Mode to IN_COMMUNICATION (VoIP)
                  await AudioToggle.setAudioMode({ mode: 'communication' });
                  // Force Speakerphone for Walkie Talkie usage
                  await AudioToggle.setSpeakerphoneOn(true);
              } catch (e) {
                  console.error("Pulse: Error setting call audio mode:", e);
              }
          } else if (callStatus === CallStatus.ENDED || callStatus === CallStatus.REJECTED) {
              // Disconnected: Release WakeLock & Revert Audio Mode
              console.log("Pulse: Reverting Audio Mode");
              try {
                  await KeepAwake.allowSleep();
                  await AudioToggle.setAudioMode({ mode: 'normal' });
              } catch (e) {
                  console.error("Pulse: Error resetting audio mode:", e);
              }
          }
      };
      handleCallState();
  }, [callStatus]);

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
      if (data.status === 'CONNECTING' && (statusRef.current === CallStatus.RINGING || statusRef.current === CallStatus.OFFERING)) {
        setCallStatus(CallStatus.CONNECTING);
        // Clear previous watchdogs
        if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
        if (ringingTimeoutRef.current) clearTimeout(ringingTimeoutRef.current);
        
        // Start CONNECTING watchdog
        if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
        connectingTimeoutRef.current = setTimeout(() => {
            console.log("Pulse: Call timed out in CONNECTING phase (ICE failure?)");
            endCall();
        }, 20000); // 20s for ICE negotiation
      }

      // 3. STATE: CONNECTED
      if (data.status === 'CONNECTED' && statusRef.current !== CallStatus.CONNECTED) {
        setCallStatus(CallStatus.CONNECTED);
        playTone("ON");
        // Ensure watchdogs are clear
        if (offeringTimeoutRef.current) clearTimeout(offeringTimeoutRef.current);
        if (ringingTimeoutRef.current) clearTimeout(ringingTimeoutRef.current);
        if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
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
      const service = rtcRef.current!;
      // Ensure media is ready and MUTED
      const stream = await service.acquireMedia();
      stream.getAudioTracks().forEach(t => t.enabled = false);

      service.createPeerConnection((remoteStream) => {
        setRemoteStream(remoteStream);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
      });

      const callId = await service.createCall(
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
      const service = rtcRef.current!;
      // Ensure media is ready and MUTED
      const stream = await service.acquireMedia();
      stream.getAudioTracks().forEach(t => t.enabled = false);

      service.createPeerConnection((remoteStream) => {
        setRemoteStream(remoteStream);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch(() => {});
        }
      });

      await service.answerCall(incomingCall.callId);

      setActiveCall(incomingCall);
      setIncomingCall(null);
      // We set local status to CONNECTING immediately as we have sent the answer
      setCallStatus(CallStatus.CONNECTING);
      
      // Start Connecting Watchdog locally as well
      if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = setTimeout(() => {
          console.log("Pulse: Answered call timed out in CONNECTING phase");
          endCall();
      }, 20000);

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
    if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
    offeringTimeoutRef.current = null;
    ringingTimeoutRef.current = null;
    connectingTimeoutRef.current = null;

    statusRef.current = CallStatus.ENDED;
    activeCallRef.current = null;

    setCallStatus(CallStatus.ENDED);
    setActiveCall(null);
    setIncomingCall(null);
    setRemoteStream(null);

    if (rtcRef.current) {
        rtcRef.current.endCurrentSession(activeCall?.callId || null);
    }
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