"""Builtin structured PDF extractor for the ingestion pipeline.

Extracts per-page text blocks with layout metadata from a text-layer PDF via
PyMuPDF and writes a single JSON document to stdout:

{
  "version": 1,
  "pageCount": <int>,
  "outline": [{"level": <int>, "title": <str>, "page": <int 1-based>}],
  "blocks": [
    {"page": <int 1-based>, "text": <str>, "bbox": [x0, y0, x1, y1],
     "fontSize": <float>, "bold": <bool>}
  ],
  "tables": [
    {"page": <int 1-based>, "bbox": [x0, y0, x1, y1], "markdown": <str>}
  ],
  "warnings": [<str>], "stats": {"textChars": <int>, "pagesWithText": <int>}
}

Structural decisions (heading levels, section paths, table binding) are made
by the TypeScript normalizer; this script only reports raw layout facts.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: builtin_pdf_extract.py <pdf-path>", file=sys.stderr)
        return 2
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("PyMuPDF is required: pip install pymupdf", file=sys.stderr)
        return 3

    try:
        doc = fitz.open(sys.argv[1])
    except Exception as error:  # noqa: BLE001 - surfaced to the caller as JSON
        print(json.dumps({"error": f"cannot open PDF: {error}"}))
        return 1

    # fitz's private _TocClear flag silences slow-to-run warnings on some
    # versions; guarded so older/newer versions without it still work.
    simple_toc = True
    try:
        fitz._TocClear = False  # type: ignore[attr-defined]
        simple_toc = False
    except AttributeError:
        pass

    outline = []
    try:
        toc = doc.get_toc(simple_toc) if hasattr(doc, "get_toc") else []
    except Exception:
        toc = []
    for entry in toc or []:
        try:
            level, title, page = entry[0], entry[1], entry[2]
            title = str(title).strip()
            if not title or not isinstance(level, int) or not isinstance(page, int):
                continue
            if page < 1:
                continue
            outline.append({"level": max(1, min(level, 6)), "title": title, "page": page})
        except Exception:
            continue

    blocks = []
    tables = []
    warnings = []
    text_chars = 0
    pages_with_text = 0

    for page_index in range(doc.page_count):
        try:
            page = doc[page_index]
        except Exception as error:  # noqa: BLE001 - surfaced to the caller as JSON
            # Encrypted PDFs open fine but fail on page access; without this
            # guard the failure escapes as a bare traceback (exit 1) that no
            # classifier can match. Mirror the structured open-failure exit.
            print(json.dumps({"error": f"cannot read PDF pages: {error}"}))
            return 1
        page_no = page_index + 1
        page_tables = []
        try:
            found = page.find_tables()
        except Exception:
            found = None
        if found:
            for table in found.tables:
                try:
                    bbox = [float(v) for v in table.bbox]
                    markdown = table.to_markdown() or ""
                    markdown = markdown.strip()
                    if markdown:
                        page_tables.append({"page": page_no, "bbox": bbox, "markdown": markdown})
                except Exception:
                    continue
        tables.extend(page_tables)

        try:
            laid_out = page.get_text("dict")
        except Exception:
            laid_out = {"blocks": []}
        page_chars = 0
        for block in laid_out.get("blocks", []):
            if block.get("type") != 0:
                continue
            lines = []
            sizes = []
            bold_chars = 0
            span_chars = 0
            for line in block.get("lines", []):
                parts = []
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    if not text.strip():
                        continue
                    parts.append(text)
                    size = float(span.get("size", 0) or 0)
                    if size > 0:
                        sizes.append((size, len(text)))
                    font = str(span.get("font", "")).lower()
                    flags = int(span.get("flags", 0) or 0)
                    if "bold" in font or "heavy" in font or (flags & 16):
                        bold_chars += len(text)
                    span_chars += len(text)
                line_text = "".join(parts).strip()
                if line_text:
                    lines.append(line_text)
            text = "\n".join(lines).strip()
            if not text:
                continue
            weighted = [s * n for s, n in sizes]
            font_size = (sum(weighted) / sum(n for _, n in sizes)) if sizes else 0.0
            bold = span_chars > 0 and bold_chars / span_chars >= 0.5
            blocks.append(
                {
                    "page": page_no,
                    "bbox": [float(v) for v in block.get("bbox", [0, 0, 0, 0])],
                    "fontSize": round(font_size, 2),
                    "bold": bold,
                    "text": text,
                }
            )
            page_chars += len(text)
        if page_chars > 0:
            pages_with_text += 1
        text_chars += page_chars

    if doc.page_count > 0 and pages_with_text / doc.page_count < 0.5:
        warnings.append(
            f"low text-layer coverage: {pages_with_text}/{doc.page_count} pages contain "
            "text; the document is likely scanned and needs the OCR API (ocr-api)"
        )

    print(
        json.dumps(
            {
                "version": 1,
                "pageCount": doc.page_count,
                "outline": outline,
                "blocks": blocks,
                "tables": tables,
                "warnings": warnings,
                "stats": {"textChars": text_chars, "pagesWithText": pages_with_text},
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
