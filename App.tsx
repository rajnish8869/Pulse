
import React, { useState, useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { CallProvider, useCall } from './context/CallContext';
import Login from './pages/Login';
import BottomNav from './components/BottomNav';
import CallHistory from './pages/CallHistory';
import WalkieTalkie from './pages/WalkieTalkie';
import Contacts from './pages/Contacts';
import ActiveCallModal from './components/ActiveCallModal';
import { User, LogOut } from 'lucide-react';

const GlobalAudioSink: React.FC = () => {
  const { remoteAudioRef } = useCall();
  return (
    <audio 
      ref={remoteAudioRef} 
      autoPlay 
      playsInline 
      className="hidden" 
      aria-hidden="true"
    />
  );
};

const AppContent: React.FC = () => {
  const { user, loading, signOut } = useAuth();
  const [page, setPage] = useState('ptt'); // Default to PTT for Ten Ten feel

  useEffect(() => {
      const handleBack = (e: PopStateEvent) => {
          if (page !== 'ptt') {
              setPage('ptt');
          }
      };
      window.addEventListener('popstate', handleBack);
      return () => window.removeEventListener('popstate', handleBack);
  }, [page]);

  if (loading) return <div className="h-screen flex items-center justify-center bg-dark text-white font-sans">Loading Pulse...</div>;
  if (!user) return <Login />;

  const handleSignOut = () => {
      signOut();
      window.location.reload();
  };

  const renderPage = () => {
    switch (page) {
      case 'calls': return <CallHistory />;
      case 'ptt': return <WalkieTalkie />;
      case 'contacts': return <Contacts />;
      case 'profile': return (
        <div className="p-6 text-center pt-20">
            <div className="w-24 h-24 bg-gray-700 rounded-full mx-auto mb-4 flex items-center justify-center overflow-hidden border-4 border-gray-600">
                {user.photoURL ? (
                    <img src={user.photoURL} className="w-full h-full object-cover" />
                ) : (
                    <User size={40}/>
                )}
            </div>
            <h2 className="text-xl font-bold text-white">{user.displayName}</h2>
            <p className="text-sm text-gray-500 mb-8">{user.email}</p>
            
            <div className="space-y-4">
                <button onClick={handleSignOut} className="w-full py-3 rounded-lg bg-gray-800 text-white flex items-center justify-center gap-2 hover:bg-red-900/50 transition-colors">
                    <LogOut size={18} />
                    Sign Out
                </button>
            </div>
        </div>
      );
      default: return <WalkieTalkie />;
    }
  };

  return (
    <div className="bg-dark h-screen text-white font-sans overflow-hidden">
      <CallProvider>
        <div className="w-full h-full relative">
          <GlobalAudioSink />
          {renderPage()}
          <BottomNav currentPage={page} onNavigate={setPage} />
          <ActiveCallModal />
        </div>
      </CallProvider>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
