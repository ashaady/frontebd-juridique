from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


ARTICLE_HEADER_RE = re.compile(
    (
        r"^\s*(article|art\.?)\s+"
        r"("
        r"[a-z]\.?-?[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[ivxlcdm]+(?:[-/.][0-9]+)?|"
        r"premier|1er|unique"
        r")\b"
    ),
    re.IGNORECASE | re.MULTILINE,
)

ARTICLE_NUM_FROM_HINT_RE = re.compile(
    (
        r"^\s*(article|art\.?)\s+"
        r"("
        r"[a-z]\.?-?[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[0-9]+(?:[-/.][0-9]+)*[a-z]?|"
        r"[ivxlcdm]+(?:[-/.][0-9]+)?|"
        r"premier|1er|unique"
        r")\b"
    ),
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate one-article-per-chunk constraints.")
    parser.add_argument("--chunks-path", default="data/chunks/chunks.jsonl", help="Chunk JSONL file.")
    parser.add_argument(
        "--max-headers-per-chunk",
        type=int,
        default=1,
        help="Maximum allowed number of article headers found in chunk text.",
    )
    parser.add_argument(
        "--enforce-unique-doc-article",
        action="store_true",
        help="Fail if the same (doc_id, article_number) appears in more than one chunk.",
    )
    parser.add_argument(
        "--max-example-rows",
        type=int,
        default=10,
        help="How many violating examples to print per category.",
    )
    return parser.parse_args()


def article_num_from_hint(hint: str | None) -> str | None:
    if not hint:
        return None
    normalized = " ".join(str(hint).split())
    match = ARTICLE_NUM_FROM_HINT_RE.match(normalized)
    if not match:
        return None
    return normalize_article_num(match.group(2))


def first_article_num_from_text(text: str) -> str | None:
    match = ARTICLE_HEADER_RE.search(text or "")
    if not match:
        return None
    return normalize_article_num(match.group(2))


def normalize_article_num(value: str | None) -> str | None:
    if not value:
        return None
    num = value.strip().lower().replace(" ", "")
    if not num:
        return None
    if num in {"premier", "1er", "unique"}:
        return num
    if any(ch.isdigit() for ch in num):
        return num
    # Keep only multi-letter roman numerals (ex: ii, iv, xii), drop ambiguous single letters.
    roman_chars = set("ivxlcdm")
    if len(num) >= 2 and set(num).issubset(roman_chars):
        return num
    return None


def validate(
    chunks_path: Path,
    max_headers_per_chunk: int,
    enforce_unique_doc_article: bool,
    max_example_rows: int,
) -> int:
    if not chunks_path.exists():
        print(f"[validate-articles] missing file: {chunks_path}")
        return 1

    total = 0
    json_errors = 0
    missing_text = 0
    too_many_headers = 0
    unique_doc_article_violations = 0

    too_many_header_examples: list[tuple[int, str, int]] = []
    unique_violations_examples: list[tuple[str, str, str, str]] = []
    json_error_examples: list[tuple[int, str]] = []

    seen_doc_article: dict[tuple[str, str], str] = {}

    with chunks_path.open("r", encoding="utf-8", errors="ignore") as f:
        for lineno, line in enumerate(f, start=1):
            s = line.strip()
            if not s:
                continue
            total += 1
            try:
                row: dict[str, Any] = json.loads(s)
            except json.JSONDecodeError:
                json_errors += 1
                if len(json_error_examples) < max_example_rows:
                    json_error_examples.append((lineno, s[:200]))
                continue

            text = row.get("text")
            if not isinstance(text, str):
                missing_text += 1
                text = ""

            headers_found = len(list(ARTICLE_HEADER_RE.finditer(text)))
            if headers_found > max_headers_per_chunk:
                too_many_headers += 1
                if len(too_many_header_examples) < max_example_rows:
                    too_many_header_examples.append(
                        (lineno, str(row.get("chunk_id")), headers_found)
                    )

            if enforce_unique_doc_article:
                doc_id = str(row.get("doc_id"))
                article_num = article_num_from_hint(row.get("article_hint"))
                if article_num is None:
                    article_num = first_article_num_from_text(text)
                if article_num:
                    key = (doc_id, article_num)
                    if key in seen_doc_article:
                        unique_doc_article_violations += 1
                        if len(unique_violations_examples) < max_example_rows:
                            unique_violations_examples.append(
                                (
                                    doc_id,
                                    article_num,
                                    seen_doc_article[key],
                                    str(row.get("chunk_id")),
                                )
                            )
                    else:
                        seen_doc_article[key] = str(row.get("chunk_id"))

    print("[validate-articles] summary")
    print(f"chunks_path={chunks_path}")
    print(f"rows_total={total}")
    print(f"json_errors={json_errors}")
    print(f"missing_or_invalid_text={missing_text}")
    print(f"chunks_with_too_many_headers={too_many_headers}")
    print(f"unique_doc_article_violations={unique_doc_article_violations}")

    if too_many_header_examples:
        print("[validate-articles] too_many_headers_examples")
        for item in too_many_header_examples:
            print(item)
    if unique_violations_examples:
        print("[validate-articles] unique_doc_article_examples")
        for item in unique_violations_examples:
            print(item)
    if json_error_examples:
        print("[validate-articles] json_error_examples")
        for item in json_error_examples:
            print(item)

    has_errors = (
        json_errors > 0
        or missing_text > 0
        or too_many_headers > 0
        or (enforce_unique_doc_article and unique_doc_article_violations > 0)
    )
    return 1 if has_errors else 0


def main() -> None:
    args = parse_args()
    exit_code = validate(
        chunks_path=Path(args.chunks_path),
        max_headers_per_chunk=max(1, int(args.max_headers_per_chunk)),
        enforce_unique_doc_article=bool(args.enforce_unique_doc_article),
        max_example_rows=max(1, int(args.max_example_rows)),
    )
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
