# UT-02：独立逐页 PDF 真值生成器。
#
# 设计原则：每页真值文本由本文件逐字设计（与被测提取完全独立），扫描页的
# "设计文本"先以文本层渲染成图像再插入目标 PDF，因此图像页同样有独立真值。
# 样本字节哈希与逐页真值写入 truth-manifest.json；测试只核对哈希一致性，
# 绝不从被测提取结果反推真值。
# 运行：E:/miniconda3/python.exe golden/upload-truth/pdf/generate.py
import hashlib
import json
import os
import tempfile

import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "C:/Windows/Fonts/simhei.ttf"
FONT_BUILTIN = "china-s"

FIXED_META = {
    "producer": "ut02-truth-generator",
    "creator": "ut02-truth-generator",
    "creationDate": "D:20261004000000Z",
    "modDate": "D:20261004000000Z",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def add_text(page, x, y, text, size=11, font=FONT_BUILTIN, fontfile=None):
    # 宽度守卫：插入文本物理超出页宽会被裁剪，真值与字节就会失配。
    # A4 宽 595pt，右边距至少保留 68pt。
    if fontfile:
        probe = fitz.Font(fontfile=fontfile)
    else:
        probe = fitz.Font(font)
    width = probe.text_length(text, fontsize=size)
    if x + width > 595 - 68:
        raise ValueError(f"text exceeds printable width ({x + width:.0f}pt > 527pt): {text!r}")
    kwargs = {"fontname": font, "fontsize": size}
    if fontfile:
        kwargs["fontfile"] = fontfile
    page.insert_text((x, y), text, **kwargs)


def render_text_page_as_image(text_lines, dpi=150):
    """把设计文本渲染成图像字节：得到"无文本层"的扫描页，但真值仍然独立可登记。"""
    scratch = fitz.open()
    page = scratch.new_page()
    y = 100
    for line in text_lines:
        add_text(page, 72, y, line, size=12)
        y += 24
    pix = page.get_pixmap(dpi=dpi)
    png = pix.tobytes("png")
    scratch.close()
    return png


def new_doc(sample_id):
    doc = fitz.open()
    doc.set_metadata({**FIXED_META, "title": f"UT-02 truth sample {sample_id}"})
    return doc


def finish(doc, filename, sample_id, page_count, expectation, pages, **extra):
    data = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    path = os.path.join(HERE, filename)
    with open(path, "wb") as handle:
        handle.write(data)
    return {
        "id": sample_id,
        "file": filename,
        "fileSha256": sha256_bytes(data),
        "fileBytes": len(data),
        "pageCount": page_count,
        "expectation": expectation,
        "pages": pages,
        **extra,
    }


samples = []

# 1) simple-body：三页简单正文（含中文/公式/数值/否定/顺序）。
doc = new_doc("simple-body")
p1 = ["上传完整性验收样本", "第一页：本样本用于逐页真值核对。", "订单编号：A-2026-1004，金额 50 元。"]
p2 = ["第二页：勾股定理 a^2+b^2=c^2 与 3.14。", "不支持跨店抵扣，也不支持过期后补办。", "Order two: quantity 3, unit price 12.5。"]
p3 = ["第三页：顺序校验 甲、乙、丙。", "结尾校验词：终线-PDF-77。", "Support email: support@example.com。"]
for index, lines in enumerate([p1, p2, p3]):
    page = doc.new_page()
    add_text(page, 72, 100, lines[0], size=16)
    y = 150
    for line in lines[1:]:
        add_text(page, 72, y, line, size=11)
        y += 24
samples.append(finish(doc, "simple-body.pdf", "simple-body", 3, "exact", [
    {"page": 1, "truthLines": p1},
    {"page": 2, "truthLines": p2},
    {"page": 3, "truthLines": p3},
], mustPreserve=["per-page-position", "order", "numbers", "negation", "formula-as-text"]))

# 2) footnotes：正文 + 页底小字脚注（脚注文本必须保留在同页）。
doc = new_doc("footnotes")
page = doc.new_page()
body = ["脚注样本标题", "正文一：退款申请需在七天内提交。", "正文二：不支持口头申请。", "正文三：审核时限为三个工作日。"]
footnote = "※ 脚注：本条款不适用于 2026-01-01 之前的订单。"
add_text(page, 72, 100, body[0], size=16)
y = 150
for line in body[1:]:
    add_text(page, 72, y, line, size=11)
    y += 24
add_text(page, 72, 780, footnote, size=8)
samples.append(finish(doc, "footnotes.pdf", "footnotes", 1, "exact", [
    {"page": 1, "truthLines": body + [footnote], "note": "脚注为小字号，必须与正文同页保留"},
], mustPreserve=["footnote-text", "per-page-position"]))

# 3) two-columns：双栏样本（分栏阅读顺序是已知结构风险）。
doc = new_doc("two-columns")
page = doc.new_page()
left = ["左栏一：退货时限为七天。", "左栏二：需保留原始包装。", "左栏三：运费由买家承担。"]
right = ["右栏一：发票需在三十天内开具。", "右栏二：金额上限 500 元。", "右栏三：不支持口头承诺。"]
for index, line in enumerate(left):
    add_text(page, 72, 140 + index * 30, line, size=11)
for index, line in enumerate(right):
    add_text(page, 315, 140 + index * 30, line, size=11)
samples.append(finish(doc, "two-columns.pdf", "two-columns", 1, "pending_review_allowed", [
    {"page": 1, "truthLines": left + right,
     "note": "真值按左栏-右栏阅读顺序登记；提取顺序无法确认时必须待校验"},
], mustPreserve=["column-order", "numbers"], notes="分栏属于结构风险：页数或标记命中不能代替全文证据。"))

# 4) table-overlap：正文行与表格区域重叠（归一化会抑制重叠文本块）。
doc = new_doc("table-overlap")
page = doc.new_page()
add_text(page, 72, 100, "重叠表格样本", size=16)
add_text(page, 72, 140, "表格上方说明：以下为费率表。", size=11)
rows = [["手续费", "比例", "说明"], ["线上", "1%", "默认"], ["线下", "2%", "需审批"], ["", "", ""]]
# 网格：x 72-420，y 180-300（最后一行 270-300 为空行，供重叠正文行落入）。
x_edges = [72, 188, 304, 420]
y_edges = [180, 210, 240, 270, 300]
for x in x_edges:
    page.draw_line((x, y_edges[0]), (x, y_edges[-1]))
for y in y_edges:
    page.draw_line((x_edges[0], y), (x_edges[-1], y))
for row_index, row in enumerate(rows):
    for col_index, cell in enumerate(row):
        if cell:
            add_text(page, x_edges[col_index] + 6, y_edges[row_index] + 20, cell, size=10)
overlap_line = "覆盖校验行：本行与表格区域重叠，必须作为正文保留。"
add_text(page, 76, 292, overlap_line, size=10)
samples.append(finish(doc, "table-overlap.pdf", "table-overlap", 1, "pending_review_allowed", [
    {"page": 1, "truthLines": ["重叠表格样本", "表格上方说明：以下为费率表。",
                               "手续费 比例 说明", "线上 1% 默认", "线下 2% 需审批", overlap_line],
     "note": "重叠行必须作为正文保留；落入空表格行被拆碎也算损失"},
], mustPreserve=["overlap-body-line", "table-content"],
    notes="表格与正文重叠是已知风险：不能因表格提取成功就宣布该页完整。"))

# 5) pure-table：纯表格页（真值登记表头-值关系）。
doc = new_doc("pure-table")
page = doc.new_page()
x_edges = [72, 192, 312, 432]
y_edges = [100, 140, 180, 220]
for x in x_edges:
    page.draw_line((x, y_edges[0]), (x, y_edges[-1]))
for y in y_edges:
    page.draw_line((x_edges[0], y), (x_edges[-1], y))
table_rows = [["姓名", "金额", "是否退款"], ["张三", "50元", "是"], ["李四", "30元", "否"]]
for row_index, row in enumerate(table_rows):
    for col_index, cell in enumerate(row):
        add_text(page, x_edges[col_index] + 6, y_edges[row_index] + 28, cell, size=10)
samples.append(finish(doc, "pure-table.pdf", "pure-table", 1, "exact", [{"page": 1, "truthLines": []}], relations=[
    {"kind": "header", "values": ["姓名", "金额", "是否退款"]},
    {"kind": "row", "values": ["张三", "50元", "是"]},
    {"kind": "row", "values": ["李四", "30元", "否"]},
], mustPreserve=["header-value-relations"], notes="纯表格页以表头-值关系为真值：每个数据行的值必须共同出现在同一表格块内。"))

# 6) empty-page：中间页无任何内容（页位必须保留）。
doc = new_doc("empty-page")
page = doc.new_page()
add_text(page, 72, 120, "空页样本第一页：校验词 甲-1。", size=11)
doc.new_page()  # 第二页：无任何内容
page = doc.new_page()
add_text(page, 72, 120, "空页样本第三页：页位必须保持为第三页，校验词 丙-3。", size=11)
samples.append(finish(doc, "empty-page.pdf", "empty-page", 3, "exact", [
    {"page": 1, "truthLines": ["空页样本第一页：校验词 甲-1。"]},
    {"page": 2, "truthLines": [], "note": "设计上的空页：无内容，但其存在必须可从后续页的页位推断"},
    {"page": 3, "truthLines": ["空页样本第三页：页位必须保持为第三页，校验词 丙-3。"]},
], mustPreserve=["page-position"]))

# 7) image-figure：正文 + 有效图片 + 图注（图片语义当前无能力通道）。
doc = new_doc("image-figure")
page = doc.new_page()
add_text(page, 72, 120, "图片样本：下方是一张有效图片。", size=11)
pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 90))
pix.clear_with(90)
page.insert_image(fitz.Rect(72, 150, 192, 240), pixmap=pix)
caption = "图 1：架构示意图（有效图片；图片语义是当前能力缺口）。"
add_text(page, 72, 280, caption, size=11)
samples.append(finish(doc, "image-figure.pdf", "image-figure", 1, "exact", [
    {"page": 1, "truthLines": ["图片样本：下方是一张有效图片。", caption],
     "note": "图片本身无文本语义；图片存在性当前没有证据通道，登记为能力缺口"},
], mustPreserve=["caption", "image-presence-gap"],
    capabilityGaps=["image semantics/asset evidence channel is absent from the builtin parser"]))

# 8) mixed-scan：文本页 + 扫描页 + 文本页（部分提取假成功设计点）。
doc = new_doc("mixed-scan")
p1 = ["混合样本第一页：文本层存在，校验词 混-1。"]
scan2 = ["扫描页设计文本：这一页没有文本层，", "当前解析会静默丢失本页，校验词 扫-2。"]
p3 = ["混合样本第三页：文本层存在，校验词 混-3。"]
page = doc.new_page()
add_text(page, 72, 120, p1[0], size=11)
page = doc.new_page()
page.insert_image(fitz.Rect(36, 36, 559, 806), stream=render_text_page_as_image(scan2))
page = doc.new_page()
add_text(page, 72, 120, p3[0], size=11)
samples.append(finish(doc, "mixed-scan.pdf", "mixed-scan", 3, "pending_review_allowed", [
    {"page": 1, "truthLines": p1},
    {"page": 2, "truthLines": scan2, "note": "扫描页：真值为设计文本；无文本层时必须待校验，不得假成功"},
    {"page": 3, "truthLines": p3},
], mustPreserve=["no-false-success", "per-page-position"],
    notes="文本层覆盖率 2/3 ≥ 0.5，脚本不会发出低覆盖警告——部分提取假成功必须由逐页真值揭示。"))

# 9) scan-majority：扫描页占多数（触发脚本低覆盖警告，但警告在归一化中丢失）。
doc = new_doc("scan-majority")
p1 = ["扫描为主样本：仅本页有文本层，覆盖警告必须可见，校验词 主-1。"]
scan2 = ["扫描页乙：无文本层，校验词 主-2。"]
scan3 = ["扫描页丙：无文本层，校验词 主-3。"]
page = doc.new_page()
add_text(page, 72, 120, p1[0], size=11)
for lines in (scan2, scan3):
    page = doc.new_page()
    page.insert_image(fitz.Rect(36, 36, 559, 806), stream=render_text_page_as_image(lines))
samples.append(finish(doc, "scan-majority.pdf", "scan-majority", 3, "pending_review_allowed", [
    {"page": 1, "truthLines": p1},
    {"page": 2, "truthLines": scan2, "note": "扫描页：真值为设计文本"},
    {"page": 3, "truthLines": scan3, "note": "扫描页：真值为设计文本"},
], mustPreserve=["warning-visibility", "no-false-success"],
    notes="文本层覆盖率 1/3 < 0.5，脚本发出低覆盖警告；警告在 TypeScript 归一化中被丢弃。"))

# 10) encrypted：设置口令的加密 PDF。
doc = new_doc("encrypted")
page = doc.new_page()
add_text(page, 72, 120, "加密样本：本文件设置了口令，解析必须显式失败而非假成功。校验词 密-1。", size=11)
data = doc.tobytes(garbage=4, deflate=True, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="ut02-secret", user_pw="ut02-secret")
doc.close()
with open(os.path.join(HERE, "encrypted.pdf"), "wb") as handle:
    handle.write(data)
samples.append({
    "id": "encrypted",
    "file": "encrypted.pdf",
    "fileSha256": sha256_bytes(data),
    "fileBytes": len(data),
    "pageCount": 1,
    "expectation": "parse_failure_allowed",
    "pages": [{"page": 1, "truthLines": ["加密样本：本文件设置了口令，解析必须显式失败而非假成功。校验词 密-1。"]}],
    "mustPreserve": ["honest-failure"],
    "notes": "加密文件必须显式失败或待校验，不得静默产出空内容。",
})

# 11) corrupted：截断的损坏 PDF。
doc = new_doc("corrupted")
page = doc.new_page()
add_text(page, 72, 120, "损坏样本：本文件被截断，解析必须显式失败。校验词 损-1。", size=11)
good = doc.tobytes(garbage=4, deflate=True)
doc.close()
data = good[: int(len(good) * 0.6)]
with open(os.path.join(HERE, "corrupted.pdf"), "wb") as handle:
    handle.write(data)
samples.append({
    "id": "corrupted",
    "file": "corrupted.pdf",
    "fileSha256": sha256_bytes(data),
    "fileBytes": len(data),
    "pageCount": 1,
    "expectation": "parse_failure_allowed",
    "pages": [{"page": 1, "truthLines": ["损坏样本：本文件被截断，解析必须显式失败。校验词 损-1。"]}],
    "mustPreserve": ["honest-failure"],
    "notes": "损坏文件必须显式失败，不得静默产出部分内容后宣布成功。",
})

manifest = {
    "manifestVersion": "ut02-pdf-truth-v1",
    "annotationMethod": "designed",
    "designNote": (
        "逐页真值由 generate.py 逐字设计，与被测提取完全独立；扫描页的文本先渲染为"
        "图像再插入，因此图像页同样拥有独立设计的真值。复杂样本（分栏/重叠表格/"
        "扫描）以正确待校验为预期，页数或标记命中不能代替全文证据。"
    ),
    "samples": samples,
}

with open(os.path.join(HERE, "truth-manifest.json"), "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"wrote {len(samples)} samples + truth-manifest.json")
