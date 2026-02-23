from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass
class EvalQuestion:
    number: int
    question: str
    reference: str | None = None


@dataclass
class EvalAnswer:
    number: int
    question: str
    reference: str | None
    answer: str
    rag_source_count: int | None
    error: str | None


QUESTION_HEADER_RE = re.compile(
    r"^\s*Question\s+(?P<number>\d+)\b(?:\s*[-\u2014]\s*(?P<tail>.+?)\s*)?$",
    re.IGNORECASE,
)


def _normalize_for_match(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return " ".join(normalized.lower().split())


def _extract_reference_from_tail(tail: str | None) -> str | None:
    if not isinstance(tail, str):
        return None
    tail_clean = tail.strip()
    if not tail_clean:
        return None

    normalized = _normalize_for_match(tail_clean)
    if "reference" in normalized and ":" in tail_clean:
        return tail_clean.split(":", maxsplit=1)[1].strip() or None
    return tail_clean


def _parse_questions_structured(lines: list[str]) -> list[EvalQuestion]:
    questions: list[EvalQuestion] = []
    current_number: int | None = None
    current_reference: str | None = None
    capture_question = False
    question_lines: list[str] = []

    def flush_current() -> None:
        nonlocal current_number, current_reference, question_lines
        if current_number is None:
            return
        question_text = " ".join(line.strip() for line in question_lines if line.strip()).strip()
        if question_text:
            questions.append(
                EvalQuestion(
                    number=current_number,
                    question=question_text,
                    reference=current_reference,
                )
            )
        current_number = None
        current_reference = None
        question_lines = []

    for line in lines:
        header_match = QUESTION_HEADER_RE.match(line)
        if header_match:
            flush_current()
            current_number = int(header_match.group("number"))
            current_reference = _extract_reference_from_tail(header_match.group("tail"))
            capture_question = False
            continue

        if current_number is None:
            continue

        stripped = line.strip()
        if not stripped:
            if capture_question:
                question_lines.append("")
            continue

        normalized = _normalize_for_match(stripped)
        if normalized == "question" or normalized.endswith(" question") or normalized.startswith("question "):
            capture_question = True
            continue

        if "reponse attendue" in normalized:
            capture_question = False
            continue

        if capture_question:
            question_lines.append(stripped)

    flush_current()
    questions.sort(key=lambda item: item.number)
    return questions


def _parse_questions_compact(lines: list[str]) -> list[EvalQuestion]:
    def is_heading(line: str) -> bool:
        cleaned = re.sub(r"^[^A-Za-z0-9]+", "", line.strip())
        normalized = _normalize_for_match(cleaned)
        if not normalized:
            return True
        if normalized.startswith("code "):
            return True
        if normalized.startswith("evaluation rag"):
            return True
        if normalized.startswith("questions"):
            return True
        if normalized.startswith("reponses"):
            return True
        return False

    questions: list[EvalQuestion] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if is_heading(stripped):
            continue

        normalized = _normalize_for_match(stripped)
        if normalized.startswith("question "):
            continue
        if normalized.startswith("reponse "):
            continue
        if len(stripped) < 10:
            continue

        question_text = " ".join(stripped.split())
        questions.append(
            EvalQuestion(
                number=len(questions) + 1,
                question=question_text,
                reference=None,
            )
        )

    return questions


def parse_questions_file(path: Path) -> list[EvalQuestion]:
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    questions = _parse_questions_structured(lines)
    if questions:
        return questions
    return _parse_questions_compact(lines)


def _parse_sse_payload(data_str: str) -> dict[str, Any]:
    try:
        parsed = json.loads(data_str)
    except json.JSONDecodeError:
        return {}
    if isinstance(parsed, dict):
        return parsed
    return {}


def ask_chat_stream(
    url: str,
    question: str,
    *,
    timeout_seconds: int,
    temperature: float,
    top_p: float,
    max_tokens: int,
    thinking: bool,
) -> tuple[str, int | None]:
    payload = {
        "messages": [{"role": "user", "content": question}],
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "thinking": bool(thinking),
    }
    request = Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    answer_parts: list[str] = []
    rag_source_count: int | None = None

    with urlopen(request, timeout=timeout_seconds) as response:
        event_name: str | None = None
        data_lines: list[str] = []
        done_seen = False

        def flush_event() -> None:
            nonlocal event_name, data_lines, rag_source_count, done_seen
            if not data_lines:
                event_name = None
                return

            payload_obj = _parse_sse_payload("\n".join(data_lines))
            current_event = (event_name or "").strip().lower()

            if current_event == "meta":
                raw_count = payload_obj.get("rag_source_count")
                if isinstance(raw_count, int):
                    rag_source_count = raw_count
            elif current_event == "token":
                text = payload_obj.get("text")
                if isinstance(text, str) and text:
                    answer_parts.append(text)
            elif current_event == "error":
                detail = payload_obj.get("detail")
                raise RuntimeError(str(detail) if detail else "SSE error event")
            elif current_event == "done":
                done_seen = True

            event_name = None
            data_lines = []

        for raw_line in response:
            line = raw_line.decode("utf-8", errors="ignore").rstrip("\r\n")
            if line == "":
                flush_event()
                if done_seen:
                    break
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip()
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].strip())

        if data_lines and not done_seen:
            flush_event()

    return "".join(answer_parts).strip(), rag_source_count


def run_batch(
    *,
    questions: list[EvalQuestion],
    url: str,
    timeout_seconds: int,
    retries: int,
    retry_wait_seconds: float,
    temperature: float,
    top_p: float,
    max_tokens: int,
    thinking: bool,
    use_reference: bool,
) -> list[EvalAnswer]:
    answers: list[EvalAnswer] = []

    for item in questions:
        last_error: str | None = None
        answer_text = ""
        rag_count: int | None = None
        for attempt in range(1, retries + 2):
            try:
                prompt = item.question
                if use_reference and item.reference:
                    prompt = f"Reference: {item.reference}\nQuestion: {item.question}"
                answer_text, rag_count = ask_chat_stream(
                    url=url,
                    question=prompt,
                    timeout_seconds=timeout_seconds,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    thinking=thinking,
                )
                last_error = None
                break
            except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt <= retries:
                    time.sleep(retry_wait_seconds)
                else:
                    break

        answers.append(
            EvalAnswer(
                number=item.number,
                question=item.question,
                reference=item.reference,
                answer=answer_text,
                rag_source_count=rag_count,
                error=last_error,
            )
        )
        status = "OK" if last_error is None else "ERROR"
        print(f"[{status}] Question {item.number}", flush=True)

    return answers


def write_answers(path: Path, answers: list[EvalAnswer]) -> None:
    output_lines: list[str] = []
    output_lines.append("REPONSES LLM - EVALUATION RAG (AUTO)")
    output_lines.append("")

    for item in answers:
        output_lines.append(f"Question {item.number}")
        output_lines.append(f"Question: {item.question}")
        if item.reference:
            output_lines.append(f"Reference: {item.reference}")
        if item.error:
            output_lines.append(f"Erreur: {item.error}")
        if item.rag_source_count is not None:
            output_lines.append(f"RAG sources: {item.rag_source_count}")
        output_lines.append("Reponse LLM:")
        output_lines.append(item.answer if item.answer else "(vide)")
        output_lines.append("")
        output_lines.append("-" * 80)
        output_lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(output_lines), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Envoi automatique d'une liste de questions vers /chat/stream et sauvegarde des reponses.",
    )
    parser.add_argument(
        "--questions-path",
        default="data/evaluation_rag_20_questions_reponses.txt",
        help="Fichier source contenant les questions.",
    )
    parser.add_argument(
        "--output-path",
        default="data/reponses_llm_20_auto.txt",
        help="Fichier de sortie des reponses.",
    )
    parser.add_argument(
        "--api-url",
        default="http://127.0.0.1:8000/chat/stream",
        help="URL du endpoint de chat stream (/chat/stream).",
    )
    parser.add_argument("--timeout-seconds", type=int, default=240, help="Timeout par requete.")
    parser.add_argument("--retries", type=int, default=1, help="Nombre de tentatives de retry.")
    parser.add_argument(
        "--retry-wait-seconds",
        type=float,
        default=1.5,
        help="Pause entre retries.",
    )
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--top-p", type=float, default=0.95, dest="top_p")
    parser.add_argument("--max-tokens", type=int, default=1024, dest="max_tokens")
    parser.add_argument(
        "--thinking",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Active/desactive le mode thinking (default: actif).",
    )
    parser.add_argument(
        "--use-reference",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Injecte la reference article dans chaque prompt (default: actif).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Nombre max de questions a envoyer (0 = toutes).",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    questions_path = Path(args.questions_path)
    output_path = Path(args.output_path)

    if not questions_path.exists():
        print(f"Erreur: fichier introuvable: {questions_path}", file=sys.stderr)
        return 1

    questions = parse_questions_file(questions_path)
    if not questions:
        print("Erreur: aucune question detectee dans le fichier source.", file=sys.stderr)
        return 1

    if args.limit > 0:
        questions = questions[: args.limit]

    print(f"Questions detectees: {len(questions)}")
    answers = run_batch(
        questions=questions,
        url=args.api_url,
        timeout_seconds=args.timeout_seconds,
        retries=max(0, args.retries),
        retry_wait_seconds=max(0.0, args.retry_wait_seconds),
        temperature=args.temperature,
        top_p=args.top_p,
        max_tokens=args.max_tokens,
        thinking=bool(args.thinking),
        use_reference=bool(args.use_reference),
    )
    write_answers(output_path, answers)
    print(f"Fichier ecrit: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
