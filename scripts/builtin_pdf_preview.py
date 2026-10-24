"""Page preview rasterizer for the PDF quality gate (ticket 05).

There is no JavaScript PDF rasterizer in this project and no poppler/mutool/
ghostscript on PATH, so page previews go through the same bounded Python
subprocess seam the text extractor already uses. PyMuPDF renders each requested
page to a PNG and reports, per page, what the rasterizer itself observed of
that page's text layer — the second observation the evidence layer declares an
absent text layer from.

Usage:
    builtin_pdf_preview.py <pdf-path> <page-spec> [scale]

    <page-spec>  "all" or a comma-separated 1-based page list, e.g. "1,2,3"
    [scale]      device pixels per PDF point (default 2.0, about 144 dpi)

Writes one JSON document to stdout:

    {
      "version": 1,
      "pageCount": <int>,
      "previews": [
        {"page": <int 1-based>, "mediaType": "image/png", "dataBase64": <str>,
         "width": <int>, "height": <int>, "textLayerAbsent": <bool>,
         "warnings": [<str>], "errors": [{"code": <str>, "message": <str>}]}
      ],
      "warnings": [<str>]
    }

Honesty rules for this script:
  * `textLayerAbsent` is what THIS page's text read saw. A page whose text read
    raised reports False plus an `errors` entry — never a guessed absence.
  * No page is silently dropped: a page that cannot be opened at all gets an
    `errors` entry and no `previews` row, which the caller turns into an
    explicit `preview_page_missing` failure rather than a blank image.
  * Nothing here synthesizes text. Images only.
"""
import base64
import json
import sys


def parse_pages(spec: str, page_count: int):
    if spec == "all":
        return list(range(1, page_count + 1))
    pages = []
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        value = int(token)
        if value < 1 or value > page_count:
            raise ValueError(f"page {value} is outside the document of {page_count} pages")
        pages.append(value)
    return pages


def has_text_layer(page) -> bool:
    """True when this page's own text read produced at least one text span."""
    laid_out = page.get_text("dict")
    for block in laid_out.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if str(span.get("text", "")).strip():
                    return True
    return False


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: builtin_pdf_preview.py <pdf-path> <page-spec> [scale]", file=sys.stderr)
        return 2
    source, spec = sys.argv[1], sys.argv[2]
    try:
        scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
    except ValueError:
        print("scale must be a number", file=sys.stderr)
        return 2
    if not scale or scale <= 0:
        print("scale must be positive", file=sys.stderr)
        return 2

    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("PyMuPDF is required for page previews: pip install pymupdf", file=sys.stderr)
        return 3

    try:
        doc = fitz.open(source)
    except Exception as error:  # noqa: BLE001 - surfaced to the caller as a stable failure
        print(f"cannot open PDF for preview: {error}", file=sys.stderr)
        return 4

    warnings = []
    previews = []
    try:
        page_count = doc.page_count
        if page_count < 1:
            print("PDF has no pages to render", file=sys.stderr)
            return 5
        try:
            requested = parse_pages(spec, page_count)
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return 2
    except Exception as error:  # noqa: BLE001
        print(f"cannot read page count: {error}", file=sys.stderr)
        return 4

    matrix = fitz.Matrix(scale, scale)
    for page_no in requested:
        entry_errors = []
        entry_warnings = []
        page = None
        try:
            page = doc[page_no - 1]
        except Exception as error:  # noqa: BLE001 - no preview row is emitted on purpose
            print(f"page {page_no} could not be opened: {error}", file=sys.stderr)
            return 6

        text_layer_absent = False
        try:
            text_layer_absent = not has_text_layer(page)
        except Exception as error:  # noqa: BLE001 - absence is NOT claimed from a failed read
            entry_errors.append({"code": "text_layer_read_failed", "message": str(error)})

        try:
            if not page.rect.width or not page.rect.height:
                message = f"page {page_no} has an empty media box"
                warnings.append(message)
                entry_warnings.append(message)
                entry_errors.append({"code": "empty_media_box", "message": message})
            if page.rotation not in (0, 90, 180, 270):
                entry_warnings.append(f"page {page_no} carries a non-rectangular rotation")
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            png = pixmap.tobytes("png")
        except Exception as error:  # noqa: BLE001 - reported, never replaced by a blank image
            print(f"page {page_no} render failed: {error}", file=sys.stderr)
            return 7

        if pixmap.colorspace is None or pixmap.colorspace.name not in ("DeviceRGB", "DeviceGray"):
            message = (
                f"page {page_no} rendered in "
                f"{pixmap.colorspace.name if pixmap.colorspace else 'an unknown space'}"
            )
            warnings.append(message)
            entry_warnings.append(message)

        previews.append(
            {
                "page": page_no,
                "mediaType": "image/png",
                "dataBase64": base64.b64encode(png).decode("ascii"),
                "width": pixmap.width,
                "height": pixmap.height,
                "textLayerAbsent": text_layer_absent,
                "warnings": entry_warnings,
                "errors": entry_errors,
            }
        )

    print(json.dumps({"version": 1, "pageCount": page_count, "previews": previews, "warnings": warnings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
