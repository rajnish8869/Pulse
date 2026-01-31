import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

// Initialize Firebase Admin SDK
// This requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY
// to be set in your Vercel Project Settings (Environment Variables).
if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
      : undefined;

    if (privateKey) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey,
            }),
        });
    } else {
        console.warn("Pulse Backend: Missing Firebase Credentials");
    }
  } catch (error) {
    console.error('Pulse Backend: Firebase admin initialization error', error);
  }
}

const db = admin.firestore();
const messaging = admin.messaging();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Enable CORS for cross-origin requests (essential for mobile apps)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  // Handle Preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 2. Authenticate Request
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    // Validate the Firebase ID Token passed from the client
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const callerUid = decodedToken.uid;

    // 3. Extract Payload
    const { calleeId, callId, callerName } = req.body;

    if (!calleeId || !callId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 4. Retrieve Callee's FCM Tokens
    const userDoc = await db.collection('users').doc(calleeId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const tokens: string[] = userData?.fcmTokens || [];

    if (!tokens.length) {
        console.log(`Pulse Backend: No tokens found for user ${calleeId}`);
        // Return 200 so client doesn't retry, just logs it
        return res.status(200).json({ message: 'User has no registered devices', count: 0 });
    }

    console.log(`Pulse Backend: Waking up ${calleeId} (Caller: ${callerName}) via ${tokens.length} tokens.`);

    // 5. Construct High-Priority Data Message
    // Note: We intentionally do NOT use the 'notification' key. 
    // This ensures it is treated as a Data Message, triggering the app in background/doze.
    const message: admin.messaging.MulticastMessage = {
      tokens: tokens,
      data: {
        type: 'WAKE_UP',
        callId: callId,
        callerName: callerName || 'Unknown',
        callerId: callerUid,
        // Add timestamp to prevent processing old signals
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        ttl: 0, // Time-to-live: 0 means "deliver immediately or drop", vital for real-time calls
      },
      apns: {
        payload: {
          aps: {
            'content-available': 1, // Required for iOS background execution
            priority: '10' // High priority for APNs
          }
        },
        headers: {
            "apns-push-type": "background", // Required for iOS 13+ background tasks
            "apns-priority": "10"
        }
      }
    };

    // 6. Send Multicast
    const response = await messaging.sendEachForMulticast(message);

    // 7. Token Cleanup (Hygiene)
    // Remove stale tokens to keep Firestore clean and messaging efficient
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const errorCode = resp.error.code;
          if (errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-argument') {
            invalidTokens.push(tokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await db.collection('users').doc(calleeId).update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
        });
        console.log(`Pulse Backend: Cleaned up ${invalidTokens.length} stale tokens for ${calleeId}`);
      }
    }

    return res.status(200).json({ 
        success: true, 
        failureCount: response.failureCount,
        successCount: response.successCount 
    });

  } catch (error: any) {
    console.error('Pulse Backend Error:', error);
    // Return detailed error only if needed, usually generic 500 is safer for production
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}