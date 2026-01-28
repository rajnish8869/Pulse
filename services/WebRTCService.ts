
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
        if (this.onIceCandidateCallback) this.onIceCandidateCallback(event.candidate);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
        console.log("[PULSE-DEBUG] ICE State:", this.peerConnection?.iceConnectionState);
    };

    this.peerConnection.ontrack = (event) => {
      console.log("[PULSE-DEBUG] Remote track received:", event.track.kind);
      
      // Better track handling: use the stream provided by the event if possible
      if (event.streams && event.streams[0]) {
          this.remoteStream = event.streams[0];
      } else {
          if (!this.remoteStream) this.remoteStream = new MediaStream();
          this.remoteStream.addTrack(event.track);
      }
      
      if (this.onRemoteStreamCallback) {
        this.onRemoteStreamCallback(this.remoteStream);
      }
    };
  }

  public async startLocalStream(videoRequested: boolean = false): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
      },
      video: videoRequested ? { facingMode: 'user' } : false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localStream = stream;
      
      if (this.peerConnection) {
          // Clear existing senders to avoid duplicates on re-start
          this.peerConnection.getSenders().forEach(sender => {
              if (sender.track) sender.track.stop();
              this.peerConnection?.removeTrack(sender);
          });

          this.localStream.getTracks().forEach((track) => {
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
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error("No PC");
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  public async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error("No PC");
    await this.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  public async addAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.peerConnection) return;
    if (this.peerConnection.signalingState !== 'stable') {
      await this.setRemoteDescription(answer);
    }
  }

  public async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      if (!this.peerConnection) return;
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
        this.isRemoteDescriptionSet = true;
        await this.processCandidateQueue();
      } catch (e) {
        console.error("[PULSE-DEBUG] Remote Desc Error:", e);
      }
  }

  public async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection) return;
    if (!this.isRemoteDescriptionSet) {
        this.candidateQueue.push(candidate);
        return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error("[PULSE-DEBUG] Candidate Error:", e);
    }
  }

  private async processCandidateQueue() {
      if (!this.peerConnection) return;
      while (this.candidateQueue.length > 0) {
          const candidate = this.candidateQueue.shift();
          if (candidate) {
              try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
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
    this.localStream?.getTracks().forEach(track => track.stop());
    if (this.peerConnection) {
        this.peerConnection.ontrack = null;
        this.peerConnection.onicecandidate = null;
        this.peerConnection.close();
    }
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.candidateQueue = [];
    this.isRemoteDescriptionSet = false;
  }
}
