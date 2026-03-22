#!/bin/bash
# Generate a TrailCurrent-branded boot splash screen (TGA format)
#
# Renders the TrailCurrent icon SVG centered on a dark background with
# the "TrailCurrent" wordmark below it. Output is a 24-bit TGA suitable
# for the rpi-splash-screen layer in rpi-image-gen.
#
# Requirements: ImageMagick (convert)
#
# Usage: ./generate-splash.sh [output.tga]
#
# Environment overrides:
#   MARKETING_DIR  — path to the TrailCurrent Marketing directory
#   ICON_SVG       — path to the icon SVG file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Marketing lives at TrailCurrent/Marketing, three levels up from the repo root
# (Product/TrailCurrentHeadwaters -> Product -> TrailCurrent).
MARKETING_DIR="${MARKETING_DIR:-$(cd "$REPO_ROOT/../../../Marketing" 2>/dev/null && pwd || echo "")}"
ICON_SVG="${ICON_SVG:-${MARKETING_DIR}/ContentHub/Media/Graphics/Logos/trailcurrent-icon.svg}"

# Output path
OUTPUT="${1:-${SCRIPT_DIR}/splash/trailcurrent-splash.tga}"
OUTPUT_DIR="$(dirname "$OUTPUT")"
mkdir -p "$OUTPUT_DIR"

# Temp directory for intermediate files
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# ── Check dependencies ──────────────────────────────────────────────
if ! command -v convert &>/dev/null; then
    echo "Error: ImageMagick is required but 'convert' not found."
    echo "Install with: sudo apt install imagemagick"
    exit 1
fi

echo "Generating TrailCurrent boot splash screen..."

# Check that source SVG exists
if [ ! -f "$ICON_SVG" ]; then
    echo "Error: Icon SVG not found: $ICON_SVG"
    echo "Set MARKETING_DIR or ICON_SVG environment variables to override."
    exit 1
fi

# ── Render icon SVG to PNG ───────────────────────────────────────────
# The icon is a self-contained vector (no text/fonts), so ImageMagick
# handles it well. Render at 400px for a good size on 1920x1080.
convert -background none -density 300 "$ICON_SVG" \
    -resize 400x400 "$TMPDIR/icon.png"

# ── Compose the splash image ────────────────────────────────────────
# Dark background with the TrailCurrent icon centered, wordmark text below.
# Colors match the brand: #52a441 (primary green), #d0e2c7 (secondary).
BG_COLOR="#1a1a2e"

# Use a common sans-serif font for the wordmark text.
# Try DejaVu Sans Bold first (widely available on Linux), fall back to Helvetica.
FONT="DejaVu-Sans-Bold"
if ! convert -list font 2>/dev/null | grep -qi "DejaVu-Sans-Bold"; then
    FONT="Helvetica-Bold"
fi

convert -size 1920x1080 "xc:${BG_COLOR}" \
    \( "$TMPDIR/icon.png" \) -gravity center -geometry +0-80 -composite \
    -font "$FONT" -pointsize 48 \
    -fill '#52a441' -gravity center -annotate +0+180 "TrailCurrent" \
    "$TMPDIR/composed.png"

# ── Convert to 24-bit TGA (splash-screen requirements) ──────────────
# - Max 224 colors
# - 24-bit depth
# - Uncompressed TGA
# - The -flip is required: TGA files for the Pi boot splash are stored
#   bottom-to-top, so the image must be flipped before saving.
convert "$TMPDIR/composed.png" \
    -depth 8 \
    -colors 224 \
    -type truecolor \
    -flip \
    -compress None \
    "$OUTPUT"

echo "Splash screen created: $OUTPUT"
echo ""

# Show file info
file "$OUTPUT"
identify "$OUTPUT" 2>/dev/null || true

echo ""
echo "Image config reference (already in trailcurrent-cm5-base.yaml):"
echo ""
echo "splash:"
echo "  image_path: $(realpath "$OUTPUT")"
