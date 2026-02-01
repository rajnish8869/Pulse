package com.pulse.app;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class PulseFirebaseMessagingService extends FirebaseMessagingService {

    private static final String TAG = "PulseFCM";

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        if (remoteMessage.getData().isEmpty()) {
            return;
        }

        String type = remoteMessage.getData().get("type");

        if (!"WAKE_UP".equals(type)) {
            return;
        }

        Log.d(TAG, "WAKE_UP signal received via FCM");

        String callerName = remoteMessage.getData().get("callerName");

        Intent serviceIntent = new Intent(this, PulseForegroundService.class);
        serviceIntent.setAction("WAKE_UP");

        if (callerName != null) {
            serviceIntent.putExtra("callerName", callerName);
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to start PulseForegroundService", e);
        }
    }

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        Log.d(TAG, "FCM token refreshed: " + token);
        // TODO: send token to backend if needed
    }
}
