package it.justapps.justclip

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.time.Instant
import java.util.concurrent.TimeUnit

const val API = "https://clip.justapps.it/api"

val http: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .pingInterval(30, TimeUnit.SECONDS)
    .build()

data class ChannelInfo(val login: String, val name: String, val live: Boolean, val title: String, val viewers: Int, val game: String?)

/** "twitch.tv/xqc", "https://www.twitch.tv/xqc?x", "xqc" → "xqc". */
fun parseChannel(input: String): String? {
    val s = input.trim()
    Regex("""^\w{3,25}$""").matchEntire(s)?.let { return s.lowercase() }
    val m = Regex("""twitch\.tv/(?!videos/)(\w{3,25})""", RegexOption.IGNORE_CASE).find(s) ?: return null
    return m.groupValues[1].lowercase()
}

private fun get(url: String): String {
    http.newCall(Request.Builder().url(url).header("user-agent", "JustClip-Android/1.0").build()).execute().use { r ->
        val body = r.body!!.string()
        if (!r.isSuccessful) {
            val err = runCatching { JSONObject(body).optString("error") }.getOrNull()
            throw RuntimeException(err?.ifBlank { null } ?: "HTTP ${r.code}")
        }
        return body
    }
}

private fun getBytes(url: String): ByteArray =
    http.newCall(Request.Builder().url(url).build()).execute().use { r ->
        if (!r.isSuccessful) throw RuntimeException("HTTP ${r.code}")
        r.body!!.bytes()
    }

suspend fun fetchChannel(login: String): ChannelInfo = withContext(Dispatchers.IO) {
    val j = JSONObject(get("$API/twitch/channel/${URLEncoder.encode(login, "UTF-8")}"))
    val live = j.optJSONObject("live")
    ChannelInfo(
        login = j.getString("login"),
        name = j.optString("channel", login),
        live = live != null,
        title = live?.optString("title").orEmpty(),
        viewers = live?.optInt("viewers") ?: 0,
        game = live?.optString("game")?.ifBlank { null },
    )
}

// ---- HLS ---------------------------------------------------------------------

data class Variant(val url: String, val height: Int, val fps: Double, val bandwidth: Long, val audioOnly: Boolean)
data class Segment(val url: String, val seq: Long, val duration: Double, val pdtMs: Long?, val ad: Boolean)

private val ATTR = Regex("""([A-Z0-9-]+)=("([^"]*)"|[^,]*)""")
private fun attrs(line: String) = ATTR.findAll(line).associate { it.groupValues[1] to (it.groupValues[3].ifEmpty { it.groupValues[2] }) }

fun parseMaster(text: String, base: String): List<Variant> {
    val lines = text.lines()
    val out = mutableListOf<Variant>()
    for ((i, l) in lines.withIndex()) {
        if (!l.startsWith("#EXT-X-STREAM-INF:")) continue
        val a = attrs(l)
        val uri = lines.drop(i + 1).firstOrNull { it.isNotBlank() && !it.startsWith("#") } ?: continue
        val res = a["RESOLUTION"]?.split("x")
        val group = a["VIDEO"].orEmpty()
        out += Variant(
            url = java.net.URI(base).resolve(uri.trim()).toString(),
            height = res?.getOrNull(1)?.toIntOrNull() ?: 0,
            fps = a["FRAME-RATE"]?.toDoubleOrNull() ?: 30.0,
            bandwidth = a["BANDWIDTH"]?.toLongOrNull() ?: 0,
            audioOnly = group == "audio_only" || res == null,
        )
    }
    return out
}

fun pickVariant(vs: List<Variant>, maxHeight: Int): Variant? {
    val video = vs.filter { !it.audioOnly && it.height > 0 }
    val fit = video.filter { it.height <= maxHeight }.ifEmpty { video.sortedBy { it.height }.take(1) }
    return fit.sortedWith(compareByDescending<Variant> { it.height }.thenBy { kotlin.math.abs(it.fps - 30) }.thenBy { it.bandwidth }).firstOrNull()
}

fun parseMedia(text: String, base: String): Pair<List<Segment>, Double> {
    val out = mutableListOf<Segment>()
    var seq = 0L
    var target = 2.0
    var dur = 0.0
    var title = ""
    var pdt: Long? = null
    var inAd = false
    for (raw in text.lines()) {
        val l = raw.trim()
        when {
            l.isEmpty() -> {}
            l.startsWith("#EXT-X-MEDIA-SEQUENCE:") -> seq = l.substring(22).toLongOrNull() ?: 0
            l.startsWith("#EXT-X-TARGETDURATION:") -> target = l.substring(22).toDoubleOrNull() ?: target
            l.startsWith("#EXT-X-PROGRAM-DATE-TIME:") -> pdt = runCatching { Instant.parse(l.substring(25)).toEpochMilli() }.getOrNull()
            l.startsWith("#EXT-X-DATERANGE:") -> {
                val a = attrs(l)
                if (Regex("stitched-ad|twitch-ad|amazon", RegexOption.IGNORE_CASE).containsMatchIn("${a["CLASS"]} ${a["ID"]}")) inAd = true
            }
            l.startsWith("#EXT-X-DISCONTINUITY") -> inAd = false
            l.startsWith("#EXTINF:") -> {
                val parts = l.substring(8).split(",", limit = 2)
                dur = parts[0].toDoubleOrNull() ?: 0.0
                title = parts.getOrElse(1) { "" }.trim()
            }
            !l.startsWith("#") -> {
                val ad = inAd || Regex("amazon|adsquared|twitch-ad|stitched", RegexOption.IGNORE_CASE).containsMatchIn(title)
                out += Segment(java.net.URI(base).resolve(l).toString(), seq++, dur, pdt, ad)
                pdt = pdt?.plus((dur * 1000).toLong())
                dur = 0.0
                title = ""
            }
        }
    }
    return out to target
}

/** A recorded piece of the live stream, on disk. */
data class Piece(val file: File, val startMs: Long, val durationMs: Long) {
    val endMs get() = startMs + durationMs
}

/**
 * Follows a Twitch live HLS playlist and keeps the last minutes on disk
 * (a rolling buffer), so clips can be cut after chat reacts.
 */
class LiveRecorder(
    private val login: String,
    private val dir: File,
    private val maxHeight: Int,
    private val bufferMs: Long,
    private val onStatus: (String?) -> Unit,
) {
    private val pieces = ArrayDeque<Piece>()
    private val seen = HashSet<Long>()
    @Volatile var latencyMs = 0L
        private set
    @Volatile var ended = false
        private set
    private var directBlocked = false

    fun available(): Pair<Long, Long> = synchronized(pieces) {
        if (pieces.isEmpty()) 0L to 0L else pieces.first().startMs to pieces.last().endMs
    }

    fun bufferedBytes(): Long = synchronized(pieces) { pieces.sumOf { it.file.length() } }

    /** Pieces overlapping [startMs, endMs]. */
    fun range(startMs: Long, endMs: Long): List<Piece> = synchronized(pieces) {
        pieces.filter { it.endMs > startMs && it.startMs < endMs }
    }

    fun start(scope: CoroutineScope) = scope.launch(Dispatchers.IO) {
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        val master = get("$API/twitch/live-playlist/$login")
        val variant = pickVariant(parseMaster(master, "https://clip.justapps.it/"), maxHeight)
            ?: throw RuntimeException("no_variant")
        var failures = 0
        while (isActive) {
            var wait = 2000L
            try {
                val (segs, target) = parseMedia(get(variant.url), variant.url)
                wait = (target * 500).toLong().coerceAtLeast(1000)
                for (s in segs) {
                    if (!seen.add(s.seq) || s.ad) continue
                    val bytes = download(s.url)
                    val file = File(dir, "seg${s.seq}.ts")
                    file.writeBytes(bytes)
                    val startMs = s.pdtMs ?: (System.currentTimeMillis() - (s.duration * 1000).toLong())
                    val piece = Piece(file, startMs, (s.duration * 1000).toLong())
                    latencyMs = (System.currentTimeMillis() - piece.endMs).coerceAtLeast(0)
                    synchronized(pieces) {
                        pieces.addLast(piece)
                        while (pieces.size > 1 && pieces.first().endMs < piece.endMs - bufferMs) pieces.removeFirst().file.delete()
                    }
                }
                if (seen.size > 5000) seen.retainAll(segs.map { it.seq }.toSet())
                failures = 0
                onStatus(null)
            } catch (e: Exception) {
                failures++
                onStatus(e.message)
                if (failures > 20) {
                    ended = true
                    return@launch
                }
            }
            delay(wait)
        }
    }

    /** CDN first, the edge proxy if the CDN refuses. */
    private fun download(url: String): ByteArray {
        if (!directBlocked) {
            try {
                return getBytes(url)
            } catch (_: Exception) {
                directBlocked = true
            }
        }
        return getBytes("$API/proxy?u=${URLEncoder.encode(url, "UTF-8")}")
    }

    fun clear() = synchronized(pieces) {
        pieces.forEach { it.file.delete() }
        pieces.clear()
    }
}

// ---- Chat ----------------------------------------------------------------------

data class ChatMessage(val tMs: Long, val user: String, val text: String)

private val PRIVMSG = Regex("""^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$""")

fun parseIrc(line: String): ChatMessage? {
    val m = PRIVMSG.matchEntire(line) ?: return null
    val tags = m.groupValues[1].split(';').mapNotNull { kv -> kv.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
    val ts = tags["tmi-sent-ts"]?.toLongOrNull() ?: System.currentTimeMillis()
    return ChatMessage(ts, tags["display-name"]?.ifBlank { null } ?: m.groupValues[2], m.groupValues[3].removePrefix("\u0001ACTION ").removeSuffix("\u0001"))
}

/** Anonymous, read-only Twitch chat. Reconnects on its own. */
class TwitchChat(private val login: String, private val onMessage: (ChatMessage) -> Unit, private val onState: (Boolean) -> Unit) {
    private var ws: WebSocket? = null
    @Volatile private var closed = false
    private var retry = 0

    fun connect() {
        val req = Request.Builder().url("wss://irc-ws.chat.twitch.tv:443").build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0
                webSocket.send("CAP REQ :twitch.tv/tags")
                webSocket.send("PASS SCHMOOPIIE")
                webSocket.send("NICK justinfan${(10000..89999).random()}")
                webSocket.send("JOIN #$login")
                onState(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                for (line in text.split("\r\n")) {
                    if (line.startsWith("PING")) webSocket.send(line.replaceFirst("PING", "PONG"))
                    else parseIrc(line)?.let(onMessage)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = reconnect()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = reconnect()
        })
    }

    private fun reconnect() {
        onState(false)
        if (closed) return
        val wait = minOf(30_000L, 1000L shl minOf(retry++, 5))
        Thread {
            Thread.sleep(wait)
            if (!closed) connect()
        }.start()
    }

    fun close() {
        closed = true
        ws?.close(1000, null)
    }
}
