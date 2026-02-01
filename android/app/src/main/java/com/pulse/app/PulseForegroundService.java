package com.pulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

// Explicit import to ensure correct resource resolution
import com.pulse.app.R;

public class PulseForegroundService extends Service {

    private static final String CHANNEL_ID = "PulseConnectionChannel";
    private static final int NOTIFICATION_ID = 12345;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {

        String contentText = "Listening for incoming transmissions...";

        if (intent != null && intent.hasExtra("callerName")) {
            contentText = "Incoming signal from " + intent.getStringExtra("callerName");
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        // PendingIntent.FLAG_IMMUTABLE is required for Android 12+
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent fullScreenIntent = PendingIntent.getActivity(
                this,
                1,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Ensure the icon exists and is valid. We use the one defined in R.drawable.ic_call_notification.
        // If this fails (e.g. build issue), the system might fallback to app icon which causes crashes if adaptive.
        // Using a try-catch block for safety during debugging, though the resource must exist.
        int iconResId = R.drawable.ic_call_notification;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Pulse Incoming")
                .setContentText(contentText)
                .setSmallIcon(iconResId)
                .setContentIntent(contentIntent)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true);

        // Fullscreen intent is key for lock screen visibility
        if (fullScreenIntent != null) {
            builder.setFullScreenIntent(fullScreenIntent, true);
        }

        Notification notification = builder.build();

        // Start Foreground Service
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            e.printStackTrace();
            // Fallback attempt without specific type if it fails
            try {
                startForeground(NOTIFICATION_ID, notification);
            } catch (Exception ex) {
                ex.printStackTrace();
                // If we can't start foreground, we must stop to prevent ANR/Crash
                stopSelf();
            }
        }

        acquireWakeLock();

        return START_STICKY;
    }

    private void acquireWakeLock() {
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);

        if (powerManager != null) {
            if (wakeLock == null) {
                wakeLock = powerManager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "Pulse::ForegroundAudioLock"
                );
                wakeLock.setReferenceCounted(false);
            }

            if (!wakeLock.isHeld()) {
                wakeLock.acquire(10 * 60 * 1000L); // 10 min safety timeout
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {

            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Pulse Call Service",
                    NotificationManager.IMPORTANCE_HIGH
            );

            channel.setDescription("Incoming call notifications for Pulse");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.setBypassDnd(true);
            
            // Sound/Vibration can be set here if needed, but we rely on the app playing audio
            // channel.enableVibration(true);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}