package it.justapps.justclip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreTest {
    @Test fun channels() {
        assertEquals("xqc", parseChannel("https://www.twitch.tv/xQc?x=1"))
        assertEquals("ibai", parseChannel("ibai"))
        assertNull(parseChannel("https://www.twitch.tv/videos/123"))
        assertNull(parseChannel("https://example.com"))
    }

    @Test fun irc() {
        val m = parseIrc("@display-name=Ada;tmi-sent-ts=1700000000123 :ada!ada@ada.tmi.twitch.tv PRIVMSG #xqc :KEKW W")!!
        assertEquals(1700000000123L, m.tMs)
        assertEquals("Ada", m.user)
        assertEquals("KEKW W", m.text)
    }

    @Test fun playlists() {
        val master = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,VIDEO="chunked",FRAME-RATE=60.000
            https://cdn/chunked/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,VIDEO="720p60",FRAME-RATE=60.000
            https://cdn/720p60/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,VIDEO="720p30",FRAME-RATE=30.000
            https://cdn/720p30/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=160000,VIDEO="audio_only"
            https://cdn/audio/index.m3u8
        """.trimIndent()
        assertEquals("https://cdn/720p30/index.m3u8", pickVariant(parseMaster(master, "https://cdn/"), 720)!!.url)
        val (segs, target) = parseMedia(
            """
            #EXTM3U
            #EXT-X-TARGETDURATION:2
            #EXT-X-MEDIA-SEQUENCE:100
            #EXT-X-PROGRAM-DATE-TIME:2026-11-16T10:00:00.000Z
            #EXTINF:2.000,live
            seg100.ts
            #EXTINF:2.000,Amazon
            ad.ts
            #EXTINF:2.000,live
            seg102.ts
            """.trimIndent(),
            "https://cdn/x/index.m3u8",
        )
        assertEquals(2.0, target, 0.0)
        assertEquals(listOf(false, true, false), segs.map { it.ad })
        assertEquals("https://cdn/x/seg100.ts", segs[0].url)
        assertEquals(1794823204000L, segs[2].pdtMs)
    }

    private fun burstChat(burst: (Int) -> String): List<ChatMessage> {
        val base = 1_700_000_000_000L
        val out = mutableListOf<ChatMessage>()
        for (t in 0 until 900 step 2) out += ChatMessage(base + t * 1000L, "u${t % 37}", "just chatting about stuff")
        for (i in 0 until 80) out += ChatMessage(base + (700 + i % 10) * 1000L, "v$i", burst(i))
        return out.sortedBy { it.tMs }
    }

    @Test fun detectsALiveBurstOnce() {
        val msgs = burstChat { if (it % 2 == 0) "KEKW" else "LMAO W" }
        val d = LiveDetector(Sensitivity.MEDIUM, 33)
        val found = mutableListOf<Long>()
        var k = 0
        for (now in 1_700_000_000L until 1_700_000_900L) {
            while (k < msgs.size && msgs[k].tMs / 1000 <= now) d.add(msgs[k++])
            d.poll(now)?.let { found += it.tSec - 1_700_000_000L }
        }
        assertEquals(1, found.size)
        assertTrue(found[0] in 696..720)
    }

    @Test fun viralityPrefersUnanimousLaughs() {
        val peak = 1_700_000_000_000L + 705_000
        val laugh = virality(burstChat { "LMAOOO" }, peak, 4.0, 30.0)
        val noise = virality(burstChat { "random message number $it about things" }, peak, 4.0, 30.0)
        assertEquals(Emotion.LAUGH, laugh.emotion)
        assertEquals("CHAT: LMAOO", laugh.hook)
        assertTrue("${laugh.score} vs ${noise.score}", laugh.score > noise.score + 15)
    }

    @Test fun coverFitKeepsTheBoxAspect() {
        // 24%×30% of a 1280×720 frame into a 720×486 box.
        val t = StackEffect.coverTex(Rect01(0.74f, 0.02f, 0.24f, 0.30f), 1280, 720, 720f, 486f)
        val aspect = (t[2] * 1280) / (t[3] * 720)
        assertEquals(720f / 486f, aspect, 0.01f)
        assertTrue(t[0] >= 0.74f && t[0] + t[2] <= 0.98f + 1e-4f)
    }
}
