#!/bin/bash
set -e

# TrailCurrent Docker Image Loader
#
# Loads Docker images from baked-in tarballs on first boot, then deletes
# the tars to reclaim disk space. Runs as a oneshot systemd service
# after docker.service is ready.

LOG_TAG="trailcurrent-load-images"
log() { echo "$1"; logger -t "$LOG_TAG" "$1"; }

# Detect the first non-root user
TC_USER=$(getent passwd 1000 | cut -d: -f1)
TC_HOME="/home/$TC_USER"
IMAGES_DIR="$TC_HOME/images"

if [ ! -d "$IMAGES_DIR" ] || ! ls "$IMAGES_DIR"/*.tar 1>/dev/null 2>&1; then
    log "No image tarballs found at $IMAGES_DIR (already loaded or deployed separately)"
    exit 0
fi

log "Loading Docker images from baked-in tarballs..."

images_loaded=0
for tar_file in "$IMAGES_DIR"/*.tar; do
    tar_name=$(basename "$tar_file")
    log "  Loading $tar_name..."
    if docker load -i "$tar_file" >/dev/null 2>&1; then
        images_loaded=$((images_loaded + 1))
    else
        log "  WARNING: Failed to load $tar_name"
    fi
done

log "Loaded $images_loaded image(s)"

# Remove tars to reclaim disk space (~1GB)
rm -f "$IMAGES_DIR"/*.tar
rmdir "$IMAGES_DIR" 2>/dev/null || true
log "Removed image tarballs to free disk space"
