# Build environment for the real app (Android side). Source it: `source build/env.sh`.
# Same idea as m0/env.sh: your shell profile is not edited, each shell opts in by sourcing this.
# Where JAVA_HOME / ANDROID_HOME are already set (CI runners set them) they are left alone.
# Otherwise it points at the Homebrew JDK 17 and android-commandlinetools cask, as M0 did.
if [ -z "${JAVA_HOME:-}" ] || [ -z "${ANDROID_HOME:-}" ]; then
  _brew_prefix="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
  export JAVA_HOME="${JAVA_HOME:-$_brew_prefix/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
  export ANDROID_HOME="${ANDROID_HOME:-$_brew_prefix/share/android-commandlinetools}"
  unset _brew_prefix
fi
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
