# M0 build environment (repo copy). Source it: `source m0/env.sh`.
# Why: the captain's shell profile is not edited, so each shell opts in by sourcing this.
# It detects Homebrew paths (Apple Silicon /opt/homebrew or Intel /usr/local) and exports
# JAVA_HOME (JDK 17, what Android Gradle Plugin 8.x needs), ANDROID_HOME / ANDROID_SDK_ROOT
# (the SDK root used by the Homebrew android-commandlinetools cask), and puts sdkmanager
# and adb on PATH. Machine-local twin: ~/.fmp-m0-env.sh (same content, fixed paths).
_brew_prefix="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
export JAVA_HOME="$_brew_prefix/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$_brew_prefix/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
unset _brew_prefix
