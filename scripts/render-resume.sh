#!/bin/bash
# Verify page-fit of the ACTUAL shipped resume.docx (does NOT regenerate it —
# regenerating here silently reverted the headline and clobbered the deliverable).
# Generate the docx in your build step, then run this to render + count pages.
APPID="${1:-2026-07-07_humana_lead-ai-product-manager}"
cd "$(dirname "$0")/.."
SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice"
DOCX="$HOME/Kairos/applications/$APPID/resume.docx"
if [ ! -f "$DOCX" ]; then echo "No resume.docx at $DOCX"; exit 1; fi
OUT=/tmp/kairos-render; rm -rf "$OUT"; mkdir -p "$OUT"
"$SOFFICE" --headless --convert-to pdf --outdir "$OUT" "$DOCX" >/dev/null 2>&1
pdfinfo "$OUT/resume.pdf" | grep -E "^Pages:"
pdftoppm -png -r 90 "$OUT/resume.pdf" "$OUT/page" >/dev/null 2>&1
echo "pages rendered: $(ls "$OUT"/page-*.png | wc -l | tr -d ' ')"
