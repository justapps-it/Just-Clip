plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing: keystore outside the repository, configured through
// ~/.gradle/gradle.properties or environment variables (CI secrets).
fun secret(name: String): String? = (project.findProperty(name) as String?) ?: System.getenv(name)

android {
    namespace = "it.justapps.justclip"
    compileSdk = 36

    defaultConfig {
        applicationId = "it.justapps.justclip"
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "1.0.1"
    }

    signingConfigs {
        create("release") {
            val store = secret("JUSTCLIP_KEYSTORE")
            if (store != null) {
                storeFile = file(store)
                storePassword = secret("JUSTCLIP_KEYSTORE_PASSWORD")
                keyAlias = secret("JUSTCLIP_KEY_ALIAS") ?: "justclip"
                keyPassword = secret("JUSTCLIP_KEY_PASSWORD") ?: secret("JUSTCLIP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (secret("JUSTCLIP_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val media3 = "1.10.1"
    implementation("androidx.media3:media3-transformer:$media3")
    implementation("androidx.media3:media3-effect:$media3")
    implementation("androidx.media3:media3-common:$media3")
    implementation("androidx.media3:media3-extractor:$media3")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation(platform("androidx.compose:compose-bom:2025.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
}
