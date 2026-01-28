import { STUN_SERVERS } from '../constants';

export class WebRTCService {
  public peerConnection: RTCPeerConnection | null = null;
  public localStream: MediaStream | null = null;
  public remoteStream: MediaStream | null = null;
  private onRemoteStreamCallback: ((stream: MediaStream) => void) | null = null;
  private onIceCandidateCallback: ((candidate: RTCIceCandidate) => void) | null = null;
  
  private candidateQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;

  constructor() {
    console.log("[PULSE-DEBUG] Initializing WebRTCService Instance...");
    this.initPC();
  }

  private initPC() {
    this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
    this.setupEventListeners();
  }

  private setupEventListeners() {
    if (!this.peerConnection) return;

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[PULSE-DEBUG] Local ICE candidate generated:", event.candidate.candidate.substring(0, 30) + "...");
        if (this.onIceCandidateCallback) this.onIceCandidateCallback(event.candidate);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
        const state = this.peerConnection?.iceConnectionState;
        console.log("[PULSE-DEBUG] ICE Connection State:", state);
    };

    this.peerConnection.onsignalingstatechange = () => {
        console.log("[PULSE-DEBUG] Signaling State:", this.peerConnection?.signalingState);
    };

    this.peerConnection.ontrack = (event) => {
      console.log("[PULSE-DEBUG] Remote track received:", event.track.kind);
      
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      
      this.remoteStream.addTrack(event.track);
      
      if (this.onRemoteStreamCallback) {
        this.onRemoteStreamCallback(this.remoteStream);
      }
    };
  }

  public async startLocalStream(videoRequested: boolean = false): Promise<MediaStream> {
    console.log("[PULSE-DEBUG] Requesting media stream. Video Requested:", videoRequested);
    
    // Constraints must be specific to avoid "Starting videoinput failed" 
    // when camera is blocked or unavailable but not actually needed.
    const constraints: MediaStreamConstraints = {
      audio: true,
      video: videoRequested ? { facingMode: 'user' } : false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log("[PULSE-DEBUG] getUserMedia Success. Stream ID:", stream.id);
      this.localStream = stream;
      
      if (this.peerConnection) {
          this.localStream.getTracks().forEach((track) => {
              console.log("[PULSE-DEBUG] Adding local track to PC:", track.kind);
              this.peerConnection?.addTrack(track, this.localStream!);
          });
      }

      return stream;
    } catch (error) {
      console.error("[PULSE-DEBUG] Media Access Error:", error);
      throw error;
    }
  }

  public toggleAudio(enabled: boolean) {
    console.log("[PULSE-DEBUG] Audio Track Toggle:", enabled);
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error("No PeerConnection during Offer creation");
    console.log("[PULSE-DEBUG] Creating WebRTC Offer...");
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  public async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error("No PeerConnection during Answer creation");
    console.log("[PULSE-DEBUG] Processing remote offer and creating answer...");
    await this.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  public async addAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.peerConnection) return;
    if (this.peerConnection.signalingState !== 'stable') {
      console.log("[PULSE-DEBUG] Signaling Answer received, adding to connection");
      await this.setRemoteDescription(answer);
    }
  }

  public async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      if (!this.peerConnection) return;
      try {
        console.log("[PULSE-DEBUG] Setting Remote Description:", desc.type);
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
        this.isRemoteDescriptionSet = true;
        await this.processCandidateQueue();
      } catch (e) {
        console.error("[PULSE-DEBUG] Remote Description Failure:", e);
      }
  }

  public async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection) return;
    
    if (!this.isRemoteDescriptionSet) {
        console.log("[PULSE-DEBUG] Candidate arrival before RemoteDesc. Queuing...");
        this.candidateQueue.push(candidate);
        return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log("[PULSE-DEBUG] Remote Candidate Handled");
    } catch (e) {
      console.error("[PULSE-DEBUG] Candidate processing error:", e);
    }
  }

  private async processCandidateQueue() {
      if (!this.peerConnection) return;
      console.log("[PULSE-DEBUG] Flushing queued candidates:", this.candidateQueue.length);
      while (this.candidateQueue.length > 0) {
          const candidate = this.candidateQueue.shift();
          if (candidate) {
              try {
                  await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                  console.error("[PULSE-DEBUG] Queued candidate failure:", e);
              }
          }
      }
  }

  public onRemoteStream(callback: (stream: MediaStream) => void) {
    this.onRemoteStreamCallback = callback;
  }

  public onIceCandidate(callback: (candidate: RTCIceCandidate) => void) {
    this.onIceCandidateCallback = callback;
  }

  public close() {
    console.log("[PULSE-DEBUG] Destroying WebRTC session...");
    this.localStream?.getTracks().forEach(track => track.stop());
    this.peerConnection?.close();
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.candidateQueue = [];
    this.isRemoteDescriptionSet = false;
  }
}