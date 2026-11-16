package it.justapps.justclip

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

val Orange = Color(0xFFFF5A1F)

class MainActivity : ComponentActivity() {
    private var shared by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        shared = intent?.getStringExtra(Intent.EXTRA_TEXT)
        setContent { JustClipTheme { Screen(shared) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { shared = it }
    }
}

@Composable
fun JustClipTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) {
        darkColorScheme(
            primary = Orange, onPrimary = Color.White, background = Color(0xFF0F0F10), surface = Color(0xFF1C1C1E),
            onBackground = Color(0xFFF5F5F7), onSurface = Color(0xFFF5F5F7), onSurfaceVariant = Color(0xFFA1A1A6),
            surfaceVariant = Color(0xFF26262A), outline = Color(0x33FFFFFF),
        )
    } else {
        lightColorScheme(
            primary = Orange, onPrimary = Color.White, background = Color(0xFFF5F5F7), surface = Color.White,
            onBackground = Color(0xFF1D1D1F), onSurface = Color(0xFF1D1D1F), onSurfaceVariant = Color(0xFF6E6E73),
            surfaceVariant = Color(0xFFEDEDF0), outline = Color(0x22000000),
        )
    }
    MaterialTheme(colorScheme = colors, content = content)
}

@SuppressLint("BatteryLife")
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Screen(shared: String?) {
    val ctx = LocalContext.current
    val engine by Engine.state.collectAsStateWithLifecycle()
    var settings by remember { mutableStateOf(Settings.load(ctx)) }
    fun update(s: Settings) {
        settings = s
        Settings.save(ctx, s)
    }
    var input by remember { mutableStateOf(settings.lastChannel) }
    var channel by remember { mutableStateOf<ChannelInfo?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    fun check() {
        val login = parseChannel(input)
        if (login == null) {
            error = ctx.getString(R.string.bad_link)
            return
        }
        loading = true
        error = null
        scope.launch {
            runCatching { fetchChannel(login) }
                .onSuccess { channel = it; update(settings.copy(lastChannel = login)) }
                .onFailure { error = ctx.getString(R.string.not_found) }
            loading = false
        }
    }

    LaunchedEffect(shared) {
        if (shared != null && parseChannel(shared) != null) {
            input = shared
            check()
        }
    }

    fun start(c: ChannelInfo) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        ClipService.start(ctx, c.login, c.title)
    }

    val pm = ctx.getSystemService(PowerManager::class.java)
    val batteryOk = pm.isIgnoringBatteryOptimizations(ctx.packageName)

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.ic_logo), null, Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)))
                Spacer(Modifier.width(10.dp))
                Text("JustClip", fontWeight = FontWeight.Bold, fontSize = 20.sp, color = MaterialTheme.colorScheme.onBackground)
            }
        }
        item {
            Column {
                Text(stringResource(R.string.hero_a), fontSize = 38.sp, lineHeight = 40.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                Text(stringResource(R.string.hero_b), fontSize = 38.sp, lineHeight = 40.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Text(stringResource(R.string.lead), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        if (!engine.running) {
            item {
                Panel {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        label = { Text(stringResource(R.string.channel_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { check() }),
                        shape = RoundedCornerShape(14.dp),
                    )
                    Spacer(Modifier.height(10.dp))
                    BigButton(if (loading) stringResource(R.string.loading) else stringResource(R.string.check), primary = false, enabled = !loading && input.isNotBlank()) { check() }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
                    channel?.let { c ->
                        Spacer(Modifier.height(14.dp))
                        Text(c.name, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                        if (c.live) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                LiveDot()
                                Spacer(Modifier.width(8.dp))
                                Text("${c.viewers} ${stringResource(R.string.viewers)}${c.game?.let { " · $it" } ?: ""}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(c.title, modifier = Modifier.padding(top = 6.dp))
                            Spacer(Modifier.height(12.dp))
                            BigButton(stringResource(R.string.start_background)) { start(c) }
                        } else {
                            Text(stringResource(R.string.offline), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        } else {
            item {
                Panel(highlight = true) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LiveDot()
                        Spacer(Modifier.width(8.dp))
                        Text(engine.channel, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                    }
                    if (engine.title.isNotBlank()) Text(engine.title, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    Spacer(Modifier.height(8.dp))
                    Mono(
                        "${stringResource(if (engine.chatConnected) R.string.chat_on else R.string.chat_off)} · ${engine.messages} msg · " +
                            "buffer ${engine.bufferedSec}s (${"%.0f".format(engine.bufferedMb)} MB)",
                    )
                    Text(stringResource(R.string.background_ok), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                    Spacer(Modifier.height(10.dp))
                    Activity(engine.activity)
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.weight(1f)) { BigButton(stringResource(R.string.clip_now), enabled = engine.bufferedSec > 10) { Engine.clipNow() } }
                        Box(Modifier.weight(1f)) { BigButton(stringResource(R.string.stop), primary = false) { ClipService.stop(ctx) } }
                    }
                }
            }
        }

        if (!batteryOk) {
            item {
                Panel {
                    Text(stringResource(R.string.battery_title), fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.battery_text), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
                    TextButton(onClick = {
                        ctx.startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
                    }) { Text(stringResource(R.string.battery_button), color = Orange, fontWeight = FontWeight.Bold) }
                }
            }
        }

        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.clips), fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                Spacer(Modifier.width(8.dp))
                Mono("${engine.clips.size}", color = Orange)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { showSettings = !showSettings }) {
                    Text(stringResource(R.string.settings) + if (showSettings) " ▴" else " ▾", color = MaterialTheme.colorScheme.onBackground)
                }
            }
        }
        if (showSettings) item { SettingsPanel(settings, engine.running) { update(it) } }
        if (engine.clips.isEmpty()) {
            item { Text(stringResource(R.string.no_clips), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        items(engine.clips, key = { it.id }) { ClipCard(it) }
        item {
            Text(
                "clip.justapps.it · JustApps · GPL-3.0",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                modifier = Modifier.padding(vertical = 16.dp),
            )
        }
    }
}

@Composable
fun Panel(highlight: Boolean = false, content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (highlight) androidx.compose.foundation.BorderStroke(2.dp, Orange) else null,
        modifier = Modifier.fillMaxWidth(),
    ) { Column(Modifier.padding(18.dp)) { content() } }
}

@Composable
fun BigButton(text: String, primary: Boolean = true, enabled: Boolean = true, onClick: () -> Unit) {
    if (primary) {
        Button(
            onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Color.White),
        ) { Text(text, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
    } else {
        OutlinedButton(onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
            Text(text, fontWeight = FontWeight.Bold, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
fun LiveDot() {
    Box(Modifier.clip(RoundedCornerShape(8.dp)).background(Orange).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text("LIVE", color = Color.White, fontFamily = FontFamily.Monospace, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun Mono(text: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) =
    Text(text, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = color)

@Composable
fun Activity(values: List<Double>) {
    val fill = Orange.copy(alpha = 0.15f)
    Canvas(Modifier.fillMaxWidth().height(70.dp).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
        if (values.size < 2) return@Canvas
        val max = (values.maxOrNull() ?: 1.0).coerceAtLeast(1.0)
        val step = size.width / (values.size - 1)
        val line = Path()
        values.forEachIndexed { i, v ->
            val p = Offset(i * step, size.height - 4 - (v / max).toFloat() * (size.height - 10))
            if (i == 0) line.moveTo(p.x, p.y) else line.lineTo(p.x, p.y)
        }
        val area = Path().apply { addPath(line); lineTo(size.width, size.height); lineTo(0f, size.height); close() }
        drawPath(area, fill)
        drawPath(line, Orange, style = Stroke(width = 4f))
    }
}

@Composable
fun ClipCard(c: ClipItem) {
    val ctx = LocalContext.current
    Panel(highlight = c.status == ClipStatus.RENDERING) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    java.text.DateFormat.getTimeInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(c.atMs)) +
                        if (c.manual) " · ${stringResource(R.string.manual)}" else "",
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    when (c.status) {
                        ClipStatus.WAITING -> stringResource(R.string.waiting)
                        ClipStatus.RENDERING -> stringResource(R.string.rendering)
                        ClipStatus.DONE -> stringResource(R.string.saved)
                        ClipStatus.ERROR -> c.error ?: "error"
                    },
                    color = if (c.status == ClipStatus.ERROR) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 13.sp,
                )
            }
            c.virality?.let { v ->
                Column(
                    Modifier.clip(RoundedCornerShape(14.dp)).background(if (v.score >= 70) Orange else MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("${v.score}", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = if (v.score >= 70) Color.White else MaterialTheme.colorScheme.onSurface)
                    Text(stringResource(R.string.virality).uppercase(), fontSize = 9.sp, color = if (v.score >= 70) Color.White else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (c.status == ClipStatus.RENDERING || c.status == ClipStatus.WAITING) {
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(Modifier.fillMaxWidth(), color = Orange)
        }
        if (c.samples.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(c.samples.joinToString("  ·  "), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        if (c.outputs.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((format, uri) in c.outputs) {
                    val label = if (format == Format.VERTICAL) "9:16" else "16:9"
                    Button(
                        onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Orange),
                    ) { Text("▶ $label", fontWeight = FontWeight.Bold) }
                    OutlinedButton(
                        onClick = {
                            val send = Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            ctx.startActivity(Intent.createChooser(send, null))
                        },
                        shape = RoundedCornerShape(12.dp),
                    ) { Text("↗", color = MaterialTheme.colorScheme.onSurface) }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsPanel(s: Settings, running: Boolean, onChange: (Settings) -> Unit) {
    @Composable
    fun <T> Choice(label: String, options: List<Pair<T, String>>, value: T, set: (T) -> Unit) {
        Text(label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((v, l) in options) FilterChip(
                selected = v == value, onClick = { set(v) }, label = { Text(l) },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Orange, selectedLabelColor = Color.White),
            )
        }
    }

    @Composable
    fun Toggle(label: String, checked: Boolean, set: (Boolean) -> Unit) {
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f))
            Switch(checked, set, colors = SwitchDefaults.colors(checkedTrackColor = Orange))
        }
    }

    @Composable
    fun Range(label: String, value: Int, range: IntRange, set: (Int) -> Unit) {
        Text("$label: $value", fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(top = 10.dp))
        Slider(
            value.toFloat(), { set(it.toInt()) }, valueRange = range.first.toFloat()..range.last.toFloat(),
            colors = SliderDefaults.colors(thumbColor = Orange, activeTrackColor = Orange),
        )
    }

    Panel {
        if (running) Text(stringResource(R.string.settings_next), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Choice(
            stringResource(R.string.sensitivity),
            listOf(Sensitivity.LOW to stringResource(R.string.low), Sensitivity.MEDIUM to stringResource(R.string.medium), Sensitivity.HIGH to stringResource(R.string.high)),
            s.sensitivity,
        ) { onChange(s.copy(sensitivity = it)) }
        Range(stringResource(R.string.before), s.before, 5..60) { onChange(s.copy(before = it)) }
        Range(stringResource(R.string.after), s.after, 0..30) { onChange(s.copy(after = it)) }
        Toggle("16:9", s.horizontal) { onChange(s.copy(horizontal = it)) }
        Toggle("9:16", s.vertical) { onChange(s.copy(vertical = it)) }
        Choice(
            stringResource(R.string.layout),
            listOf(VerticalMode.STACK to stringResource(R.string.layout_stack), VerticalMode.CROP to stringResource(R.string.layout_crop)),
            s.verticalMode,
        ) { onChange(s.copy(verticalMode = it)) }
        if (s.verticalMode == VerticalMode.STACK) {
            Choice(
                stringResource(R.string.facecam),
                listOf(
                    "topLeft" to stringResource(R.string.top_left), "topRight" to stringResource(R.string.top_right),
                    "bottomLeft" to stringResource(R.string.bottom_left), "bottomRight" to stringResource(R.string.bottom_right),
                ),
                s.facePreset,
            ) { onChange(s.copy(facePreset = it)) }
            Range(stringResource(R.string.face_share), (s.faceShare * 100).toInt(), 20..55) { onChange(s.copy(faceShare = it / 100f)) }
        }
        Choice(stringResource(R.string.quality), listOf(720 to "720p", 1080 to "1080p"), s.quality) { onChange(s.copy(quality = it)) }
        Toggle(stringResource(R.string.hook_title), s.hookTitle) { onChange(s.copy(hookTitle = it)) }
        Range(stringResource(R.string.buffer_minutes), s.bufferMinutes, 1..10) { onChange(s.copy(bufferMinutes = it)) }
    }
}
