import React, { useState } from 'react';
import { useCall } from '../context/CallContext';
import { CallType } from '../types';
import { Radio } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// For this demo, we mock a list of "Friends". In a real app, you'd fetch this from Firestore.
const MOCK_FRIENDS = [
    { uid: 'user1', name: 'Alice', photo: 'https://picsum.photos/201' },
    { uid: 'user2', name: 'Bob', photo: 'https://picsum.photos/202' },
    { uid: 'user3', name: 'Charlie', photo: 'https://picsum.photos/203' }
];

const WalkieTalkie: React.FC = () => {
    const { makeCall, endCall } = useCall();
    const { user } = useAuth();
    const [talkingTo, setTalkingTo] = useState<string | null>(null);

    const handleTouchStart = async (friend: typeof MOCK_FRIENDS[0]) => {
        setTalkingTo(friend.uid);
        // Start an audio call immediately
        // In "Ten Ten", this is PTT. We simulate PTT by starting an Audio call.
        // Ideally, the receiver auto-answers.
        await makeCall(friend.uid, friend.name, CallType.PTT);
    };

    const handleTouchEnd = async () => {
        setTalkingTo(null);
        await endCall();
    };

    return (
        <div className="h-full flex flex-col p-6 pb-24">
            <h1 className="text-2xl font-bold mb-6">Walkie Talkie</h1>
            <p className="text-gray-400 mb-8 text-sm">Hold button to speak instantly.</p>

            <div className="grid grid-cols-2 gap-6">
                {MOCK_FRIENDS.map(friend => (
                    <div key={friend.uid} className="flex flex-col items-center">
                        <button
                            onMouseDown={() => handleTouchStart(friend)}
                            onMouseUp={handleTouchEnd}
                            onTouchStart={() => handleTouchStart(friend)}
                            onTouchEnd={handleTouchEnd}
                            className={`w-32 h-32 rounded-3xl mb-3 flex items-center justify-center transition-all duration-100 shadow-2xl ${
                                talkingTo === friend.uid 
                                ? 'bg-accent scale-95 border-4 border-white' 
                                : 'bg-gray-800 border-2 border-gray-700 hover:bg-gray-700'
                            }`}
                        >
                            <img 
                                src={friend.photo} 
                                className={`w-full h-full object-cover rounded-3xl opacity-60 ${talkingTo === friend.uid ? 'opacity-40' : ''}`}
                            />
                            <div className="absolute z-10">
                                {talkingTo === friend.uid ? (
                                    <Radio className="animate-pulse text-white w-12 h-12" />
                                ) : (
                                    <span className="text-xl font-bold drop-shadow-md">{friend.name}</span>
                                )}
                            </div>
                        </button>
                    </div>
                ))}
            </div>

            {talkingTo && (
                <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                    <div className="text-accent font-bold text-4xl animate-pulse">TRANSMITTING...</div>
                </div>
            )}
        </div>
    );
};

export default WalkieTalkie;