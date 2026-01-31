
export const APP_NAME = "Pulse";

// Replace this with your actual Vercel project URL
export const BACKEND_URL = "https://your-pulse-api.vercel.app/api";

export const STUN_SERVERS = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

export const COLLECTIONS = {
  USERS: 'users',
  CALLS: 'calls',
  CANDIDATES: 'candidates',
};

// Placeholder image for users without avatars
export const DEFAULT_AVATAR = "https://picsum.photos/200";
