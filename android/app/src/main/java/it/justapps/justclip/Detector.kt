package it.justapps.justclip

import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// Same model as the web app (src/lib/peaks.ts and src/lib/virality.ts):
// moments are bursts of chat volume or of reactions, scored for virality.

private val HYPE = setOf(
    "lul", "lol", "lmao", "lmfao", "kekw", "kek", "omegalul", "icant", "xd", "xdd", "haha", "hahaha", "ahah", "jaja",
    "pog", "pogchamp", "poggers", "pogu", "w", "ww", "www", "holy", "wtf", "omg", "clip", "clipit", "insane", "gg", "ez",
    "rip", "wow", "letsgo", "goat", "aura", "nooo", "what", "bruh", "madonna", "assurdo", "pazzesco", "clippa", "oddio",
)
private val HYPE_RE = Regex("""^(a?ha){2,}h?$|^(ja){2,}$|^x+d+$|^l+u+l+$|^w{2,}$|^no{3,}$""")
private val HYPE_EMOJI = Regex("[😂🤣💀🔥😱😭🤯👀💯😳]")
private val WORD_SPLIT = Regex("""[^\p{L}\p{N}]+""")

fun messageWeight(text: String): Double {
    val m = text.trim()
    if (m.isEmpty()) return 0.0
    var w = 1.0
    val words = m.lowercase().split(WORD_SPLIT).filter { it.isNotEmpty() }
    if (words.any { it in HYPE || HYPE_RE.matches(it) }) w += 1
    if (HYPE_EMOJI.containsMatchIn(m)) w += 0.5
    if (Regex("[!?]{2,}").containsMatchIn(m)) w += 0.5
    val letters = m.filter { it.isLetter() }
    if (letters.length >= 4 && letters == letters.uppercase() && letters != letters.lowercase()) w += 0.5
    return min(w, 3.0)
}

private fun median(a: DoubleArray): Double {
    if (a.isEmpty()) return 0.0
    val s = a.sortedArray()
    val m = s.size / 2
    return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
}

private fun smooth(s: DoubleArray, w: Int): DoubleArray {
    val out = DoubleArray(s.size)
    val half = w / 2
    var acc = 0.0
    for (i in 0 until s.size + half) {
        if (i < s.size) acc += s[i]
        if (i - w >= 0) acc -= s[i - w]
        val j = i - half
        if (j in s.indices) out[j] = acc
    }
    return out
}

private fun zScore(s: DoubleArray, i: Int, from: Int, floor: Double): Double {
    val sample = ArrayList<Double>()
    var j = from
    while (j < s.size) {
        if (abs(j - i) > 15) sample += s[j]
        j += 2
    }
    if (sample.size < 10) return 0.0
    val arr = sample.toDoubleArray()
    val base = median(arr)
    val mad = median(arr.map { abs(it - base) }.toDoubleArray()) * 1.4826
    return (s[i] - base) / max(mad, floor)
}

data class Peak(val tSec: Long, val z: Double)

/** Online detector: feed messages, poll every second, get a peak when a burst is over. */
class LiveDetector(private val sensitivity: Sensitivity, private val minGap: Int) {
    private val count = HashMap<Long, Double>()
    private val hype = HashMap<Long, Double>()
    private val weighted = HashMap<Long, Double>()
    private var firstAt = Long.MAX_VALUE
    private var lastPeakAt = Long.MIN_VALUE / 2
    private var best: Peak? = null
    private var bestScore = 0.0

    @Synchronized
    fun add(m: ChatMessage) {
        val sec = m.tMs / 1000
        if (sec < firstAt) firstAt = sec
        val w = messageWeight(m.text)
        count.merge(sec, 1.0, Double::plus)
        weighted.merge(sec, w, Double::plus)
        if (w > 1) hype.merge(sec, 1.0, Double::plus)
    }

    /** Weighted activity per second for the last [seconds] (for the UI). */
    @Synchronized
    fun series(nowSec: Long, seconds: Int): DoubleArray = DoubleArray(seconds) { weighted[nowSec - seconds + it] ?: 0.0 }

    @Synchronized
    fun poll(nowSec: Long): Peak? {
        val win = 300
        val smoothW = 10
        val end = nowSec - smoothW / 2
        val t0 = end - win
        for (map in listOf(count, hype, weighted)) map.keys.removeAll { it < t0 - 120 }
        if (end - firstAt < 90) return null
        val c = DoubleArray(win + 1) { count[t0 + it] ?: 0.0 }
        val h = DoubleArray(win + 1) { hype[t0 + it] ?: 0.0 }
        val vol = smooth(c, smoothW)
        val hs = smooth(h, smoothW)
        val ratio = DoubleArray(vol.size) { hs[it] / (vol[it] + 4) }
        val i = win
        val from = max(0L, firstAt - t0).toInt()
        val z = if (hs[i] >= 3) {
            val zv = zScore(vol, i, from, sqrt(max(1.0, vol[i])))
            val zr = zScore(ratio, i, from, 0.03)
            max(zv, zr) + 0.35 * max(0.0, min(zv, zr))
        } else 0.0
        val th = sensitivity.z
        if (z >= th && end - lastPeakAt >= minGap) {
            val score = z * ln(2 + hs[i])
            if (best == null || score > bestScore) {
                best = Peak(end, z)
                bestScore = score
            }
            return null
        }
        val b = best
        if (b != null && (z < th * 0.6 || end - b.tSec > 20)) {
            best = null
            lastPeakAt = b.tSec
            return b
        }
        return null
    }
}

// ---- Virality ------------------------------------------------------------------

enum class Emotion { LAUGH, HYPE, SHOCK, CLIP }

private val EMOTION_WORDS = mapOf(
    Emotion.LAUGH to Regex("""^(lol+|lmao+|lmfao+|kekw|kek|omegalul|icant|xd+|l+u+l+|(a?ha){2,}h?|(ja){2,}|rofl|dead|morto)$"""),
    Emotion.HYPE to Regex("""^(pog|pogchamp|poggers|pogu|w+|letsgo+|lets|goat|insane|clean|massive|huge|aura|ez|gg|fire|cinema|peak)$"""),
    Emotion.SHOCK to Regex("""^(wtf|omg|omfg|what|huh|no+|holy|bruh|wait|nah|yo+|madonna|oddio|cosa|bro)$"""),
    Emotion.CLIP to Regex("""^(clip|clipit|clipped|clippa|clippate|clipper)$"""),
)
private val EMOTION_EMOJI = mapOf(
    Emotion.LAUGH to Regex("[😂🤣💀😭]"),
    Emotion.HYPE to Regex("[🔥💯🐐🚀👑]"),
    Emotion.SHOCK to Regex("[😱🤯😳😮👀]"),
)

private fun emotionsOf(text: String): Set<Emotion> {
    val words = text.lowercase().split(WORD_SPLIT).filter { it.isNotEmpty() }
    val out = HashSet<Emotion>()
    for ((e, re) in EMOTION_WORDS) if (words.any { re.matches(it) } || EMOTION_EMOJI[e]?.containsMatchIn(text) == true) out += e
    if (Regex("""clip\s*(it|that|this)|clippa""", RegexOption.IGNORE_CASE).containsMatchIn(text)) out += Emotion.CLIP
    if (Regex("""\?{2,}|!{3,}""").containsMatchIn(text)) out += Emotion.SHOCK
    return out
}

private fun normalize(text: String): String {
    val first = text.lowercase().replace(Regex("""[^\p{L}\p{N}\s]"""), "").trim().split(Regex("""\s+""")).firstOrNull().orEmpty()
    return first.replace(Regex("""(.)\1{2,}"""), "$1$1")
}

data class Virality(val score: Int, val emotion: Emotion?, val reasons: List<String>, val hook: String)

private fun sat(x: Double) = x.coerceIn(0.0, 1.0)

/** Chat-based virality of a moment (0–100) plus a title suggestion. */
fun virality(messages: List<ChatMessage>, peakMs: Long, z: Double, durationSec: Double): Virality {
    val win = messages.filter { it.tMs >= peakMs - 8000 && it.tMs < peakMs + 6000 }
    val base = messages.filter { (it.tMs >= peakMs - 150_000 && it.tMs < peakMs - 25_000) || (it.tMs > peakMs + 25_000 && it.tMs <= peakMs + 150_000) }
    val firstT = messages.firstOrNull()?.tMs ?: peakMs
    val lastT = messages.lastOrNull()?.tMs ?: peakMs
    val baseSpan = max(1.0, (max(0L, peakMs - 25_000 - max(peakMs - 150_000, firstT)) + max(0L, min(peakMs + 150_000, lastT) - (peakMs + 25_000))) / 1000.0)
    val lift = (win.size / 14.0) / max(base.size / baseSpan, 0.15)

    val counts = HashMap<String, Int>()
    val reactionCounts = HashMap<String, Int>()
    val emo = HashMap<Emotion, Int>()
    var reacting = 0
    for (m in win) {
        val n = normalize(m.text)
        if (n.isNotEmpty()) counts.merge(n, 1, Int::plus)
        val e = emotionsOf(m.text)
        if (e.isNotEmpty()) {
            reacting++
            if (n.isNotEmpty()) reactionCounts.merge(n, 1, Int::plus)
        }
        e.forEach { emo.merge(it, 1, Int::plus) }
    }
    val total = max(1, win.size)
    val consensus = counts.values.sortedDescending().take(3).sum().toDouble() / total
    val reaction = reacting.toDouble() / total
    val clipRequests = emo[Emotion.CLIP] ?: 0
    val rising = messages.count { it.tMs >= peakMs - 4000 && it.tMs < peakMs } / 4.0
    val earlier = messages.count { it.tMs >= peakMs - 14000 && it.tMs < peakMs - 4000 } / 10.0
    val sharpness = rising / max(earlier, 0.3)
    val users = win.map { it.user }.toSet().size
    val baseUsers = max(1, messages.filter { it.tMs >= peakMs - 60_000 && it.tMs < peakMs - 46_000 }.map { it.user }.toSet().size)
    val breadth = users.toDouble() / baseUsers
    val dominant = emo.filterKeys { it != Emotion.CLIP }.maxByOrNull { it.value }
    val emotion = when {
        dominant != null && dominant.value >= 3 -> dominant.key
        clipRequests >= 3 -> Emotion.CLIP
        else -> null
    }

    val parts = linkedMapOf(
        "intensity" to (sat(0.65 * sat(z / 4) + 0.35 * sat((lift - 1) / 2.5)) * (0.75 + 0.25 * sat(breadth / 2)) + 0.15 * sat((reaction - 0.3) / 0.3)).coerceAtMost(1.0),
        "consensus" to sat((consensus - 0.1) / 0.35),
        "emotion" to sat(reaction * 1.4 + min(0.3, clipRequests * 0.06) + if (emotion == Emotion.LAUGH || emotion == Emotion.SHOCK) 0.1 else 0.0),
        "surprise" to sat((sharpness - 1) / 2.5),
        "structure" to (if (durationSec < 12) sat(durationSec / 12) else if (durationSec <= 35) 1.0 else sat(1 - (durationSec - 35) / 30)) * 0.85,
    )
    val weights = mapOf("intensity" to 0.26, "consensus" to 0.14, "emotion" to 0.18, "surprise" to 0.12, "structure" to 0.14)
    val score = (100 * parts.entries.sumOf { (k, v) -> weights.getValue(k) * v } / weights.values.sum()).toInt()
    val reasons = parts.entries.filter { it.value >= 0.45 }.sortedByDescending { it.value }.take(3).map { it.key }
    val top = reactionCounts.entries.sortedByDescending { it.value }.firstOrNull { it.value >= 2 && it.key.length in 1..16 }?.key
    val hook = top?.uppercase()?.takeIf { it.any(Char::isLetter) }?.let { "CHAT: $it" }.orEmpty()
    return Virality(score, emotion, reasons, hook)
}
