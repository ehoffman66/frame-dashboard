#!/bin/sh
# Wraps src/dashboard.html in a full document for the frame's kiosk WebView.
# GitHub Pages serves docs/. docs/sports.json is written by the sports routines; this script leaves it alone.
set -e
cd "$(dirname "$0")"
mkdir -p docs
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n'
  cat src/dashboard.html
  printf '\n</body>\n</html>\n'
} > docs/index.html
echo "Built docs/index.html"
cp src/art.html docs/art.html
echo "Built docs/art.html"
