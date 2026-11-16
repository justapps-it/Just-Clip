package it.justapps.justclip

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class ClipStatus { WAITING, RENDERING, DONE, ERROR }

data class ClipItem(
    val id: Long,
    val atMs: Long,
    val virality: Virality?,
    val manual: Boolean,
    val status: ClipStatus,
    val outputs: Map<Format, Uri> = emptyMap(),
    val error: String? = null,
    val samples: List<String> = emptyList(),
)

data class EngineState(
    val running: Boolean = false,
    val channel: String = "",
    val title: String = "",
    val chatConnected: Boolean = false,
    val messages: Int = 0,
    val bufferedSec: Int = 0,
    val bufferedMb: Double = 0.0,
    val status: String? = null,
    val activity: List<Double> = emptyList(),
    val clips: List<ClipItem> = emptyList(),
    val error: String? = null,
)

/**
 * The clipping engine, owned by [ClipService] so it keeps running with the
 * app in the background. The UI observes [state].
 */
object Engine {
    private val _state = MutableStateFlow(EngineState())
    val state: StateFlow<EngineState> = _state

    private var scope: CoroutineScope? = null
    private var recorder: LiveRecorder? = null
    private var chat: TwitchChat? = null
    private var detector: LiveDetector? = null
    private val messages = ArrayDeque<ChatMessage>()
    private val queue = Channel<Long>(Channel.UNLIMITED)
    private var seq = 0L
    private lateinit var settings: Settings

    /** Called with each finished clip (for notifications). */
    var onClip: ((ClipItem) -> Unit)? = null

    fun start(ctx: Context, login: String, title: String) {
        stop()
        settings = Settings.load(ctx)
        val app = ctx.applicationContext
        val sc = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        scope = sc
        messages.clear()
        _state.value = EngineState(running = true, channel = login, title = title, clips = _state.value.clips)

        val rec = LiveRecorder(login, File(app.cacheDir, "live"), settings.quality, settings.bufferMinutes * 60_000L) { s ->
            _state.update { it.copy(status = s) }
        }
        recorder = rec
        rec.start(sc).invokeOnCompletion { e ->
            if (e != null && e !is kotlinx.coroutines.CancellationException) _state.update { it.copy(error = e.message, running = false) }
        }

        val det = LiveDetector(settings.sensitivity, settings.before + settings.after)
        detector = det
        chat = TwitchChat(login, { m ->
            det.add(m)
            synchronized(messages) {
                messages.addLast(m)
                while (messages.size > 30_000) messages.removeFirst()
            }
            _state.update { it.copy(messages = it.messages + 1) }
        }, { ok -> _state.update { it.copy(chatConnected = ok) } }).also { it.connect() }

        // Detection loop.
        sc.launch {
            while (isActive) {
                delay(1000)
                val now = System.currentTimeMillis()
                det.poll(now / 1000)?.let { peak -> addMoment(peak.tSec * 1000, peak.z, manual = false) }
                val (a, b) = rec.available()
                val series = det.series(now / 1000, 600)
                _state.update {
                    it.copy(
                        bufferedSec = ((b - a) / 1000).toInt(),
                        bufferedMb = rec.bufferedBytes() / 1_048_576.0,
                        activity = series.toList().chunked(10) { c -> c.sum() },
                    )
                }
            }
        }

        // Render queue: one clip at a time.
        sc.launch {
            for (id in queue) runCatching { renderOne(app, id) }.onFailure { e ->
                setClip(id) { it.copy(status = ClipStatus.ERROR, error = e.message ?: e.javaClass.simpleName) }
            }
        }
    }

    /** "Clip it" button: the last moments of the stream. */
    fun clipNow() {
        val rec = recorder ?: return
        val end = rec.available().second
        if (end == 0L) return
        addMoment(end - settings.after * 1000L + rec.latencyMs, 0.0, manual = true)
    }

    private fun addMoment(chatPeakMs: Long, z: Double, manual: Boolean) {
        val snapshot = synchronized(messages) { messages.toList() }
        val dur = (settings.before + settings.after).toDouble()
        val v = if (manual) null else virality(snapshot, chatPeakMs, z, dur)
        val samples = snapshot.filter { it.tMs in (chatPeakMs - 6000)..(chatPeakMs + 6000) }
            .groupingBy { it.text.trim() }.eachCount().entries.sortedByDescending { it.value }.take(4).map { it.key.take(40) }
        val item = ClipItem(++seq, chatPeakMs, v, manual, ClipStatus.WAITING, samples = samples)
        _state.update { it.copy(clips = listOf(item) + it.clips) }
        queue.trySend(item.id)
    }

    private fun setClip(id: Long, f: (ClipItem) -> ClipItem) =
        _state.update { s -> s.copy(clips = s.clips.map { if (it.id == id) f(it) else it }) }

    private suspend fun renderOne(ctx: Context, id: Long) {
        val rec = recorder ?: return
        val item = _state.value.clips.firstOrNull { it.id == id } ?: return
        // Chat reacts to what viewers see, which lags behind the stream.
        val peak = item.atMs - rec.latencyMs
        val startMs = peak - settings.before * 1000L
        val endMs = peak + settings.after * 1000L
        // Wait until the end of the clip has been recorded.
        while (rec.available().second < endMs) {
            if (rec.ended) throw RuntimeException("stream ended")
            delay(1000)
        }
        setClip(id) { it.copy(status = ClipStatus.RENDERING) }
        val pieces = rec.range(startMs, endMs)
        if (pieces.isEmpty()) throw RuntimeException("out of buffer")
        val input = File(ctx.cacheDir, "clip-$id.ts")
        withContext(Dispatchers.IO) {
            input.outputStream().use { out -> pieces.forEach { p -> p.file.inputStream().use { it.copyTo(out) } } }
        }
        val offset = (startMs - pieces.first().startMs).coerceAtLeast(0)
        val job = RenderJob(input, offset, offset + (endMs - startMs), settings, if (settings.hookTitle) item.virality?.hook else null)
        val outputs = linkedMapOf<Format, Uri>()
        try {
            val formats = buildList {
                if (settings.horizontal) add(Format.HORIZONTAL)
                if (settings.vertical || isEmpty()) add(Format.VERTICAL)
            }
            for (format in formats) {
                val tmp = File(ctx.cacheDir, "out-$id-${format.name.lowercase()}.mp4")
                Renderer.render(ctx, job, format, tmp)
                outputs[format] = withContext(Dispatchers.IO) { saveToGallery(ctx, tmp, item, format) }
                tmp.delete()
            }
        } finally {
            input.delete()
        }
        setClip(id) { it.copy(status = ClipStatus.DONE, outputs = outputs) }
        _state.value.clips.firstOrNull { it.id == id }?.let { onClip?.invoke(it) }
    }

    private fun saveToGallery(ctx: Context, file: File, item: ClipItem, format: Format): Uri {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(item.atMs))
        val name = "${_state.value.channel}-$stamp-${if (format == Format.VERTICAL) "9x16" else "16x9"}.mp4"
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/JustClip")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: throw RuntimeException("gallery")
        resolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
        return uri
    }

    fun stop() {
        chat?.close()
        chat = null
        scope?.cancel()
        scope = null
        recorder?.clear()
        recorder = null
        _state.update { it.copy(running = false, chatConnected = false) }
    }
}
