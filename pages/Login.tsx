import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { UserCircle2, AlertTriangle } from 'lucide-react';
import { APP_NAME } from '../constants';

const Login: React.FC = () => {
  const { signInAnon } = useAuth();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      await signInAnon(name);
      // Loading handled by global auth state on success
    } catch (err: any) {
      setLoading(false);
      console.error(err);
      
      if (err.code === 'auth/operation-not-allowed') {
        setError('Anonymous login is disabled. Enable it in Firebase Console > Authentication > Sign-in method.');
      } else if (err.code === 'auth/configuration-not-found') {
        setError('Firebase Auth is not enabled. Go to Firebase Console > Authentication and click "Get Started".');
      } else {
        setError('Failed to sign in: ' + (err.message || 'Unknown error'));
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-dark">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <UserCircle2 size={64} className="mx-auto text-primary mb-4" />
          <h2 className="text-3xl font-bold text-white">Join {APP_NAME}</h2>
          <p className="mt-2 text-gray-400">Enter a nickname to start using the walkie-talkie.</p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <input
                type="text"
                required
                className="appearance-none rounded-lg relative block w-full px-3 py-4 border border-gray-700 placeholder-gray-500 text-white bg-secondary focus:outline-none focus:ring-primary focus:border-primary focus:z-10 sm:text-sm text-center text-xl"
                placeholder="Your Nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle className="text-red-500 shrink-0" size={20} />
              <div className="text-sm text-red-200 text-left">
                <p className="font-semibold mb-1">Connection Error</p>
                <p>{error}</p>
              </div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-4 px-4 border border-transparent text-sm font-medium rounded-full text-white bg-primary hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Entering...' : 'Start Talking'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;