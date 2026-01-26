import { STUN_SERVERS } from '../constants';

type SignalCallback = (data: any) => void;

export class WebRTCService {
  public peerConnection: RTCPeerConnection | null = null;
  public localStream: MediaStream | null = null;
  public remoteStream: MediaStream | null = null;
  private onRemoteStreamCallback: ((stream: MediaStream) => void) | null = null;
  private onIceCandidateCallback: ((candidate: RTCIceCandidate) => void) | null = null;

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
      event.streams[0].getTracks().forEach((track) => {
        this.remoteStream?.addTrack(track);
      });
      if (this.onRemoteStreamCallback && event.streams[0]) {
        this.onRemoteStreamCallback(event.streams[0]);
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
      this.remoteStream = new MediaStream();

      // Add tracks to peer connection
      this.localStream.getTracks().forEach((track) => {
        if (this.peerConnection) {
          this.peerConnection.addTrack(track, this.localStream!);
        }
      });

      return stream;
    } catch (error) {
      console.error("Error accessing media devices:", error);
      throw error;
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
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  public async addAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.peerConnection) return;
    if (!this.peerConnection.currentRemoteDescription) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  public async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection) return;
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error("Error adding ice candidate", e);
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
  }
}