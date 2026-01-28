export enum CallType {
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
  PTT = 'PTT' // Walkie-talkie mode
}

export enum CallStatus {
  OFFERING = 'OFFERING',
  RINGING = 'RINGING',
  CONNECTED = 'CONNECTED',
  ENDED = 'ENDED',
  REJECTED = 'REJECTED',
  MISSED = 'MISSED'
}

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string | null;
  photoURL: string | null;
  lastActive: number;
  fcmToken?: string;
}

export interface CallSession {
  callId: string;
  callerId: string;
  callerName: string;
  callerPhoto: string | null;
  calleeId: string;
  calleeName: string;
  type: CallType;
  status: CallStatus;
  startedAt: number;
  endedAt?: number | null;
  duration?: number | null;
  activeSpeakerId?: string | null;
}

export interface WebRTCSignal {
  type: 'offer' | 'answer' | 'candidate';
  payload: any;
  timestamp: number;
}