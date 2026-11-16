package it.justapps.justclip

import android.content.Context

enum class Sensitivity(val z: Double) { LOW(3.2), MEDIUM(2.4), HIGH(1.8) }
enum class VerticalMode { STACK, CROP }

/** A rectangle in the source frame, 0..1, origin top-left. */
data class Rect01(val x: Float, val y: Float, val w: Float, val h: Float)

val FACE_PRESETS = linkedMapOf(
    "topLeft" to Rect01(0.02f, 0.02f, 0.24f, 0.30f),
    "topRight" to Rect01(0.74f, 0.02f, 0.24f, 0.30f),
    "bottomLeft" to Rect01(0.02f, 0.68f, 0.24f, 0.30f),
    "bottomRight" to Rect01(0.74f, 0.68f, 0.24f, 0.30f),
)

data class Settings(
    val sensitivity: Sensitivity = Sensitivity.MEDIUM,
    val before: Int = 25,
    val after: Int = 8,
    val horizontal: Boolean = true,
    val vertical: Boolean = true,
    val quality: Int = 720,
    val verticalMode: VerticalMode = VerticalMode.STACK,
    val facePreset: String = "topRight",
    val faceShare: Float = 0.38f,
    val hookTitle: Boolean = true,
    val bufferMinutes: Int = 3,
    val lastChannel: String = "",
) {
    val face: Rect01 get() = FACE_PRESETS[facePreset] ?: FACE_PRESETS.getValue("topRight")
    /** Gameplay: the frame minus a little on the sides (keeps the center). */
    val game: Rect01 get() = Rect01(0.125f, 0f, 0.75f, 1f)

    companion object {
        private const val PREFS = "justclip"

        fun load(ctx: Context): Settings {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val d = Settings()
            return Settings(
                sensitivity = runCatching { Sensitivity.valueOf(p.getString("sensitivity", d.sensitivity.name)!!) }.getOrDefault(d.sensitivity),
                before = p.getInt("before", d.before),
                after = p.getInt("after", d.after),
                horizontal = p.getBoolean("horizontal", d.horizontal),
                vertical = p.getBoolean("vertical", d.vertical),
                quality = p.getInt("quality", d.quality),
                verticalMode = runCatching { VerticalMode.valueOf(p.getString("verticalMode", d.verticalMode.name)!!) }.getOrDefault(d.verticalMode),
                facePreset = p.getString("facePreset", d.facePreset)!!,
                faceShare = p.getFloat("faceShare", d.faceShare),
                hookTitle = p.getBoolean("hookTitle", d.hookTitle),
                bufferMinutes = p.getInt("bufferMinutes", d.bufferMinutes),
                lastChannel = p.getString("lastChannel", "")!!,
            )
        }

        fun save(ctx: Context, s: Settings) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("sensitivity", s.sensitivity.name)
                .putInt("before", s.before)
                .putInt("after", s.after)
                .putBoolean("horizontal", s.horizontal)
                .putBoolean("vertical", s.vertical)
                .putInt("quality", s.quality)
                .putString("verticalMode", s.verticalMode.name)
                .putString("facePreset", s.facePreset)
                .putFloat("faceShare", s.faceShare)
                .putBoolean("hookTitle", s.hookTitle)
                .putInt("bufferMinutes", s.bufferMinutes)
                .putString("lastChannel", s.lastChannel)
                .apply()
        }
    }
}
