
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
  processedCandidateszb: Set<string> = new Set();

  constructor() {}

  async setupLocalMedia(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media devices API not supported");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.localStream = stream;
      return stream;
    } catch (e: any) {
      console.error("Error accessing microphone.", e.name, e.message);
      throw e;
    }
  }

  createPeerConnection(onTrack: (stream: MediaStream) => void) {
    this.peerConnection = new RTCPeerConnection(servers);
    this.remoteStream = new MediaStream();

    this.localStream?.getTracks().forEach((track) => {
      if (this.peerConnection && this.localStream) {
        this.peerConnection.addTrack(track, this.localStream);
      }
    });

    this.peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        this.remoteStream?.addTrack(track);
      });
      onTrack(this.remoteStream!);
    };

    // Log connection state changes for debugging
    this.peerConnection.onconnectionstatechange = () => {
      console.log("WebRTC Connection State:", this.peerConnection?.connectionState);
    };

    return this.peerConnection;
  }

  async createCall(
    callerId: string,
    calleeId: string,
    metadata?: Record<string, any>,
  ): Promise<string> {
    if (!this.peerConnection) throw new Error("PeerConnection not initialized");

    const callDocRef = doc(collection(db, "calls"));
    const candidateQueue: RTCIceCandidate[] = [];
    let docCreated = false;

    // Handle ICE Candidates - Write to 'offerCandidates' array
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        const json = event.candidate.toJSON();
        if (docCreated) {
          await updateDoc(callDocRef, {
            offerCandidates: arrayUnion(json)
          }).catch(e => console.error("Error sending offer candidate:", e));
        } else {
          candidateQueue.push(event.candidate);
        }
      }
    };

    const offerDescription = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offerDescription);

    const callData = {
      callId: callDocRef.id,
      callerId,
      calleeId,
      type: "PTT",
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp,
      },
      offerCandidates: [], // Initialize arrays
      answerCandidates: [],
      status: "offering",
      timestamp: Date.now(),
      ...metadata,
    };

    await setDoc(callDocRef, callData);
    docCreated = true;

    // Flush queued candidates
    if (candidateQueue.length > 0) {
      const jsonCandidates = candidateQueue.map(c => c.toJSON());
      await updateDoc(callDocRef, {
        offerCandidates: arrayUnion(...jsonCandidates)
      });
    }

    // Listen for Answer and Answer Candidates
    const unsub = onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!this.peerConnection || !data) return;

      // Handle Answer SDP
      if (!this.peerConnection.currentRemoteDescription && data.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        this.peerConnection.setRemoteDescription(answerDescription);
      }

      // Handle Answer Candidates
      if (data.answerCandidates && Array.isArray(data.answerCandidates)) {
        data.answerCandidates.forEach((candidate: any) => {
          const candStr = JSON.stringify(candidate);
          if (!this.processedCandidateszb.has(candStr)) {
            this.processedCandidateszb.add(candStr);
            this.peerConnection?.addIceCandidate(new RTCIceCandidate(candidate))
              .catch(e => console.error("Error adding answer candidate", e));
          }
        });
      }
    });

    this.unsubscribes.push(unsub);
    return callDocRef.id;
  }

  async answerCall(callId: string) {
    if (!this.peerConnection) throw new Error("PeerConnection not initialized");

    const callDocRef = doc(db, "calls", callId);
    const callSnap = await getDoc(callDocRef);
    const callData = callSnap.data();

    if (!callData) throw new Error("Call not found");

    // Handle ICE Candidates - Write to 'answerCandidates' array
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        await updateDoc(callDocRef, {
          answerCandidates: arrayUnion(event.candidate.toJSON())
        }).catch(e => console.error("Error sending answer candidate:", e));
      }
    };

    // Set Remote Description (Offer)
    const offerDescription = callData.offer;
    await this.peerConnection.setRemoteDescription(
      new RTCSessionDescription(offerDescription),
    );

    // Create Answer
    const answerDescription = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await updateDoc(callDocRef, { answer, status: "connected" });

    // Process existing offer candidates immediately
    if (callData.offerCandidates && Array.isArray(callData.offerCandidates)) {
        callData.offerCandidates.forEach((candidate: any) => {
            const candStr = JSON.stringify(candidate);
            if (!this.processedCandidateszb.has(candStr)) {
              this.processedCandidateszb.add(candStr);
              this.peerConnection?.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("Error adding initial offer candidate", e));
            }
        });
    }

    // Listen for new Offer Candidates
    const unsub = onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!this.peerConnection || !data) return;

      if (data.offerCandidates && Array.isArray(data.offerCandidates)) {
        data.offerCandidates.forEach((candidate: any) => {
          const candStr = JSON.stringify(candidate);
          if (!this.processedCandidateszb.has(candStr)) {
            this.processedCandidateszb.add(candStr);
            this.peerConnection?.addIceCandidate(new RTCIceCandidate(candidate))
              .catch(e => console.error("Error adding offer candidate", e));
          }
        });
      }
    });

    this.unsubscribes.push(unsub);
  }

  async cleanup(callId: string | null) {
    // Unsubscribe from all Firestore listeners to prevent memory leaks and ghost updates
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    this.processedCandidateszb.clear();

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
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
          // Only end if not already ended/rejected to avoid overwriting final state
          if (data.status !== "ended" && data.status !== "rejected") {
            await updateDoc(callRef, {
              status: "ended",
              endedAt: Date.now(),
            });
          }
        }
      } catch (e) {
        // ignore errors during cleanup
      }
    }
  }
}

export const webRTCService = new WebRTCService();
