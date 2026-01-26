import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { CallProvider } from './context/CallContext';
import { db } from './services/firebase';
import Login from './pages/Login';
import BottomNav from './components/BottomNav';
import CallHistory from './pages/CallHistory';
import WalkieTalkie from './pages/WalkieTalkie';
import ActiveCallModal from './components/ActiveCallModal';
import { FirebaseSetup } from './components/FirebaseSetup';
import { User, LogOut } from 'lucide-react';

const AppContent: React.FC = () => {
  const { user, loading, signOut } = useAuth();
  const [page, setPage] = useState('calls');

  if (loading) return <div className="h-screen flex items-center justify-center bg-dark text-white">Loading...</div>;
  if (!user) return <Login />;

  const handleSignOut = () => {
      signOut();
      window.location.reload();
  };

  const renderPage = () => {
    switch (page) {
      case 'calls': return <CallHistory />;
      case 'ptt': return <WalkieTalkie />;
      case 'contacts': return <div className="p-6 text-center text-gray-400">Contacts List Placeholder</div>;
      case 'profile': return (
        <div className="p-6 text-center">
            <div className="w-24 h-24 bg-gray-700 rounded-full mx-auto mb-4 flex items-center justify-center">
                <User size={40}/>
            </div>
            <h2 className="text-xl font-bold text-white">{user.displayName}</h2>
            <p className="text-sm text-gray-500 mb-8">UID: {user.uid.substring(0,8)}...</p>
            
            <div className="space-y-4">
                <button onClick={handleSignOut} className="w-full py-3 rounded-lg bg-gray-800 text-white flex items-center justify-center gap-2">
                    <LogOut size={18} />
                    Sign Out
                </button>
            </div>
        </div>
      );
      default: return <CallHistory />;
    }
  };

  return (
    <div className="bg-dark min-h-screen text-white font-sans">
      <CallProvider>
        <div className="max-w-md mx-auto min-h-screen relative shadow-2xl bg-secondary/50">
          {renderPage()}
          <BottomNav currentPage={page} onNavigate={setPage} />
          <ActiveCallModal />
        </div>
      </CallProvider>
    </div>
  );
};

const App: React.FC = () => {
  if (!db) {
    return <FirebaseSetup />;
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;