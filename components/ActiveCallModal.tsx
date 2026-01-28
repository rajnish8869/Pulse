import React, { useEffect, useRef, useState } from 'react';
import { useCall } from '../context/CallContext';
import { CallStatus, CallType } from '../types';
import { PhoneOff, Phone, Mic, MicOff, Video, VideoOff, Maximize2 } from 'lucide-react';

const ActiveCallModal: React.FC = () => {
  const { 
    activeCall, incomingCall, callStatus, 
    answerCall, rejectCall, endCall, 
    remoteStream, localStream 
  } = useCall();

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [callTime, setCallTime] = useState(0);

  useEffect(() => {
    let interval: any;
    if (callStatus === CallStatus.CONNECTED) {
        interval = setInterval(() => {
            setCallTime(prev => prev + 1);
        }, 1000);
    } else {
        setCallTime(0);
    }
    return () => clearInterval(interval);
  }, [callStatus]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.muted = true; 
    }
  }, [remoteStream, localStream, callStatus]);

  const formatTime = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (incomingCall?.type === CallType.PTT || activeCall?.type === CallType.PTT) return null;
  if (!incomingCall && (!activeCall || callStatus === CallStatus.ENDED)) return null;

  // Incoming Call View
  if (incomingCall) {
    return (
      <div className="fixed inset-0 z-[60] bg-dark/95 backdrop-blur-xl flex flex-col items-center justify-between py-24 px-8 animate-in fade-in duration-300">
        <div className="text-center space-y-6">
          <div className="w-32 h-32 rounded-full bg-gray-800 mx-auto overflow-hidden border-4 border-primary/30 shadow-[0_0_30px_rgba(59,130,246,0.2)]">
             {incomingCall.callerPhoto ? (
                <img src={incomingCall.callerPhoto} className="w-full h-full object-cover" />
             ) : (
                <div className="w-full h-full flex items-center justify-center text-4xl bg-gradient-to-br from-primary/20 to-accent/20">?</div>
             )}
          </div>
          <div>
              <h2 className="text-3xl font-black tracking-tight">{incomingCall.callerName}</h2>
              <p className="text-primary font-bold tracking-[0.2em] mt-2 animate-pulse text-xs uppercase">Incoming {incomingCall.type} Call</p>
          </div>
        </div>

        <div className="flex gap-10">
          <button 
            onClick={rejectCall}
            className="w-20 h-20 rounded-full bg-red-500 flex items-center justify-center shadow-2xl shadow-red-500/20 active:scale-90 transition-transform"
          >
            <PhoneOff className="text-white" size={32} />
          </button>
          <button 
            onClick={answerCall}
            className="w-20 h-20 rounded-full bg-green-500 flex items-center justify-center shadow-2xl shadow-green-500/20 active:scale-90 transition-transform animate-bounce"
          >
            <Phone className="text-white" size={32} />
          </button>
        </div>
      </div>
    );
  }

  // Active Call View
  const isVideo = activeCall?.type === CallType.VIDEO;

  return (
    <div className="fixed inset-0 z-[60] bg-dark flex flex-col overflow-hidden animate-in slide-in-from-bottom duration-500">
      <div className="flex-1 relative bg-black">
        {isVideo ? (
            <>
                <video 
                    ref={remoteVideoRef} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-cover"
                />
                <div className="absolute top-10 right-4 w-28 h-40 bg-gray-800 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl z-10">
                    <video 
                        ref={localVideoRef} 
                        autoPlay 
                        playsInline 
                        className="w-full h-full object-cover"
                    />
                </div>
            </>
        ) : (
             <div className="absolute inset-0 flex flex-col items-center justify-center space-y-8 bg-gradient-to-b from-dark to-secondary/20">
                <div className="w-40 h-40 rounded-full bg-gray-800 border-4 border-primary/40 flex items-center justify-center overflow-hidden shadow-[0_0_50px_rgba(59,130,246,0.15)]">
                    {activeCall?.callerPhoto ? (
                        <img src={activeCall.callerPhoto} className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full bg-gradient-to-tr from-primary/10 to-accent/10"></div>
                    )}
                </div>
                <div className="text-center">
                    <h2 className="text-3xl font-black text-white">{activeCall?.calleeName || activeCall?.callerName}</h2>
                    <p className={`mt-3 font-mono text-sm tracking-widest ${callStatus === CallStatus.CONNECTED ? 'text-green-400' : 'text-primary animate-pulse'}`}>
                        {callStatus === CallStatus.CONNECTED ? formatTime(callTime) : "ESTABLISHING LINK..."}
                    </p>
                </div>
                <audio ref={remoteVideoRef as any} autoPlay /> 
             </div>
        )}

        {/* Top Header Info for Video */}
        {isVideo && (
            <div className="absolute top-10 left-4 z-10 flex flex-col">
                <span className="text-white font-black text-lg drop-shadow-md">{activeCall?.calleeName || activeCall?.callerName}</span>
                <span className="text-green-400 font-mono text-xs drop-shadow-md">{formatTime(callTime)}</span>
            </div>
        )}
      </div>

      {/* Control Bar */}
      <div className="h-32 bg-secondary/80 backdrop-blur-md flex items-center justify-around px-10 pb-6 rounded-t-[3rem] border-t border-white/5">
         <button 
            onClick={() => setMicEnabled(!micEnabled)}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${micEnabled ? 'bg-white/10 text-white' : 'bg-white text-dark'}`}
         >
            {micEnabled ? <Mic size={24}/> : <MicOff size={24}/>}
         </button>

         <button 
            onClick={endCall}
            className="w-20 h-20 rounded-full bg-red-600 flex items-center justify-center shadow-xl shadow-red-600/30 active:scale-95 transition-transform"
         >
            <PhoneOff className="text-white" size={32} />
         </button>

         <button 
            className="w-14 h-14 rounded-full bg-white/10 text-white/40 flex items-center justify-center"
            disabled
         >
             {isVideo ? <Video size={24}/> : <VideoOff size={24}/>}
         </button>
      </div>
    </div>
  );
};

export default ActiveCallModal;