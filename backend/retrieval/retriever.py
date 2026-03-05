from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    import faiss
except Exception as exc:  # noqa: BLE001
    raise RuntimeError(
        "faiss is required for retrieval. Install dependencies with `pip install -r requirements.txt`."
    ) from exc


@dataclass(frozen=True)
class RetrievedChunk:
    rank: int
    score: float
    chunk_id: str
    text: str
    doc_id: str | None
    relative_path: str | None
    source_path: str | None
    page_start: int | None
    page_end: int | None
    article_hint: str | None

    def citation(self) -> str:
        source = self.relative_path or self.source_path or "unknown-source"
        if isinstance(self.page_start, int) and isinstance(self.page_end, int):
            if self.page_start == self.page_end:
                return f"{source} (p. {self.page_start})"
            return f"{source} (pp. {self.page_start}-{self.page_end})"
        if isinstance(self.page_start, int):
            return f"{source} (p. {self.page_start})"
        return source

    def to_source_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "score": self.score,
            "chunk_id": self.chunk_id,
            "citation": self.citation(),
            "relative_path": self.relative_path,
            "source_path": self.source_path,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "article_hint": self.article_hint,
        }


@dataclass(frozen=True)
class RelevanceAssessment:
    is_relevant: bool
    confidence_level: str
    best_score: float
    mean_score: float
    score_spread: float
    chunk_count: int


_QUERY_ARTICLE_REF_RE = re.compile(
    r"\b(?:articles?|art\.?)\s+((?P<prefix>[A-Za-z]{1,3})\s*\.?\s*)?(?P<number>\d+[A-Za-z]?(?:-\d+)?)\b",
    re.IGNORECASE,
)
_DIRECT_PREFIXED_REF_RE = re.compile(
    r"(?<![A-Za-z0-9])(?P<prefix>[A-Za-z]{1,3})\s*\.?\s*(?P<number>\d+[A-Za-z]?(?:-\d+)?)\b",
    re.IGNORECASE,
)
_ANY_PREFIXED_ARTICLE_RE = re.compile(
    r"\b(?:article|art\.?)\s+[A-Za-z]{1,3}\s*\.?\s*\d+",
    re.IGNORECASE,
)
_LEGAL_DOMAIN_RE = re.compile(
    r"\b(?:code|droit)\s+(?:du|de la|de l['’]|de)\s+([a-z0-9][a-z0-9'’\-]*(?:\s+[a-z0-9][a-z0-9'’\-]*){0,3})",
    re.IGNORECASE,
)

ArticleRef = tuple[str, bool]

_DIRECT_ARTICLE_PREFIX_ALLOWLIST = {
    "L",
    "R",
    "D",
    "A",
    "P",
    "C",
    "LO",
    "LP",
}
_DIRECT_ARTICLE_PREFIX_BLOCKLIST = {
    "CE",
    "DE",
    "DU",
    "LE",
    "LA",
    "LES",
    "DES",
    "UN",
    "UNE",
    "AU",
    "AUX",
    "ET",
    "EN",
    "PAR",
    "SUR",
    "POUR",
}
_DOMAIN_FILTER_STOP_TOKENS = {
    "article",
    "articles",
    "code",
    "codes",
    "droit",
    "droits",
    "penal",
    "penale",
    "penales",
    "civil",
    "commercial",
    "senegal",
    "ohada",
    "question",
    "risque",
    "risquent",
    "quoi",
    "quel",
    "quels",
    "quelle",
    "quelles",
    "comment",
    "avec",
    "sans",
    "dans",
    "pour",
    "contre",
    "entre",
}
_FOOD_SAFETY_QUERY_MARKERS = (
    "viande",
    "aliment",
    "alimentaire",
    "denree",
    "boucher",
    "hygiene",
    "consommation",
    "insalubre",
    "impropre",
)

DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "travail": (
        "droit du travail",
        "code du travail",
        "conge",
        "conges",
        "conges payes",
        "repos hebdomadaire",
        "temps de travail",
        "indemnite de conges",
        "licenciement",
        "salaire",
        "employeur",
        "employe",
        "contrat de travail",
        "inspection du travail",
    ),
    "procedure_penale": (
        "code de procedure penal",
        "procedure penal",
        "garde a vue",
        "officier de police judiciaire",
        "opj",
        "mandat de depot",
    ),
    "penal": (
        "droit penal",
        "code penal",
        "infraction",
        "crime",
        "delit",
        "contravention",
        "peine",
        "sanction penale",
    ),
    "electoral": (
        "code electoral",
        "electoral",
        "election",
        "cena",
        "liste electorale",
        "scrutin",
    ),
    "fiscal": (
        "code general des impots",
        "impot",
        "fiscal",
        "taxe",
        "tva",
        "douane",
        "douanier",
    ),
    "civil_commercial": (
        "code des obligations civiles et commerciales",
        "code des obligations",
        "obligations civiles et commerciales",
        "procedure civile",
        "cpc",
        "responsabilite civile",
        "contrat commercial",
        "commerce",
    ),
    "famille": (
        "code de la famille",
        "droit de la famille",
        "mariage",
        "divorce",
        "filiation",
        "succession",
    ),
    "notariat": (
        "notariat",
        "notaire",
        "acte notarie",
        "deontologie notaire",
    ),
    "ohada": (
        "ohada",
        "acte uniforme",
        "pdfs_ohada",
        "suretes",
        "societes commerciales",
        "voies d execution",
        "recouvrement",
    ),
    "foncier": (
        "foncier",
        "terrain",
        "propriete fonciere",
        "regime foncier",
    ),
    "route": (
        "code de la route",
        "permis de conduire",
        "circulation routiere",
    ),
    "presse": (
        "code de la presse",
        "journaliste",
        "organe de presse",
    ),
    "environnement": (
        "code de l environnement",
        "environnement",
        "pollution",
        "assainissement",
    ),
    "hygiene_consommation": (
        "code de l hygiene",
        "hygiene",
        "inspection veterinaire",
        "produits carnes",
        "viande",
        "denree alimentaire",
        "protection du consommateur",
        "consommation",
    ),
}


def _normalize_article_number(value: str) -> str:
    return re.sub(r"\s+", "", value).upper()


def _normalize_article_prefix(value: str) -> str:
    return re.sub(r"[^A-Za-z]", "", value).upper()


def _is_valid_direct_article_prefix(prefix: str, *, has_explicit_separator: bool) -> bool:
    normalized = _normalize_article_prefix(prefix)
    if not normalized:
        return False
    if normalized in _DIRECT_ARTICLE_PREFIX_BLOCKLIST:
        return False
    if normalized not in _DIRECT_ARTICLE_PREFIX_ALLOWLIST:
        return False
    if len(normalized) >= 2 and not has_explicit_separator:
        # Reject weak patterns like "ce 4 mars" while keeping "L 39" and "R 41".
        return False
    return True


def _normalize_match_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    no_diacritics = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    lowered = no_diacritics.lower().replace("’", "'").replace("_", " ")
    cleaned = re.sub(r"[^a-z0-9']+", " ", lowered)
    return re.sub(r"\s+", " ", cleaned).strip()


def _tokenize_for_bm25(value: str) -> list[str]:
    normalized = _normalize_match_text(value)
    return [token for token in normalized.split() if len(token) >= 2]

def _extract_legal_domain_terms(query: str) -> tuple[list[str], set[str]]:
    terms: list[str] = []
    tokens: set[str] = set()
    for match in _LEGAL_DOMAIN_RE.finditer(query):
        raw = match.group(1)
        if not raw:
            continue
        term = _normalize_match_text(raw)
        if not term:
            continue
        terms.append(term)
        for token in term.split():
            if len(token) >= 3:
                tokens.add(token)
    return terms, tokens


def _compute_domain_scores(normalized_text: str) -> dict[str, int]:
    scores: dict[str, int] = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        score = 0
        for keyword in keywords:
            if keyword in normalized_text:
                score += max(1, len(keyword.split()))
        if score > 0:
            scores[domain] = score
    return scores


def detect_query_domains(query: str) -> list[str]:
    normalized = _normalize_match_text(query)
    if not normalized:
        return []
    scores = _compute_domain_scores(normalized)
    if not scores:
        return []
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best = ranked[0][1]
    threshold = 2 if best >= 2 else 1
    selected = [domain for domain, score in ranked if score >= max(threshold, best - 1)]
    return selected


def infer_chunk_domains(chunk: RetrievedChunk) -> set[str]:
    source_text = _normalize_match_text(f"{chunk.relative_path or ''} {chunk.source_path or ''}")
    if not source_text:
        return set()
    scores = _compute_domain_scores(source_text)
    return {domain for domain, score in scores.items() if score > 0}


def _chunk_top_folder(chunk: RetrievedChunk) -> str:
    rp = (chunk.relative_path or "").replace("\\", "/").strip("/")
    if not rp:
        return ""
    return rp.split("/", 1)[0]


def _is_domain_specific_path(top_folder: str) -> bool:
    normalized = _normalize_match_text(top_folder)
    if not normalized:
        return False
    return (
        normalized.startswith("code ")
        or normalized.startswith("droit ")
        or normalized.startswith("loi ")
        or normalized.startswith("organisation ")
        or normalized.startswith("pdfs ")
        or normalized.startswith("regime ")
        or normalized.startswith("notariat")
    )


def _extract_query_content_tokens(query: str) -> set[str]:
    normalized = _normalize_match_text(query)
    if not normalized:
        return set()
    tokens: set[str] = set()
    for token in normalized.split():
        if len(token) < 4:
            continue
        if token in _DOMAIN_FILTER_STOP_TOKENS:
            continue
        tokens.add(token)
    return tokens


def _chunk_query_overlap(chunk: RetrievedChunk, query_tokens: set[str]) -> int:
    if not query_tokens:
        return 0
    haystack = _normalize_match_text(
        " ".join(
            [
                chunk.relative_path or "",
                chunk.source_path or "",
                chunk.article_hint or "",
                chunk.text[:900],
            ]
        )
    )
    if not haystack:
        return 0
    haystack_tokens = set(haystack.split())
    return len(query_tokens.intersection(haystack_tokens))


def _extract_query_article_refs(query: str) -> tuple[set[str], set[str]]:
    prefixed_refs: set[str] = set()
    plain_refs: set[str] = set()
    for match in _QUERY_ARTICLE_REF_RE.finditer(query):
        number_raw = match.group("number")
        if not number_raw:
            continue
        number = _normalize_article_number(number_raw)
        prefix_raw = match.group("prefix")
        if prefix_raw and prefix_raw.strip():
            prefix = re.sub(r"[^A-Za-z]", "", prefix_raw).upper()
            if prefix:
                prefixed_refs.add(f"{prefix}.{number}")
                continue
        plain_refs.add(number)
    for match in _DIRECT_PREFIXED_REF_RE.finditer(query):
        number_raw = match.group("number")
        prefix_raw = match.group("prefix")
        if not number_raw or not prefix_raw:
            continue
        separator = query[match.start("prefix") + len(prefix_raw) : match.start("number")]
        has_explicit_separator = "." in separator or "-" in separator
        if not _is_valid_direct_article_prefix(
            prefix_raw,
            has_explicit_separator=has_explicit_separator,
        ):
            continue
        number = _normalize_article_number(number_raw)
        prefix = _normalize_article_prefix(prefix_raw)
        if prefix:
            prefixed_refs.add(f"{prefix}.{number}")
    return prefixed_refs, plain_refs


def _extract_query_article_refs_ordered(query: str) -> list[ArticleRef]:
    ordered: list[ArticleRef] = []
    seen: set[ArticleRef] = set()
    for match in _QUERY_ARTICLE_REF_RE.finditer(query):
        number_raw = match.group("number")
        if not number_raw:
            continue
        number = _normalize_article_number(number_raw)
        prefix_raw = match.group("prefix")
        if prefix_raw and prefix_raw.strip():
            prefix = re.sub(r"[^A-Za-z]", "", prefix_raw).upper()
            if prefix:
                ref: ArticleRef = (f"{prefix}.{number}", True)
                if ref not in seen:
                    ordered.append(ref)
                    seen.add(ref)
                continue
        ref = (number, False)
        if ref not in seen:
            ordered.append(ref)
            seen.add(ref)
    for match in _DIRECT_PREFIXED_REF_RE.finditer(query):
        number_raw = match.group("number")
        prefix_raw = match.group("prefix")
        if not number_raw or not prefix_raw:
            continue
        separator = query[match.start("prefix") + len(prefix_raw) : match.start("number")]
        has_explicit_separator = "." in separator or "-" in separator
        if not _is_valid_direct_article_prefix(
            prefix_raw,
            has_explicit_separator=has_explicit_separator,
        ):
            continue
        number = _normalize_article_number(number_raw)
        prefix = _normalize_article_prefix(prefix_raw)
        if not prefix:
            continue
        ref = (f"{prefix}.{number}", True)
        if ref not in seen:
            ordered.append(ref)
            seen.add(ref)
    return ordered


def extract_query_article_refs(query: str) -> list[ArticleRef]:
    return _extract_query_article_refs_ordered(query)


def _matches_article_ref_in_text(text: str, article_ref: str, prefixed: bool) -> bool:
    if prefixed:
        return _contains_prefixed_exact(text, article_ref)
    return _contains_plain_article_exact(text, article_ref)


def _contains_prefixed_exact(text: str, canonical_ref: str) -> bool:
    prefix, number = canonical_ref.split(".", maxsplit=1)
    pattern = re.compile(
        rf"(?<![A-Za-z0-9]){re.escape(prefix)}\s*\.?\s*{re.escape(number)}(?![0-9])",
        re.IGNORECASE,
    )
    return bool(pattern.search(text))


def _contains_prefixed_near_miss(text: str, canonical_ref: str) -> bool:
    prefix, number = canonical_ref.split(".", maxsplit=1)
    pattern = re.compile(
        rf"(?<![A-Za-z0-9]){re.escape(prefix)}\s*\.?\s*{re.escape(number)}[0-9]+",
        re.IGNORECASE,
    )
    return bool(pattern.search(text))


def _contains_plain_article_exact(text: str, number: str) -> bool:
    pattern = re.compile(
        rf"\b(?:article|art\.?)\s+(?:[A-Za-z]\s*\.?\s*)?{re.escape(number)}\b"
        rf"(?!\s*(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)\b)"
        rf"(?!\s*[-/.]\s*\d)"
        rf"(?![A-Za-z0-9])",
        re.IGNORECASE,
    )
    return bool(pattern.search(text))


def _build_article_haystack(chunk: RetrievedChunk) -> str:
    parts: list[str] = []
    if isinstance(chunk.article_hint, str) and chunk.article_hint.strip():
        parts.append(chunk.article_hint.strip())
    snippet = chunk.text.strip()
    if snippet:
        # Limit matching scope for performance while keeping early legal headers.
        parts.append(snippet[:1500])
    return "\n".join(parts)


def chunk_matches_article_ref(chunk: RetrievedChunk, article_ref: str, prefixed: bool) -> bool:
    return _matches_article_ref_in_text(_build_article_haystack(chunk), article_ref, prefixed)


def rerank_article_aware(
    query: str,
    candidates: Sequence[RetrievedChunk],
    top_k: int,
) -> tuple[list[RetrievedChunk], bool]:
    if top_k < 1:
        raise ValueError("top_k must be >= 1")

    candidate_list = list(candidates)
    if not candidate_list:
        return [], False

    prefixed_refs, plain_refs = _extract_query_article_refs(query)
    prefixed_numbers = {ref.split(".", maxsplit=1)[1] for ref in prefixed_refs}
    legal_domain_terms, legal_domain_tokens = _extract_legal_domain_terms(query)
    if not prefixed_refs and not plain_refs and not legal_domain_terms:
        return [
            replace(chunk, rank=rank) for rank, chunk in enumerate(candidate_list[:top_k], start=1)
        ], False

    scored: list[tuple[float, float, int, RetrievedChunk]] = []
    for idx, chunk in enumerate(candidate_list):
        haystack = _build_article_haystack(chunk)
        bonus = 0.0
        matches_requested_ref = False

        for ref in prefixed_refs:
            if _contains_prefixed_exact(haystack, ref):
                bonus += 0.25
                matches_requested_ref = True
            elif _contains_prefixed_near_miss(haystack, ref):
                bonus -= 0.10

        if prefixed_numbers:
            for number in prefixed_numbers:
                if _contains_plain_article_exact(haystack, number):
                    # Query asks a codified article (e.g. L.18), plain Article 18 is likely noise.
                    bonus -= 0.12

        for number in plain_refs:
            if _contains_plain_article_exact(haystack, number):
                bonus += 0.15
                matches_requested_ref = True

        if plain_refs and not prefixed_refs and _ANY_PREFIXED_ARTICLE_RE.search(haystack):
            bonus -= 0.06

        if (prefixed_refs or plain_refs) and not matches_requested_ref:
            # If the question explicitly targets article references, deprioritize chunks
            # that do not contain any requested reference.
            bonus -= 0.18

        if legal_domain_terms:
            source_text = _normalize_match_text(
                f"{chunk.relative_path or ''} {chunk.source_path or ''}"
            )
            domain_match = any(term in source_text for term in legal_domain_terms)
            if domain_match:
                # Strong alignment with requested legal branch (e.g. "droit du travail").
                bonus += 0.35
            else:
                token_overlap = sum(1 for token in legal_domain_tokens if token in source_text)
                if len(legal_domain_tokens) <= 1 and token_overlap >= 1:
                    bonus += min(0.15, token_overlap * 0.05)
                else:
                    bonus -= 0.30

        final_score = chunk.score + bonus
        scored.append((final_score, bonus, -idx, chunk))

    scored.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)

    reranked: list[RetrievedChunk] = []
    for rank, (_, _, _, chunk) in enumerate(scored[:top_k], start=1):
        reranked.append(replace(chunk, rank=rank))
    return reranked, True


def filter_by_score_threshold(
    chunks: Sequence[RetrievedChunk],
    min_score_threshold: float,
) -> tuple[list[RetrievedChunk], int]:
    if min_score_threshold <= 0.0:
        renumbered = [replace(chunk, rank=rank) for rank, chunk in enumerate(chunks, start=1)]
        return renumbered, 0

    kept: list[RetrievedChunk] = []
    removed = 0
    for chunk in chunks:
        if chunk.score >= min_score_threshold:
            kept.append(chunk)
        else:
            removed += 1

    renumbered = [replace(chunk, rank=rank) for rank, chunk in enumerate(kept, start=1)]
    return renumbered, removed


def score_context_relevance(
    chunks: Sequence[RetrievedChunk],
    *,
    min_chunks_required: int,
    min_score_threshold: float,
) -> RelevanceAssessment:
    if min_chunks_required < 1:
        raise ValueError("min_chunks_required must be >= 1")
    if not chunks:
        return RelevanceAssessment(
            is_relevant=False,
            confidence_level="none",
            best_score=0.0,
            mean_score=0.0,
            score_spread=0.0,
            chunk_count=0,
        )

    scores = np.asarray([chunk.score for chunk in chunks], dtype=np.float32)
    best_score = float(np.max(scores))
    mean_score = float(np.mean(scores))
    score_spread = float(np.std(scores))
    chunk_count = len(chunks)

    if best_score < min_score_threshold:
        return RelevanceAssessment(
            is_relevant=False,
            confidence_level="none",
            best_score=best_score,
            mean_score=mean_score,
            score_spread=score_spread,
            chunk_count=chunk_count,
        )

    if chunk_count < min_chunks_required and best_score < (min_score_threshold + 0.20):
        return RelevanceAssessment(
            is_relevant=False,
            confidence_level="none",
            best_score=best_score,
            mean_score=mean_score,
            score_spread=score_spread,
            chunk_count=chunk_count,
        )

    if (
        best_score >= (min_score_threshold + 0.45)
        and mean_score >= (min_score_threshold + 0.20)
        and score_spread <= 0.30
    ):
        confidence = "high"
    elif best_score >= (min_score_threshold + 0.20) and mean_score >= (min_score_threshold + 0.05):
        confidence = "medium"
    else:
        confidence = "low"

    return RelevanceAssessment(
        is_relevant=True,
        confidence_level=confidence,
        best_score=best_score,
        mean_score=mean_score,
        score_spread=score_spread,
        chunk_count=chunk_count,
    )


def filter_candidates_by_query_domains(
    query: str,
    candidates: Sequence[RetrievedChunk],
    *,
    top_k: int,
    neutral_fallback_max: int = 2,
) -> tuple[list[RetrievedChunk], bool, list[str], int]:
    if top_k < 1:
        raise ValueError("top_k must be >= 1")
    if neutral_fallback_max < 0:
        raise ValueError("neutral_fallback_max must be >= 0")

    candidate_list = list(candidates)
    if not candidate_list:
        return [], False, [], 0

    query_domains = detect_query_domains(query)
    if not query_domains:
        return candidate_list, False, [], 0

    query_domain_set = set(query_domains)
    if "penal" in query_domain_set:
        query_domain_set.add("procedure_penale")
    if "procedure_penale" in query_domain_set:
        query_domain_set.add("penal")
    normalized_query = _normalize_match_text(query)
    if "penal" in query_domain_set and any(
        marker in normalized_query for marker in _FOOD_SAFETY_QUERY_MARKERS
    ):
        query_domain_set.add("hygiene_consommation")
    in_domain: list[RetrievedChunk] = []
    neutral: list[RetrievedChunk] = []
    out_domain: list[RetrievedChunk] = []

    for chunk in candidate_list:
        chunk_domains = infer_chunk_domains(chunk)
        if not chunk_domains:
            top_folder = _chunk_top_folder(chunk)
            if _is_domain_specific_path(top_folder):
                out_domain.append(chunk)
            else:
                neutral.append(chunk)
            continue
        if chunk_domains.intersection(query_domain_set):
            in_domain.append(chunk)
        else:
            out_domain.append(chunk)

    in_domain_count = len(in_domain)
    allowed_neutral = neutral[:neutral_fallback_max] if neutral_fallback_max > 0 else []
    filtered = in_domain + allowed_neutral

    # Keep a few strong lexical matches even when domain labels do not overlap
    # (e.g. hygiene/consumption texts relevant to a penal question).
    query_tokens = _extract_query_content_tokens(query)
    lexical_fallback_max = max(neutral_fallback_max, min(4, max(2, top_k // 4)))
    lexical_candidates: list[tuple[int, float, int, RetrievedChunk]] = []
    if query_tokens and lexical_fallback_max > 0:
        for idx, chunk in enumerate(out_domain):
            overlap = _chunk_query_overlap(chunk, query_tokens)
            if overlap >= 2:
                lexical_candidates.append((overlap, chunk.score, -idx, chunk))
        lexical_candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        seen_ids = {chunk.chunk_id for chunk in filtered}
        added_lexical = 0
        for _, _, _, chunk in lexical_candidates:
            if len(filtered) >= top_k:
                break
            if chunk.chunk_id in seen_ids:
                continue
            filtered.append(chunk)
            seen_ids.add(chunk.chunk_id)
            added_lexical += 1
            if added_lexical >= lexical_fallback_max:
                break
    if filtered:
        return filtered, True, query_domains, in_domain_count

    return [], True, query_domains, in_domain_count


def select_chunks_adaptive(
    candidates: Sequence[RetrievedChunk],
    *,
    min_score_threshold: float,
    threshold_floor: float,
    threshold_step: float,
    target_min: int,
    target_max: int,
    neutral_fallback_max: int,
    article_refs: Sequence[ArticleRef],
    exact_matches_by_ref: Mapping[ArticleRef, list[RetrievedChunk]],
) -> tuple[list[RetrievedChunk], float, int, int]:
    if target_min < 1:
        raise ValueError("target_min must be >= 1")
    if target_max < target_min:
        raise ValueError("target_max must be >= target_min")
    if threshold_step <= 0.0:
        raise ValueError("threshold_step must be > 0")
    if neutral_fallback_max < 0:
        raise ValueError("neutral_fallback_max must be >= 0")

    candidate_list = list(candidates)
    if not candidate_list:
        return [], max(0.0, min_score_threshold), 0, 0
    target_min_effective = min(target_max, max(target_min, min(3, len(candidate_list))))

    threshold = max(0.0, min_score_threshold)
    floor = max(0.0, min(threshold_floor, threshold))
    iterations = 0
    neutral_added = 0

    def _apply_threshold(value: float) -> list[RetrievedChunk]:
        kept = [chunk for chunk in candidate_list if chunk.score >= value]
        if len(kept) > target_max:
            kept = kept[:target_max]
        return [replace(chunk, rank=rank) for rank, chunk in enumerate(kept, start=1)]

    selected = _apply_threshold(threshold)

    while len(selected) < target_min_effective and threshold > floor + 1e-9:
        threshold = max(floor, threshold - threshold_step)
        iterations += 1
        selected = _apply_threshold(threshold)
        if len(selected) >= target_min_effective:
            break

    if len(selected) < target_min_effective:
        selected_ids = {chunk.chunk_id for chunk in selected}
        # If adaptive threshold still leaves too few chunks, backfill from ranked
        # in-domain candidates regardless of score before consuming neutral fallback.
        for chunk in candidate_list:
            if len(selected) >= target_min_effective or len(selected) >= target_max:
                break
            if chunk.chunk_id in selected_ids:
                continue
            if infer_chunk_domains(chunk):
                selected.append(replace(chunk, rank=len(selected) + 1))
                selected_ids.add(chunk.chunk_id)

    if len(selected) < target_min_effective and neutral_fallback_max > 0:
        selected_ids = {chunk.chunk_id for chunk in selected}
        neutral_candidates = [
            chunk
            for chunk in candidate_list
            if not infer_chunk_domains(chunk) and chunk.chunk_id not in selected_ids
        ]
        for chunk in neutral_candidates:
            if neutral_added >= neutral_fallback_max or len(selected) >= target_min_effective:
                break
            selected.append(replace(chunk, rank=len(selected) + 1))
            selected_ids.add(chunk.chunk_id)
            neutral_added += 1

    selected, _ = enforce_article_reference_coverage(
        ranked_chunks=selected,
        article_refs=article_refs,
        exact_matches_by_ref=dict(exact_matches_by_ref),
        top_k=target_max,
    )

    if len(selected) > target_max:
        selected = selected[:target_max]
    selected = [replace(chunk, rank=rank) for rank, chunk in enumerate(selected, start=1)]
    return selected, threshold, iterations, neutral_added


class FaissRetriever:
    def __init__(
        self,
        index_dir: Path,
        model_name: str,
        device: str | None = None,
        normalize_query_embeddings: bool = True,
        reranker_model_name: str | None = None,
        reranker_device: str | None = None,
        reranker_batch_size: int = 16,
        reranker_cpu_max_candidates: int = 20,
        reranker_snippet_chars: int = 1600,
        reranker_cpu_snippet_chars: int = 900,
    ) -> None:
        self.index_dir = index_dir
        self.model_name = model_name
        self.device = device
        self.normalize_query_embeddings = normalize_query_embeddings
        self.reranker_model_name = reranker_model_name
        self.reranker_device = reranker_device
        self.reranker_batch_size = max(1, int(reranker_batch_size))
        self.reranker_cpu_max_candidates = max(1, int(reranker_cpu_max_candidates))
        self.reranker_snippet_chars = max(200, int(reranker_snippet_chars))
        self.reranker_cpu_snippet_chars = max(200, int(reranker_cpu_snippet_chars))

        self._index: Any | None = None
        self._metric_type: int | None = None
        self._dim: int | None = None
        self._meta: list[dict[str, Any]] | None = None
        self._model: Any | None = None
        self._reranker: Any | None = None
        self._bm25_ready = False
        self._bm25_doc_term_freqs: list[dict[str, int]] = []
        self._bm25_doc_len: list[int] = []
        self._bm25_df: dict[str, int] = {}
        self._bm25_avgdl: float = 0.0

    def warmup(self, *, load_reranker: bool = True, prepare_bm25: bool = True) -> None:
        self._load_index()
        self._load_model()
        if prepare_bm25:
            self._ensure_bm25_state()
        if load_reranker and self.reranker_model_name:
            self._load_reranker()

    def _load_index(self) -> None:
        if self._index is not None and self._meta is not None:
            return

        index_path = self.index_dir / "index.faiss"
        meta_path = self.index_dir / "meta.jsonl"
        if not index_path.exists():
            raise RuntimeError(f"index file is missing: {index_path}")
        if not meta_path.exists():
            raise RuntimeError(f"index metadata file is missing: {meta_path}")

        index = faiss.read_index(str(index_path))
        if index is None:
            raise RuntimeError(f"unable to load FAISS index: {index_path}")

        meta_rows: list[dict[str, Any]] = []
        with meta_path.open("r", encoding="utf-8", errors="ignore") as f:
            for line_no, line in enumerate(f, start=1):
                s = line.strip()
                if not s:
                    continue
                try:
                    row = json.loads(s)
                except json.JSONDecodeError as exc:
                    raise RuntimeError(
                        f"invalid JSON in metadata file at line {line_no}: {meta_path}"
                    ) from exc
                if not isinstance(row, dict):
                    raise RuntimeError(
                        f"invalid metadata record at line {line_no}: expected object"
                    )
                meta_rows.append(row)

        if int(index.ntotal) != len(meta_rows):
            raise RuntimeError(
                "index consistency error: "
                f"index_ntotal={int(index.ntotal)} metadata_rows={len(meta_rows)}"
            )

        self._index = index
        self._metric_type = int(getattr(index, "metric_type", faiss.METRIC_INNER_PRODUCT))
        self._dim = int(index.d)
        self._meta = meta_rows

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "sentence-transformers is required for retrieval query embeddings. "
                "Install dependencies with `pip install -r requirements.txt`."
            ) from exc

        kwargs: dict[str, Any] = {}
        if self.device:
            kwargs["device"] = self.device
        self._model = SentenceTransformer(self.model_name, **kwargs)
        return self._model

    def _load_reranker(self) -> Any | None:
        if not self.reranker_model_name:
            return None
        if self._reranker is not None:
            return self._reranker
        try:
            from sentence_transformers import CrossEncoder
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "sentence-transformers CrossEncoder is required for reranking. "
                "Install dependencies with `pip install -r requirements.txt`."
            ) from exc

        kwargs: dict[str, Any] = {}
        if self.reranker_device:
            kwargs["device"] = self.reranker_device

        try:
            self._reranker = CrossEncoder(
                self.reranker_model_name,
                trust_remote_code=True,
                **kwargs,
            )
        except TypeError:
            self._reranker = CrossEncoder(self.reranker_model_name, **kwargs)
        return self._reranker

    def _encode_query(self, query: str) -> np.ndarray:
        model = self._load_model()
        vectors = model.encode(
            [query],
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=self.normalize_query_embeddings,
        )
        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim == 1:
            matrix = np.expand_dims(matrix, axis=0)
        if matrix.ndim != 2 or matrix.shape[0] < 1:
            raise RuntimeError("query embedding model returned no vectors")
        query_vector = np.asarray(matrix[0], dtype=np.float32)
        if query_vector.ndim != 1 or query_vector.size == 0:
            raise RuntimeError("query embedding vector is empty")
        norm = float(np.linalg.norm(query_vector))
        if norm > 0.0:
            query_vector = query_vector / norm
        return query_vector

    def _chunk_from_meta(self, idx: int, score: float, rank: int) -> RetrievedChunk:
        assert self._meta is not None
        meta = self._meta[idx]
        return RetrievedChunk(
            rank=rank,
            score=float(score),
            chunk_id=str(meta.get("chunk_id", "")),
            text=str(meta.get("text", "")),
            doc_id=_as_optional_str(meta.get("doc_id")),
            relative_path=_as_optional_str(meta.get("relative_path")),
            source_path=_as_optional_str(meta.get("source_path")),
            page_start=_as_optional_int(meta.get("page_start")),
            page_end=_as_optional_int(meta.get("page_end")),
            article_hint=_as_optional_str(meta.get("article_hint")),
        )

    def _ensure_bm25_state(self) -> None:
        if self._bm25_ready:
            return

        self._load_index()
        assert self._meta is not None

        self._bm25_doc_term_freqs = []
        self._bm25_doc_len = []
        self._bm25_df = {}

        for row in self._meta:
            text = row.get("text")
            article_hint = row.get("article_hint")
            relative_path = row.get("relative_path")
            combined = " ".join(
                part
                for part in [
                    text if isinstance(text, str) else "",
                    article_hint if isinstance(article_hint, str) else "",
                    relative_path if isinstance(relative_path, str) else "",
                ]
                if part
            )
            tokens = _tokenize_for_bm25(combined)
            tf: dict[str, int] = {}
            for token in tokens:
                tf[token] = tf.get(token, 0) + 1
            self._bm25_doc_term_freqs.append(tf)
            self._bm25_doc_len.append(len(tokens))
            for token in tf:
                self._bm25_df[token] = self._bm25_df.get(token, 0) + 1

        if self._bm25_doc_len:
            self._bm25_avgdl = float(sum(self._bm25_doc_len)) / float(len(self._bm25_doc_len))
        else:
            self._bm25_avgdl = 0.0
        self._bm25_ready = True

    def _search_dense_indices(
        self,
        query_vector: np.ndarray,
        *,
        top_k: int,
        candidate_pool_size: int | None = None,
    ) -> list[tuple[int, float]]:
        self._load_index()
        assert self._index is not None
        assert self._dim is not None

        if query_vector.ndim != 1:
            raise RuntimeError("query embedding must be a 1D vector")
        if query_vector.shape[0] != self._dim:
            raise RuntimeError(
                "query embedding dimension mismatch: "
                f"query={query_vector.shape[0]} index={self._dim}"
            )

        query_batch = np.expand_dims(query_vector.astype(np.float32, copy=False), axis=0)
        requested = top_k
        if candidate_pool_size is not None:
            requested = max(top_k, int(candidate_pool_size))
        k = min(requested, int(self._index.ntotal))
        distances, indices = self._index.search(query_batch, k)
        distance_row = distances[0]
        index_row = indices[0]

        dense_rows: list[tuple[int, float]] = []
        for idx, distance in zip(index_row.tolist(), distance_row.tolist(), strict=True):
            if idx < 0:
                continue
            dense_rows.append((int(idx), float(distance)))
        return dense_rows

    def _bm25_search(
        self,
        query: str,
        *,
        top_n: int,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> list[tuple[int, float]]:
        self._ensure_bm25_state()
        if not self._bm25_doc_term_freqs:
            return []

        query_terms = list(dict.fromkeys(_tokenize_for_bm25(query)))
        if not query_terms:
            return []

        n_docs = len(self._bm25_doc_term_freqs)
        avgdl = self._bm25_avgdl if self._bm25_avgdl > 0.0 else 1.0
        scores: list[tuple[int, float]] = []

        for doc_idx, tf_map in enumerate(self._bm25_doc_term_freqs):
            doc_len = self._bm25_doc_len[doc_idx]
            score = 0.0
            for term in query_terms:
                df = self._bm25_df.get(term, 0)
                if df <= 0:
                    continue
                tf = tf_map.get(term, 0)
                if tf <= 0:
                    continue
                idf = float(np.log(1.0 + ((n_docs - df + 0.5) / (df + 0.5))))
                denom = tf + k1 * (1.0 - b + b * (doc_len / avgdl))
                score += idf * ((tf * (k1 + 1.0)) / denom)
            if score > 0.0:
                scores.append((doc_idx, score))

        scores.sort(key=lambda item: item[1], reverse=True)
        return scores[: max(1, top_n)]

    def _score_index_for_query(self, idx: int, query_vector: np.ndarray) -> float:
        assert self._index is not None
        if not hasattr(self._index, "reconstruct"):
            return 0.0
        vector = np.asarray(self._index.reconstruct(int(idx)), dtype=np.float32)
        if self._metric_type == faiss.METRIC_L2:
            diff = vector - query_vector
            return float(-np.dot(diff, diff))
        return float(np.dot(vector, query_vector))

    def find_exact_article_matches(
        self,
        query: str,
        *,
        refs: Sequence[ArticleRef] | None = None,
        per_ref_limit: int = 2,
    ) -> dict[ArticleRef, list[RetrievedChunk]]:
        if per_ref_limit < 1:
            raise ValueError("per_ref_limit must be >= 1")
        query = query.strip()
        if not query:
            return {}

        self._load_index()
        assert self._index is not None
        assert self._meta is not None
        assert self._dim is not None
        if int(self._index.ntotal) == 0:
            return {}

        ordered_refs = list(refs) if refs is not None else _extract_query_article_refs_ordered(query)
        legal_domain_terms, legal_domain_tokens = _extract_legal_domain_terms(query)
        if not ordered_refs:
            return {}

        query_vector = self._encode_query(query)
        matched: dict[ArticleRef, list[tuple[float, int]]] = {ref: [] for ref in ordered_refs}

        for idx, meta in enumerate(self._meta):
            hint = meta.get("article_hint")
            text = meta.get("text")
            haystack_parts: list[str] = []
            if isinstance(hint, str) and hint.strip():
                haystack_parts.append(hint.strip())
            if isinstance(text, str) and text.strip():
                haystack_parts.append(text[:1000])
            if not haystack_parts:
                continue
            haystack = "\n".join(haystack_parts)

            for ref in ordered_refs:
                article_ref, prefixed = ref
                if _matches_article_ref_in_text(haystack, article_ref, prefixed):
                    score = self._score_index_for_query(idx=idx, query_vector=query_vector)
                    if legal_domain_terms:
                        source_text = _normalize_match_text(
                            f"{meta.get('relative_path') or ''} {meta.get('source_path') or ''}"
                        )
                        if any(term in source_text for term in legal_domain_terms):
                            score += 0.35
                        else:
                            token_overlap = sum(
                                1 for token in legal_domain_tokens if token in source_text
                            )
                            if token_overlap >= 2:
                                score += min(0.24, token_overlap * 0.08)
                            elif token_overlap == 1:
                                score += 0.06
                            else:
                                score -= 0.25
                    matched[ref].append((score, idx))

        results: dict[ArticleRef, list[RetrievedChunk]] = {}
        for ref in ordered_refs:
            scored_rows = matched.get(ref, [])
            if not scored_rows:
                continue
            scored_rows.sort(key=lambda row: row[0], reverse=True)
            chunks: list[RetrievedChunk] = []
            seen_ids: set[str] = set()
            for score, idx in scored_rows:
                chunk = self._chunk_from_meta(idx=idx, score=score, rank=0)
                if chunk.chunk_id in seen_ids:
                    continue
                seen_ids.add(chunk.chunk_id)
                chunks.append(chunk)
                if len(chunks) >= per_ref_limit:
                    break
            if chunks:
                results[ref] = chunks
        return results

    def search(
        self,
        query: str,
        top_k: int,
        *,
        candidate_pool_size: int | None = None,
    ) -> list[RetrievedChunk]:
        if top_k < 1:
            raise ValueError("top_k must be >= 1")
        query = query.strip()
        if not query:
            return []

        self._load_index()
        assert self._index is not None
        assert self._dim is not None
        assert self._meta is not None
        if int(self._index.ntotal) == 0:
            return []

        query_vector = self._encode_query(query)
        dense_rows = self._search_dense_indices(
            query_vector=query_vector,
            top_k=top_k,
            candidate_pool_size=candidate_pool_size,
        )

        results: list[RetrievedChunk] = []
        for rank, (idx, distance) in enumerate(dense_rows, start=1):
            results.append(self._chunk_from_meta(idx=idx, score=distance, rank=rank))
        return results

    def search_hybrid(
        self,
        query: str,
        top_k: int,
        *,
        candidate_pool_size: int | None = None,
        bm25_top_n: int = 200,
        dense_weight: float = 0.7,
        bm25_weight: float = 0.3,
    ) -> list[RetrievedChunk]:
        if top_k < 1:
            raise ValueError("top_k must be >= 1")
        query = query.strip()
        if not query:
            return []

        self._load_index()
        assert self._index is not None
        assert self._meta is not None
        if int(self._index.ntotal) == 0:
            return []

        query_vector = self._encode_query(query)
        requested = top_k
        if candidate_pool_size is not None:
            requested = max(top_k, int(candidate_pool_size))

        dense_rows = self._search_dense_indices(
            query_vector=query_vector,
            top_k=requested,
            candidate_pool_size=requested,
        )
        bm25_rows = self._bm25_search(query, top_n=max(bm25_top_n, requested))

        def _normalize_scores(rows: list[tuple[int, float]]) -> dict[int, float]:
            if not rows:
                return {}
            values = [score for _, score in rows]
            lo = min(values)
            hi = max(values)
            if hi <= lo:
                return {idx: 1.0 for idx, _ in rows}
            scale = hi - lo
            return {idx: (score - lo) / scale for idx, score in rows}

        dense_norm = _normalize_scores(dense_rows)
        bm25_norm = _normalize_scores(bm25_rows)
        dense_raw = {idx: score for idx, score in dense_rows}
        bm25_raw = {idx: score for idx, score in bm25_rows}

        combined: dict[int, float] = {}
        for idx, score in dense_norm.items():
            combined[idx] = combined.get(idx, 0.0) + (dense_weight * score)
        for idx, score in bm25_norm.items():
            combined[idx] = combined.get(idx, 0.0) + (bm25_weight * score)

        ranked_rows = sorted(
            combined.items(),
            key=lambda item: (
                item[1],
                dense_raw.get(item[0], float("-inf")),
                bm25_raw.get(item[0], float("-inf")),
            ),
            reverse=True,
        )

        results: list[RetrievedChunk] = []
        limit = min(requested, len(ranked_rows))
        for rank, (idx, score) in enumerate(ranked_rows[:limit], start=1):
            results.append(self._chunk_from_meta(idx=idx, score=float(score), rank=rank))
        return results

    def rerank_with_cross_encoder(
        self,
        query: str,
        candidates: Sequence[RetrievedChunk],
        *,
        top_k: int,
        candidate_pool_size: int,
    ) -> tuple[list[RetrievedChunk], bool, str | None]:
        if top_k < 1:
            raise ValueError("top_k must be >= 1")
        if candidate_pool_size < 1:
            raise ValueError("candidate_pool_size must be >= 1")

        candidate_list = list(candidates)
        if not candidate_list:
            return [], False, None

        reranker = self._load_reranker()
        if reranker is None:
            return [
                replace(chunk, rank=rank)
                for rank, chunk in enumerate(candidate_list[:top_k], start=1)
            ], False, None

        reranker_device = (self.reranker_device or "").strip().lower()
        reranker_on_cpu = reranker_device.startswith("cpu")
        requested_pool_size = max(top_k, candidate_pool_size)
        effective_pool_size = requested_pool_size
        if reranker_on_cpu:
            effective_pool_size = min(
                requested_pool_size,
                max(top_k, self.reranker_cpu_max_candidates),
            )
        pool = candidate_list[:effective_pool_size]
        snippet_limit = (
            self.reranker_cpu_snippet_chars if reranker_on_cpu else self.reranker_snippet_chars
        )
        pairs: list[list[str]] = []
        for chunk in pool:
            # Cross-encoder inference cost grows quickly with input length.
            # Keep a sizable excerpt to preserve legal precision while staying efficient.
            snippet = chunk.text.strip()
            if len(snippet) > snippet_limit:
                snippet = snippet[:snippet_limit]
            pairs.append([query, snippet])

        try:
            raw_scores = reranker.predict(
                pairs,
                batch_size=self.reranker_batch_size,
                show_progress_bar=False,
            )
        except Exception as exc:  # noqa: BLE001
            fallback = [
                replace(chunk, rank=rank)
                for rank, chunk in enumerate(pool[:top_k], start=1)
            ]
            return fallback, False, str(exc)

        scores = np.asarray(raw_scores, dtype=np.float32).reshape(-1)
        if scores.size != len(pool):
            fallback = [
                replace(chunk, rank=rank)
                for rank, chunk in enumerate(pool[:top_k], start=1)
            ]
            return fallback, False, "reranker returned unexpected score count"

        lo = float(np.min(scores))
        hi = float(np.max(scores))
        if hi <= lo:
            normalized = np.ones_like(scores, dtype=np.float32)
        else:
            normalized = (scores - lo) / float(hi - lo)

        scored_rows: list[tuple[float, RetrievedChunk]] = []
        for idx, chunk in enumerate(pool):
            scored_rows.append((float(normalized[idx]), chunk))

        scored_rows.sort(key=lambda item: item[0], reverse=True)
        reranked: list[RetrievedChunk] = []
        for rank, (score, chunk) in enumerate(scored_rows[:top_k], start=1):
            reranked.append(replace(chunk, rank=rank, score=score))
        return reranked, True, None


def enforce_article_reference_coverage(
    ranked_chunks: Sequence[RetrievedChunk],
    article_refs: Sequence[ArticleRef],
    exact_matches_by_ref: dict[ArticleRef, list[RetrievedChunk]],
    top_k: int,
) -> tuple[list[RetrievedChunk], bool]:
    if top_k < 1:
        raise ValueError("top_k must be >= 1")

    selected = list(ranked_chunks[:top_k])
    selected_ids = {chunk.chunk_id for chunk in selected}
    changed = False

    if not selected:
        for ref in article_refs:
            matches = exact_matches_by_ref.get(ref, [])
            if not matches:
                continue
            candidate = matches[0]
            if candidate.chunk_id in selected_ids:
                continue
            selected.append(candidate)
            selected_ids.add(candidate.chunk_id)
            changed = True
            if len(selected) >= top_k:
                break

    def satisfies_any_ref(chunk: RetrievedChunk) -> bool:
        return any(chunk_matches_article_ref(chunk, ref, prefixed) for ref, prefixed in article_refs)

    for ref in article_refs:
        matches = exact_matches_by_ref.get(ref, [])
        if not matches:
            continue
        ref_value, prefixed = ref
        if any(chunk_matches_article_ref(chunk, ref_value, prefixed) for chunk in selected):
            continue

        replacement = next((chunk for chunk in matches if chunk.chunk_id not in selected_ids), None)
        if replacement is None:
            continue

        if len(selected) < top_k:
            selected.append(replacement)
            selected_ids.add(replacement.chunk_id)
            changed = True
            continue

        replace_idx = None
        for i in range(len(selected) - 1, -1, -1):
            if not satisfies_any_ref(selected[i]):
                replace_idx = i
                break
        if replace_idx is None and selected:
            replace_idx = len(selected) - 1

        if replace_idx is not None:
            selected_ids.discard(selected[replace_idx].chunk_id)
            selected[replace_idx] = replacement
            selected_ids.add(replacement.chunk_id)
            changed = True

    renumbered = [replace(chunk, rank=rank) for rank, chunk in enumerate(selected, start=1)]
    return renumbered, changed


# Backward compatibility for existing imports.
NumpyRetriever = FaissRetriever


def _as_optional_str(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _as_optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def format_retrieval_context(
    chunks: Sequence[RetrievedChunk],
    max_chars: int,
) -> tuple[str, list[dict[str, Any]]]:
    context_parts: list[str] = []
    used_sources: list[dict[str, Any]] = []
    used_chars = 0

    for chunk in chunks:
        snippet = chunk.text.strip()
        if not snippet:
            continue
        header = f"[source {chunk.rank}] {chunk.citation()}\n"
        if max_chars > 0:
            remaining = max_chars - used_chars
            if remaining <= 0:
                break
            max_snippet_chars = remaining - len(header) - 1
            if max_snippet_chars <= 0:
                if context_parts:
                    break
                snippet = ""
            elif len(snippet) > max_snippet_chars:
                if max_snippet_chars <= 3:
                    snippet = snippet[:max_snippet_chars]
                else:
                    snippet = snippet[: max_snippet_chars - 3].rstrip() + "..."
        block = f"{header}{snippet}\n"
        if max_chars > 0 and used_chars + len(block) > max_chars:
            if context_parts:
                break
            block = block[:max_chars]
        context_parts.append(block)
        used_chars += len(block)
        source_dict = chunk.to_source_dict()
        # Keep a short excerpt for post-generation citation validation.
        source_dict["excerpt"] = snippet[:1200]
        used_sources.append(source_dict)

    return "\n".join(context_parts).strip(), used_sources
