#!/bin/sh
# Public, reproducible recipe for the LGPL-2.1 FFmpeg binary Playwright uses to record video.
# Playwright's own ffmpeg-1011 build recipe is not public, so TestMaster images replace that
# binary with this build. The configuration mirrors Playwright's last public CONFIG.sh
# (static zlib/libvpx, mjpeg pipe -> VP8 WebM, no GPL components), except that pthreads stay
# enabled because the FFmpeg 7 command-line tool requires threads.
set -eu
OUT=${1:?usage: build.sh OUTPUT_DIRECTORY}
WORK=$(mktemp -d)
PREFIX="$WORK/prefix"
JOBS=$(nproc)

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$WORK/$3" "$1"
  echo "$2  $WORK/$3" | sha256sum -c -
}
fetch https://zlib.net/fossils/zlib-1.3.1.tar.gz \
  9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23 zlib-1.3.1.tar.gz
fetch https://github.com/webmproject/libvpx/archive/refs/tags/v1.14.1.tar.gz \
  901747254d80a7937c933d03bd7c5d41e8e6c883e0665fadcb172542167c7977 libvpx-1.14.1.tar.gz
fetch https://ffmpeg.org/releases/ffmpeg-7.0.1.tar.xz \
  bce9eeb0f17ef8982390b1f37711a61b4290dc8c2a0c1a37b5857e85bfb0e4ff ffmpeg-7.0.1.tar.xz

cd "$WORK"
tar xzf zlib-1.3.1.tar.gz
(cd zlib-1.3.1 && ./configure --static --prefix="$PREFIX" && make -j"$JOBS" && make install)
tar xzf libvpx-1.14.1.tar.gz
(cd libvpx-1.14.1 && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  --disable-docs --disable-tools --disable-unit-tests --disable-examples \
  && make -j"$JOBS" && make install)
tar xJf ffmpeg-7.0.1.tar.xz
(cd ffmpeg-7.0.1 && PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" \
  --extra-version=testmaster-1 \
  --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
  --disable-debug --disable-autodetect --disable-everything \
  --enable-ffmpeg --disable-ffprobe \
  --enable-protocol=pipe --enable-protocol=file \
  --enable-parser=mjpeg --enable-decoder=mjpeg --enable-demuxer=image2pipe \
  --enable-filter=pad --enable-filter=crop --enable-filter=scale \
  --enable-muxer=webm --enable-libvpx --enable-static \
  --enable-encoder=libvpx_vp8 --enable-decoder=libvpx_vp8 --enable-demuxer=matroska \
  --enable-encoder=png --enable-zlib --enable-muxer=image2 \
  --disable-iconv --disable-w32threads --disable-bzlib \
  && make -j"$JOBS")
test -x ffmpeg-7.0.1/ffmpeg
mkdir -p "$OUT"
install -m 0755 ffmpeg-7.0.1/ffmpeg "$OUT/ffmpeg-linux"
install -m 0644 ffmpeg-7.0.1/COPYING.LGPLv2.1 "$OUT/COPYING.LGPLv2.1"
"$OUT/ffmpeg-linux" -hide_banner -version | head -1
rm -rf "$WORK"
