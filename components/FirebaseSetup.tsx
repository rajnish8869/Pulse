import React, { useState } from 'react';
import { saveConfig } from '../services/firebase';
import { Flame, CheckCircle2, AlertCircle } from 'lucide-react';

export const FirebaseSetup: React.FC = () => {
    const [jsonInput, setJsonInput] = useState('');
    const [error, setError] = useState('');

    const handleSave = () => {
        try {
            let cleanJson = jsonInput.trim();
            
            // Heuristic to extract object if user pastes full JS code
            const firstBrace = cleanJson.indexOf('{');
            const lastBrace = cleanJson.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
            }

            let config;
            try {
                config = JSON.parse(cleanJson);
            } catch (e) {
                // Fallback: try parsing as JS object (for keys without quotes)
                // eslint-disable-next-line no-new-func
                config = new Function(`return ${cleanJson}`)();
            }

            if (!config || !config.apiKey) {
                throw new Error("Invalid configuration object. Missing apiKey.");
            }

            saveConfig(config);
        } catch (e) {
            setError('Could not parse configuration. Please ensure it is a valid JSON object.');
        }
    };

    return (
        <div className="min-h-screen bg-dark text-white flex flex-col items-center justify-center p-6">
            <div className="max-w-lg w-full bg-secondary p-8 rounded-2xl shadow-2xl border border-gray-700">
                <div className="flex items-center justify-center mb-6">
                    <div className="w-16 h-16 bg-orange-500/20 rounded-full flex items-center justify-center">
                         <Flame className="text-orange-500 w-8 h-8" />
                    </div>
                </div>
                <h1 className="text-2xl font-bold text-center mb-2">Connect to Firebase</h1>
                <p className="text-gray-400 text-center mb-6 text-sm">
                    This app requires a Firebase project to function.
                </p>

                <ol className="list-decimal list-inside text-sm text-gray-400 mb-6 space-y-2">
                    <li>Go to <a href="https://console.firebase.google.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">Firebase Console</a>.</li>
                    <li>Create a free project.</li>
                    <li>Add a <strong>Web App</strong>.</li>
                    <li>Copy the <code>firebaseConfig</code> object.</li>
                </ol>

                <textarea 
                    className="w-full h-48 bg-dark border border-gray-700 rounded-lg p-4 font-mono text-xs text-gray-300 focus:ring-2 focus:ring-primary outline-none resize-none mb-4"
                    placeholder={`{
  apiKey: "AIzaSy...",
  authDomain: "...",
  projectId: "...",
  ...
}`}
                    value={jsonInput}
                    onChange={(e) => setJsonInput(e.target.value)}
                />

                {error && (
                    <div className="flex items-center gap-2 text-red-400 text-sm mb-4 bg-red-400/10 p-3 rounded-lg">
                        <AlertCircle size={16} />
                        {error}
                    </div>
                )}

                <button 
                    onClick={handleSave}
                    className="w-full py-3 bg-primary hover:bg-blue-600 rounded-lg font-bold transition-colors flex items-center justify-center gap-2"
                >
                    <CheckCircle2 size={18} />
                    Save & Restart
                </button>
            </div>
        </div>
    );
};