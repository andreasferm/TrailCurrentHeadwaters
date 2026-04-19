#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Headwaters — Docker image loader
#
# Loads Docker images from baked-in tarballs on first boot, then deletes
# the tars to reclaim disk space. Runs as a oneshot systemd service after
# docker.service is ready.
# ============================================================================

set -e

LOG_TAG="headwaters-load-images"
log() { echo "$*"; logger -t "$LOG_TAG" "$*"; }

TC_HOME="/home/trailcurrent"
IMAGES_DIR="$TC_HOME/images"

if [ ! -d "$IMAGES_DIR" ] || ! ls "$IMAGES_DIR"/*.tar 1>/dev/null 2>&1; then
    log "no image tarballs at $IMAGES_DIR (already loaded or deployed separately)"
    exit 0
fi

log "loading Docker images from baked-in tarballs"

loaded=0
for tar_file in "$IMAGES_DIR"/*.tar; do
    name=$(basename "$tar_file")
    log "  loading $name"
    if docker load -i "$tar_file" >/dev/null 2>&1; then
        loaded=$((loaded + 1))
    else
        log "  WARNING: failed to load $name"
    fi
done

log "loaded $loaded image(s)"

# Reclaim disk space (~1 GB of tars)
rm -f "$IMAGES_DIR"/*.tar
rmdir "$IMAGES_DIR" 2>/dev/null || true
log "removed image tarballs"
