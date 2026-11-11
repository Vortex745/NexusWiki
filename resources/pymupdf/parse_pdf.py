# PDF -> per-page PNG + text layer manifest（PyMuPDF）。stdout 恰好输出一个 JSON 对象，其余信息一律走 stderr。
# 用法: python parse_pdf.py <pdf> <out_dir> [--dpi 150]
import json
import os
import sys


def parse_args(argv):
    pdf = None
    out_dir = None
    dpi = 150
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--dpi":
            i += 1
            if i >= len(argv):
                raise ValueError("--dpi requires a value")
            dpi = int(argv[i])
        elif arg.startswith("--dpi="):
            dpi = int(arg.split("=", 1)[1])
        elif pdf is None:
            pdf = arg
        elif out_dir is None:
            out_dir = arg
        else:
            raise ValueError(f"unexpected argument {arg}")
        i += 1
    if not pdf or not out_dir:
        raise ValueError("usage: python parse_pdf.py <pdf> <out_dir> [--dpi 150]")
    return pdf, out_dir, dpi


def run(pdf, out_dir, dpi):
    import fitz

    document = fitz.open(pdf)
    try:
        os.makedirs(out_dir, exist_ok=True)
        pages = []
        for index, page in enumerate(document):
            pixmap = page.get_pixmap(dpi=dpi)
            image_path = os.path.abspath(os.path.join(out_dir, f"page-{index}.png"))
            pixmap.save(image_path)
            pages.append({"index": index, "imagePath": image_path, "text": page.get_text()})
    finally:
        document.close()
    print(json.dumps({"pageCount": len(pages), "pages": pages}))


def main():
    try:
        pdf, out_dir, dpi = parse_args(sys.argv[1:])
        run(pdf, out_dir, dpi)
    except Exception as exc:
        print(f"parse_pdf failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
