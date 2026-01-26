import React, { useEffect, useRef } from 'react';
import { useCall } from '../context/CallContext';
import { CallStatus, CallType } from '../types';
import { PhoneOff, Phone, Mic, MicOff, Video, VideoOff } from 'lucide-react';

const ActiveCallModal: React.FC = () => {
  const { 
    activeCall, incomingCall, callStatus, 
    answerCall, rejectCall, endCall, 
    remoteStream, localStream 
  } = useCall();

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [micEnabled, setMicEnabled] = React.useState(true);

  // Attach streams to video elements
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      // Mute local video to prevent feedback
      localVideoRef.current.muted = true; 
    }
  }, [remoteStream, localStream, callStatus]);

  if (!incomingCall && (!activeCall || callStatus === CallStatus.ENDED)) {
    return null;
  }

  // Incoming Call Screen
  if (incomingCall) {
    return (
      <div className="fixed inset-0 z-50 bg-dark/95 flex flex-col items-center justify-center space-y-8 animate-in fade-in">
        <div className="text-center space-y-4">
          <div className="w-24 h-24 rounded-full bg-gray-700 mx-auto overflow-hidden border-4 border-gray-600">
             {incomingCall.callerPhoto ? (
                <img src={incomingCall.callerPhoto} className="w-full h-full object-cover" />
             ) : (
                <div className="w-full h-full flex items-center justify-center text-3xl">?</div>
             )}
          </div>
          <h2 className="text-2xl font-bold">{incomingCall.callerName}</h2>
          <p className="text-gray-400">Incoming {incomingCall.type} Call...</p>
        </div>

        <div className="flex gap-8">
          <button 
            onClick={rejectCall}
            className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          >
            <PhoneOff className="text-white" size={32} />
          </button>
          <button 
            onClick={answerCall}
            className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center shadow-lg active:scale-95 transition-transform animate-bounce"
          >
            <Phone className="text-white" size={32} />
          </button>
        </div>
      </div>
    );
  }

  // Active Call Screen
  const isVideo = activeCall?.type === CallType.VIDEO;

  return (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      {/* Video Area */}
      <div className="flex-1 relative bg-black">
        {isVideo && (
            <>
                <video 
                    ref={remoteVideoRef} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-cover"
                />
                <div className="absolute top-4 right-4 w-32 h-48 bg-gray-800 rounded-lg overflow-hidden border-2 border-gray-700 shadow-xl">
                    <video 
                        ref={localVideoRef} 
                        autoPlay 
                        playsInline 
                        className="w-full h-full object-cover"
                    />
                </div>
            </>
        )}

        {!isVideo && (
             <div className="absolute inset-0 flex flex-col items-center justify-center space-y-6">
                <div className="w-32 h-32 rounded-full bg-gray-700 border-4 border-primary flex items-center justify-center overflow-hidden">
                    {/* Placeholder for audio visualization */}
                    <div className="animate-pulse w-full h-full bg-primary/20"></div>
                </div>
                <div className="text-center">
                    <h2 className="text-2xl font-bold text-white">{activeCall?.calleeName || activeCall?.callerName}</h2>
                    <p className="text-green-400 font-mono mt-2">
                        {callStatus === CallStatus.CONNECTED ? "00:00" : "Connecting..."}
                    </p>
                </div>
                {/* Audio elements needed for audio-only calls even if no video UI */}
                <audio ref={remoteVideoRef as any} autoPlay /> 
             </div>
        )}
      </div>

      {/* Controls */}
      <div className="h-24 bg-secondary flex items-center justify-center gap-6 pb-4 rounded-t-3xl">
         <button 
            onClick={() => setMicEnabled(!micEnabled)}
            className={`p-4 rounded-full ${micEnabled ? 'bg-gray-700' : 'bg-white text-black'}`}
         >
            {micEnabled ? <Mic size={24}/> : <MicOff size={24}/>}
         </button>

         <button 
            onClick={endCall}
            className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
         >
            <PhoneOff className="text-white" size={32} />
         </button>

         <button 
            className="p-4 rounded-full bg-gray-700 text-gray-400"
            disabled
         >
             {isVideo ? <Video size={24}/> : <VideoOff size={24}/>}
         </button>
      </div>
    </div>
  );
};

export default ActiveCallModal;