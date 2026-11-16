package it.justapps.justclip

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class JustClipApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, getString(R.string.channel_service), NotificationManager.IMPORTANCE_LOW),
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CLIPS, getString(R.string.channel_clips), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    companion object {
        const val CHANNEL_SERVICE = "recording"
        const val CHANNEL_CLIPS = "clips"
    }
}
