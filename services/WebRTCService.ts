
import { rtdb, db } from "./firebase";
import {
  ref,
  set,
  push,
  onValue,
  update,
  get,
  child,
  remove,
  off,
  runTransaction,
  DataSnapshot,
  onDisconnect
} from "firebase/database";
import { doc, setDoc, collection } from "firebase/firestore";

const servers = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
        "stun:stun3.l.google.com:19302",
        "stun:stun4.l.google.com:19302",
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

export class WebRTCService {
  peerConnection: RTCPeerConnection | null = null;
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;
  
  // RTDB Unsubscribes
  rtdbListeners: { ref: any, callback: (snap: DataSnapshot) => void }[] = [];
  
  processedCandidates: Set<string> = new Set();
  
  // Signaling state tracking
  private remoteDescriptionSet = false;
  private candidateQueue: RTCIceCandidateInit[] = [];
  
  // Track current active call ID to preventing ghost signals
  private currentCallId: string | null = null;
  private isOfferer = false; // Role tracking for ICE restart
  private isRenegotiating = false; // Prevent overlapping renegotiations

  constructor() {
    console.log("PulseRTC: Service initialized");
  }

  // --- MEDIA MANAGEMENT ---

  async acquireMedia(): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream;
    }

    console.log("PulseRTC: Acquiring new media stream...");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media devices API not supported");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        },
      });
      
      this.localStream = stream;
      return stream;
    } catch (e: any) {
      console.error("PulseRTC: Error accessing microphone.", e);
      throw e;
    }
  }

  releaseMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }

  // --- CALL LOGIC ---

  private resetConnectionState() {
    // 1. Detach Listeners
    this.rtdbListeners.forEach(({ ref, callback }) => {
        off(ref, "value", callback);
    });
    this.rtdbListeners = [];
    
    // 2. Clear Queues
    this.processedCandidates.clear();
    this.candidateQueue = [];
    this.remoteDescriptionSet = false;
    this.currentCallId = null;
    this.isOfferer = false;
    this.isRenegotiating = false;

    // 3. Close PeerConnection
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    
    // 4. Reset Remote Stream
    this.remoteStream = new MediaStream();
  }

  createPeerConnection(onTrack: (stream: MediaStream) => void) {
    this.resetConnectionState();
    
    console.log("PulseRTC: Creating new PeerConnection");
    this.peerConnection = new RTCPeerConnection(servers);
    this.remoteStream = new MediaStream();

    // Monitor Connection State for Recovery
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log(`PulseRTC: Connection State: ${state}`);
      if (state === 'failed' || state === 'disconnected') {
          this.handleConnectionFailure();
      }
    };

    // Add local tracks (Clone keys to not disturb original stream)
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        if (this.peerConnection && this.localStream) {
          this.peerConnection.addTrack(track, this.localStream);
        }
      });
    } else {
        console.warn("PulseRTC: No local stream available when creating PeerConnection!");
    }

    // Handle remote tracks
    this.peerConnection.ontrack = (event) => {
      console.log("PulseRTC: Remote track received", event.streams[0]?.id);
      event.streams[0].getTracks().forEach((track) => {
        this.remoteStream?.addTrack(track);
      });
      onTrack(this.remoteStream!);
    };

    return this.peerConnection;
  }

  private async handleConnectionFailure() {
      if (!this.peerConnection || !this.currentCallId) return;
      
      const state = this.peerConnection.connectionState;
      console.warn(`PulseRTC: Connection unstable (${state}). Attempting recovery...`);
      
      // Only the Offerer (Caller) initiates ICE Restart to avoid glare
      // Also ensure we are stable before trying to restart
      if (this.isOfferer && !this.isRenegotiating && this.peerConnection.signalingState === 'stable') {
          this.isRenegotiating = true;
          try {
              console.log("PulseRTC: Creating ICE Restart Offer");
              // Use explicit iceRestart
              const offer = await this.peerConnection.createOffer({ iceRestart: true });
              await this.peerConnection.setLocalDescription(offer);
              
              const callRef = ref(rtdb, `calls/${this.currentCallId}`);
              await update(callRef, {
                  offer: { type: offer.type, sdp: offer.sdp }
              });
          } catch (e: any) {
              console.error("PulseRTC: ICE Restart failed", e.message || e);
          } finally {
              this.isRenegotiating = false;
          }
      }
  }

  private async safeAddIceCandidate(candidateInit: RTCIceCandidateInit) {
      if (!this.peerConnection) return;

      const candStr = JSON.stringify(candidateInit);
      if (this.processedCandidates.has(candStr)) return;
      this.processedCandidates.add(candStr);

      if (this.remoteDescriptionSet && this.peerConnection.remoteDescription) {
          try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
          } catch (e) {
              console.warn("PulseRTC: Failed to add candidate", e);
          }
      } else {
          console.log("PulseRTC: Buffering candidate (RemoteDesc not set)");
          this.candidateQueue.push(candidateInit);
      }
  }

  private async processBufferedCandidates() {
    if (!this.peerConnection) return;
    if (this.candidateQueue.length === 0) return;

    console.log(`PulseRTC: Flushing ${this.candidateQueue.length} buffered candidates`);
    for (const candidate of this.candidateQueue) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("PulseRTC: Error flushing candidate", e);
      }
    }
    this.candidateQueue = [];
  }

  async createCall(
    callerId: string,
    calleeId: string,
    metadata?: Record<string, any>,
  ): Promise<string> {
    if (!this.peerConnection) throw new Error("PeerConnection not initialized");
    
    this.isOfferer = true;

    // RTDB: Push new call to 'calls' node
    const callsRef = ref(rtdb, "calls");
    const newCallRef = push(callsRef);
    const callId = newCallRef.key as string;
    this.currentCallId = callId;
    
    console.log("PulseRTC: Creating call", callId);

    // 1. Listen for ICE candidates locally and push to RTDB
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.currentCallId === callId) {
        try {
           const candidatesRef = ref(rtdb, `calls/${callId}/offerCandidates`);
           await push(candidatesRef, event.candidate.toJSON());
        } catch (e: any) {
          console.error("PulseRTC: Error uploading caller candidate", e.message || e);
        }
      }
    };

    // 2. Create Offer
    const offerDescription = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offerDescription);

    // 3. Write Initial Data to RTDB
    const callData = {
      callId,
      callerId,
      calleeId,
      type: "PTT",
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp,
      },
      status: "OFFERING", 
      timestamp: Date.now(),
      ...metadata,
    };

    await set(newCallRef, callData);

    // PHASE 4: Presence & Cleanup - Register onDisconnect
    await onDisconnect(newCallRef).update({ status: 'ENDED' });

    // 4. Listen for Answer in RTDB
    const callRef = ref(rtdb, `calls/${callId}`);
    const answerListener = onValue(callRef, async (snapshot) => {
      const data = snapshot.val();
      if (this.currentCallId !== callId || !this.peerConnection || !data) return;

      // Handle Answer (Works for both initial connection and ICE restart)
      if (data.answer) {
        const hasLocalOffer = this.peerConnection.signalingState === 'have-local-offer';
        
        if (hasLocalOffer) {
            console.log("PulseRTC: Received Answer, setting remote description...");
            const answerDescription = new RTCSessionDescription(data.answer);
            try {
              await this.peerConnection.setRemoteDescription(answerDescription);
              this.remoteDescriptionSet = true;
              await this.processBufferedCandidates();
              
              // Only update status to CONNECTED if we are in the initial handshake
              if (data.status === 'CONNECTING') {
                  await update(callRef, { status: 'CONNECTED' });
              }
            } catch (e) {
              console.error("PulseRTC: Error setting remote description", e);
            }
        }
      }
    });
    this.rtdbListeners.push({ ref: callRef, callback: answerListener });

    // 5. Listen for Answer Candidates in RTDB
    const answerCandidatesRef = ref(rtdb, `calls/${callId}/answerCandidates`);
    const candidatesListener = onValue(answerCandidatesRef, async (snapshot) => {
      if (this.currentCallId !== callId) return;
      const candidates = snapshot.val();
      if (!candidates) return;

      Object.values(candidates).forEach(async (candidate: any) => {
          await this.safeAddIceCandidate(candidate);
      });
    });
    this.rtdbListeners.push({ ref: answerCandidatesRef, callback: candidatesListener });

    return callId;
  }

  async answerCall(callId: string) {
    if (!this.peerConnection) throw new Error("PeerConnection not initialized");
    
    this.isOfferer = false;
    this.currentCallId = callId;
    console.log("PulseRTC: Answering Call", callId);

    const callRef = ref(rtdb, `calls/${callId}`);
    
    // HANDSHAKE STEP 1: Acknowledge with RINGING via Transaction
    await runTransaction(callRef, (data) => {
        if (data && data.status === 'OFFERING') {
            data.status = 'RINGING';
            return data;
        }
        return; 
    });

    const snapshot = await get(callRef);
    if (!snapshot.exists()) throw new Error("Call not found");
    const callData = snapshot.val();
    
    if (callData.status !== 'RINGING') {
        throw new Error("Call is not in valid state for answering");
    }

    // PHASE 4: Presence & Cleanup - Register onDisconnect
    await onDisconnect(callRef).update({ status: 'ENDED' });

    // 1. Listen for ICE candidates locally
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.currentCallId === callId) {
        try {
          const candidatesRef = ref(rtdb, `calls/${callId}/answerCandidates`);
          await push(candidatesRef, event.candidate.toJSON());
        } catch (e: any) {
           console.error("PulseRTC: Error uploading answer candidate", e.message || e);
        }
      }
    };

    // 2. Set Remote Description (Initial Offer)
    if (this.peerConnection.signalingState === 'stable') {
        const offerDescription = callData.offer;
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offerDescription));
          this.remoteDescriptionSet = true;
        } catch (e) {
          console.error("PulseRTC: Failed to set remote description", e);
          throw e;
        }
    }

    // 3. Create Answer
    const answerDescription = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    // HANDSHAKE STEP 2: Set status to CONNECTING
    await update(callRef, { answer, status: "CONNECTING" });

    // 4. Setup Listeners for Candidates & Negotiation (ICE Restart)
    const offerCandidatesRef = ref(rtdb, `calls/${callId}/offerCandidates`);
    
    // Process existing candidates first
    const candidatesSnap = await get(offerCandidatesRef);
    if (candidatesSnap.exists()) {
        const candidates = candidatesSnap.val();
        Object.values(candidates).forEach(async (candidate: any) => {
            await this.safeAddIceCandidate(candidate);
        });
    }

    // Listen for NEW Offer Candidates
    const candListener = onValue(offerCandidatesRef, async (snapshot) => {
      if (this.currentCallId !== callId) return;
      const candidates = snapshot.val();
      if (!candidates) return;

      Object.values(candidates).forEach(async (candidate: any) => {
         await this.safeAddIceCandidate(candidate);
      });
    });
    this.rtdbListeners.push({ ref: offerCandidatesRef, callback: candListener });

    // Listen for Offer Updates (Renegotiation / ICE Restart)
    const offerListener = onValue(callRef, async (snapshot) => {
        const data = snapshot.val();
        if (this.currentCallId !== callId || !this.peerConnection || !data || !data.offer) return;

        const currentRemoteSdp = this.peerConnection.remoteDescription?.sdp;
        const newOfferSdp = data.offer.sdp;

        // If we receive a new offer while in stable state (ICE Restart)
        if (newOfferSdp && newOfferSdp !== currentRemoteSdp && this.peerConnection.signalingState === 'stable') {
            console.log("PulseRTC: Detected new offer (ICE Restart)");
            try {
                // Ensure we explicitly set type to 'offer' to avoid "createAnswer not called" errors
                // caused by implicit state issues or malformed objects.
                const offerDesc = { type: 'offer' as RTCSdpType, sdp: newOfferSdp };
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offerDesc));
                this.remoteDescriptionSet = true;
                await this.processBufferedCandidates(); 

                const newAnswer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(newAnswer);

                await update(callRef, {
                    answer: { type: newAnswer.type, sdp: newAnswer.sdp }
                });
            } catch(e) {
                console.error("PulseRTC: Error handling renegotiation", e);
            }
        }
    });
    this.rtdbListeners.push({ ref: callRef, callback: offerListener });
  }

  async endCurrentSession(callId: string | null) {
    console.log("PulseRTC: Ending session", callId);
    
    this.resetConnectionState();

    if (this.localStream) {
        this.localStream.getAudioTracks().forEach(t => {
            t.enabled = false;
        });
    }

    if (callId) {
      try {
        const callRef = ref(rtdb, `calls/${callId}`);
        
        // PHASE 4: Clean up onDisconnect so we don't accidentally wipe data if we are archiving
        await onDisconnect(callRef).cancel();

        const snap = await get(callRef);
        
        if (snap.exists()) {
          const data = snap.val();
          if (data.status !== "ENDED" && data.status !== "REJECTED") {
              const historyData = { ...data, status: "ENDED", endedAt: Date.now() };
              delete historyData.offerCandidates;
              delete historyData.answerCandidates;
              
              const historyRef = doc(collection(db, "calls"));
              await setDoc(historyRef, historyData);
              await remove(callRef);
          } else {
             await remove(callRef);
          }
        }
      } catch (e) {
        console.warn("PulseRTC: Cleanup failed", e);
      }
    }
  }
}

export const webRTCService = new WebRTCService();
