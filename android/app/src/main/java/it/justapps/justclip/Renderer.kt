package it.justapps.justclip

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.opengl.GLES20
import android.text.Spannable
import android.text.SpannableString
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.OverlaySettings
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.Crop
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

enum class Format { HORIZONTAL, VERTICAL }

/**
 * 9:16 frame with the facecam on top and the gameplay below, from a single
 * input frame, in one GPU pass. Each area is "cover"-fitted (no bars).
 */
@OptIn(UnstableApi::class)
class StackEffect(
    private val face: Rect01,
    private val game: Rect01,
    private val faceShare: Float,
    private val outW: Int,
    private val outH: Int,
) : GlEffect {
    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram = Program()

    private inner class Program : BaseGlShaderProgram(false, 1) {
        private val program = GlProgram(VERTEX, FRAGMENT)
        private var faceTex = FloatArray(4)
        private var gameTex = FloatArray(4)

        init {
            program.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE)
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            val topH = outH * faceShare
            faceTex = coverTex(face, inputWidth, inputHeight, outW.toFloat(), topH)
            gameTex = coverTex(game, inputWidth, inputHeight, outW.toFloat(), outH - topH)
            return Size(outW, outH)
        }

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            program.use()
            program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
            program.setFloatsUniform("uFace", faceTex)
            program.setFloatsUniform("uGame", gameTex)
            program.setFloatUniform("uSplit", 1f - faceShare)
            program.bindAttributesAndUniforms()
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        }

        override fun release() {
            super.release()
            program.delete()
        }
    }

    companion object {
        /** Source rect (top-left origin) → texture rect (bottom-left origin), cropped to the box aspect. */
        fun coverTex(r: Rect01, inW: Int, inH: Int, boxW: Float, boxH: Float): FloatArray {
            val rectAspect = (r.w * inW) / (r.h * inH)
            val boxAspect = boxW / boxH
            var w = r.w
            var h = r.h
            if (rectAspect > boxAspect) w = r.h * inH * boxAspect / inW else h = r.w * inW / boxAspect / inH
            val x = r.x + (r.w - w) / 2
            val y = r.y + (r.h - h) / 2
            return floatArrayOf(x, 1f - (y + h), w, h)
        }

        private const val VERTEX = """
attribute vec4 aFramePosition;
varying vec2 vUv;
void main() {
  gl_Position = aFramePosition;
  vUv = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);
}"""

        private const val FRAGMENT = """
precision highp float;
uniform sampler2D uTexSampler;
uniform vec4 uFace;
uniform vec4 uGame;
uniform float uSplit;
varying vec2 vUv;
void main() {
  vec4 r;
  vec2 local;
  if (vUv.y >= uSplit) {
    r = uFace;
    local = vec2(vUv.x, (vUv.y - uSplit) / (1.0 - uSplit));
  } else {
    r = uGame;
    local = vec2(vUv.x, vUv.y / uSplit);
  }
  gl_FragColor = texture2D(uTexSampler, r.xy + local * r.zw);
}"""
    }
}

/** Title card for the first seconds of the clip. */
@OptIn(UnstableApi::class)
class HookOverlay(text: String, private val untilUs: Long, sizePx: Int, private val y: Float) : TextOverlay() {
    private val span = SpannableString("  ${text.uppercase()}  ").apply {
        setSpan(ForegroundColorSpan(Color.WHITE), 0, length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        setSpan(BackgroundColorSpan(0xFFFF5A1F.toInt()), 0, length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        setSpan(AbsoluteSizeSpan(sizePx), 0, length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        setSpan(StyleSpan(Typeface.BOLD), 0, length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    override fun getText(presentationTimeUs: Long): SpannableString = span

    override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings =
        StaticOverlaySettings.Builder()
            .setBackgroundFrameAnchor(0f, y)
            .setOverlayFrameAnchor(0f, 0f)
            .setAlphaScale(if (presentationTimeUs <= untilUs) 1f else 0f)
            .build()
}

data class RenderJob(
    val input: File,
    val startMs: Long,
    val endMs: Long,
    val settings: Settings,
    val hook: String?,
)

@OptIn(UnstableApi::class)
object Renderer {
    private fun size(format: Format, quality: Int) =
        if (format == Format.HORIZONTAL) (if (quality >= 1080) 1920 to 1080 else 1280 to 720)
        else (if (quality >= 1080) 1080 to 1920 else 720 to 1280)

    private fun effects(format: Format, s: Settings, hook: String?): List<Effect> {
        val (w, h) = size(format, s.quality)
        val list = mutableListOf<Effect>()
        if (format == Format.HORIZONTAL) {
            list += Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT)
        } else if (s.verticalMode == VerticalMode.CROP) {
            // 9:16 slice of a 16:9 frame, centered.
            val f = (9f / 16f) / (16f / 9f)
            val left = -f
            list += Crop(left, left + 2 * f, -1f, 1f)
            list += Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP)
        } else {
            list += StackEffect(s.face, s.game, s.faceShare, w, h)
        }
        if (!hook.isNullOrBlank()) {
            // Anchors are in NDC: y = 0.8 is near the top.
            list += OverlayEffect(listOf(HookOverlay(hook, 3_000_000, (h * if (format == Format.VERTICAL) 0.035f else 0.05f).toInt(), if (format == Format.VERTICAL) 0.82f else 0.75f)))
        }
        return list
    }

    /** Exports one format. Must be called on the main thread (Transformer needs a Looper). */
    suspend fun render(ctx: Context, job: RenderJob, format: Format, out: File): File = withContext(Dispatchers.Main) {
        val item = MediaItem.Builder()
            .setUri(Uri.fromFile(job.input))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(job.startMs)
                    .setEndPositionMs(job.endMs)
                    .build(),
            )
            .build()
        val edited = EditedMediaItem.Builder(item)
            .setEffects(Effects(listOf(), effects(format, job.settings, job.hook)))
            .build()
        suspendCancellableCoroutine { cont ->
            val transformer = Transformer.Builder(ctx)
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        if (cont.isActive) cont.resume(out)
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                        if (cont.isActive) cont.resumeWithException(exportException)
                    }
                })
                .build()
            cont.invokeOnCancellation { transformer.cancel() }
            transformer.start(edited, out.absolutePath)
        }
    }
}
