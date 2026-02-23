from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tqdm import tqdm


ARTICLE_HEADER_RE = re.compile(
    (
        r"^\s*(article|art\.?)\s+"
        r"("
        r"[a-z]\.?-?[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[ivxlcdm]+(?:[-/.][0-9]+)?|"
        r"premier|1er|unique"
        r")\b(.*)$"
    ),
    re.IGNORECASE,
)
ARTICLE_KEYWORD_ONLY_RE = re.compile(r"^\s*(article|art\.?)\s*$", re.IGNORECASE)
ARTICLE_NUMBER_CONTINUATION_RE = re.compile(
    (
        r"^\s*("
        r"[a-z]\.?-?[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[ivxlcdm]+"
        r")\b"
    ),
    re.IGNORECASE,
)
TOC_TITLE_RE = re.compile(
    r"^\s*(table\s+des\s+matieres|table\s+of\s+contents|sommaire)\b",
    re.IGNORECASE,
)
TOC_DOT_LEADER_RE = re.compile(r"(?:\.{5,}|[_\-]{5,}|[•·]{3,})")
TOC_PAGE_NUMBER_RE = re.compile(r"\b\d{1,4}\s*$")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.?!;:])\s+(?=[A-Z0-9])")
HEADING_PATTERNS = {
    "livre": re.compile(r"^\s*livre\b.*$", re.IGNORECASE),
    "titre": re.compile(r"^\s*titre\b.*$", re.IGNORECASE),
    "chapitre": re.compile(r"^\s*chapitre\b.*$", re.IGNORECASE),
    "section": re.compile(r"^\s*section\b.*$", re.IGNORECASE),
}


@dataclass
class ChunkingArgs:
    pages_path: Path
    output_path: Path
    report_path: Path
    max_tokens: int
    overlap_tokens: int
    min_chunk_chars: int
    max_page_span: int
    limit_docs: int | None
    strict_article_chunks: bool


def parse_args() -> ChunkingArgs:
    parser = argparse.ArgumentParser(description="Article-first chunking from pages.jsonl.")
    parser.add_argument("--pages-path", default="data/ingestion/pages.jsonl", help="Input pages JSONL.")
    parser.add_argument("--output-path", default="data/chunks/chunks.jsonl", help="Output chunks JSONL.")
    parser.add_argument(
        "--report-path",
        default="data/chunks/chunking_report.json",
        help="Output chunking report JSON.",
    )
    parser.add_argument("--max-tokens", type=int, default=900, help="Max estimated tokens per chunk.")
    parser.add_argument("--overlap-tokens", type=int, default=120, help="Estimated token overlap.")
    parser.add_argument("--min-chunk-chars", type=int, default=120, help="Minimum chars per chunk.")
    parser.add_argument(
        "--max-page-span",
        type=int,
        default=6,
        help="Maximum number of pages covered by one chunk.",
    )
    parser.add_argument("--limit-docs", type=int, default=None, help="Optional document limit for tests.")
    parser.add_argument(
        "--strict-article-chunks",
        action="store_true",
        help="Force one chunk per detected article (no split of article blocks).",
    )
    ns = parser.parse_args()
    return ChunkingArgs(
        pages_path=Path(ns.pages_path),
        output_path=Path(ns.output_path),
        report_path=Path(ns.report_path),
        max_tokens=max(100, ns.max_tokens),
        overlap_tokens=max(0, ns.overlap_tokens),
        min_chunk_chars=max(1, ns.min_chunk_chars),
        max_page_span=max(1, ns.max_page_span),
        limit_docs=ns.limit_docs,
        strict_article_chunks=bool(ns.strict_article_chunks),
    )


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_text(text: str) -> str:
    cleaned = text.replace("\x00", " ").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.splitlines()]
    compacted: list[str] = []
    prev_empty = False
    for line in lines:
        if not line:
            if prev_empty:
                continue
            prev_empty = True
            compacted.append("")
            continue
        prev_empty = False
        compacted.append(line)
    return "\n".join(compacted).strip()


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def control_char_ratio(text: str) -> float:
    if not text:
        return 0.0
    control_count = sum(1 for ch in text if ord(ch) < 32 and ch not in "\n\t\r")
    return control_count / len(text)


def line_is_article_header(line: str, strict_mode: bool = False) -> bool:
    normalized = " ".join(line.split())
    if not normalized:
        return False

    if strict_mode:
        # Strict mode favors recall: detect as many article headers as possible.
        if len(normalized) > 260:
            return False
        return ARTICLE_HEADER_RE.match(normalized) is not None

    if len(normalized) > 140:
        return False
    if len(normalized.split()) > 18:
        return False

    match = ARTICLE_HEADER_RE.match(normalized)
    if not match:
        return False

    tail = (match.group(3) or "").strip()
    if not tail:
        return True
    if tail[0] in "-:.":
        return True
    # Accept short title-like tails, reject long prose references.
    return len(tail.split()) <= 8 and tail[:1].isupper()


def is_split_article_header_start(line: str, next_line: str | None) -> bool:
    if not next_line:
        return False
    return bool(
        ARTICLE_KEYWORD_ONLY_RE.match(line.strip())
        and ARTICLE_NUMBER_CONTINUATION_RE.match(next_line.strip())
    )


def is_probably_toc_line(line: str) -> bool:
    normalized = " ".join(line.split())
    if not normalized:
        return False

    if TOC_TITLE_RE.match(normalized):
        return True

    if not TOC_DOT_LEADER_RE.search(normalized):
        return False

    if TOC_PAGE_NUMBER_RE.search(normalized):
        return True

    # Some OCR outputs keep only dot leaders with section names.
    return normalized.count(".") >= 24


def filter_toc_noise(lines: list[str]) -> tuple[list[str], int, bool]:
    non_empty = [line.strip() for line in lines if line.strip()]
    if not non_empty:
        return lines, 0, False

    toc_like_count = sum(1 for line in non_empty if is_probably_toc_line(line))
    toc_ratio = toc_like_count / len(non_empty)

    # Skip an entire page if it is mostly TOC noise.
    if len(non_empty) >= 8 and toc_ratio >= 0.45:
        return [], toc_like_count, True

    filtered: list[str] = []
    removed = 0
    for raw in lines:
        line = raw.strip()
        if line and is_probably_toc_line(line):
            removed += 1
            continue
        filtered.append(raw)
    return filtered, removed, False


def get_article_hint(line: str | None) -> str | None:
    if not line:
        return None
    normalized = " ".join(line.split())
    return normalized[:120].rstrip()


def update_heading_context(context: dict[str, str | None], line: str) -> None:
    for key, pattern in HEADING_PATTERNS.items():
        if pattern.match(line):
            context[key] = " ".join(line.split())[:200]


def load_documents_from_pages(
    pages_path: Path,
    limit_docs: int | None,
) -> tuple[list[dict[str, Any]], int]:
    if not pages_path.exists():
        raise FileNotFoundError(f"pages file not found: {pages_path}")

    docs_by_id: dict[str, dict[str, Any]] = {}
    skipped_lines = 0

    with pages_path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                skipped_lines += 1
                continue
            try:
                row = json.loads(s)
            except json.JSONDecodeError:
                skipped_lines += 1
                continue

            doc_id = row.get("doc_id")
            if not doc_id:
                skipped_lines += 1
                continue

            if doc_id not in docs_by_id:
                if limit_docs is not None and len(docs_by_id) >= limit_docs:
                    continue
                docs_by_id[doc_id] = {
                    "doc_id": doc_id,
                    "relative_path": row.get("relative_path"),
                    "domain": row.get("domain"),
                    "source_path": row.get("source_path"),
                    "pages": [],
                }

            docs_by_id[doc_id]["pages"].append(
                {
                    "page_number": int(row.get("page_number", 0)),
                    "text": row.get("text", "") or "",
                    "extraction_method": row.get("extraction_method", "native"),
                }
            )

    docs = list(docs_by_id.values())
    for doc in docs:
        doc["pages"].sort(key=lambda x: x["page_number"])
    return docs, skipped_lines


def split_text_by_words(text: str, max_tokens: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    max_chars = max_tokens * 4
    parts: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in words:
        extra = len(word) + (1 if current else 0)
        if current and current_len + extra > max_chars:
            parts.append(" ".join(current))
            current = [word]
            current_len = len(word)
        else:
            current.append(word)
            current_len += extra
    if current:
        parts.append(" ".join(current))
    return [normalize_text(part) for part in parts if part.strip()]


def pack_segments_to_max_tokens(segments: list[str], max_tokens: int) -> list[str]:
    packed: list[str] = []
    current_parts: list[str] = []
    current_tokens = 0

    def flush_current() -> None:
        nonlocal current_parts, current_tokens
        if not current_parts:
            return
        text = normalize_text(" ".join(current_parts))
        if text:
            packed.append(text)
        current_parts = []
        current_tokens = 0

    for seg in segments:
        segment = normalize_text(seg)
        if not segment:
            continue
        seg_tokens = estimate_tokens(segment)
        if seg_tokens > max_tokens:
            flush_current()
            packed.extend(split_text_by_words(segment, max_tokens))
            continue
        if current_parts and current_tokens + seg_tokens > max_tokens:
            flush_current()
        current_parts.append(segment)
        current_tokens += seg_tokens

    flush_current()
    return packed


def split_text_to_max_tokens(text: str, max_tokens: int) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    if estimate_tokens(normalized) <= max_tokens:
        return [normalized]

    paragraphs = [normalize_text(p) for p in re.split(r"\n{2,}", normalized) if p.strip()]
    if not paragraphs:
        paragraphs = [normalized]

    pieces: list[str] = []
    for paragraph in paragraphs:
        if estimate_tokens(paragraph) <= max_tokens:
            pieces.append(paragraph)
            continue
        sentence_like = [s.strip() for s in SENTENCE_SPLIT_RE.split(paragraph) if s.strip()]
        if len(sentence_like) <= 1:
            sentence_like = [s.strip() for s in re.split(r"\n+", paragraph) if s.strip()]
        if len(sentence_like) <= 1:
            pieces.extend(split_text_by_words(paragraph, max_tokens))
            continue
        pieces.extend(pack_segments_to_max_tokens(sentence_like, max_tokens))
    return [normalize_text(piece) for piece in pieces if piece.strip()]


def split_oversized_unit(unit: dict[str, Any], max_tokens: int) -> list[dict[str, Any]]:
    text = normalize_text(unit.get("text", ""))
    if not text:
        return []
    if estimate_tokens(text) <= max_tokens:
        return [{**unit, "text": text}]

    parts = split_text_to_max_tokens(text, max_tokens=max_tokens)
    if len(parts) <= 1:
        return [{**unit, "text": text}]
    return [{**unit, "text": part} for part in parts if part]


def split_text_on_article_headers(text: str) -> list[tuple[str | None, str]]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    lines = normalized.splitlines()
    parts: list[tuple[str | None, str]] = []
    current_lines: list[str] = []
    current_hint: str | None = None

    i = 0
    while i < len(lines):
        raw_line = lines[i]
        line = raw_line.strip()
        next_line = lines[i + 1].strip() if i + 1 < len(lines) else None
        if line_is_article_header(line, strict_mode=True) or is_split_article_header_start(line, next_line):
            if current_lines:
                part_text = normalize_text("\n".join(current_lines))
                if part_text:
                    parts.append((current_hint, part_text))
            if is_split_article_header_start(line, next_line):
                combined_header = f"{line} {next_line}"
                current_lines = [line, next_line or ""]
                current_hint = get_article_hint(combined_header)
                i += 2
                continue
            current_lines = [line]
            current_hint = get_article_hint(line)
        else:
            current_lines.append(line)
        i += 1

    if current_lines:
        part_text = normalize_text("\n".join(current_lines))
        if part_text:
            parts.append((current_hint, part_text))

    return parts


def build_blocks_for_document(
    doc: dict[str, Any],
    strict_article_chunks: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    blocks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    heading_context = {"livre": None, "titre": None, "chapitre": None, "section": None}
    article_headers_detected = 0
    toc_pages_skipped = 0
    toc_lines_skipped = 0

    def flush_current() -> None:
        nonlocal current
        if current is None:
            return
        if current["units"]:
            blocks.append(current)
        current = None

    def ensure_current_block() -> None:
        nonlocal current
        if current is None:
            current = {
                "article_hint": None,
                "heading_context": dict(heading_context),
                "units": [],
            }

    for page in doc["pages"]:
        page_number = page["page_number"]
        method = page.get("extraction_method", "native")
        normalized = normalize_text(page.get("text", ""))
        if not normalized:
            continue
        page_lines = normalized.splitlines()
        page_lines, removed_toc_lines, page_was_toc = filter_toc_noise(page_lines)
        toc_lines_skipped += removed_toc_lines
        if page_was_toc:
            toc_pages_skipped += 1
            continue
        if not page_lines:
            continue

        paragraph_lines: list[str] = []

        def flush_paragraph() -> None:
            if not paragraph_lines:
                return
            paragraph = normalize_text("\n".join(paragraph_lines))
            paragraph_lines.clear()
            if not paragraph:
                return
            ensure_current_block()
            current["units"].append(
                {
                    "text": paragraph,
                    "page_number": page_number,
                    "method": method,
                }
            )

        i = 0
        while i < len(page_lines):
            raw_line = page_lines[i]
            line = raw_line.strip()
            next_line = page_lines[i + 1].strip() if i + 1 < len(page_lines) else None
            if not line:
                flush_paragraph()
                i += 1
                continue

            update_heading_context(heading_context, line)
            if line_is_article_header(line, strict_mode=strict_article_chunks) or is_split_article_header_start(
                line,
                next_line,
            ):
                flush_paragraph()
                flush_current()
                article_headers_detected += 1
                combined_header = (
                    f"{line} {next_line}"
                    if is_split_article_header_start(line, next_line)
                    else line
                )
                current = {
                    "article_hint": get_article_hint(combined_header),
                    "heading_context": dict(heading_context),
                    "units": [],
                }
                paragraph_lines = [line]
                if is_split_article_header_start(line, next_line):
                    paragraph_lines.append(next_line or "")
                    i += 2
                    continue
                i += 1
                continue

            paragraph_lines.append(line)
            i += 1

        flush_paragraph()

    flush_current()
    return blocks, {
        "article_headers_detected": article_headers_detected,
        "toc_pages_skipped": toc_pages_skipped,
        "toc_lines_skipped": toc_lines_skipped,
    }


def chunk_units(
    units: list[dict[str, Any]],
    max_tokens: int,
    overlap_tokens: int,
    max_page_span: int,
) -> list[list[dict[str, Any]]]:
    if not units:
        return []

    unit_tokens = [estimate_tokens(u["text"]) for u in units]
    chunks: list[list[dict[str, Any]]] = []
    start = 0
    n = len(units)

    while start < n:
        end = start
        token_sum = 0
        min_page = units[start]["page_number"]
        max_page = units[start]["page_number"]

        while end < n:
            t = unit_tokens[end]
            next_min_page = min(min_page, units[end]["page_number"])
            next_max_page = max(max_page, units[end]["page_number"])
            next_span = next_max_page - next_min_page + 1
            if end > start and (token_sum + t > max_tokens or next_span > max_page_span):
                break
            token_sum += t
            min_page = next_min_page
            max_page = next_max_page
            end += 1

        if end == start:
            end = start + 1

        chunks.append(units[start:end])

        if end >= n:
            break

        overlap_sum = 0
        overlap_start = end
        i = end - 1
        while i >= start and overlap_sum < overlap_tokens:
            overlap_sum += unit_tokens[i]
            overlap_start = i
            i -= 1

        if overlap_start <= start:
            start = end
        else:
            start = overlap_start

    return chunks


def build_chunks_for_document(
    doc: dict[str, Any],
    max_tokens: int,
    overlap_tokens: int,
    min_chunk_chars: int,
    max_page_span: int,
    strict_article_chunks: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    blocks, block_stats = build_blocks_for_document(
        doc,
        strict_article_chunks=strict_article_chunks,
    )
    chunks: list[dict[str, Any]] = []
    chunk_idx = 0
    split_from_long_article = 0
    dedup_removed = 0
    oversized_units_split = 0
    control_char_filtered = 0
    strict_multi_header_splits = 0

    for block in blocks:
        units: list[dict[str, Any]] = []
        if strict_article_chunks and block["article_hint"] is not None:
            # Keep an entire detected article as a single chunk candidate.
            for unit in block["units"]:
                text = normalize_text(unit.get("text", ""))
                if not text:
                    continue
                units.append({**unit, "text": text})
        else:
            for unit in block["units"]:
                split_units = split_oversized_unit(unit, max_tokens=max_tokens)
                if len(split_units) > 1:
                    oversized_units_split += len(split_units) - 1
                units.extend(split_units)
        if not units:
            continue
        if strict_article_chunks and block["article_hint"] is not None:
            unit_groups = [units]
        else:
            unit_groups = chunk_units(
                units,
                max_tokens=max_tokens,
                overlap_tokens=overlap_tokens if block["article_hint"] else min(overlap_tokens, 60),
                max_page_span=max_page_span,
            )
            if len(unit_groups) > 1 and block["article_hint"] is not None:
                split_from_long_article += len(unit_groups) - 1

        for part_idx, group in enumerate(unit_groups, start=1):
            text = normalize_text("\n\n".join(unit["text"] for unit in group))
            page_numbers = sorted({unit["page_number"] for unit in group})
            source_methods = sorted({unit["method"] for unit in group})

            output_parts: list[tuple[str | None, str]] = [(block["article_hint"], text)]
            if strict_article_chunks:
                split_parts = split_text_on_article_headers(text)
                if len(split_parts) > 1:
                    strict_multi_header_splits += len(split_parts) - 1
                    output_parts = split_parts

            part_total = len(output_parts)
            for out_idx, (out_article_hint, out_text) in enumerate(output_parts, start=1):
                if len(out_text) < min_chunk_chars:
                    continue
                # Drop chunks dominated by binary/control glyph artifacts from broken native text layers.
                if control_char_ratio(out_text) > 0.05:
                    control_char_filtered += 1
                    continue
                chunks.append(
                    {
                        "chunk_id": f"{doc['doc_id']}_{chunk_idx:05d}",
                        "doc_id": doc["doc_id"],
                        "relative_path": doc["relative_path"],
                        "domain": doc.get("domain"),
                        "source_path": doc.get("source_path"),
                        "article_hint": out_article_hint or block["article_hint"],
                        "heading_livre": block["heading_context"].get("livre"),
                        "heading_titre": block["heading_context"].get("titre"),
                        "heading_chapitre": block["heading_context"].get("chapitre"),
                        "heading_section": block["heading_context"].get("section"),
                        "page_start": page_numbers[0],
                        "page_end": page_numbers[-1],
                        "page_numbers": page_numbers,
                        "source_methods": source_methods,
                        "chunk_part_index": out_idx if part_total > 1 else part_idx,
                        "chunk_part_total": part_total if part_total > 1 else len(unit_groups),
                        "text": out_text,
                        "char_count": len(out_text),
                        "token_count_est": estimate_tokens(out_text),
                    }
                )
                chunk_idx += 1

    # Deduplicate exact repeated chunks within the same document.
    seen_keys: set[tuple[str, str | None]] = set()
    deduped: list[dict[str, Any]] = []
    for chunk in chunks:
        text_hash = hashlib.sha1(chunk["text"].encode("utf-8", errors="ignore")).hexdigest()
        key = (text_hash, chunk.get("article_hint"))
        if key in seen_keys:
            dedup_removed += 1
            continue
        seen_keys.add(key)
        deduped.append(chunk)

    stats = {
        "blocks_total": len(blocks),
        "article_headers_detected": block_stats["article_headers_detected"],
        "chunks_total": len(deduped),
        "chunks_with_article_hint": sum(1 for c in deduped if c["article_hint"]),
        "long_article_extra_parts": split_from_long_article,
        "dedup_removed": dedup_removed,
        "oversized_units_split": oversized_units_split,
        "control_char_filtered": control_char_filtered,
        "strict_multi_header_splits": strict_multi_header_splits,
        "toc_pages_skipped": block_stats["toc_pages_skipped"],
        "toc_lines_skipped": block_stats["toc_lines_skipped"],
    }
    return deduped, stats


def run_chunking(args: ChunkingArgs) -> dict[str, Any]:
    started_at = utc_now_iso()
    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.parent.mkdir(parents=True, exist_ok=True)

    documents, skipped_lines = load_documents_from_pages(args.pages_path, limit_docs=args.limit_docs)
    all_chunks: list[dict[str, Any]] = []
    per_doc_stats: list[dict[str, Any]] = []
    counters = {
        "docs_total": len(documents),
        "docs_with_any_article_header": 0,
        "blocks_total": 0,
        "chunks_total": 0,
        "chunks_with_article_hint": 0,
        "long_article_extra_parts": 0,
        "dedup_removed": 0,
        "oversized_units_split": 0,
        "control_char_filtered": 0,
        "strict_multi_header_splits": 0,
        "toc_pages_skipped": 0,
        "toc_lines_skipped": 0,
        "skipped_input_lines": skipped_lines,
    }

    for doc in tqdm(documents, desc="Chunking", unit="doc"):
        chunks, stats = build_chunks_for_document(
            doc,
            max_tokens=args.max_tokens,
            overlap_tokens=args.overlap_tokens,
            min_chunk_chars=args.min_chunk_chars,
            max_page_span=args.max_page_span,
            strict_article_chunks=args.strict_article_chunks,
        )
        all_chunks.extend(chunks)
        counters["blocks_total"] += stats["blocks_total"]
        counters["chunks_total"] += stats["chunks_total"]
        counters["chunks_with_article_hint"] += stats["chunks_with_article_hint"]
        counters["long_article_extra_parts"] += stats["long_article_extra_parts"]
        counters["dedup_removed"] += stats["dedup_removed"]
        counters["oversized_units_split"] += stats["oversized_units_split"]
        counters["control_char_filtered"] += stats["control_char_filtered"]
        counters["strict_multi_header_splits"] += stats["strict_multi_header_splits"]
        counters["toc_pages_skipped"] += stats["toc_pages_skipped"]
        counters["toc_lines_skipped"] += stats["toc_lines_skipped"]
        if stats["article_headers_detected"] > 0:
            counters["docs_with_any_article_header"] += 1
        per_doc_stats.append({"doc_id": doc["doc_id"], "relative_path": doc["relative_path"], **stats})

    with args.output_path.open("w", encoding="utf-8") as f:
        for row in all_chunks:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    report = {
        "started_at_utc": started_at,
        "finished_at_utc": utc_now_iso(),
        "config": {
            "pages_path": str(args.pages_path),
            "output_path": str(args.output_path),
            "report_path": str(args.report_path),
            "max_tokens": args.max_tokens,
            "overlap_tokens": args.overlap_tokens,
            "min_chunk_chars": args.min_chunk_chars,
            "max_page_span": args.max_page_span,
            "limit_docs": args.limit_docs,
            "strict_article_chunks": args.strict_article_chunks,
        },
        "stats": counters,
        "per_doc_stats": per_doc_stats,
    }
    args.report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    args = parse_args()
    report = run_chunking(args)
    stats = report["stats"]
    print("[chunking] completed")
    print(f"strict_article_chunks={args.strict_article_chunks}")
    print(
        "docs_total="
        f"{stats['docs_total']} chunks_total={stats['chunks_total']} "
        f"chunks_with_article_hint={stats['chunks_with_article_hint']}"
    )
    print(
        "docs_with_any_article_header="
        f"{stats['docs_with_any_article_header']} dedup_removed={stats['dedup_removed']} "
        f"skipped_input_lines={stats['skipped_input_lines']}"
    )
    print(
        "oversized_units_split="
        f"{stats['oversized_units_split']} toc_pages_skipped={stats['toc_pages_skipped']} "
        f"toc_lines_skipped={stats['toc_lines_skipped']}"
    )
    print(f"control_char_filtered={stats['control_char_filtered']}")
    print(f"strict_multi_header_splits={stats['strict_multi_header_splits']}")
    print(f"chunks_file={args.output_path}")
    print(f"report_file={args.report_path}")


if __name__ == "__main__":
    main()
