package it.justapps.justclip

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service: keeps recording, reading chat and rendering clips
 * while the app is in the background or the screen is off.
 */
class ClipService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }
        val login = intent?.getStringExtra(EXTRA_LOGIN) ?: return START_NOT_STICKY
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()

        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildStatus(Engine.state.value.copy(channel = login)),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
        acquireLocks()
        Engine.onClip = { clip -> notifyClip(clip) }
        Engine.start(this, login, title)

        scope.launch {
            Engine.state
                .map { Triple(it.running, it.bufferedSec / 10, it.clips.count { c -> c.status == ClipStatus.DONE } * 1000 + it.clips.size) }
                .distinctUntilChanged()
                .collectLatest {
                    val s = Engine.state.value
                    getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildStatus(s))
                    if (!s.running && s.error != null) stopEverything()
                }
        }
        return START_REDELIVER_INTENT
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JustClip:recording")
                .apply { setReferenceCounted(false); acquire(12 * 60 * 60 * 1000L) }
        }
        if (wifiLock == null) {
            @Suppress("DEPRECATION")
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "JustClip:stream")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildStatus(s: EngineState): Notification {
        val done = s.clips.count { it.status == ClipStatus.DONE }
        val working = s.clips.count { it.status == ClipStatus.RENDERING || it.status == ClipStatus.WAITING }
        val text = buildString {
            append(getString(R.string.notif_recording, s.channel))
            if (s.bufferedSec > 0) append(" · ${s.bufferedSec}s")
            append(" · ").append(resources.getQuantityString(R.plurals.clips_count, done, done))
            if (working > 0) append(" · ").append(getString(R.string.notif_working, working))
        }
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ClipService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, JustClipApp.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_clip)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .addAction(0, getString(R.string.stop), stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun notifyClip(clip: ClipItem) {
        val uri = clip.outputs[Format.VERTICAL] ?: clip.outputs.values.firstOrNull() ?: return
        val view = PendingIntent.getActivity(
            this, clip.id.toInt(),
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val title = clip.virality?.let { getString(R.string.notif_clip_viral, it.score) } ?: getString(R.string.notif_clip)
        val n = NotificationCompat.Builder(this, JustClipApp.CHANNEL_CLIPS)
            .setSmallIcon(R.drawable.ic_stat_clip)
            .setContentTitle(title)
            .setContentText(clip.samples.take(3).joinToString(" · ").ifBlank { Engine.state.value.channel })
            .setContentIntent(view)
            .setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(1000 + clip.id.toInt(), n)
    }

    private fun stopEverything() {
        Engine.stop()
        wakeLock?.release()
        wakeLock = null
        wifiLock?.release()
        wifiLock = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        Engine.stop()
        wakeLock?.release()
        wifiLock?.release()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "it.justapps.justclip.STOP"
        const val EXTRA_LOGIN = "login"
        const val EXTRA_TITLE = "title"
        private const val NOTIF_ID = 1

        fun start(ctx: Context, login: String, title: String) {
            ctx.startForegroundService(
                Intent(ctx, ClipService::class.java).putExtra(EXTRA_LOGIN, login).putExtra(EXTRA_TITLE, title),
            )
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, ClipService::class.java).setAction(ACTION_STOP))
        }
    }
}
