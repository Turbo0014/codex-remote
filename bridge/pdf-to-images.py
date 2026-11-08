# Rasterise a PDF into per-page JPEGs so any mobile browser can preview it.
# Usage: python pdf-to-images.py <pdf> <outdir> <maxWidth> <quality>
# Prints JSON: {"ok": true, "count": N, "files": ["page-001.jpg", ...]}
import json
import os
import sys

try:
    import fitz  # PyMuPDF
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": "pymupdf missing: %s" % e}))
    sys.exit(0)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: pdf-to-images.py <pdf> <outdir> [maxWidth] [quality]"}))
        return
    pdf, outdir = sys.argv[1], sys.argv[2]
    max_width = int(sys.argv[3]) if len(sys.argv) > 3 else 1400
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 82
    os.makedirs(outdir, exist_ok=True)

    doc = fitz.open(pdf)
    files = []
    try:
        for i, page in enumerate(doc):
            rect = page.rect
            zoom = 1.0
            if rect.width > 0:
                zoom = min(3.0, max(1.0, max_width / rect.width))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            name = "page-%03d.jpg" % (i + 1)
            path = os.path.join(outdir, name)
            pix.save(path, jpg_quality=quality)
            files.append(name)
    finally:
        doc.close()
    print(json.dumps({"ok": True, "count": len(files), "files": files}))


if __name__ == "__main__":
    main()
