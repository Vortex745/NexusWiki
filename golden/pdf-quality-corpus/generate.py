#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ticket 02：PDF 质量门独立标注语料生成器。

运行：
    python golden/pdf-quality-corpus/generate.py            # 写入语料目录
    python golden/pdf-quality-corpus/generate.py --out DIR  # 写入临时目录（可复现性核对）

一次运行产出：`pdfs/*.pdf`、`corpus-manifest.json`、`coverage-map.json`、
`replay/*.json`。

为什么存在这个文件
------------------
质量门判断的是「这一页的图片」与「这一页的文本」是否一致，所以它需要页级真值。
真值不能从被测实现（builtin-pdf / Clef / Volcengine OCR）的输出里抄，否则门禁
只会给自己的产物盖章。本脚本把每一页「人眼看到什么」作为常量写死（DESIGN 表），
页级期望裁决由 `closedSetRule` 从这些常量推导，然后才把这些常量写进 PDF 字节。
顺序是：先设计真值 → 再生成文件，不是反过来。

独立性
-----
* 标注输入只有 DESIGN 常量与载体声明（文本层 / 图像 / 空页 / 不可读）。
* 生成器不读取任何提取结果来填真值；它只用原始字节检查文件确实按设计写成了这样
  （内容流里的文本字节、`3 Tr` 不可见文本、/Encrypt 是否存在）。
* 页数与「能不能打开」由 Node 端 pdf-lib 在 corpus.test.ts 里独立核对；pdf-lib
  不是生产解析器（生产路径是 scripts/builtin_pdf_extract.py 走 PyMuPDF）。

确定性
------
* 元数据日期固定为 D:20260101000000Z；MuPDF 每次随机写入的 trailer /ID 用样本名
  散列钉死，因此两次生成的字节完全一致（测试跑两遍比对）。
* 例外：PDF AES-256 加密每次写入随机 salt/IV，字节无法复现。该样本在清单里标记
  byteStableOnRegeneration=false，身份由清单 sha256 钉住，并由「没有口令就读不出
  任何页」这一不变量核对。
* 只依赖 PyMuPDF（builtin-pdf 提取脚本已有的本地依赖）与内置 CJK 字体：不联网、
  不下载样本、不依赖任何真实服务、不含任何密钥。
"""

import argparse
import hashlib
import json
import os
import re
import sys

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    sys.stderr.write("PyMuPDF (fitz) is required: pip install pymupdf\n")
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
PRODUCER = "pdf-quality-corpus-generator"
FIXED_DATE = "D:20260101000000Z"
FONT = "china-s"  # MuPDF 内置 CJK 字体：中文 + ASCII 都可绘制，不依赖外部字体文件
PAGE_W, PAGE_H = 595, 842  # A4 pt
RIGHT_MARGIN_KEEP = 68  # 宽度守卫：物理超出页宽的文字会被裁掉，真值与字节就会失配
CLEF_MAX_IMAGES_PER_REQUEST = 4  # 票 01/10 的代码约束：单次请求最多 4 张图
CLEF_TIMEOUT_MS = 10000
OCR_TIMEOUT_MS = 120000  # 与 PARSER_TIMEOUT_MS 同阶
ENCRYPTED_PASSWORD = "pdf-quality-gate-test-vector"

VERDICTS = ["pass", "fail", "uncertain"]
ISSUE_LABELS = [
    "none",
    "text-layer-absent",
    "garbled-text-layer",
    "content-missing",
    "content-fabricated",
    "reading-order-broken",
    "structure-flattened",
    "structure-unverified",
    "page-image-unavailable",
    "document-unreadable",
    "audit-incomplete",
]
DIMENSIONS = ["completeness", "accuracy", "readingOrder", "structureFidelity"]
CARRIERS = [
    "text-layer",
    "image-only",
    "image-plus-text-layer",
    "image-plus-garbled-text-layer",
    "blank",
    "unreadable",
]
PAGE_LAYOUTS = [
    "single-column",
    "two-column",
    "table",
    "image-cover",
    "blank",
    "mixed",
    "rasterized",
    "unreadable",
]
TEXT_ROLES = ["title", "body", "footnote", "table-cell", "formula", "caption", "image-only-text", "label"]
STRUCTURE_OBLIGATIONS = [
    "table-cell-alignment",
    "header-value-relation",
    "column-reading-order",
    "footnote-retention",
    "formula-fidelity",
    "page-position",
    "image-presence",
    "number-and-negation-fidelity",
]
REQUIRED_CATEGORIES = [
    "pure-text",
    "scanned",
    "mixed",
    "blank-page",
    "image-cover",
    "garbled",
    "table",
    "multi-column",
    "encrypted",
    "damaged",
    "unopenable",
]
CATEGORIES = REQUIRED_CATEGORIES + ["footnote", "formula", "partial-rasterization", "batch-splitting"]

# 标签 → 四维评估。闭集标签只有这一张解释表，清单与回放脚本共用它，
# 因此「页裁决」与「逐维证据」不可能互相漂移。
LABEL_DIMENSIONS = {
    "none": {"completeness": "pass", "accuracy": "pass", "readingOrder": "pass", "structureFidelity": "pass"},
    "text-layer-absent": {
        "completeness": "fail",
        "accuracy": "uncertain",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "garbled-text-layer": {
        "completeness": "fail",
        "accuracy": "fail",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "content-missing": {
        "completeness": "fail",
        "accuracy": "uncertain",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "content-fabricated": {
        "completeness": "uncertain",
        "accuracy": "fail",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "reading-order-broken": {
        "completeness": "pass",
        "accuracy": "pass",
        "readingOrder": "fail",
        "structureFidelity": "uncertain",
    },
    "structure-flattened": {
        "completeness": "pass",
        "accuracy": "pass",
        "readingOrder": "uncertain",
        "structureFidelity": "fail",
    },
    "structure-unverified": {
        "completeness": "uncertain",
        "accuracy": "uncertain",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "page-image-unavailable": {
        "completeness": "uncertain",
        "accuracy": "uncertain",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
    "document-unreadable": {
        "completeness": "fail",
        "accuracy": "fail",
        "readingOrder": "fail",
        "structureFidelity": "fail",
    },
    "audit-incomplete": {
        "completeness": "uncertain",
        "accuracy": "uncertain",
        "readingOrder": "uncertain",
        "structureFidelity": "uncertain",
    },
}

CLOSED_SET_RULE = (
    "本地文本候选（stage=local）：1) 载体是纯图像且页面上有人眼可见文字 ⇒ fail + text-layer-absent"
    "（本地文本层按构造不可能表示这些内容）；2) 文本层与页面字形不对应 ⇒ fail + garbled-text-layer；"
    "3) 文本层只覆盖了部分可见内容 ⇒ fail + content-missing；4) 设计上的空页 ⇒ pass + none"
    "（没有可丢失内容，但该页必须作为证据存在）；5) 文本层按设计等于可见内容但带结构义务 ⇒ "
    "uncertain + structure-unverified（表格对齐、表头-值关系、分栏顺序、脚注位置、公式保真都无法"
    "由文档自身自证，pass 只能由逐维证据支撑）；6) 其余纯文本单栏页 ⇒ pass + none；"
    "7) 加密/损坏/不可打开 ⇒ fail + document-unreadable 且 auditEligible=false，不得进入审计。"
    "OCR 候选（stage=ocr-candidate）：干净印刷 raster 的可见内容应被恢复 ⇒ 无结构义务时 pass + none；"
    "带结构义务时仍是 uncertain + structure-unverified。"
)

STRUCTURE_OBLIGATION_RULE = (
    "带结构义务的页面对本地文本候选的独立期望只能是 uncertain：文档自身的声明无法证明义务已被保留，"
    "而发布规则要求 uncertain 阻断激活。pass 只允许出现在逐维证据齐备的回放脚本里；票 07 的评估器"
    "负责拒绝用概率或置信度把 uncertain 折成 pass。"
)


# ---------------------------------------------------------------------------
# 底层写入
# ---------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pin_pdf_id(data: bytes, seed: str) -> bytes:
    """把 MuPDF 每次随机写入的 trailer /ID 换成由样本名派生的固定值。

    只替换 /ID 数组里的两个 32 位十六进制串，字节长度不变，交叉引用偏移仍然有效。
    """
    digest = hashlib.sha256(("qg02:" + seed).encode("utf-8")).hexdigest()
    fixed = b"[<" + digest[:32].encode("ascii") + b"><" + digest[32:64].encode("ascii") + b">]"
    pinned, count = re.subn(rb"/ID\s*\[[^\]]*\]", b"/ID" + fixed, data)
    if count != 1:
        raise AssertionError("expected exactly one trailer /ID entry, got %d" % count)
    return pinned


def new_doc(sample_id: str, title: str):
    doc = fitz.open()
    doc.set_metadata(
        {
            "producer": PRODUCER,
            "creator": PRODUCER,
            "title": title,
            "author": "pdf-quality-corpus",
            "subject": "PDF quality gate fixture corpus (ticket 02)",
            "keywords": "ticket-02 local fixture %s" % sample_id,
            "creationDate": FIXED_DATE,
            "modDate": FIXED_DATE,
        }
    )
    return doc


def add_text(page, x, y, text, size=11, render_mode=0):
    width = fitz.Font(FONT).text_length(text, fontsize=size)
    if x + width > PAGE_W - RIGHT_MARGIN_KEEP:
        raise ValueError("text exceeds printable width (%.0fpt > %dpt): %r" % (x + width, PAGE_W - RIGHT_MARGIN_KEEP, text))
    page.insert_text((x, y), text, fontname=FONT, fontsize=size, render_mode=render_mode)


def raster_page(lines, extra_art=None, dpi=150, size=12):
    """把设计文本渲染成 PNG 字节：页面上确实印着这些字，但没有文本层。"""
    scratch = fitz.open()
    page = scratch.new_page(width=PAGE_W, height=PAGE_H)
    y = 110
    for line in lines:
        add_text(page, 72, y, line, size=size)
        y += 30
    if extra_art:
        extra_art(page, y)
    png = page.get_pixmap(dpi=dpi).tobytes("png")
    scratch.close()
    return png


def insert_full_image(page, png, rect=None):
    page.insert_image(rect or fitz.Rect(36, 36, PAGE_W - 36, PAGE_H - 36), stream=png)


def to_garble(text: str) -> str:
    """UTF-8 字节按 Latin-1 解读的确定性乱码（C1 控制位折进可打印区）。

    这是真实世界「扫描件带了一层坏 OCR 文本」的形状：肉眼看到干净印刷字，文本层
    给出的是一串对不上字形的字符。
    """
    out = []
    for byte in text.encode("utf-8"):
        if 0x80 <= byte < 0xA1:
            out.append(chr(0xB0 + (byte - 0x80)))
        else:
            out.append(chr(byte))
    return "".join(out)


def decompressed_content_streams(data: bytes):
    """把内容流原样取出（只做 deflate 解压），用于按字节确认文件写成了设计的样子。"""
    streams = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        raw = match.group(1)
        try:
            import zlib

            streams.append(zlib.decompress(raw))
        except Exception:
            streams.append(raw)
    return streams


# ---------------------------------------------------------------------------
# DESIGN：逐页真值常量（人眼在这一页上看到什么）
# ---------------------------------------------------------------------------

TITLE = "title"
BODY = "body"
FOOTNOTE = "footnote"
CELL = "table-cell"
LABEL = "label"
FORMULA = "formula"
CAPTION = "caption"
IMAGE = "image-only-text"

PURE_TEXT = [
    [
        ("质量门语料：纯文本样本", TITLE),
        ("第一页：退款政策适用于所有 2026 年的订单。", BODY),
        ("订单 A-2026-1001，金额 50 元，校验词 纯-1。", BODY),
    ],
    [
        ("第二页：不支持过期后补办，也不支持跨店抵扣。", BODY),
        ("Order A-2026-1002: quantity 3, unit price 12.5。", BODY),
        ("审核时限为三个工作日，校验词 纯-2。", BODY),
    ],
    [
        ("第三页：申诉渠道 support@example.com。", BODY),
        ("结尾校验词：终线-质量门-88。", BODY),
    ],
]

LONG_TEXT = [[("纯文本长样本 第%d页：批次切分用页，校验词 长-%d。" % (i, i), BODY)] for i in range(1, 7)]

SCANNED = [
    [
        ("扫描件第一页：这是纯图像页，没有文本层。", IMAGE),
        ("发票号 INV-77881，校验词 扫-1。", IMAGE),
    ],
    [
        ("扫描件第二页：图像里的正文第二段。", IMAGE),
        ("本页只有像素，校验词 扫-2。", IMAGE),
    ],
]

MIXED = [
    [("混合样本第一页：文本层存在，校验词 混-1。", BODY)],
    [("混合样本第二页：这一页只有图像，校验词 混-2。", IMAGE)],
    [("混合样本第三页：文本层存在，校验词 混-3。", BODY)],
]

BLANK = [
    [("空页样本第一页：校验词 空-1。", BODY)],
    [],
    [("空页样本第三页：页位必须保持为第三页，校验词 空-3。", BODY)],
]

COVER_TITLE = [
    ("封面（整页图像）：产品质量门验收", IMAGE),
    ("COVER-42", IMAGE),
]
COVER_BODY = [("正文第一页：封面之后从这里开始，校验词 封-2。", BODY)]

GARBLED_VISIBLE = [("本页肉眼看到的是正常印刷文本：退款时限七天，校验词 乱-1。", IMAGE)]
GARBLED_CONTROL = [("对照页：文本层与页面一致，校验词 乱-2。", BODY)]

TABLE_CELLS = [
    [("费用项目", LABEL), ("金额", LABEL), ("是否可退", LABEL)],
    [("手续费", CELL), ("50元", CELL), ("是", CELL)],
    [("运费", CELL), ("30元", CELL), ("否", CELL)],
    [("打包费", CELL), ("20元", CELL), ("是", CELL)],
]
TABLE_NOTE = ("表格下方说明：以上费率不含税，校验词 表-1。", BODY)
TABLE_VISIBLE = [cell for row in TABLE_CELLS for cell in row] + [TABLE_NOTE]

TWO_COLUMN_LEFT = [
    ("左栏一：退货时限为七天。", BODY),
    ("左栏二：需保留原始包装。", BODY),
    ("左栏三：运费由买家承担，不支持口头承诺。", BODY),
]
TWO_COLUMN_RIGHT = [
    ("右栏一：发票需在三十天内开具。", BODY),
    ("右栏二：金额上限 500 元。", BODY),
    ("右栏三：校验词 栏-1。", BODY),
]

FOOTNOTE_BODY = [
    ("脚注样本标题", TITLE),
    ("正文一：退款申请需在七天内提交。", BODY),
    ("正文二：不支持口头申请。", BODY),
    ("正文三：审核时限为三个工作日。", BODY),
]
FOOTNOTE_LINE = ("※ 脚注：本条款不适用于 2026-01-01 之前的订单。", FOOTNOTE)

FORMULA_LINES = [
    ("公式样本标题", TITLE),
    ("勾股定理 a^2 + b^2 = c^2 与圆周率 3.14159。", FORMULA),
    ("级数求和 1 + 1/4 + 1/9 = 1.3611，校验词 式-1。", FORMULA),
]

PARTIAL_TEXT_LINES = [
    ("混排页第一行：这一行在文本层里。", BODY),
    ("混排页第二行：这一行也在文本层里。", BODY),
]
PARTIAL_IMAGE_LINE = ("混排页第三行：这一行只存在于图像里，校验词 缺-3。", IMAGE)
PARTIAL_CAPTION = ("图 1：上方插图在文本层里没有对应物。", CAPTION)
PARTIAL_VISIBLE = PARTIAL_TEXT_LINES + [PARTIAL_IMAGE_LINE, PARTIAL_CAPTION]


def design(page, carrier, layout, visible, text_layer, obligations=(), blank=False, note=None):
    return {
        "page": page,
        "carrier": carrier,
        "layout": layout,
        "blankByDesign": blank,
        "textLayerAuthored": text_layer,
        "visible": [{"line": line, "role": role} for line, role in visible],
        "structureObligations": list(obligations),
        "note": note,
    }


# ---------------------------------------------------------------------------
# 期望裁决的推导（这就是 closedSetRule 的实现；输入只有 DESIGN 常量）
# ---------------------------------------------------------------------------


def derive_local_expectation(item, openable=True):
    if not openable:
        return {"verdict": "fail", "issueLabels": ["document-unreadable"]}
    if item["blankByDesign"]:
        return {"verdict": "pass", "issueLabels": ["none"]}
    if item["textLayerAuthored"] == "garbled":
        return {"verdict": "fail", "issueLabels": ["garbled-text-layer"]}
    if item["carrier"] == "image-only" and item["visible"]:
        return {"verdict": "fail", "issueLabels": ["text-layer-absent"]}
    if item["textLayerAuthored"] == "faithful-partial":
        return {"verdict": "fail", "issueLabels": ["content-missing"]}
    if item["structureObligations"]:
        return {"verdict": "uncertain", "issueLabels": ["structure-unverified"]}
    return {"verdict": "pass", "issueLabels": ["none"]}


def derive_ocr_expectation(item, openable=True):
    if not openable:
        return {"verdict": "fail", "issueLabels": ["document-unreadable"]}
    if item["blankByDesign"] or not item["visible"]:
        return {"verdict": "pass", "issueLabels": ["none"]}
    if item["structureObligations"]:
        return {"verdict": "uncertain", "issueLabels": ["structure-unverified"]}
    return {"verdict": "pass", "issueLabels": ["none"]}


def with_dimensions(expectation):
    result = dict(expectation)
    labels = expectation["issueLabels"]
    result["dimensions"] = {
        dimension: (
            "fail"
            if any(LABEL_DIMENSIONS[label][dimension] == "fail" for label in labels)
            else "uncertain"
            if any(LABEL_DIMENSIONS[label][dimension] == "uncertain" for label in labels)
            else "pass"
        )
        for dimension in DIMENSIONS
    }
    return result


def annotate_page(item, openable):
    """把 DESIGN 常量变成页标注；来源只可能是这条设计，绝不可能来自被测实现。"""
    local = with_dimensions(derive_local_expectation(item, openable))
    ocr = with_dimensions(derive_ocr_expectation(item, openable))
    if openable:
        properties = ["declared-carrier:%s" % item["carrier"], "declared-text-layer:%s" % item["textLayerAuthored"]]
        if item["visible"]:
            properties.append("declared-visible-line-count:%d" % len(item["visible"]))
        if item["structureObligations"]:
            properties.append("declared-structure-obligations:%s" % ",".join(item["structureObligations"]))
        if item["blankByDesign"]:
            properties.append("declared-blank-by-design")
    else:
        properties = ["file-not-openable-by-any-pdf-reader"]
    return {
        "page": item["page"],
        "carrier": item["carrier"],
        "layout": item["layout"],
        "blankByDesign": item["blankByDesign"],
        "textLayerAuthored": item["textLayerAuthored"],
        "visible": item["visible"],
        "structureObligations": item["structureObligations"],
        "expected": {"local": local, "ocrCandidate": ocr},
        "annotation": {
            "authoredBy": "ticket-02:generate.py DESIGN table",
            "independentOfImplementationOutput": True,
            "derivation": (
                "closedSetRule 命中记录：载体=%s，文本层设计=%s，结构义务=%s，可见行数=%d，"
                "文件可独立打开=%s ⇒ local=%s + %s，ocr-candidate=%s + %s。可见内容由 generate.py "
                "常量逐字给出，写 PDF 之前就已确定。"
            )
            % (
                item["carrier"],
                item["textLayerAuthored"],
                ",".join(item["structureObligations"]) or "-",
                len(item["visible"]),
                openable,
                local["verdict"],
                local["issueLabels"][0],
                ocr["verdict"],
                ocr["issueLabels"][0],
            ),
            "consultedSources": [],
            "documentPropertyUsed": properties,
        },
        "note": item.get("note"),
    }


# ---------------------------------------------------------------------------
# fixture 构造：PDF 字节 + 页设计
# ---------------------------------------------------------------------------

FIXTURES = []


def register(
    fixture_id,
    categories,
    pages,
    production_method,
    production_notes,
    build=None,
    custom=None,
    openable=True,
    byte_stable=True,
    password=None,
    password_note=None,
    title=None,
):
    for known in (item["fixtureId"] for item in FIXTURES):
        if known == fixture_id:
            raise AssertionError("duplicate fixture id %s" % fixture_id)
    FIXTURES.append(
        {
            "fixtureId": fixture_id,
            "categories": categories,
            "pages": pages,
            "productionMethod": production_method,
            "productionNotes": production_notes,
            "build": build,
            "custom": custom,
            "openable": openable,
            "byteStable": byte_stable,
            "password": password,
            "passwordNote": password_note,
            "title": title or ("PDF 质量门语料样本 %s" % fixture_id),
        }
    )


def generic_text_doc(sample):
    """纯文本类样本：按 visible 常量逐页写文本层（title 用 16pt，其余 11pt）。"""
    doc = new_doc(sample["fixtureId"], sample["title"])
    for page in sample["pages"]:
        target = doc.new_page(width=PAGE_W, height=PAGE_H)
        y = 110
        for index, item in enumerate(page["visible"]):
            size = 16 if index == 0 and item["role"] == TITLE else 11
            add_text(target, 72, y, item["line"], size=size)
            y += 30
    return doc


def build_scanned(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    for lines in SCANNED:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        insert_full_image(page, raster_page([line for line, _role in lines]))
    return doc


def build_mixed(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, MIXED[0][0][0], size=11)
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    insert_full_image(page, raster_page([MIXED[1][0][0]]))
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, MIXED[2][0][0], size=11)
    return doc


def build_blank(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, BLANK[0][0][0], size=11)
    doc.new_page(width=PAGE_W, height=PAGE_H)  # 第二页：什么都不写
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, BLANK[2][0][0], size=11)
    return doc


def cover_art(page, start_y):
    for row in range(6):
        rect = fitz.Rect(72 + row * 68, start_y + 30, 122 + row * 68, start_y + 170)
        page.draw_rect(rect, color=(0.1, 0.1, 0.1), fill=(0.15 + row * 0.12, 0.2, 0.85 - row * 0.1), width=1)


def build_image_cover(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    insert_full_image(page, raster_page([line for line, _role in COVER_TITLE], extra_art=cover_art))
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, COVER_BODY[0][0], size=11)
    return doc


def build_garbled(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    clean = GARBLED_VISIBLE[0][0]
    insert_full_image(page, raster_page([clean]))
    # 同一区域写一层不可见文本（render mode 3：既不填充也不描边）。
    add_text(page, 76, 112, to_garble(clean), size=5, render_mode=3)
    add_text(page, 76, 120, to_garble("校验词 乱-1"), size=5, render_mode=3)
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, GARBLED_CONTROL[0][0], size=11)
    return doc


def text_layer_hex(data: bytes) -> bytes:
    """把内容流里所有 <hex> 字面量拼接成一个可搜索的串。

    china-s 以 Identity 编码写入，CID 等于码位，因此这段十六进制就是文本层的
    UTF-16BE 表示。按原始字节校验文本层属于构造核对，不是提取器输出。
    """
    joined = b"".join(
        stream for stream in decompressed_content_streams(data) if b"Tf" in stream or b"TJ" in stream
    )
    runs = re.findall(rb"<([0-9A-Fa-f\s]*)>", joined)
    return b"".join(re.sub(rb"\s", b"", run) for run in runs).lower(), joined


def check_garbled_bytes(data, sample_id):
    hex_stream, joined = text_layer_hex(data)
    if b"3 Tr" not in joined:
        raise AssertionError("%s: invisible (render mode 3) text layer was not written" % sample_id)
    clean = GARBLED_VISIBLE[0][0]
    if to_garble(clean).encode("utf-16-be").hex().encode("ascii") not in hex_stream:
        raise AssertionError("%s: garbled text layer bytes are not in the content stream" % sample_id)
    if clean.encode("utf-16-be").hex().encode("ascii") in hex_stream:
        raise AssertionError("%s: the clean line must not also exist as a text layer" % sample_id)


def build_table(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    x_edges = [72, 196, 320, 444]
    y_edges = [110, 150, 190, 230, 270]
    for x in x_edges:
        page.draw_line((x, y_edges[0]), (x, y_edges[-1]))
    for y in y_edges:
        page.draw_line((x_edges[0], y), (x_edges[-1], y))
    for row_index, row in enumerate(TABLE_CELLS):
        for col_index, (cell, _role) in enumerate(row):
            add_text(page, x_edges[col_index] + 6, y_edges[row_index] + 28, cell, size=10)
    add_text(page, 72, 320, TABLE_NOTE[0], size=11)
    return doc


def build_two_column(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 140
    for line, _role in TWO_COLUMN_LEFT:
        add_text(page, 72, y, line, size=11)
        y += 34
    y = 140
    for line, _role in TWO_COLUMN_RIGHT:
        add_text(page, 315, y, line, size=11)
        y += 34
    return doc


def build_footnote(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 110
    for index, (line, _role) in enumerate(FOOTNOTE_BODY):
        add_text(page, 72, y, line, size=16 if index == 0 else 11)
        y += 32
    add_text(page, 72, 780, FOOTNOTE_LINE[0], size=8)
    return doc


def build_formula(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 110
    for index, (line, _role) in enumerate(FORMULA_LINES):
        add_text(page, 72, y, line, size=16 if index == 0 else 11)
        y += 34
    return doc


def build_partial(sample):
    doc = new_doc(sample["fixtureId"], sample["title"])
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 110, PARTIAL_TEXT_LINES[0][0], size=11)
    add_text(page, 72, 142, PARTIAL_TEXT_LINES[1][0], size=11)
    page.insert_image(fitz.Rect(72, 168, PAGE_W - 120, 240), stream=raster_page([PARTIAL_IMAGE_LINE[0]], size=13))
    add_text(page, 72, 270, PARTIAL_CAPTION[0], size=11)
    return doc


def check_partial_bytes(data, sample_id):
    hex_stream, _joined = text_layer_hex(data)
    if PARTIAL_IMAGE_LINE[0].encode("utf-16-be").hex().encode("ascii") in hex_stream:
        raise AssertionError("%s: the image-only line must not be present in the text layer" % sample_id)
    for line, _role in PARTIAL_TEXT_LINES + [PARTIAL_CAPTION]:
        if line.encode("utf-16-be").hex().encode("ascii") not in hex_stream:
            raise AssertionError("%s: text-layer line missing: %s" % (sample_id, line))


def write_encrypted(out_path):
    doc = new_doc("encrypted-aes256", "PDF 质量门语料：口令加密样本")
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, "加密样本：这一页只有用口令才能读出来。", size=11)
    data = doc.tobytes(
        garbage=4,
        deflate=True,
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw=ENCRYPTED_PASSWORD,
        user_pw=ENCRYPTED_PASSWORD,
    )
    doc.close()
    if b"/Encrypt" not in data:
        raise AssertionError("encrypted-aes256: no /Encrypt dictionary was written")
    if ENCRYPTED_PASSWORD.encode("ascii") in data:
        raise AssertionError("encrypted-aes256: the password must not appear in the file bytes")
    with open(out_path, "wb") as handle:
        handle.write(data)
    return data, {"encryptDictionary": True, "cleartextBodyBytes": False}


def write_damaged_truncated(out_path):
    doc = new_doc("damaged-truncated", "PDF 质量门语料：截断损坏样本")
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    add_text(page, 72, 120, "损坏样本：本文件被确定性截断到 45%。", size=11)
    good = pin_pdf_id(doc.tobytes(garbage=4, deflate=True), "damaged-truncated")
    doc.close()
    data = good[: int(len(good) * 0.45)]
    if b"startxref" in data or b"trailer" in data:
        raise AssertionError("damaged-truncated: the cut kept the cross-reference table")
    with open(out_path, "wb") as handle:
        handle.write(data)
    return data, {"intactSourceBytes": len(good), "damageMethod": "deterministic-truncation-to-45-percent"}


def write_damaged_objects(out_path):
    """第二个损坏样本：把每个间接对象的 `N 0 obj` 关键字改成 `N 0 Xbj`。

    为什么不用"只清掉交叉引用表"：实测宽容的阅读器（PyMuPDF 与 pdf-lib）会自行重建页树并读出
    全部两页，那种样本的"能不能打开"取决于阅读器宽容度，不是文档事实，因此不能作为
    document-unreadable 的语料。破坏对象关键字后两个阅读器都拒绝，见
    readerToleranceObservations。
    """
    doc = new_doc("damaged-corrupt-object-headers", "PDF 质量门语料：对象关键字破坏样本")
    for index in (1, 2):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        add_text(page, 72, 120, "对象关键字破坏样本第 %d 页。" % index, size=11)
    good = pin_pdf_id(doc.tobytes(garbage=4, deflate=True), "damaged-corrupt-object-headers")
    doc.close()
    intact_objects = good.count(b" 0 obj")
    if intact_objects < 5:
        raise AssertionError("damaged-corrupt-object-headers: expected at least 5 indirect objects")
    data = good.replace(b" 0 obj", b" 0 Xbj")
    if b" 0 obj" in data:
        raise AssertionError("damaged-corrupt-object-headers: an object header survived")
    with open(out_path, "wb") as handle:
        handle.write(data)
    return data, {
        "intactSourceBytes": len(good),
        "intactObjectCount": intact_objects,
        "damageMethod": "every-indirect-object-keyword-rewritten-0-obj-to-0-Xbj",
    }


def write_not_a_pdf(out_path):
    """不可打开样本：一份真正的复合文档（OLE）容器字节，文件名是 .pdf。

    这里刻意不用 PNG/JPEG 图像字节：实测 PyMuPDF 会把图片当成一页文档正常打开，
    "打不开"就不是文档事实而是阅读器差异（见 readerToleranceObservations）。OLE 容器
    与随机二进制载荷被 pdf-lib 与 PyMuPDF 双双拒绝，因此选 OLE。
    """
    header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # OLE 复合文档魔数（.doc/.xls 家族）
    body = b"".join(
        hashlib.sha256(("qg02-not-a-pdf-%04d" % index).encode("utf-8")).digest() for index in range(16)
    )
    data = header + body
    if data[:4] == b"%PD" or data[:4] == b"\x89PNG":
        raise AssertionError("unopenable-not-a-pdf: bytes must not look like a PDF or an image")
    with open(out_path, "wb") as handle:
        handle.write(data)
    return data, {"firstFourBytesHex": data[:4].hex(), "container": "ole-compound-file", "containsPdfHeader": False}


def write_stub_header(out_path):
    data = (
        b"%PDF-1.7\n"
        b"% pdf-quality-corpus deliberately object-free stub: no catalog, no cross-reference\n"
        b"not-an-indirect-object 0123456789\n"
        b"%%EOF\n"
    )
    if b"0 obj" in data:
        raise AssertionError("unopenable-stub-header: stub must not contain any indirect object")
    with open(out_path, "wb") as handle:
        handle.write(data)
    return data, {"firstFourBytesHex": data[:4].hex(), "containsIndirectObject": False}


BYTES_CHECKS = {"garbled": check_garbled_bytes, "partially-rasterized": check_partial_bytes}

register(
    "pure-text",
    ["pure-text"],
    [
        design(1, "text-layer", "single-column", PURE_TEXT[0], "faithful"),
        design(2, "text-layer", "single-column", PURE_TEXT[1], "faithful"),
        design(3, "text-layer", "single-column", PURE_TEXT[2], "faithful"),
    ],
    "PyMuPDF 新建 3 页 A4，用内置 china-s 字体把设计常量逐行写进文本层；固定元数据日期并钉死 trailer /ID。",
    "文本层内容与可见内容按构造一一对应，因此本地候选的独立期望只能是 pass + none。",
    build=generic_text_doc,
)

register(
    "text-long-6p",
    ["pure-text", "batch-splitting"],
    [design(index, "text-layer", "single-column", LONG_TEXT[index - 1], "faithful") for index in range(1, 7)],
    "同上，但生成 6 页，用来证明「每次最多 4 张图」的切分场景有真实文件可喂。",
    "票 09/10 用它断言超限输入必须切分而不是静默截断。",
    build=generic_text_doc,
)

register(
    "scanned-textless",
    ["scanned"],
    [
        design(1, "image-only", "rasterized", SCANNED[0], "absent", note="整页是 150dpi 的印刷字 raster，没有文本层。"),
        design(2, "image-only", "rasterized", SCANNED[1], "absent"),
    ],
    "把设计文本先渲染成 PNG（raster_page），再整页插入目标 PDF；插入图像不会创建文本层。",
    "本机没有 scanner：扫描件用「数字排版渲染成图像」这一诚实 route 产生，raster 是干净印刷体，"
    "所以 OCR 候选的期望是 pass；真实复印件退化在 coverage-map.unrepresented 里显式登记。",
    build=build_scanned,
)

register(
    "mixed-text-scan",
    ["mixed", "scanned"],
    [
        design(1, "text-layer", "single-column", MIXED[0], "faithful"),
        design(2, "image-only", "rasterized", MIXED[1], "absent", note="第 2 页整页是图像。"),
        design(3, "text-layer", "single-column", MIXED[2], "faithful"),
    ],
    "第 1、3 页写文本层；第 2 页整页插入渲染好的 PNG。",
    "文档级「部分成功」的形状：本地审计必须给出页级 fail，而不是一个整篇结论。",
    build=build_mixed,
)

register(
    "blank-page",
    ["blank-page"],
    [
        design(1, "text-layer", "single-column", BLANK[0], "faithful"),
        design(2, "blank", "blank", [], "absent", obligations=["page-position"], blank=True,
               note="设计上的空页：页上什么都没有，但这一页必须作为一条证据存在。"),
        design(3, "text-layer", "single-column", BLANK[2], "faithful"),
    ],
    "三页 A4，第二页 new_page() 之后不写任何内容、也不写文本层。",
    "空页不是「缺页」：票 05 要求每一页都产出文本记录与预览。",
    build=build_blank,
)

register(
    "image-cover",
    ["image-cover"],
    [
        design(1, "image-only", "image-cover", COVER_TITLE, "absent",
               note="封面整页是一张 raster：标题文字与装饰色块都在像素里。"),
        design(2, "text-layer", "single-column", COVER_BODY, "faithful"),
    ],
    "在临时页上渲染标题文字 + 六个填充色块（draw_rect），整页转 150dpi PNG 后作为第 1 页插入。",
    "图像封面是「有可见文字但没有文本层」的典型页；图片语义本身登记为能力缺口。",
    build=build_image_cover,
)

register(
    "garbled",
    ["garbled"],
    [
        design(1, "image-plus-garbled-text-layer", "rasterized", GARBLED_VISIBLE, "garbled",
               note="可见文字来自 raster；文本层是 UTF-8→Latin-1 的确定性乱码，以 render mode 3 不可见写入。"),
        design(2, "text-layer", "single-column", GARBLED_CONTROL, "faithful"),
    ],
    "第 1 页先插入干净印刷 raster，再在同一坐标用 render_mode=3（既不填充也不描边，肉眼不可见）写入 "
    "to_garble() 产生的乱码文本层；第 2 页是正常的忠实文本层作为对照。",
    "这是真实扫描件带坏 OCR 文本层的形状：肉眼读到正常文字，文本层读到乱码，因此该页图像与该页文本"
    "必须判 fail + garbled-text-layer。生成器会按原始字节校验乱码确实在内容流里、干净句子确实不在。",
    build=build_garbled,
)

register(
    "table-grid",
    ["table"],
    [
        design(1, "text-layer", "table", TABLE_VISIBLE, "faithful",
               obligations=["table-cell-alignment", "header-value-relation", "number-and-negation-fidelity"],
               note="网格线与单元格文字都在文本层；行列对应关系必须由证据证明，不能由页数证明。")
    ],
    "draw_line 画 4 列 x 4 行网格，逐格用文本层写入表头（label）与数据（table-cell），表下再写一行正文说明。",
    "可见内容按「表头行→数据行→说明行」的阅读顺序登记，文本层内容是完整的；期望仍是 uncertain，"
    "因为表格对齐与表头-值关系是否保留无法由文档自身自证。",
    build=build_table,
)

register(
    "two-column",
    ["multi-column"],
    [
        design(1, "text-layer", "two-column", TWO_COLUMN_LEFT + TWO_COLUMN_RIGHT, "faithful",
               obligations=["column-reading-order", "number-and-negation-fidelity"],
               note="内容流先写满左栏再写右栏；人眼阅读顺序同样是左栏→右栏。")
    ],
    "一页 A4，左栏 x=72、右栏 x=315，各自按 y 递增写入；内容流顺序刻意与阅读顺序一致。",
    "分栏的判定不依赖「内容是否都在」，而依赖「顺序是否还是左栏→右栏」，所以期望是 uncertain。",
    build=build_two_column,
)

register(
    "footnote",
    ["footnote", "multi-column"],
    [
        design(1, "text-layer", "single-column", FOOTNOTE_BODY + [FOOTNOTE_LINE], "faithful",
               obligations=["footnote-retention", "page-position"],
               note="脚注是 8pt、位于页底 y=780 的可见正文；任何页脚过滤器把它当噪声丢掉都是内容损失。")
    ],
    "正文 16/11pt 写在页面上部，脚注 8pt 写在页底（y=780），全部走文本层。",
    "脚注与正文同页且都必须保留；是否被页眉页脚过滤吞掉属于结构保真，期望 uncertain。",
    build=build_footnote,
)

register(
    "formula-inline",
    ["formula"],
    [
        design(1, "text-layer", "single-column", FORMULA_LINES, "faithful",
               obligations=["formula-fidelity"],
               note="公式用普通文本字符写成（a^2 + b^2 = c^2、1 + 1/4 + 1/9 = 1.3611），不依赖任何特殊字形。")
    ],
    "文本层逐行写入含幂标记与分式的公式文本，全部使用 ASCII 数学写法以避免字体缺字。",
    "风险在于候选可能把 a^2 变成 a2 或整段重排；这属于文本准确性与结构保真，期望 uncertain。",
    build=build_formula,
)

register(
    "partially-rasterized",
    ["partial-rasterization", "mixed"],
    [
        design(1, "image-plus-text-layer", "mixed", PARTIAL_VISIBLE, "faithful-partial",
               obligations=["image-presence", "page-position"],
               note="第 1、2 行与图注在文本层里；第 3 行只作为图像像素存在。")
    ],
    "同一页上混排：两行正文 + 一段只存在于 PNG 图像里的文字 + 一行图注。",
    "可见内容有一部分永远进不了文本层，因此本地候选必须 fail + content-missing，"
    "而不是整页都没有文本。生成器按原始字节校验第 3 行确实不在文本层里。",
    build=build_partial,
)

register(
    "encrypted-aes256",
    ["encrypted"],
    [design(1, "unreadable", "unreadable", [], "unreadable",
            note="页树能被枚举（阅读器报 1 页），但没有任何一页的内容能在无口令下读出，因此不登记可见行。")],
    "PyMuPDF 以 PDF_ENCRYPT_AES_256、owner_pw 与 user_pw 保存：/Encrypt 字典存在，字符串与流全部加密。",
    "口令写在清单里，是公开测试向量而不是凭据：它不指向任何服务或账号，也不来自任何环境变量。"
    "实测 pdf-lib 直接拒绝加载，PyMuPDF 打开后读取任何一页都会抛错。",
    custom=write_encrypted,
    openable=False,
    byte_stable=False,
    password=ENCRYPTED_PASSWORD,
    password_note=(
        "fixture 口令是公开测试向量，用来证明「没有口令就读不出来」；它不是凭据，不指向任何服务或账号。"
    ),
)

register(
    "damaged-truncated",
    ["damaged"],
    [design(1, "unreadable", "unreadable", [], "unreadable",
            note="交叉引用表与 trailer 都在截断区间之外：没有任何阅读器能重建页树。")],
    "先生成一份完整 1 页 PDF，再按字节数保留前 45%（截掉交叉引用表与 trailer），不引入随机性。",
    "损坏方式是写死的比例切片，任何一次重跑都落到同一个字节长度；生成器断言截断结果里已无 startxref/trailer，"
    "并实测 pdf-lib 与 PyMuPDF 都拒绝打开该文件。",
    custom=write_damaged_truncated,
    openable=False,
)

register(
    "damaged-corrupt-object-headers",
    ["damaged"],
    [
        design(1, "unreadable", "unreadable", [], "unreadable"),
        design(2, "unreadable", "unreadable", [], "unreadable"),
    ],
    "先生成完整 2 页 PDF，再把每一个间接对象的关键字 `N 0 obj` 等长改写为 `N 0 Xbj`（对象数量、"
    "trailer 与 startxref 都原样保留）。",
    "这是「对象全部无法解析」的损坏：没有任何阅读器能靠重建交叉引用救回来。刻意不采用「只清掉交叉引用表」"
    "的损坏方式，因为实测两个阅读器都会自行重建并读出全部两页，那种样本的能不能打开取决于阅读器宽容度。",
    custom=write_damaged_objects,
    openable=False,
)

register(
    "unopenable-not-a-pdf",
    ["unopenable"],
    [],
    "写入 OLE 复合文档魔数（D0 CF 11 E0 A1 B1 1A E1）+ 由 sha256 确定性生成的 512 字节载荷，文件名 .pdf。",
    "这类输入在任何提取器之前就该被判为打不开：它根本不是 PDF，因此不声明页数。刻意不用图片字节，"
    "因为实测 PyMuPDF 会把 PNG 当作文档打开。",
    custom=write_not_a_pdf,
    openable=False,
)

register(
    "unopenable-stub-header",
    ["unopenable"],
    [],
    "手写固定字节：保留 %PDF-1.7 头与 %%EOF，但整份文件不含任何间接对象、没有目录、没有交叉引用表。",
    "只有头的「PDF」是打不开的：它连「有哪些页」都无法声明，因此 pageCount=0、页真值为空。",
    custom=write_stub_header,
    openable=False,
)


# ---------------------------------------------------------------------------
# 生成 fixture 条目
# ---------------------------------------------------------------------------


def build_fixture_entry(sample, out_dir):
    pdf_dir = os.path.join(out_dir, "pdfs")
    os.makedirs(pdf_dir, exist_ok=True)
    out_path = os.path.join(pdf_dir, sample["fixtureId"] + ".pdf")
    extra = {}
    if sample["custom"]:
        data, extra = sample["custom"](out_path)
    else:
        doc = sample["build"](sample)
        raw = doc.tobytes(garbage=4, deflate=True)
        doc.close()
        data = pin_pdf_id(raw, sample["fixtureId"])
        extra["idPinned"] = True
        extra["trailerIdDerivedFrom"] = "sha256(qg02:%s)" % sample["fixtureId"]
        with open(out_path, "wb") as handle:
            handle.write(data)
    check = BYTES_CHECKS.get(sample["fixtureId"])
    if check:
        check(data, sample["fixtureId"])
    pages = [annotate_page(item, sample["openable"]) for item in sample["pages"]]
    entry = {
        "fixtureId": sample["fixtureId"],
        "file": "pdfs/%s.pdf" % sample["fixtureId"],
        "categories": sample["categories"],
        "fileSha256": sha256_bytes(data),
        "fileBytes": len(data),
        "pageCount": len(pages),
        "evidencePageCount": len(pages),
        "pageMappingFormat": "1-based-contiguous",
        "byteStableOnRegeneration": sample["byteStable"],
        "openableByIndependentReader": sample["openable"],
        "auditEligible": sample["openable"],
        "documentOutcome": "auditable" if sample["openable"] else "input-failure",
        "documentExpectation": (
            {
                "verdict": "fail",
                "issueLabels": ["document-unreadable"],
                "requiresZeroServiceCalls": True,
                "note": "必须在任何 Clef/OCR 调用之前判为输入失败，不得被当成质量 pass，也不得产出部分内容后宣布成功。",
            }
            if not sample["openable"]
            else {
                "verdict": None,
                "issueLabels": [],
                "requiresZeroServiceCalls": False,
                "note": "整篇结果由逐页裁决归约得出，清单不预设 pass：票 07/09 的归约器负责全页 pass 的条件。",
            }
        ),
        "productionMethod": sample["productionMethod"],
        "productionNotes": sample["productionNotes"],
        "sourceDocument": {
            "identity": "qg02-%s" % sample["fixtureId"],
            "kind": "locally-generated",
            "origin": "由本仓库的 golden/pdf-quality-corpus/generate.py 生成，不是下载或第三方的真实业务文档。",
            "title": sample["title"],
            "producer": PRODUCER,
            "creationDateFixed": FIXED_DATE,
            "downloadUrl": None,
        },
        "pages": pages,
    }
    if sample["password"]:
        entry["fixturePasswordTestVector"] = sample["password"]
        entry["passwordIsNotACredential"] = True
        entry["passwordNote"] = sample["passwordNote"]
    if not sample["byteStable"]:
        entry["byteStabilityNote"] = (
            "PDF AES-256 加密每次写入随机 salt/IV，因此重跑生成的字节会变；样本身份由这里的 sha256 钉住，"
            "并由「没有口令就读不出任何页」这一不变量核对。"
        )
    entry.update(extra)
    return entry, data


# ---------------------------------------------------------------------------
# 覆盖图
# ---------------------------------------------------------------------------

COVERAGE_TABLE = [
    ("pure-text-all-pages-pass", "纯文本样本每页都应判 pass：门禁不得把好文件判坏。", ["pure-text"],
     ["pure-text", "text-long-6p"], ["clef-local-audit--pass--pure-text", "clef-local-audit--pass--text-long-6p-batch-1",
                                     "clef-local-audit--pass--text-long-6p-batch-2"], None, None),
    ("textless-scan-needs-ocr", "整篇无文本层的扫描件必须走到 OCR 而不是在提取器空文本处失败。", ["scanned"],
     ["scanned-textless"], ["clef-local-audit--fail--scanned-textless", "ocr--faithful-candidate--scanned-textless",
                            "clef-second-audit--pass--scanned-textless"], None, None),
    ("mixed-document-partial-failure", "文本页与图像页混排：审计结论必须是页级的，不能是整篇的。", ["mixed"],
     ["mixed-text-scan", "partially-rasterized"], ["clef-local-audit--fail--mixed-text-scan",
                                                   "clef-second-audit--fail--mixed-text-scan"], None, None),
    ("blank-page-still-evidenced", "设计上的空页判 pass，但仍必须产出该页的证据。", ["blank-page"], ["blank-page"],
     ["clef-local-audit--pass--blank-page"], None, None),
    ("image-cover-text-only-as-pixels", "整页图像封面上的文字只存在于像素里。", ["image-cover"], ["image-cover"],
     ["clef-local-audit--fail--image-cover", "ocr--faithful-candidate--image-cover",
      "clef-second-audit--pass--image-cover"], None, None),
    ("garbled-text-layer-vs-clean-image", "页面视觉干净但文本层是乱码：图像与文本必须判不一致。", ["garbled"],
     ["garbled"], ["clef-local-audit--fail--garbled-text", "ocr--faithful-candidate--garbled",
      "clef-second-audit--pass--garbled"], None, None),
    ("table-structure-must-be-proven", "表格页：单元格齐全不等于对齐与表头-值关系保真。", ["table"], ["table-grid"],
     ["clef-local-audit--uncertain--table-grid", "clef-local-audit--fail-structure-flattened--table-grid",
      "clef-second-audit--uncertain--table-grid"], None, None),
    ("multi-column-reading-order-must-be-proven", "多栏页：顺序必须是左栏→右栏，否则 readingOrder 失败。",
     ["multi-column"], ["two-column", "footnote"],
     ["clef-local-audit--uncertain--two-column", "clef-second-audit--fail-reading-order--two-column"], None, None),
    ("footnote-retention-must-be-proven", "页底小字脚注必须留在同页正文里。", ["footnote"], ["footnote"],
     ["clef-local-audit--uncertain--footnote"], None, None),
    ("formula-fidelity-must-be-proven", "公式作为文本必须逐字符保真（a^2 不能变成 a2）。", ["formula"],
     ["formula-inline"], ["clef-local-audit--uncertain--formula-inline"], None, None),
    ("visible-content-missing-from-text-layer", "可见内容有一部分只在图像里：本地候选必须 content-missing。",
     ["partial-rasterization", "mixed"], ["partially-rasterized"],
     ["clef-local-audit--fail--partially-rasterized"], None, None),
    ("encrypted-input-failure", "加密 PDF 在任何 Clef/OCR 调用之前就是终态输入失败。", ["encrypted"],
     ["encrypted-aes256"], [], True,
     "票 17 的契约要求加密文件在任何 Clef/OCR 调用发生之前终止，所以这条路径上没有服务应答可以脚本化；"
     "语料提供真实 AES-256 字节，由票 17 断言调用计数为零。"),
    ("damaged-input-failure", "损坏 PDF（截断/交叉引用清零）必须是输入失败而不是质量失败。", ["damaged"],
     ["damaged-truncated", "damaged-corrupt-object-headers"], [], True,
     "损坏文件读不出页，也就没有页级应答可回放；票 17 用真实字节断言输入失败与零服务调用。"),
    ("unopenable-input-failure", "根本不是 PDF 的输入（PNG 字节、只有 %PDF 头）必须显式失败。", ["unopenable"],
     ["unopenable-not-a-pdf", "unopenable-stub-header"], [], True,
     "这类输入没有页结构可言，因此不声明页数，也不需要 Clef/OCR 应答脚本。"),
    ("ocr-candidate-passes-second-audit", "OCR 候选通过第二次逐页审计才允许继续导入。", [],
     ["scanned-textless", "image-cover"], ["ocr--faithful-candidate--scanned-textless",
                                          "clef-second-audit--pass--scanned-textless",
                                          "clef-second-audit--pass--image-cover"], None, None),
    ("ocr-candidate-rejected-second-audit", "OCR 候选在第二次审计里失败：导入必须终止。", [],
     ["mixed-text-scan", "scanned-textless"], ["ocr--incomplete-candidate--mixed-text-scan",
                                               "clef-second-audit--fail--mixed-text-scan"], None, None),
    ("ocr-fabricated-candidate-rejected", "OCR 凭空产出的内容要判 content-fabricated。", [], ["scanned-textless"],
     ["ocr--fabricated-candidate--scanned-textless", "clef-second-audit--fail-fabricated--scanned-textless"], None, None),
    ("uncertain-page-blocks-pass", "任一页 uncertain 都不能让整篇 pass（含审计覆盖不完整）。", [],
     ["two-column", "table-grid", "footnote", "formula-inline", "mixed-text-scan"],
     ["clef-local-audit--uncertain--two-column", "clef-local-audit--uncertain--table-grid",
      "clef-local-audit--uncertain--footnote", "clef-local-audit--uncertain--formula-inline",
      "clef-second-audit--uncertain-audit-incomplete--mixed-text-scan",
      "clef-local-audit--uncertain-page-image-unavailable--pure-text",
      "ocr--blank-page-empty-candidate--blank-page"], None, None),
    ("malformed-clef-response-fails-closed", "语法就无效的 Clef 响应必须 fail-closed，与质量失败分开分类。", [],
     ["pure-text", "scanned-textless"], ["clef-local-audit--malformed--pure-text",
                                        "clef-second-audit--malformed--scanned-textless",
                                        "ocr--malformed-response--scanned-textless"], None, None),
    ("invalid-clef-answer-rejected", "缺页、重复页、未知裁决、未知标签、页号越界都要被拒绝。", [], ["pure-text"],
     ["clef-local-audit--invalid-missing-page--pure-text", "clef-local-audit--invalid-duplicate-page--pure-text",
      "clef-local-audit--invalid-unknown-verdict--pure-text", "clef-local-audit--invalid-unknown-issue-label--pure-text",
      "clef-local-audit--invalid-page-out-of-range--pure-text"], None, None),
    ("clef-timeout-bounded-retry", "Clef 超时走有界重试，重试成功后仍能完成审计。", [], ["pure-text"],
     ["clef-local-audit--timeout-then-pass--pure-text",
      "clef-second-audit--timeout-then-pass--scanned-textless"], None, None),
    ("clef-service-exhausted", "重试耗尽得到服务不可用终态，绝不能变成质量 pass。", [], ["pure-text"],
     ["clef-local-audit--unavailable-exhausted--pure-text"], None, None),
    ("clef-cancellation-persisted-not-quality-fail", "取消要作为取消落盘，而不是被判成质量失败。", [],
     ["pure-text", "scanned-textless"], ["clef-local-audit--cancelled--pure-text",
                                        "clef-second-audit--cancelled--scanned-textless",
                                        "ocr--cancelled--scanned-textless"], None, None),
    ("clef-recovery-reuses-durable-evidence", "恢复时复用已持久化的审计证据，服务调用次数为 0。", [],
     ["pure-text", "scanned-textless"], ["clef-local-audit--recovery-reuse--pure-text",
                                        "clef-second-audit--recovery-reuse--scanned-textless"], None, None),
    ("ocr-timeout-and-recovery", "OCR 超时后的有界重试与恢复复用。", [], ["scanned-textless"],
     ["ocr--timeout-then-faithful--scanned-textless", "ocr--recovery-reuse--scanned-textless"], None, None),
    ("ocr-service-exhausted", "OCR 重试耗尽得到服务不可用终态。", [], ["scanned-textless"],
     ["ocr--unavailable-exhausted--scanned-textless"], None, None),
    ("oversized-input-splitting-below-image-limit", "超过每次 4 张图的上限必须切分，且不静默截断。", [],
     ["text-long-6p"], ["clef-local-audit--pass--text-long-6p", "clef-local-audit--pass--text-long-6p-batch-1",
                        "clef-local-audit--pass--text-long-6p-batch-2"], None, None),
    ("metadata-only-evidence-cannot-pass", "只给元数据不给页面图像的请求必须被记为契约违规。", [],
     ["pure-text", "scanned-textless"], ["clef-local-audit--pass--pure-text",
                                        "clef-local-audit--uncertain-page-image-unavailable--pure-text"], None, None),
    ("multi-script-and-number-fidelity", "中英混排、数值与否定词的文本准确性。", [],
     ["pure-text", "two-column", "table-grid"], ["clef-local-audit--pass--pure-text",
                                                "clef-local-audit--uncertain--two-column"], None, None),
]

UNREPRESENTED = [
    {
        "case": "scanner-photocopy-artifacts",
        "reason": (
            "本机没有 scanner/相机，无法产出真实复印件的倾斜、摩尔纹、低光照与透印退化；"
            "这类图像对 OCR 与审计的额外压力不在本票可诚实复现的范围内。"
        ),
        "approximatedBy": "scanned-textless / image-cover 用 150dpi 数字渲染 raster 近似「无文本层的印刷页」，只保留载体事实。",
    },
    {
        "case": "handwritten-text",
        "reason": "手写内容需要真实笔迹样本，合成字形无法诚实代表手写识别难度，也不应用打印字体冒充。",
        "approximatedBy": None,
    },
    {
        "case": "production-mojibake-pdfs",
        "reason": (
            "真实生产环境里 ToUnicode 损坏的 PDF 需要外部来源；本票不引入无法解释来源的二进制样本。"
        ),
        "approximatedBy": "garbled 用 raster 干净视觉 + render mode 3 不可见乱码文本层合成同一形状，构造方式写在清单里。",
    },
    {
        "case": "live-clef-or-ocr-responses",
        "reason": (
            "本票只提供确定性回放脚本；真实 Clef/OCR 响应属于票 29 的在线质量评估，"
            "不能在这里边写边调外部服务，否则真值会被实现产物污染。"
        ),
        "approximatedBy": "replay/*.json 覆盖 pass/fail/uncertain/malformed/timeout/cancellation/recovery。",
    },
    {
        "case": "signature-form-and-annotation-layers",
        "reason": "数字签名、AcroForm 字段与批注层不是本次质量门的判定对象，没有诚实的页级真值可登记。",
        "approximatedBy": None,
    },
    {
        "case": "encrypted-with-owner-password-only",
        "reason": (
            "只设 owner 口令（内容仍可无口令读取）的文件在质量门语义上不是「打不开」，"
            "放进语料会与 document-unreadable 的定义冲突，故显式不表示。"
        ),
        "approximatedBy": None,
    },
    {
        "case": "zero-byte-upload",
        "reason": "0 字节文件不是 PDF 语料样本，属于上传准入层（票 21/26）的输入校验。",
        "approximatedBy": "unopenable-stub-header 提供「有 %PDF 头但没有任何对象」的更近形状。",
    },
]


def build_coverage_map(fixtures):
    by_id = {entry["fixtureId"]: entry for entry in fixtures}
    scenarios = []
    for scenario_id, description, categories, fixture_ids, replay_ids, replay_free, replay_reason in COVERAGE_TABLE:
        for fixture_id in fixture_ids:
            if fixture_id not in by_id:
                raise AssertionError("coverage %s references unknown fixture %s" % (scenario_id, fixture_id))
        for category in categories:
            if not any(category in by_id[fid]["categories"] for fid in fixture_ids):
                raise AssertionError("coverage %s claims category %s but no mapped fixture carries it" % (scenario_id, category))
        scenarios.append(
            {
                "scenarioId": scenario_id,
                "description": description,
                "categories": categories,
                "fixtureIds": fixture_ids,
                "replayScenarioIds": replay_ids,
                "replayFree": bool(replay_free),
                "replayFreeReason": replay_reason,
            }
        )
    coverage = {
        "schemaVersion": "pdf-quality-coverage-v1",
        "ticket": "pdf-quality-02",
        "requiredCategories": REQUIRED_CATEGORIES,
        "requiredAcceptanceScenarioIds": [entry["scenarioId"] for entry in scenarios],
        "scenarios": scenarios,
        "unrepresented": UNREPRESENTED,
    }
    return coverage


# ---------------------------------------------------------------------------
# 回放脚本
# ---------------------------------------------------------------------------


def corpus_pages(fixture, stage):
    key = "local" if stage == "local" else "ocrCandidate"
    return [
        {
            "page": page["page"],
            "verdict": page["expected"][key]["verdict"],
            "issueLabels": page["expected"][key]["issueLabels"],
            "probability": round(0.93 - 0.01 * page["page"], 2),
            "confidence": round(0.86 - 0.01 * page["page"], 2),
        }
        for page in fixture["pages"]
    ]


def visible_text(fixture, page_number, omit=False, fabricate=None):
    page = next(entry for entry in fixture["pages"] if entry["page"] == page_number)
    lines = [item["line"] for item in page["visible"]]
    if omit:
        lines = []
    if fabricate:
        lines = lines + [fabricate]
    return "\n".join(lines)


def clef_scenario(scenario_id, stage, fixture_id, case_kinds, answers, covers_pages=None, attempts=None,
                  answers_source=None, authored_from="", max_images=CLEF_MAX_IMAGES_PER_REQUEST):
    base = {
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": scenario_id,
        "service": "clef",
        "stage": stage,
        "fixture": fixture_id,
        "caseKinds": case_kinds,
        "coversPages": covers_pages if covers_pages is not None else list(range(1, len(answers) + 1)) if answers else [1],
        "maxImagesPerRequest": max_images,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": authored_from,
    }
    if answers_source:
        base["answersSource"] = answers_source
    if attempts is not None:
        base["attempts"] = attempts
        return base
    base["attempts"] = [{"attempt": 1, "outcome": "answered", "latencyMs": 140, "pages": answers}]
    return base


def ocr_attempt_pages(fixture, page_numbers, defects=None):
    pages = []
    for number in page_numbers:
        defect = (defects or {}).get(number, {})
        pages.append(
            {
                "page": number,
                "text": visible_text(
                    fixture,
                    number,
                    omit=defect.get("omit", False),
                    fabricate=defect.get("fabricate"),
                ),
            }
        )
    return pages


def build_replay_scenarios(fixtures):
    by_id = {entry["fixtureId"]: entry for entry in fixtures}
    corpus_authored = (
        "脚本答案逐页取自 corpus-manifest.json 的 expected 记录；这些期望由 generate.py 的 DESIGN 常量按 "
        "closedSetRule 推导，早于任何提取器/Clef/OCR 调用，因此回放绑定的是独立标注的页面真值。"
    )
    defect_authored = (
        "脚本答案是人为构造的 defective candidate：用来证明评估器会给出指定闭集标签与页号，"
        "它不对应任何真实模型输出，也不参与页面真值的制定。"
    )

    local = []

    def expect(fixture_id, stage="local"):
        return {"kind": "corpus-expectations", "fixture": fixture_id, "stage": stage}

    local.append(clef_scenario(
        "clef-local-audit--pass--pure-text", "local-audit", "pure-text", ["pass"],
        corpus_pages(by_id["pure-text"], "local"), answers_source=expect("pure-text"),
        authored_from=corpus_authored))
    local.append(clef_scenario(
        "clef-local-audit--pass--blank-page", "local-audit", "blank-page", ["pass"],
        corpus_pages(by_id["blank-page"], "local"), answers_source=expect("blank-page"),
        authored_from=corpus_authored))
    for fixture_id, scenario_id in [
        ("scanned-textless", "clef-local-audit--fail--scanned-textless"),
        ("image-cover", "clef-local-audit--fail--image-cover"),
        ("mixed-text-scan", "clef-local-audit--fail--mixed-text-scan"),
        ("garbled", "clef-local-audit--fail--garbled-text"),
        ("partially-rasterized", "clef-local-audit--fail--partially-rasterized"),
    ]:
        local.append(clef_scenario(
            scenario_id, "local-audit", fixture_id, ["fail"], corpus_pages(by_id[fixture_id], "local"),
            answers_source=expect(fixture_id), authored_from=corpus_authored))
    for fixture_id in ["table-grid", "two-column", "footnote", "formula-inline"]:
        local.append(clef_scenario(
            "clef-local-audit--uncertain--%s" % fixture_id, "local-audit", fixture_id, ["uncertain"],
            corpus_pages(by_id[fixture_id], "local"), answers_source=expect(fixture_id),
            authored_from=corpus_authored))

    # 批量切分：整篇一次请求会超过 4 张图上限；两个批次才是合规形状。
    long_pages = corpus_pages(by_id["text-long-6p"], "local")
    local.append(clef_scenario(
        "clef-local-audit--pass--text-long-6p", "local-audit", "text-long-6p", ["pass"], long_pages,
        covers_pages=[1, 2, 3, 4, 5, 6], answers_source=expect("text-long-6p"),
        authored_from=corpus_authored + " 6 页一次请求故意超过 4 张图上限，用来证明超限会被显式记录而不是静默截断。"))
    local.append(clef_scenario(
        "clef-local-audit--pass--text-long-6p-batch-1", "local-audit", "text-long-6p", ["pass"], long_pages[:4],
        covers_pages=[1, 2, 3, 4], answers_source=expect("text-long-6p"), authored_from=corpus_authored))
    local.append(clef_scenario(
        "clef-local-audit--pass--text-long-6p-batch-2", "local-audit", "text-long-6p", ["pass"], long_pages[4:],
        covers_pages=[5, 6], answers_source=expect("text-long-6p"), authored_from=corpus_authored))

    # 协议级无效响应（malformed 族）。
    local.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-local-audit--malformed--pure-text",
        "service": "clef",
        "stage": "local-audit",
        "fixture": "pure-text",
        "caseKinds": ["malformed"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "响应体是语法上就无效的输出（截断 JSON + 尾随逗号），用来证明票 11 的 fail-closed 与质量失败分类相互独立。",
        "answersSource": {"kind": "none", "fixture": "pure-text", "stage": "local"},
        "attempts": [{"attempt": 1, "outcome": "malformed", "latencyMs": 90, "httpStatus": 200,
                      "bodyRaw": "{\"pages\":[{\"page\":1,\"verdict\":\"pass\",\"issueLabels\":[\"none\"}],"}],
    })
    def pass_answer(number):
        return {"page": number, "verdict": "pass", "issueLabels": ["none"], "probability": 0.9, "confidence": 0.84}

    invalid_cases = [
        ("missing-page", [pass_answer(1), pass_answer(2)], "回答缺少被声明的第 3 页"),
        ("duplicate-page", [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 1, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 2, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"]},
        ], "同一页被回答两次"),
        ("unknown-verdict", [
            {"page": 1, "verdict": "probably-pass", "issueLabels": ["none"]},
            {"page": 2, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"]},
        ], "裁决不在闭集里"),
        ("unknown-issue-label", [
            {"page": 1, "verdict": "fail", "issueLabels": ["looks-suspicious"]},
            {"page": 2, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"]},
        ], "问题标签不在闭集里"),
        ("page-out-of-range", [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 2, "verdict": "pass", "issueLabels": ["none"]},
            {"page": 9, "verdict": "pass", "issueLabels": ["none"]},
        ], "页号超出声明页数"),
    ]
    for name, answers, note in invalid_cases:
        local.append({
            "schemaVersion": "pdf-quality-replay-v1",
            "scenarioId": "clef-local-audit--invalid-%s--pure-text" % name,
            "service": "clef",
            "stage": "local-audit",
            "fixture": "pure-text",
            "caseKinds": ["malformed"],
            "coversPages": [1, 2, 3] if name != "duplicate-page" else [1, 2, 3],
            "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
            "timeoutMs": CLEF_TIMEOUT_MS,
            "externalServiceDependency": "none",
            "authoredFrom": "%s：%s。属于协议无效，不得被折叠成语义质量失败。" % (defect_authored, note),
            "answersSource": {"kind": "authored-defect", "fixture": "pure-text", "stage": "local", "defect": name},
            "attempts": [{"attempt": 1, "outcome": "invalid", "latencyMs": 110, "httpStatus": 200,
                          "invalidReason": name if name != "missing-page" else "missing-page", "pages": answers}],
        })

    # 服务故障族。
    local.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-local-audit--timeout-then-pass--pure-text",
        "service": "clef",
        "stage": "local-audit",
        "fixture": "pure-text",
        "caseKinds": ["timeout", "recovery", "pass"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "第一次尝试超时、第二次尝试给出与语料一致的逐页 pass，用来证明有界重试后的成功路径与超时不是质量失败。",
        "answersSource": expect("pure-text"),
        "attempts": [
            {"attempt": 1, "outcome": "timeout", "latencyMs": CLEF_TIMEOUT_MS},
            {"attempt": 2, "outcome": "answered", "latencyMs": 160, "pages": corpus_pages(by_id["pure-text"], "local")},
        ],
    })
    local.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-local-audit--unavailable-exhausted--pure-text",
        "service": "clef",
        "stage": "local-audit",
        "fixture": "pure-text",
        "caseKinds": ["service-fault"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "三次尝试全部是限流/服务端错误，用来证明重试耗尽得到服务不可用终态而不是质量 pass。",
        "answersSource": {"kind": "none", "fixture": "pure-text", "stage": "local"},
        "attempts": [
            {"attempt": 1, "outcome": "service-error", "latencyMs": 300, "httpStatus": 429},
            {"attempt": 2, "outcome": "service-error", "latencyMs": 300, "httpStatus": 500},
            {"attempt": 3, "outcome": "service-error", "latencyMs": 300, "httpStatus": 503},
        ],
    })
    local.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-local-audit--cancelled--pure-text",
        "service": "clef",
        "stage": "local-audit",
        "fixture": "pure-text",
        "caseKinds": ["cancellation"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "请求在传输中被取消：回放服务抛 AbortError，与票 25 的取消落盘而不是质量失败一致。",
        "answersSource": {"kind": "none", "fixture": "pure-text", "stage": "local"},
        "attempts": [{"attempt": 1, "outcome": "cancelled", "latencyMs": 40}],
    })
    local.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-local-audit--recovery-reuse--pure-text",
        "service": "clef",
        "stage": "local-audit",
        "fixture": "pure-text",
        "caseKinds": ["recovery", "pass"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "恢复路径从已持久化的第一批证据里复用逐页裁决，因此不产生新的远程调用（invocations=0）。",
        "answersSource": expect("pure-text"),
        "attempts": [{"attempt": 1, "outcome": "answered-from-durable-evidence", "reusedFromAttempt": 1,
                      "latencyMs": 5, "pages": corpus_pages(by_id["pure-text"], "local")}],
    })
    local.append(clef_scenario(
        "clef-local-audit--uncertain-page-image-unavailable--pure-text", "local-audit", "pure-text", ["uncertain"],
        [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"], "probability": 0.9, "confidence": 0.85},
            {"page": 2, "verdict": "uncertain", "issueLabels": ["page-image-unavailable"], "probability": 0.4, "confidence": 0.3},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"], "probability": 0.88, "confidence": 0.83},
        ],
        answers_source={"kind": "authored-defect", "fixture": "pure-text", "stage": "local", "defect": "page-image-unavailable"},
        authored_from=defect_authored + " 该页没有可比对的页面图像，必须停在 uncertain。"))

    second = []
    for fixture_id in ["scanned-textless", "image-cover", "garbled"]:
        second.append(clef_scenario(
            "clef-second-audit--pass--%s" % fixture_id, "ocr-audit", fixture_id, ["pass"],
            corpus_pages(by_id[fixture_id], "ocr"),
            answers_source={"kind": "corpus-expectations", "fixture": fixture_id, "stage": "ocr-candidate"},
            authored_from=corpus_authored))
    second.append(clef_scenario(
        "clef-second-audit--uncertain--table-grid", "ocr-audit", "table-grid", ["uncertain"],
        corpus_pages(by_id["table-grid"], "ocr"),
        answers_source={"kind": "corpus-expectations", "fixture": "table-grid", "stage": "ocr-candidate"},
        authored_from=corpus_authored))
    second.append(clef_scenario(
        "clef-second-audit--fail--mixed-text-scan", "ocr-audit", "mixed-text-scan", ["fail"],
        [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"], "probability": 0.92, "confidence": 0.85},
            {"page": 2, "verdict": "fail", "issueLabels": ["content-missing"], "probability": 0.2, "confidence": 0.2},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"], "probability": 0.9, "confidence": 0.84},
        ],
        answers_source={"kind": "authored-defect", "fixture": "mixed-text-scan", "stage": "ocr-candidate", "defect": "content-missing"},
        authored_from=defect_authored + " OCR 候选没读回第 2 页可见内容。"))
    second.append(clef_scenario(
        "clef-second-audit--uncertain-audit-incomplete--mixed-text-scan", "ocr-audit", "mixed-text-scan", ["uncertain"],
        [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"], "probability": 0.91, "confidence": 0.84},
            {"page": 2, "verdict": "uncertain", "issueLabels": ["audit-incomplete"], "probability": 0.45, "confidence": 0.4},
            {"page": 3, "verdict": "pass", "issueLabels": ["none"], "probability": 0.9, "confidence": 0.83},
        ],
        answers_source={"kind": "authored-defect", "fixture": "mixed-text-scan", "stage": "ocr-candidate", "defect": "audit-incomplete"},
        authored_from=defect_authored + " 第 2 页的审计覆盖不完整，必须停在 uncertain 而不是被折成 pass。"))
    second.append(clef_scenario(
        "clef-second-audit--fail-reading-order--two-column", "ocr-audit", "two-column", ["fail"],
        [{"page": 1, "verdict": "fail", "issueLabels": ["reading-order-broken"], "probability": 0.3, "confidence": 0.3}],
        answers_source={"kind": "authored-defect", "fixture": "two-column", "stage": "ocr-candidate", "defect": "reading-order-broken"},
        authored_from=defect_authored + " 左右栏被逐行交错读出。"))
    second.append(clef_scenario(
        "clef-second-audit--fail-fabricated--scanned-textless", "ocr-audit", "scanned-textless", ["fail"],
        [
            {"page": 1, "verdict": "pass", "issueLabels": ["none"], "probability": 0.9, "confidence": 0.85},
            {"page": 2, "verdict": "fail", "issueLabels": ["content-fabricated"], "probability": 0.25, "confidence": 0.3},
        ],
        answers_source={"kind": "authored-defect", "fixture": "scanned-textless", "stage": "ocr-candidate", "defect": "content-fabricated"},
        authored_from=defect_authored + " OCR 在第 2 页产出了页面上不存在的句子。"))
    second.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-second-audit--malformed--scanned-textless",
        "service": "clef",
        "stage": "ocr-audit",
        "fixture": "scanned-textless",
        "caseKinds": ["malformed"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "第二次审计返回的不是有效 JSON：必须按协议无效处理，且不得触发质量重试。",
        "answersSource": {"kind": "none", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "malformed", "latencyMs": 80, "httpStatus": 200,
                      "bodyRaw": "{\"pages\":[]"}],
    })
    second.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-second-audit--timeout-then-pass--scanned-textless",
        "service": "clef",
        "stage": "ocr-audit",
        "fixture": "scanned-textless",
        "caseKinds": ["timeout", "recovery", "pass"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "第二次审计超时后一次有界重试成功，逐页答案与语料 ocr-candidate 期望一致。",
        "answersSource": {"kind": "corpus-expectations", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [
            {"attempt": 1, "outcome": "timeout", "latencyMs": CLEF_TIMEOUT_MS},
            {"attempt": 2, "outcome": "answered", "latencyMs": 150,
             "pages": corpus_pages(by_id["scanned-textless"], "ocr")},
        ],
    })
    second.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-second-audit--cancelled--scanned-textless",
        "service": "clef",
        "stage": "ocr-audit",
        "fixture": "scanned-textless",
        "caseKinds": ["cancellation"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "第二次审计在飞行中被取消：AbortError，而不是质量失败。",
        "answersSource": {"kind": "none", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "cancelled", "latencyMs": 40}],
    })
    second.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "clef-second-audit--recovery-reuse--scanned-textless",
        "service": "clef",
        "stage": "ocr-audit",
        "fixture": "scanned-textless",
        "caseKinds": ["recovery", "pass"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": CLEF_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "恢复路径复用已持久化的第二次审计证据，不重新调用 Clef。",
        "answersSource": {"kind": "corpus-expectations", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "answered-from-durable-evidence", "reusedFromAttempt": 1,
                      "latencyMs": 5, "pages": corpus_pages(by_id["scanned-textless"], "ocr")}],
    })
    local.append(clef_scenario(
        "clef-local-audit--fail-structure-flattened--table-grid", "local-audit", "table-grid", ["fail"],
        [{"page": 1, "verdict": "fail", "issueLabels": ["structure-flattened"], "probability": 0.3, "confidence": 0.35}],
        answers_source={"kind": "authored-defect", "fixture": "table-grid", "stage": "local", "defect": "structure-flattened"},
        authored_from=defect_authored + " 表格被压平成一行串，表头-值关系丢失。"))

    ocr = []
    for fixture_id in ["scanned-textless", "image-cover", "garbled"]:
        fixture = by_id[fixture_id]
        pages = list(range(1, fixture["pageCount"] + 1))
        ocr.append({
            "schemaVersion": "pdf-quality-replay-v1",
            "scenarioId": "ocr--faithful-candidate--%s" % fixture_id,
            "service": "ocr",
            "stage": "ocr-fallback",
            "fixture": fixture_id,
            "caseKinds": ["pass"],
            "coversPages": pages,
            "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
            "timeoutMs": OCR_TIMEOUT_MS,
            "externalServiceDependency": "none",
            "authoredFrom": "整篇 OCR 候选文本逐页等于 corpus-manifest 登记的可见内容（corpus-visible-lines），"
                           "代表一次理想识别，用于票 13 的正向恢复路径。",
            "answersSource": {"kind": "corpus-visible-lines", "fixture": fixture_id, "stage": "ocr-candidate"},
            "attempts": [{"attempt": 1, "outcome": "answered", "latencyMs": 900,
                          "pages": ocr_attempt_pages(fixture, pages)}],
        })
    mixed_fixture = by_id["mixed-text-scan"]
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--incomplete-candidate--mixed-text-scan",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "mixed-text-scan",
        "caseKinds": ["fail"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 候选在第 2 页返回空文本（真实识别失败的形状），用来配对第二次审计的 content-missing 失败。",
        "answersSource": {"kind": "corpus-visible-lines", "fixture": "mixed-text-scan", "stage": "ocr-candidate", "defect": "page-2-empty"},
        "attempts": [{"attempt": 1, "outcome": "answered", "latencyMs": 900,
                      "pages": ocr_attempt_pages(mixed_fixture, [1, 2, 3], defects={2: {"omit": True}})}],
    })
    scanned_fixture = by_id["scanned-textless"]
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--fabricated-candidate--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["fail"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 候选在第 2 页多出页面上不存在的句子（幻觉/串行），必须被第二次审计按 content-fabricated 拒绝。",
        "answersSource": {"kind": "corpus-visible-lines", "fixture": "scanned-textless", "stage": "ocr-candidate", "defect": "page-2-fabricated"},
        "attempts": [{"attempt": 1, "outcome": "answered", "latencyMs": 900,
                      "pages": ocr_attempt_pages(scanned_fixture, [1, 2],
                                                 defects={2: {"fabricate": "本页不存在的一句话：无条件全额退款。"}})}],
    })
    blank_fixture = by_id["blank-page"]
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--blank-page-empty-candidate--blank-page",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "blank-page",
        "caseKinds": ["uncertain"],
        "coversPages": [1, 2, 3],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 对每一页都返回空文本：没有任何内容可以被确认，第二次审计只能是 uncertain，不能是 pass。",
        "answersSource": {"kind": "corpus-visible-lines", "fixture": "blank-page", "stage": "ocr-candidate", "defect": "all-empty"},
        "attempts": [{"attempt": 1, "outcome": "answered", "latencyMs": 700,
                      "pages": ocr_attempt_pages(blank_fixture, [1, 2, 3],
                                                 defects={1: {"omit": True}, 2: {"omit": True}, 3: {"omit": True}})}],
    })
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--malformed-response--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["malformed"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 返回了非法 JSON（截断响应体）：必须按协议无效处理，不能当成「没有内容」。",
        "answersSource": {"kind": "none", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "malformed", "latencyMs": 200, "httpStatus": 200,
                      "bodyRaw": "{\"result\":{\"pages\":[{\"page\":1,\"text\":"}],
    })
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--timeout-then-faithful--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["timeout", "recovery"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "第一次 OCR 超时，一次有界重试后拿到与语料可见内容一致的候选。",
        "answersSource": {"kind": "corpus-visible-lines", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [
            {"attempt": 1, "outcome": "timeout", "latencyMs": OCR_TIMEOUT_MS},
            {"attempt": 2, "outcome": "answered", "latencyMs": 900,
             "pages": ocr_attempt_pages(scanned_fixture, [1, 2])},
        ],
    })
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--cancelled--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["cancellation"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 请求被取消：AbortError，票 19/25 用它断言取消不被改写成质量失败。",
        "answersSource": {"kind": "none", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "cancelled", "latencyMs": 30}],
    })
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--recovery-reuse--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["recovery"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "恢复路径复用已持久化的 OCR 候选，不重新调用 OCR（invocations=0）。",
        "answersSource": {"kind": "corpus-visible-lines", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [{"attempt": 1, "outcome": "answered-from-durable-evidence", "reusedFromAttempt": 1,
                      "latencyMs": 4, "pages": ocr_attempt_pages(scanned_fixture, [1, 2])}],
    })
    ocr.append({
        "schemaVersion": "pdf-quality-replay-v1",
        "scenarioId": "ocr--unavailable-exhausted--scanned-textless",
        "service": "ocr",
        "stage": "ocr-fallback",
        "fixture": "scanned-textless",
        "caseKinds": ["service-fault"],
        "coversPages": [1, 2],
        "maxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        "timeoutMs": OCR_TIMEOUT_MS,
        "externalServiceDependency": "none",
        "authoredFrom": "OCR 连续三次服务端错误：重试耗尽得到服务不可用终态，绝不能被当成质量 pass。",
        "answersSource": {"kind": "none", "fixture": "scanned-textless", "stage": "ocr-candidate"},
        "attempts": [
            {"attempt": 1, "outcome": "service-error", "latencyMs": 400, "httpStatus": 429},
            {"attempt": 2, "outcome": "service-error", "latencyMs": 400, "httpStatus": 500},
            {"attempt": 3, "outcome": "service-error", "latencyMs": 400, "httpStatus": 503},
        ],
    })

    return {
        "clef-local-audit.json": local,
        "clef-second-audit.json": second,
        "ocr-fallback.json": ocr,
    }


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def validate_before_write(fixtures, replay):
    """写出前的自检：类别齐全、闭集合法、覆盖图没有悬空引用。"""
    covered = set()
    for entry in fixtures:
        covered.update(entry["categories"])
        for page in entry["pages"]:
            assert page["carrier"] in CARRIERS, page
            assert page["layout"] in PAGE_LAYOUTS, page
            assert page["textLayerAuthored"] in ("faithful", "faithful-partial", "garbled", "absent", "unreadable")
            for item in page["visible"]:
                assert item["role"] in TEXT_ROLES, item
            for obligation in page["structureObligations"]:
                assert obligation in STRUCTURE_OBLIGATIONS, obligation
            for key in ("local", "ocrCandidate"):
                expectation = page["expected"][key]
                assert expectation["verdict"] in VERDICTS
                assert len(expectation["issueLabels"]) == 1
                for label in expectation["issueLabels"]:
                    assert label in ISSUE_LABELS, label
                if expectation["verdict"] == "pass":
                    assert expectation["issueLabels"] == ["none"]
    missing = [category for category in REQUIRED_CATEGORIES if category not in covered]
    if missing:
        raise AssertionError("corpus does not cover required categories: %s" % ", ".join(missing))
    scenario_ids = set()
    for group in replay.values():
        for scenario in group:
            assert scenario["scenarioId"] not in scenario_ids, "duplicate replay scenario"
            scenario_ids.add(scenario["scenarioId"])
    return covered


def main():
    parser = argparse.ArgumentParser(description="Regenerate the ticket-02 PDF quality corpus.")
    parser.add_argument("--out", default=HERE, help="target directory (defaults to the corpus directory)")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    entries = []
    for sample in FIXTURES:
        entry, _data = build_fixture_entry(sample, out_dir)
        entries.append(entry)

    replay = build_replay_scenarios(entries)
    validate_before_write(entries, replay)
    coverage = build_coverage_map(entries)

    # 覆盖图与被生成场景必须互相闭合：不允许悬空引用或孤儿场景。
    replay_ids = {scenario["scenarioId"] for group in replay.values() for scenario in group}
    referenced = {scenario_id for entry in coverage["scenarios"] for scenario_id in entry["replayScenarioIds"]}
    if referenced - replay_ids:
        raise AssertionError("coverage references unknown replay scenarios: %s" % sorted(referenced - replay_ids))
    if replay_ids - referenced:
        raise AssertionError("replay scenarios not used by any acceptance scenario: %s" % sorted(replay_ids - referenced))
    fixture_ids = {entry["fixtureId"] for entry in entries}
    for scenario in coverage["scenarios"]:
        unknown = [fixture_id for fixture_id in scenario["fixtureIds"] if fixture_id not in fixture_ids]
        if unknown:
            raise AssertionError("coverage %s references unknown fixtures %s" % (scenario["scenarioId"], unknown))

    manifest = {
        "schemaVersion": "pdf-quality-corpus-v1",
        "ticket": "pdf-quality-02",
        "generatedBy": "golden/pdf-quality-corpus/generate.py",
        "generatedWith": {
            "library": "PyMuPDF",
            "libraryVersion": getattr(fitz, "__version__", "unknown"),
            "font": FONT,
            "pageSizePt": [PAGE_W, PAGE_H],
            "metadataDateFixed": FIXED_DATE,
            "clefMaxImagesPerRequest": CLEF_MAX_IMAGES_PER_REQUEST,
        },
        "annotationProvenance": {
            "method": "designed-before-write",
            "statement": (
                "每一页的可见内容与期望裁决来自 generate.py 的 DESIGN 常量表，写在 PDF 字节之前；"
                "期望由 closedSetRule 从载体、文本层设计、结构义务与可见行数这些文档自身属性推导，"
                "不读取任何提取器、Clef 或 OCR 的输出。"
            ),
            "notDerivedFrom": ["pymupdf-get-text", "pdfminer", "clef-service-output", "ocr-service-output"],
            "independentVerification": (
                "页数、能否打开、以及「损坏/加密/不可打开是否真的读不出来」由 Node 端 pdf-lib 在 "
                "src/ingestion/pdf_quality_corpus/corpus.test.ts 里独立核对；pdf-lib 不是生产解析器"
                "（生产路径 scripts/builtin_pdf_extract.py 走 PyMuPDF），因此这条核对不构成自我确认。"
            ),
            "structureObligationRule": STRUCTURE_OBLIGATION_RULE,
            "closedSetRule": CLOSED_SET_RULE,
        },
        "externalServiceDependency": "none",
        "readerToleranceObservations": [
            {
                "reader": "pdf-lib 1.17.1（语料独立核对用，非生产解析器）",
                "observation": (
                    "拒绝加载 encrypted-aes256 / damaged-truncated / damaged-corrupt-object-headers / "
                    "unopenable-not-a-pdf / unopenable-stub-header；其余 12 个样本按标注页数读出。"
                ),
            },
            {
                "reader": "PyMuPDF（生产提取器 scripts/builtin_pdf_extract.py 所用库）",
                "observation": (
                    "只清掉交叉引用表的样本会被它自行重建并读出全部页；PNG 字节改名 .pdf 也会被它当作一页文档打开。"
                    "因此语料改用「对象关键字全部破坏」与「OLE 容器字节」两种两个阅读器都拒绝的损坏，"
                    "不把阅读器宽容度当成文档真值。加密样本对它暴露 1 页但读取内容即抛错。"
                ),
            },
        ],
        "verdicts": VERDICTS,
        "issueLabels": ISSUE_LABELS,
        "dimensions": DIMENSIONS,
        "carriers": CARRIERS,
        "pageLayouts": PAGE_LAYOUTS,
        "textRoles": TEXT_ROLES,
        "structureObligations": STRUCTURE_OBLIGATIONS,
        "requiredCategories": REQUIRED_CATEGORIES,
        "categories": CATEGORIES,
        "labelDimensionMap": LABEL_DIMENSIONS,
        "fixtures": entries,
    }
    write_json(os.path.join(out_dir, "corpus-manifest.json"), manifest)
    write_json(os.path.join(out_dir, "coverage-map.json"), coverage)
    replay_dir = os.path.join(out_dir, "replay")
    os.makedirs(replay_dir, exist_ok=True)
    for name, scenarios in replay.items():
        write_json(os.path.join(replay_dir, name), {"schemaVersion": "pdf-quality-replay-v1", "scenarios": scenarios})

    print(
        "wrote %d fixtures, %d coverage scenarios, %d replay scenarios into %s"
        % (len(entries), len(coverage["scenarios"]), len(replay_ids), out_dir)
    )


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
