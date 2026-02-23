from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


ARTICLE_START_RE = re.compile(r"^\s*(article|art\.?)\s+[a-z0-9ivxlcdm]+", re.IGNORECASE)


def normalize_text(text: str) -> str:
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", " ")
    lines = [line.rstrip() for line in cleaned.splitlines()]
    compacted: list[str] = []
    prev_empty = False
    for line in lines:
        if line.strip() == "":
            if prev_empty:
                continue
            prev_empty = True
            compacted.append("")
            continue
        prev_empty = False
        compacted.append(line)
    return "\n".join(compacted).strip()


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def split_manual_text_into_sections(text: str, max_chars: int) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []

    lines = normalized.splitlines()
    sections: list[list[str]] = []
    current: list[str] = []

    for line in lines:
        if ARTICLE_START_RE.match(line) and current:
            sections.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        sections.append(current)

    # Keep sections article-first, but split oversized sections to avoid giant rows.
    out: list[str] = []
    for sec_lines in sections:
        sec_text = normalize_text("\n".join(sec_lines))
        if len(sec_text) <= max_chars:
            out.append(sec_text)
            continue

        paragraphs = [p.strip() for p in sec_text.split("\n\n") if p.strip()]
        if not paragraphs:
            out.append(sec_text)
            continue

        part: list[str] = []
        part_len = 0
        for p in paragraphs:
            add_len = len(p) + (2 if part else 0)
            if part and part_len + add_len > max_chars:
                out.append(normalize_text("\n\n".join(part)))
                part = [p]
                part_len = len(p)
            else:
                part.append(p)
                part_len += add_len
        if part:
            out.append(normalize_text("\n\n".join(part)))

    return [x for x in out if x]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply manual text override to one document in pages.jsonl.")
    parser.add_argument("--pages-path", default="data/ingestion/pages.jsonl")
    parser.add_argument("--relative-path", required=True, help="Document relative_path key to replace.")
    parser.add_argument(
        "--text-path",
        required=True,
        help="Manual plain text source file. Use '-' to read text from stdin.",
    )
    parser.add_argument(
        "--output-pages-path",
        default="data/ingestion/pages.manual.jsonl",
        help="Output JSONL path with manual override applied.",
    )
    parser.add_argument(
        "--max-section-chars",
        type=int,
        default=3200,
        help="Maximum characters per generated manual section row.",
    )
    parser.add_argument(
        "--report-path",
        default="data/ingestion/manual_override_report.json",
        help="Summary report path.",
    )
    return parser.parse_args()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                continue
            try:
                rows.append(json.loads(s))
            except json.JSONDecodeError:
                continue
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_manual_rows(template_row: dict[str, Any], relative_path: str, sections: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for idx, section in enumerate(sections, start=1):
        text = normalize_text(section)
        rows.append(
            {
                "doc_id": template_row["doc_id"],
                "relative_path": relative_path,
                "source_path": template_row.get("source_path"),
                "domain": template_row.get("domain"),
                "extension": ".pdf",
                "page_number": idx,
                "native_char_count": len(text),
                "ocr_char_count": 0,
                "ocr_used": False,
                "ocr_error": None,
                "extraction_method": "manual",
                "text": text,
                "token_count_est": estimate_tokens(text),
            }
        )
    return rows


def main() -> None:
    args = parse_args()
    pages_path = Path(args.pages_path)
    text_path = Path(args.text_path)
    output_pages_path = Path(args.output_pages_path)
    report_path = Path(args.report_path)

    if not pages_path.exists():
        raise FileNotFoundError(f"pages file not found: {pages_path}")
    if args.text_path != "-" and not text_path.exists():
        raise FileNotFoundError(f"manual text file not found: {text_path}")

    all_rows = load_jsonl(pages_path)
    target_rows = [r for r in all_rows if r.get("relative_path") == args.relative_path]
    if not target_rows:
        raise ValueError(f"relative_path not found in pages file: {args.relative_path}")

    if args.text_path == "-":
        import sys

        manual_text = sys.stdin.read()
        text_source = "<stdin>"
    else:
        manual_text = text_path.read_text(encoding="utf-8", errors="ignore")
        text_source = str(text_path)
    sections = split_manual_text_into_sections(manual_text, max_chars=max(800, int(args.max_section_chars)))
    if not sections:
        raise ValueError("manual text is empty after normalization")

    template_row = target_rows[0]
    manual_rows = build_manual_rows(template_row, args.relative_path, sections)

    merged: list[dict[str, Any]] = []
    inserted = False
    for row in all_rows:
        if row.get("relative_path") == args.relative_path:
            if not inserted:
                merged.extend(manual_rows)
                inserted = True
            continue
        merged.append(row)
    if not inserted:
        merged.extend(manual_rows)

    write_jsonl(output_pages_path, merged)

    report = {
        "pages_path": str(pages_path),
        "output_pages_path": str(output_pages_path),
        "relative_path": args.relative_path,
        "text_path": text_source,
        "original_pages": len(target_rows),
        "manual_sections": len(manual_rows),
        "manual_chars_total": sum(len(r["text"]) for r in manual_rows),
        "max_section_chars": max(len(r["text"]) for r in manual_rows),
        "min_section_chars": min(len(r["text"]) for r in manual_rows),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("[manual-override] completed")
    print(
        f"relative_path={args.relative_path} original_pages={len(target_rows)} "
        f"manual_sections={len(manual_rows)}"
    )
    print(f"output_pages={output_pages_path}")
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
