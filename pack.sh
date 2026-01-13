#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_name="${1:-chrome-tab-gallery.zip}"
output_path="$output_name"

cd "$root_dir"

required_items=(
  "manifest.json"
  "service-worker.js"
  "content-script.js"
  "tab-manager.html"
  "tab-manager.css"
  "tab-manager.js"
  "icons"
)

for item in "${required_items[@]}"; do
  if [[ ! -e "$item" ]]; then
    echo "Missing required item: $item" >&2
    exit 1
  fi
done

rm -f "$output_path"

zip -r "$output_path" "${required_items[@]}" -x "*.DS_Store"
