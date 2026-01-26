import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { 
  collection, doc, addDoc, updateDoc, onSnapshot, 
  query, where, serverTimestamp, setDoc, getDoc 
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from './AuthContext';
import { CallSession, CallStatus, CallType } from '../types';
import { WebRTCService } from '../services/WebRTCService';
import { COLLECTIONS } from '../constants';

interface CallContextType {
  activeCall: CallSession | null;
  incomingCall: CallSession | null;
  callStatus: CallStatus;
  makeCall: (calleeId: string, calleeName: string, type: CallType) => Promise<void>;
  answerCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  endCall: () => Promise<void>;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
}

const CallContext = createContext<CallContextType>({} as CallContextType);

export const useCall = () => useContext(CallContext);

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallSession | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.ENDED);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const rtcRef = useRef<WebRTCService | null>(null);
  const callUnsubRef = useRef<(() => void) | null>(null);

  // Initialize WebRTC helper
  useEffect(() => {
    rtcRef.current = new WebRTCService();
    
    rtcRef.current.onRemoteStream((stream) => {
      setRemoteStream(stream);
    });

    return () => {
      if (rtcRef.current) rtcRef.current.close();
    };
  }, []);

  // Listen for incoming calls
  useEffect(() => {
    if (!user || !db) return;

    const q = query(
      collection(db, COLLECTIONS.CALLS),
      where('calleeId', '==', user.uid),
      where('status', '==', CallStatus.OFFERING)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as CallSession;
          // Only accept if we aren't already in a call
          if (callStatus === CallStatus.ENDED) {
            setIncomingCall(data);
            setCallStatus(CallStatus.RINGING);
          } else {
             // Auto-reject busy
             if (db) {
                updateDoc(doc(db, COLLECTIONS.CALLS, data.callId), { status: 'BUSY' });
             }
          }
        }
      });
    }, (error) => {
        console.error("Error listening for incoming calls:", error);
    });

    return () => unsubscribe();
  }, [user, callStatus]);

  // Handle Active Call Signaling
  useEffect(() => {
    if (!activeCall || !db || !rtcRef.current) return;

    const callDocRef = doc(db, COLLECTIONS.CALLS, activeCall.callId);

    // Listen to call document changes (Answer, End, Hangup)
    const unsub = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        // Remote user answered
        if (data.status === CallStatus.CONNECTED && callStatus === CallStatus.OFFERING) {
            setCallStatus(CallStatus.CONNECTED);
        }

        // Remote user ended call
        if (data.status === CallStatus.ENDED || data.status === CallStatus.REJECTED) {
             cleanupCall();
        }
    });

    // Listen for remote answers (SDP)
    const answerUnsub = onSnapshot(collection(callDocRef, 'answerCandidates'), (snapshot) => {
       snapshot.docChanges().forEach((change) => {
           if (change.type === 'added') {
             const data = change.doc.data();
             rtcRef.current?.addIceCandidate(data as RTCIceCandidateInit);
           }
       });
    });
    
    // Check for answer SDP if I am the caller
    if (activeCall.callerId === user?.uid) {
         getDoc(callDocRef).then(async (snap) => {
             const data = snap.data();
             if (snap.exists() && data?.answer) {
                 await rtcRef.current?.addAnswer(data.answer);
             }
         });
         
         // Realtime listener for answer SDP field
         const sdpUnsub = onSnapshot(callDocRef, async (snap) => {
            const d = snap.data();
            if (d?.answer && !rtcRef.current?.peerConnection?.currentRemoteDescription) {
                await rtcRef.current?.addAnswer(d.answer);
            }
         });
         callUnsubRef.current = () => { unsub(); answerUnsub(); sdpUnsub(); };
    } else {
         callUnsubRef.current = () => { unsub(); answerUnsub(); };
    }
    
    return () => {
        if(callUnsubRef.current) callUnsubRef.current();
    }
  }, [activeCall, user, callStatus]);

  const makeCall = async (calleeId: string, calleeName: string, type: CallType) => {
    if (!user || !db || !rtcRef.current) return;

    // 1. Get Local Stream
    const stream = await rtcRef.current.startLocalStream(type === CallType.VIDEO);
    setLocalStream(stream);

    // 2. Create Offer
    const offer = await rtcRef.current.createOffer();

    // 3. Create Call Document
    const callDocRef = doc(collection(db, COLLECTIONS.CALLS));
    const callId = callDocRef.id;
    
    // Use null instead of undefined for photo
    const callData: CallSession = {
      callId,
      callerId: user.uid,
      callerName: user.displayName || 'Unknown',
      callerPhoto: user.photoURL || undefined, 
      calleeId,
      calleeName,
      type,
      status: CallStatus.OFFERING,
      startedAt: Date.now(),
    };

    // Prepare data for Firestore (remove undefined)
    const firestoreData = {
        ...callData,
        callerPhoto: user.photoURL || null,
        offer: { type: offer.type, sdp: offer.sdp }
    };

    // 4. Save to Firestore (include offer SDP)
    await setDoc(callDocRef, firestoreData);

    // 5. Handle ICE Candidates
    rtcRef.current.onIceCandidate(async (candidate) => {
        if (db) {
            await addDoc(collection(db, COLLECTIONS.CALLS, callId, 'offerCandidates'), candidate.toJSON());
        }
    });

    setActiveCall(callData);
    setCallStatus(CallStatus.OFFERING);
  };

  const answerCall = async () => {
    if (!incomingCall || !user || !db || !rtcRef.current) return;

    // 1. Get Local Stream
    const stream = await rtcRef.current.startLocalStream(incomingCall.type === CallType.VIDEO);
    setLocalStream(stream);

    // 2. Get the Offer from DB
    const callDocRef = doc(db, COLLECTIONS.CALLS, incomingCall.callId);
    const callDoc = await getDoc(callDocRef);
    const callData = callDoc.data();
    
    if (callData && callData.offer) {
        // 3. Set Remote Description
        await rtcRef.current.peerConnection?.setRemoteDescription(new RTCSessionDescription(callData.offer));
        
        // 4. Create Answer
        const answer = await rtcRef.current.createAnswer(callData.offer);
        
        // 5. Update DB
        await updateDoc(callDocRef, {
            status: CallStatus.CONNECTED,
            answer: { type: answer.type, sdp: answer.sdp }
        });

        // 6. Handle ICE Candidates (send answer candidates)
        rtcRef.current.onIceCandidate(async (candidate) => {
            if (db) {
                await addDoc(collection(db, COLLECTIONS.CALLS, incomingCall.callId, 'answerCandidates'), candidate.toJSON());
            }
        });
        
        // 7. Listen for Offer Candidates (from caller)
        onSnapshot(collection(db, COLLECTIONS.CALLS, incomingCall.callId, 'offerCandidates'), (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if(change.type === 'added') {
                    rtcRef.current?.addIceCandidate(change.doc.data() as RTCIceCandidateInit);
                }
            })
        });

        setActiveCall(incomingCall);
        setIncomingCall(null);
        setCallStatus(CallStatus.CONNECTED);
    }
  };

  const cleanupCall = () => {
    setCallStatus(CallStatus.ENDED);
    setActiveCall(null);
    setIncomingCall(null);
    setRemoteStream(null);
    setLocalStream(null);
    // Re-init WebRTC service for next call
    rtcRef.current?.close();
    rtcRef.current = new WebRTCService();
    rtcRef.current.onRemoteStream((stream) => setRemoteStream(stream));
  };

  const endCall = async () => {
    if (activeCall && db) {
        const duration = Math.floor((Date.now() - activeCall.startedAt) / 1000);
        await updateDoc(doc(db, COLLECTIONS.CALLS, activeCall.callId), {
            status: CallStatus.ENDED,
            endedAt: Date.now(),
            duration: duration
        });
    }
    cleanupCall();
  };

  const rejectCall = async () => {
      if (incomingCall && db) {
        await updateDoc(doc(db, COLLECTIONS.CALLS, incomingCall.callId), {
            status: CallStatus.REJECTED,
            endedAt: Date.now(),
            duration: 0
        });
      }
      setIncomingCall(null);
      setCallStatus(CallStatus.ENDED);
  }

  return (
    <CallContext.Provider value={{
      activeCall,
      incomingCall,
      callStatus,
      makeCall,
      answerCall,
      rejectCall,
      endCall,
      remoteStream,
      localStream
    }}>
      {children}
    </CallContext.Provider>
  );
};