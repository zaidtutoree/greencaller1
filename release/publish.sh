#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
gh release create desktop-v0.0.2 "Greencaller-Setup-0.0.2.exe" \
  --repo zaidtutoree/GreencallerWebsite \
  --title "Greencaller for Windows 0.0.2" \
  --notes "Windows desktop installer. SHA-256: c9f99e34742ecf8d8b8e9254cc1687729bf746bb5a4b2862b7e5f477b348b909"
