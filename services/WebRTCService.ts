
import { STUN_SERVERS } from '../constants';

type SignalCallback = (data: any) => void;

export class WebRTCService {
  public peerConnection: RTCPeerConnection | null = null;
  public localStream: MediaStream | null = null;
  public remoteStream: MediaStream | null = null;
  private onRemoteStreamCallback: ((stream: MediaStream) => void) | null = null;
  private onIceCandidateCallback: ((candidate: RTCIceCandidate) => void) | null = null;
  
  private candidateQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;

  constructor() {
    this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
    this.setupEventListeners();
  }

  private setupEventListeners() {
    if (!this.peerConnection) return;

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidateCallback) {
        this.onIceCandidateCallback(event.candidate);
      }
    };

    this.peerConnection.ontrack = (event) => {
      // Create remote stream if not exists
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      
      event.streams[0].getTracks().forEach((track) => {
        this.remoteStream?.addTrack(track);
      });
      
      if (this.onRemoteStreamCallback && this.remoteStream) {
        this.onRemoteStreamCallback(this.remoteStream);
      }
    };
  }

  public async startLocalStream(video: boolean = false): Promise<MediaStream> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video
      });
      this.localStream = stream;
      
      // Ensure tracks are added
      this.localStream.getTracks().forEach((track) => {
        if (this.peerConnection) {
            // Check if track already added to avoid "Track already exists" error
            const senders = this.peerConnection.getSenders();
            const exists = senders.find(s => s.track === track);
            if (!exists) {
                this.peerConnection.addTrack(track, this.localStream!);
            }
        }
      });

      return stream;
    } catch (error) {
      console.error("Error accessing media devices:", error);
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
    if (!this.peerConnection) throw new Error("No PeerConnection");
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  public async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error("No PeerConnection");
    await this.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  public async addAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.peerConnection) return;
    if (!this.peerConnection.currentRemoteDescription) {
      await this.setRemoteDescription(answer);
    }
  }

  public async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      if (!this.peerConnection) return;
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
      this.isRemoteDescriptionSet = true;
      await this.processCandidateQueue();
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
      console.error("Error adding ice candidate", e);
    }
  }

  private async processCandidateQueue() {
      if (!this.peerConnection) return;
      while (this.candidateQueue.length > 0) {
          const candidate = this.candidateQueue.shift();
          if (candidate) {
              try {
                  await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                  console.error("Error processing queued candidate", e);
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
    this.localStream?.getTracks().forEach(track => track.stop());
    this.peerConnection?.close();
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.candidateQueue = [];
    this.isRemoteDescriptionSet = false;
  }
}
