"""Build an exhaustive eval-run data DOCX for the KG-compact comparison.

The environment used by Codex may not have python-docx installed. This script
therefore emits a minimal but valid DOCX directly with stdlib zip/xml helpers.

Run from repo root:
    python3 packages/eval/scripts/build_eval_runs_data_docx.py
"""

from __future__ import annotations

import json
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape


REPO = Path(__file__).resolve().parents[3]
EVAL = REPO / "packages" / "eval"
RUNS = EVAL / "runs"
REPORTS = EVAL / "reports"
OUT = REPORTS / "eval-runs-data-kg-compact.docx"

DERIVED_RUN = RUNS / "kg-compact-vs-control-kglic-lic-20260610"
FULL_SOURCE_RUN = RUNS / "kg-future-20-haiku45-3seed-20260609"
KG_COMPACT_SOURCE_RUN = RUNS / "kg-future-compact-gated-haiku45-3seed-20260609-live"

REPORT_TEXTS = [
    (RUNS / "data-science-share-20260610" / "README.md", "Data Science Share Bundle README"),
    (DERIVED_RUN / "report.md", "Code-Gen Outcome Report: Compact KG as KG-only"),
    (RUNS / "kg-retrieval-expanded-vs-lean-20260610" / "expanded-vs-lean.md", "Expanded vs. Lean KG Retrieval Report"),
    (RUNS / "kg-retrieval-expanded-vs-lean-20260610" / "expanded-current.md", "Expanded KG Retrieval Baseline Report"),
    (REPORTS / "kg-retrieval.md", "KG Retrieval Eval Report"),
    (REPORTS / "lic-retrieval.md", "LIC Retrieval Eval Report"),
]

CODE_GEN_ARMS = ["control", "kg-only", "kg-lic", "lic-full"]


def clean_xml_text(value: Any) -> str:
    text = "" if value is None else str(value)
    # XML 1.0 legal chars: tab, LF, CR, and U+0020.. except surrogate blocks.
    return "".join(
        ch
        if ch in "\t\n\r" or (0x20 <= ord(ch) <= 0xD7FF) or (0xE000 <= ord(ch) <= 0xFFFD)
        else " "
        for ch in text
    )


def x(value: Any) -> str:
    return escape(clean_xml_text(value), {'"': "&quot;"})


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def rel(path: Path) -> str:
    return str(path.relative_to(REPO))


def pct(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value * 100:.0f}%"


def money(value: float | None) -> str:
    if value is None:
        return "-"
    return f"${value:.4f}"


def short_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class DocxBuilder:
    def __init__(self) -> None:
        self.parts: list[str] = []

    def p(
        self,
        text: str = "",
        *,
        style: str | None = None,
        bold: bool = False,
        italic: bool = False,
        color: str | None = None,
        size: int | None = None,
        font: str | None = None,
        page_break_before: bool = False,
    ) -> None:
        ppr: list[str] = []
        if style:
            ppr.append(f'<w:pStyle w:val="{style}"/>')
        if page_break_before:
            ppr.append('<w:pageBreakBefore/>')
        rpr: list[str] = []
        if bold:
            rpr.append("<w:b/>")
        if italic:
            rpr.append("<w:i/>")
        if color:
            rpr.append(f'<w:color w:val="{color}"/>')
        if size:
            rpr.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
        if font:
            rpr.append(f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"/>')
        body = clean_xml_text(text)
        lines = body.split("\n")
        run_bits: list[str] = []
        for idx, line in enumerate(lines):
            if idx:
                run_bits.append("<w:br/>")
            run_bits.append(f'<w:t xml:space="preserve">{x(line)}</w:t>')
        self.parts.append(
            "<w:p>"
            + (f"<w:pPr>{''.join(ppr)}</w:pPr>" if ppr else "")
            + "<w:r>"
            + (f"<w:rPr>{''.join(rpr)}</w:rPr>" if rpr else "")
            + "".join(run_bits)
            + "</w:r></w:p>"
        )

    def heading(self, text: str, level: int = 1, *, page_break_before: bool = False) -> None:
        style = {1: "Heading1", 2: "Heading2", 3: "Heading3"}.get(level, "Heading3")
        self.p(text, style=style, page_break_before=page_break_before)

    def page_break(self) -> None:
        self.parts.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

    def code_block(self, title: str, text: str) -> None:
        self.p(title, style="CodeCaption", bold=True)
        lines = clean_xml_text(text).splitlines()
        if not lines:
            lines = [""]
        for line in lines:
            self.p(line, style="Code")
        self.p("", style="Small")

    def table(
        self,
        headers: list[str],
        rows: list[list[Any]],
        *,
        widths: list[int] | None = None,
        header_fill: str = "E8EEF5",
    ) -> None:
        if not widths:
            base = 9360 // max(1, len(headers))
            widths = [base for _ in headers]
            widths[-1] += 9360 - sum(widths)
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
        tbl = [
            "<w:tbl>",
            "<w:tblPr>",
            '<w:tblW w:w="9360" w:type="dxa"/>',
            '<w:tblInd w:w="120" w:type="dxa"/>',
            "<w:tblBorders>",
            '<w:top w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            '<w:left w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            '<w:right w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9E2EC"/>',
            "</w:tblBorders>",
            '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>',
            "</w:tblPr>",
            f"<w:tblGrid>{grid}</w:tblGrid>",
        ]
        tbl.append(self._tr(headers, widths, is_header=True, fill=header_fill))
        for row in rows:
            tbl.append(self._tr(row, widths))
        tbl.append("</w:tbl>")
        self.parts.append("".join(tbl))
        self.p("", style="Small")

    def _tr(self, values: list[Any], widths: list[int], *, is_header: bool = False, fill: str | None = None) -> str:
        cells: list[str] = []
        for idx, value in enumerate(values):
            text = clean_xml_text(value)
            cpr = [
                f'<w:tcW w:w="{widths[idx]}" w:type="dxa"/>',
                '<w:vAlign w:val="center"/>',
            ]
            if fill:
                cpr.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>')
            lines = text.splitlines() or [""]
            run_pr = "<w:rPr><w:b/></w:rPr>" if is_header else ""
            run_text = "".join(
                ("" if i == 0 else "<w:br/>") + f'<w:t xml:space="preserve">{x(line)}</w:t>'
                for i, line in enumerate(lines)
            )
            p_style = "TableHeader" if is_header else "TableBody"
            cells.append(
                "<w:tc><w:tcPr>"
                + "".join(cpr)
                + "</w:tcPr>"
                + f'<w:p><w:pPr><w:pStyle w:val="{p_style}"/></w:pPr><w:r>{run_pr}{run_text}</w:r></w:p>'
                + "</w:tc>"
            )
        trpr = "<w:trPr><w:tblHeader/></w:trPr>" if is_header else ""
        return "<w:tr>" + trpr + "".join(cells) + "</w:tr>"

    def xml(self) -> str:
        sect_pr = (
            "<w:sectPr>"
            '<w:pgSz w:w="12240" w:h="15840"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'
            "</w:sectPr>"
        )
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body>"
            + "".join(self.parts)
            + sect_pr
            + "</w:body></w:document>"
        )


def content_types_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""


def rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""


def document_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>"""


def styles_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="0B2545"/><w:sz w:val="48"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="180" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/><w:sz w:val="21"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4D78"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="CodeCaption"><w:name w:val="Code Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4D78"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0" w:line="220" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:color w:val="222222"/><w:sz w:val="15"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableBody"><w:name w:val="Table Body"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="17"/></w:rPr></w:style>
</w:styles>"""


def settings_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:zoom w:percent="100"/>
  <w:proofState w:spelling="clean" w:grammar="clean"/>
  <w:defaultTabStop w:val="720"/>
  <w:characterSpacingControl w:val="doNotCompress"/>
</w:settings>"""


def core_xml(created: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Eval Runs Data - KG Compact</dc:title>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified>
</cp:coreProperties>"""


def app_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Codex OOXML Builder</Application>
</Properties>"""


def write_docx(doc: DocxBuilder, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    created = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types_xml())
        z.writestr("_rels/.rels", rels_xml())
        z.writestr("word/_rels/document.xml.rels", document_rels_xml())
        z.writestr("word/document.xml", doc.xml())
        z.writestr("word/styles.xml", styles_xml())
        z.writestr("word/settings.xml", settings_xml())
        z.writestr("docProps/core.xml", core_xml(created))
        z.writestr("docProps/app.xml", app_xml())


def summarize_graph_snapshot(path: Path) -> dict[str, Any]:
    data = read_json(path)
    graph = data.get("graph", {})
    return {
        "path": rel(path),
        "generatedAt": data.get("generatedAt"),
        "org": data.get("org"),
        "nodes": data.get("nodeCount") or len(graph.get("nodes", [])),
        "edges": len(graph.get("edges", [])),
        "kind": data.get("kind"),
    }


def inclusion_decision(run_id: str, manifest: dict[str, Any]) -> str:
    if run_id == "kg-compact-vs-control-kglic-lic-20260610":
        return "included - canonical derived code-gen report"
    if run_id == "kg-future-20-haiku45-3seed-20260609":
        return "source only - control, kg-lic, lic-full prompts/outputs used; pim-full and old kg-only omitted"
    if run_id == "kg-future-compact-gated-haiku45-3seed-20260609-live":
        return "source only - kg-compact prompts/outputs used as the standalone PIM/KG arm"
    arms = ",".join(manifest.get("arms", []))
    if any(arm in arms for arm in ["pim-full", "pim-clipped", "lic-pim-combined"]):
        return "excluded - PIM rows are not kg-compact"
    if "smoke" in run_id or "rerun" in run_id or "tight" in run_id or "contract-card" in run_id:
        return "excluded - exploratory or superseded diagnostic run"
    return "excluded - not part of the 2026-06-10 share bundle"


def add_front_matter(doc: DocxBuilder, manifest: dict[str, Any], analysis: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    doc.p("Eval Runs Data: KG-Compact Comparison", style="Title")
    doc.p(
        "Source data package for the 2026-06-10 eval share bundle. Standalone PIM/KG data is restricted to "
        "the kg-compact arm from kg-future-compact-gated-haiku45-3seed-20260609-live; pim-full, pim-clipped, "
        "and older non-compact KG-only rows are omitted.",
        style="Subtitle",
    )
    doc.table(
        ["Field", "Value"],
        [
            ["Generated from", str(REPO)],
            ["Derived run", manifest.get("runId")],
            ["Derived run generated", manifest.get("generatedAt")],
            ["Rows included", len(rows)],
            ["Tasks", len(manifest.get("tasks", []))],
            ["Seeds", manifest.get("seeds")],
            ["Arms in derived report", ", ".join(manifest.get("arms", []))],
            ["Candidate model", manifest.get("model")],
            ["Judge model", manifest.get("judgeModel")],
            ["KG-compact source", manifest.get("sourceRuns", {}).get("kgOnlyCompact")],
            ["Control/KG+LIC/LIC source", manifest.get("sourceRuns", {}).get("controlKgLicLicFull")],
        ],
        widths=[2400, 6960],
    )
    doc.heading("Scope Guard", 1)
    doc.p(
        "The standalone PIM/KG arm in this document is kg-compact only. In the derived report it is displayed "
        "as KG-only (compact) / kg-only for comparison consistency. The source run's pim-full rows are not "
        "included. The KG+LIC arm is retained as a combined-context comparison arm from the canonical derived report."
    )
    doc.heading("Headline Metrics", 1)
    doc.table(
        ["Arm", "n", "Passes", "Pass rate", "Avg score", "Total cost", "Cost/correct", "Out tok/correct", "p50 latency"],
        [
            [
                item.get("label"),
                item.get("n"),
                item.get("passes"),
                pct(item.get("passRate")),
                f"{item.get('avgScore', 0):.2f}",
                money(item.get("totalCost")),
                money(item.get("costPerCorrect")),
                item.get("outputTokPerCorrect"),
                item.get("p50LatencyMs"),
            ]
            for item in analysis.get("summaries", [])
        ],
        widths=[1700, 650, 750, 900, 900, 1050, 1100, 1100, 1210],
    )
    doc.heading("Differential Outcomes", 2)
    diff_rows = []
    for item in analysis.get("differentialOutcomes", {}).get("kgOnlyBeatsControl", []):
        diff_rows.append([item.get("taskId"), item.get("control"), item.get("kgOnly"), item.get("kgLic"), item.get("licFull")])
    doc.table(["Task", "Control", "KG-only compact", "KG+LIC", "LIC-full"], diff_rows, widths=[5000, 900, 1300, 900, 1260])


def add_graph_and_retrieval_summary(doc: DocxBuilder) -> None:
    doc.heading("Retrieval And Graph Quality", 1, page_break_before=True)
    graph_rows = [
        list(summarize_graph_snapshot(RUNS / "kg-rebuild-2026-06-04-cutoff" / "graph-before.json").values()),
        list(summarize_graph_snapshot(RUNS / "kg-rebuild-2026-06-04-cutoff" / "graph-after.json").values()),
    ]
    doc.table(
        ["Path", "Generated", "Org", "Nodes", "Edges", "Kind"],
        graph_rows,
        widths=[3600, 1800, 1200, 800, 800, 1160],
    )
    source_manifest = read_json(RUNS / "kg-rebuild-2026-06-04-cutoff" / "source-manifest.json")
    doc.table(
        ["Source manifest field", "Value"],
        [
            ["Path", "packages/eval/runs/kg-rebuild-2026-06-04-cutoff/source-manifest.json"],
            ["Generated", source_manifest.get("generatedAt")],
            ["OK", source_manifest.get("ok")],
            ["File count", source_manifest.get("fileCount")],
            ["Total bytes", source_manifest.get("totalBytes")],
            ["Claimability", source_manifest.get("claimability")],
            ["Extraction", short_json(source_manifest.get("extraction"))],
        ],
        widths=[2300, 7060],
    )
    for path, title in REPORT_TEXTS:
        doc.heading(title, 2)
        doc.p(f"Source: {rel(path)}", style="Small")
        doc.code_block("Full report text", read_text(path))


def add_run_inventory(doc: DocxBuilder) -> None:
    doc.heading("Run Inventory", 1, page_break_before=True)
    manifests = []
    for path in sorted(RUNS.glob("*/manifest.json")):
        manifest = read_json(path)
        run_id = path.parent.name
        manifests.append(
            [
                run_id,
                manifest.get("generatedAt"),
                manifest.get("mode"),
                manifest.get("model"),
                manifest.get("seeds"),
                ",".join(manifest.get("arms", [])),
                len(manifest.get("tasks", [])),
                inclusion_decision(run_id, manifest),
            ]
        )
    doc.table(
        ["Run", "Generated", "Mode", "Model", "Seeds", "Arms", "Tasks", "Decision"],
        manifests,
        widths=[1900, 1350, 900, 1550, 550, 1600, 550, 960],
    )
    report_only = []
    for path in sorted(RUNS.glob("*/report.md")):
        if not (path.parent / "manifest.json").exists():
            report_only.append([path.parent.name, rel(path), "excluded - report-only legacy artifact"])
    for path in sorted(REPORTS.glob("*.md")):
        report_only.append([path.stem, rel(path), "included if listed in Retrieval And Graph Quality"])
    if report_only:
        doc.heading("Report-only artifacts", 2)
        doc.table(["Artifact", "Path", "Decision"], report_only, widths=[2300, 4800, 2260])


def add_task_materiality(doc: DocxBuilder, manifest: dict[str, Any]) -> None:
    doc.heading("KG Materiality", 1, page_break_before=True)
    rows = []
    for item in manifest.get("kgMateriality", []):
        rows.append(
            [
                item.get("taskId"),
                item.get("kgNodeCount"),
                item.get("totalMatching"),
                "yes" if item.get("truncated") else "no",
                "yes" if item.get("requiredFactPresent") else "no",
                "yes" if item.get("requiredSymbolPresent") else "no",
                item.get("eligible"),
                item.get("topNodeSummary"),
            ]
        )
    doc.table(
        ["Task", "KG nodes", "Matches", "Trunc", "Fact", "Symbol", "Eligible", "Top node summary"],
        rows,
        widths=[2650, 650, 700, 600, 600, 650, 800, 2710],
    )


def add_rows_summary(doc: DocxBuilder, manifest: dict[str, Any], analysis: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    doc.heading("Per-Task Results", 1, page_break_before=True)
    per_task = analysis.get("perTask", [])
    table_rows = []
    for item in per_task:
        table_rows.append(
            [
                item.get("taskId"),
                item.get("label"),
                f"{item.get('passes')}/{item.get('n')}",
                f"{item.get('avgScore', 0):.2f}",
                item.get("inputTokens"),
                item.get("cacheReadTokens"),
                item.get("cacheCreationTokens"),
                item.get("outputTokens"),
                money(item.get("cost")),
                item.get("latencyMs"),
                ", ".join(item.get("signalsHit", [])) or "-",
            ]
        )
    doc.table(
        ["Task", "Arm", "Pass", "Score", "In", "CacheR", "CacheW", "Out", "Cost", "Latency", "Signals"],
        table_rows,
        widths=[2500, 1450, 700, 650, 550, 650, 650, 550, 700, 750, 1210],
    )
    doc.heading("Row-Level Result Records", 2)
    row_table = []
    for row in rows:
        row_table.append(
            [
                row.get("taskId"),
                row.get("armLabel"),
                row.get("seed"),
                "pass" if row.get("judge", {}).get("passed") else "fail",
                row.get("judge", {}).get("score"),
                row.get("usage", {}).get("inputTokens"),
                row.get("usage", {}).get("cacheReadTokens"),
                row.get("usage", {}).get("cacheCreationTokens"),
                row.get("usage", {}).get("outputTokens"),
                money(row.get("costUsd")),
                row.get("latencyMs"),
                row.get("sourceRunId"),
                row.get("originalArm"),
            ]
        )
    doc.table(
        ["Task", "Arm", "Seed", "Pass", "Score", "In", "CacheR", "CacheW", "Out", "Cost", "Latency", "Source run", "Original arm"],
        row_table,
        widths=[2200, 1250, 500, 600, 600, 450, 550, 600, 450, 650, 650, 1700, 760],
    )


def prompt_path_for(row: dict[str, Any]) -> Path:
    source_run = row["sourceRunId"]
    arm = row.get("originalArm") or row["arm"]
    return RUNS / source_run / "prompts" / f"{row['taskId']}__{arm}__seed-{row['seed']}.json"


def add_prompt_output_appendix(doc: DocxBuilder, manifest: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    doc.heading("Prompt And Output Appendix", 1, page_break_before=True)
    doc.p(
        "Every row below includes the candidate-visible input prompt segments, the model output, usage/cost/latency, "
        "and the judge result. The KG-only rows are sourced from original arm kg-compact and renamed only for "
        "the derived comparison report."
    )
    rows_by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        rows_by_task[row["taskId"]].append(row)

    task_order = manifest.get("tasks", sorted(rows_by_task))
    for task_idx, task_id in enumerate(task_order, 1):
        task_rows = sorted(
            rows_by_task[task_id],
            key=lambda r: (CODE_GEN_ARMS.index(r["arm"]) if r["arm"] in CODE_GEN_ARMS else 99, r.get("seed", 0)),
        )
        doc.heading(f"{task_idx}. {task_id}", 2, page_break_before=task_idx > 1)
        doc.table(
            ["Arm", "Seed", "Pass", "Score", "Input", "Output", "Cost", "Latency", "Source"],
            [
                [
                    row.get("armLabel"),
                    row.get("seed"),
                    "pass" if row.get("judge", {}).get("passed") else "fail",
                    row.get("judge", {}).get("score"),
                    row.get("usage", {}).get("inputTokens"),
                    row.get("usage", {}).get("outputTokens"),
                    money(row.get("costUsd")),
                    row.get("latencyMs"),
                    f"{row.get('sourceRunId')}:{row.get('originalArm')}",
                ]
                for row in task_rows
            ],
            widths=[1700, 500, 650, 650, 700, 700, 700, 750, 3010],
        )
        for row in task_rows:
            original_arm = row.get("originalArm") or row.get("arm")
            title = f"{task_id} | {row.get('armLabel')} | seed {row.get('seed')} | source {row.get('sourceRunId')}:{original_arm}"
            doc.heading(title, 3)
            ppath = prompt_path_for(row)
            prompt_artifact = read_json(ppath)
            doc.table(
                ["Field", "Value"],
                [
                    ["Prompt artifact", rel(ppath)],
                    ["Run ID", prompt_artifact.get("runId")],
                    ["Task", prompt_artifact.get("taskId")],
                    ["Original arm", prompt_artifact.get("arm")],
                    ["Derived arm", row.get("arm")],
                    ["Seed", prompt_artifact.get("seed")],
                    ["Runner/model", f"{row.get('runner')} / {row.get('model')}"],
                    ["Usage", short_json(row.get("usage"))],
                    ["Cost USD", row.get("costUsd")],
                    ["Latency ms", row.get("latencyMs")],
                    ["Signals hit", ", ".join(row.get("signalsHit", [])) or "-"],
                    ["Judge", short_json(row.get("judge"))],
                ],
                widths=[1900, 7460],
            )
            prompt = prompt_artifact.get("prompt", {})
            for key in sorted(prompt.keys(), key=lambda k: ["system", "pimContext", "licContext", "userTask"].index(k) if k in ["system", "pimContext", "licContext", "userTask"] else 99):
                doc.code_block(f"Input prompt segment: {key}", prompt.get(key, ""))
            doc.code_block("Model output", row.get("output", ""))
            doc.code_block("Judge result", json.dumps(row.get("judge", {}), ensure_ascii=False, indent=2))


def main() -> None:
    manifest = read_json(DERIVED_RUN / "manifest.json")
    analysis = read_json(DERIVED_RUN / "analysis.json")
    rows = read_jsonl(DERIVED_RUN / "rows.jsonl")

    # Defensive guard against accidentally pulling full PIM rows into the derived data set.
    bad_rows = [
        row
        for row in rows
        if row.get("arm") in {"pim-full", "pim-clipped", "lic-pim-combined"}
        or row.get("originalArm") in {"pim-full", "pim-clipped", "lic-pim-combined"}
    ]
    if bad_rows:
        raise RuntimeError(f"Found non-kg-compact PIM rows in derived row set: {len(bad_rows)}")
    kg_rows = [row for row in rows if row.get("arm") == "kg-only"]
    if any(row.get("originalArm") != "kg-compact" for row in kg_rows):
        raise RuntimeError("Derived KG-only rows are not all sourced from original arm kg-compact")

    doc = DocxBuilder()
    add_front_matter(doc, manifest, analysis, rows)
    add_graph_and_retrieval_summary(doc)
    add_run_inventory(doc)
    add_task_materiality(doc, manifest)
    add_rows_summary(doc, manifest, analysis, rows)
    add_prompt_output_appendix(doc, manifest, rows)
    write_docx(doc, OUT)
    print(f"wrote {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
