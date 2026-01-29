
import { db } from "./firebase";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  arrayUnion,
  collection
} from "firebase/firestore";

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
  unsubscribes: (() => void)[] = [];
  processedCandidates: Set<string> = new Set();
  
  // Signaling state tracking
  private remoteDescriptionSet = false;
  private candidateQueue: RTCIceCandidateInit[] = [];

  constructor() {
    console.log("PulseRTC: Service initialized");
  }

  async setupLocalMedia(): Promise<MediaStream> {
    console.log("PulseRTC: Setting up local media...");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media devices API not supported");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true 
        },
      });
      this.localStream = stream;
      console.log("PulseRTC: Local media acquired", stream.id);
      return stream;
    } catch (e: any) {
      console.error("PulseRTC: Error accessing microphone.", e);
      throw e;
    }
  }

  createPeerConnection(onTrack: (stream: MediaStream) => void) {
    console.log("PulseRTC: Creating PeerConnection");
    this.peerConnection = new RTCPeerConnection(servers);
    this.remoteStream = new MediaStream();
    this.remoteDescriptionSet = false;
    this.candidateQueue = [];
    this.processedCandidates.clear();

    // Add local tracks
    this.localStream?.getTracks().forEach((track) => {
      if (this.peerConnection && this.localStream) {
        console.log("PulseRTC: Adding local track", track.kind);
        this.peerConnection.addTrack(track, this.localStream);
      }
    });

    // Handle remote tracks
    this.peerConnection.ontrack = (event) => {
      console.log("PulseRTC: Remote track received", event.streams[0].id);
      event.streams[0].getTracks().forEach((track) => {
        this.remoteStream?.addTrack(track);
      });
      onTrack(this.remoteStream!);
    };

    // Log connection state
    this.peerConnection.onconnectionstatechange = () => {
      console.log("PulseRTC: Connection State Change:", this.peerConnection?.connectionState);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log("PulseRTC: ICE State Change:", this.peerConnection?.iceConnectionState);
    };

    return this.peerConnection;
  }

  // --- Helper to handle buffered candidates ---
  private async processBufferedCandidates() {
    console.log(`PulseRTC: Processing ${this.candidateQueue.length} buffered candidates`);
    for (const candidate of this.candidateQueue) {
      try {
        if (this.peerConnection) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log("PulseRTC: Buffered candidate added successfully");
        }
      } catch (e) {
        console.error("PulseRTC: Error adding buffered candidate", e);
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

    const callDocRef = doc(collection(db, "calls"));
    console.log("PulseRTC: Creating call document", callDocRef.id);

    // 1. Listen for ICE candidates locally and upload them
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        console.log("PulseRTC: Found Local Caller Candidate");
        try {
          // Use arrayUnion to safely add to the list
          await updateDoc(callDocRef, {
            offerCandidates: arrayUnion(event.candidate.toJSON())
          });
        } catch (e) {
          console.error("PulseRTC: Error uploading caller candidate", e);
        }
      }
    };

    // 2. Create Offer
    const offerDescription = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offerDescription);
    console.log("PulseRTC: Local Description set (Offer)");

    // 3. Write Initial Doc
    const callData = {
      callId: callDocRef.id,
      callerId,
      calleeId,
      type: "PTT",
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp,
      },
      offerCandidates: [], 
      answerCandidates: [],
      status: "OFFERING", // FIXED: Uppercase to match CallStatus.OFFERING
      timestamp: Date.now(),
      ...metadata,
    };

    await setDoc(callDocRef, callData);
    console.log("PulseRTC: Call Document Written");

    // 4. Listen for Answer
    const unsub = onSnapshot(callDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (!this.peerConnection || !data) return;

      // A. Handle Remote Description (Answer)
      if (!this.peerConnection.currentRemoteDescription && data.answer) {
        console.log("PulseRTC: Received Answer from Callee");
        const answerDescription = new RTCSessionDescription(data.answer);
        try {
          await this.peerConnection.setRemoteDescription(answerDescription);
          this.remoteDescriptionSet = true;
          console.log("PulseRTC: Remote Description Set (Answer)");
          await this.processBufferedCandidates();
        } catch (e) {
          console.error("PulseRTC: Error setting remote description", e);
        }
      }

      // B. Handle Remote Candidates (Answer Candidates)
      if (data.answerCandidates && Array.isArray(data.answerCandidates)) {
        for (const candidate of data.answerCandidates) {
          const candStr = JSON.stringify(candidate);
          if (!this.processedCandidates.has(candStr)) {
            this.processedCandidates.add(candStr);
            
            if (this.remoteDescriptionSet) {
              try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log("PulseRTC: Added Answer Candidate");
              } catch (e) {
                console.error("PulseRTC: Error adding answer candidate", e);
              }
            } else {
              console.log("PulseRTC: Buffering Answer Candidate (Remote not set)");
              this.candidateQueue.push(candidate);
            }
          }
        }
      }
    });

    this.unsubscribes.push(unsub);
    return callDocRef.id;
  }

  async answerCall(callId: string) {
    console.log("PulseRTC: Answering Call", callId);
    if (!this.peerConnection) throw new Error("PeerConnection not initialized");

    const callDocRef = doc(db, "calls", callId);
    const callSnap = await getDoc(callDocRef);
    
    if (!callSnap.exists()) {
       console.error("PulseRTC: Call document not found");
       throw new Error("Call not found");
    }
    
    const callData = callSnap.data();

    // 1. Listen for ICE candidates locally and upload them
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        console.log("PulseRTC: Found Local Callee Candidate");
        try {
          await updateDoc(callDocRef, {
            answerCandidates: arrayUnion(event.candidate.toJSON())
          });
        } catch (e) {
          console.error("PulseRTC: Error uploading callee candidate", e);
        }
      }
    };

    // 2. Set Remote Description (Offer) IMMEDIATELY
    const offerDescription = callData.offer;
    try {
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(offerDescription),
      );
      this.remoteDescriptionSet = true;
      console.log("PulseRTC: Remote Description Set (Offer)");
    } catch (e) {
      console.error("PulseRTC: Failed to set remote description", e);
      throw e;
    }

    // 3. Create Answer
    const answerDescription = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answerDescription);
    console.log("PulseRTC: Local Description set (Answer)");

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await updateDoc(callDocRef, { answer, status: "CONNECTED" }); // FIXED: Uppercase to match CallStatus.CONNECTED
    console.log("PulseRTC: Sent Answer");

    // 4. Process Existing Offer Candidates
    if (callData.offerCandidates && Array.isArray(callData.offerCandidates)) {
        console.log(`PulseRTC: Processing ${callData.offerCandidates.length} existing offer candidates`);
        for (const candidate of callData.offerCandidates) {
            const candStr = JSON.stringify(candidate);
            if (!this.processedCandidates.has(candStr)) {
              this.processedCandidates.add(candStr);
              try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                 console.error("PulseRTC: Error adding existing offer candidate", e);
              }
            }
        }
    }

    // 5. Listen for NEW Offer Candidates
    const unsub = onSnapshot(callDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (!this.peerConnection || !data) return;

      if (data.offerCandidates && Array.isArray(data.offerCandidates)) {
        for (const candidate of data.offerCandidates) {
          const candStr = JSON.stringify(candidate);
          if (!this.processedCandidates.has(candStr)) {
            this.processedCandidates.add(candStr);
            // Callee sets remote desc immediately, so we can usually add directly
            // But checking the flag is safe
            if (this.remoteDescriptionSet) {
                try {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log("PulseRTC: Added Offer Candidate (Live)");
                } catch (e) {
                    console.error("PulseRTC: Error adding offer candidate (Live)", e);
                }
            } else {
                console.log("PulseRTC: Buffering Offer Candidate (Unexpected: Remote not set)");
                this.candidateQueue.push(candidate);
            }
          }
        }
      }
    });

    this.unsubscribes.push(unsub);
  }

  async cleanup(callId: string | null) {
    console.log("PulseRTC: Cleaning up session");
    // Unsubscribe from all Firestore listeners
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    this.processedCandidates.clear();
    this.candidateQueue = [];
    this.remoteDescriptionSet = false;

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.localStream = null;
    }
    this.remoteStream = null;

    if (callId) {
      try {
        const callRef = doc(db, "calls", callId);
        const snap = await getDoc(callRef);
        if (snap.exists()) {
          const data = snap.data();
          // Only end if not already ended/rejected
          if (data.status !== "ENDED" && data.status !== "REJECTED") { // FIXED: Uppercase
            await updateDoc(callRef, {
              status: "ENDED", // FIXED: Uppercase
              endedAt: Date.now(),
            });
            console.log("PulseRTC: Call marked as ended in DB");
          }
        }
      } catch (e) {
        console.warn("PulseRTC: Cleanup DB update failed (likely already gone)", e);
      }
    }
  }
}

export const webRTCService = new WebRTCService();
