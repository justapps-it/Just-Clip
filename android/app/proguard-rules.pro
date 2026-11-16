# Media3 and OkHttp ship their own consumer rules.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Media3 instantiates codecs, extractors and effects by reflection: keep it whole.
-keep class androidx.media3.** { *; }
-keep interface androidx.media3.** { *; }
