
export enum CallType {
  PTT = 'PTT'
}

export enum CallStatus {
  OFFERING = 'OFFERING',
  RINGING = 'RINGING',
  CONNECTING = 'CONNECTING', // Key Exchange
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
  pin: string; // 6-digit PIN for friend requests
}

export interface FriendRequest {
  id: string;
  fromUid: string;
  fromName: string;
  fromPhoto: string | null;
  toUid: string;
  status: 'pending' | 'accepted' | 'declined';
  timestamp: number;
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
