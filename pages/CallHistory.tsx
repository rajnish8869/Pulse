import React, { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from '../context/AuthContext';
import { useCall } from '../context/CallContext';
import { CallSession, CallStatus, CallType } from '../types';
import { COLLECTIONS, DEFAULT_AVATAR } from '../constants';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Video, Phone } from 'lucide-react';

const CallHistory: React.FC = () => {
  const { user } = useAuth();
  const { makeCall } = useCall();
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !db) {
        setLoading(false);
        return;
    }

    const fetchCalls = async () => {
      try {
        const callsRef = collection(db, COLLECTIONS.CALLS);

        // Firestore requires composite indexes for complex queries.
        // To keep this "Zero Config" friendly, we perform simple queries and merge in JS.
        
        const q1 = query(
            callsRef,
            where('callerId', '==', user.uid),
            orderBy('startedAt', 'desc'),
            limit(20)
        );
            
        const q2 = query(
            callsRef,
            where('calleeId', '==', user.uid),
            orderBy('startedAt', 'desc'),
            limit(20)
        );

        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
        
        const combined = [
            ...snap1.docs.map(d => d.data() as CallSession),
            ...snap2.docs.map(d => d.data() as CallSession)
        ].sort((a, b) => b.startedAt - a.startedAt);

        // Deduplicate if needed (though unlikely with these specific queries unless self-calling)
        const uniqueCalls = combined.filter((v,i,a)=>a.findIndex(v2=>(v2.callId===v.callId))===i);

        setCalls(uniqueCalls);
      } catch (e) {
        console.error("Error fetching calls", e);
      } finally {
        setLoading(false);
      }
    };

    fetchCalls();
  }, [user]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (loading) return <div className="p-4 text-center text-gray-500">Loading history...</div>;

  if (calls.length === 0) {
      return (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <PhoneMissed size={48} className="mb-4 opacity-50"/>
              <p>No recent calls</p>
          </div>
      )
  }

  return (
    <div className="pb-20 pt-4 px-4 space-y-4">
      <h1 className="text-2xl font-bold mb-6">Recents</h1>
      {calls.map((call) => {
        const isIncoming = call.calleeId === user?.uid;
        const isMissed = call.status === CallStatus.MISSED || call.status === CallStatus.REJECTED;
        const otherPartyName = isIncoming ? call.callerName : call.calleeName;
        const otherPartyId = isIncoming ? call.callerId : call.calleeId;
        const otherPartyPhoto = isIncoming ? call.callerPhoto : undefined; // Simplified

        return (
          <div key={call.callId} className="flex items-center justify-between bg-card p-4 rounded-xl shadow-sm border border-gray-800">
            <div className="flex items-center space-x-4">
              <img 
                src={otherPartyPhoto || DEFAULT_AVATAR} 
                className="w-12 h-12 rounded-full bg-gray-700 object-cover"
                alt="Avatar"
              />
              <div>
                <h3 className="font-semibold text-white">{otherPartyName}</h3>
                <div className="flex items-center space-x-2 text-xs text-gray-400">
                  {isIncoming ? (
                      isMissed ? <PhoneMissed size={12} className="text-red-500"/> : <PhoneIncoming size={12} className="text-green-500"/>
                  ) : (
                      <PhoneOutgoing size={12} className="text-blue-500"/>
                  )}
                  <span>{call.type} • {formatTime(call.startedAt)}</span>
                </div>
              </div>
            </div>
            
            <button 
                onClick={() => makeCall(otherPartyId, otherPartyName, CallType.AUDIO)}
                className="p-3 bg-gray-800 rounded-full hover:bg-primary transition-colors"
            >
                <Phone size={18} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default CallHistory;