from __future__ import annotations

import unittest

from backend.retrieval.retriever import (
    RetrievedChunk,
    detect_query_domains,
    filter_candidates_by_query_domains,
    select_chunks_adaptive,
)


def _chunk(
    chunk_id: str,
    score: float,
    relative_path: str,
    text: str = "contenu",
    article_hint: str | None = None,
) -> RetrievedChunk:
    return RetrievedChunk(
        rank=1,
        score=score,
        chunk_id=chunk_id,
        text=text,
        doc_id="doc",
        relative_path=relative_path,
        source_path=relative_path,
        page_start=1,
        page_end=1,
        article_hint=article_hint,
    )


class RetrievalDomainAdaptiveTests(unittest.TestCase):
    def test_detect_query_domains_workflow(self) -> None:
        self.assertIn("travail", detect_query_domains("c quoi le droit du travail"))
        self.assertIn(
            "procedure_penale",
            detect_query_domains("que dit l article 55 du code de procedure penal"),
        )
        self.assertIn("electoral", detect_query_domains("Combien de membres compose la CENA ?"))

    def test_filter_candidates_by_query_domains_excludes_out_domain(self) -> None:
        query = "c quoi le droit du travail"
        candidates = [
            _chunk("a", 0.80, "droit du travail/code.pdf"),
            _chunk("b", 0.79, "droit penal/code.pdf"),
            _chunk("c", 0.60, "autres/doc.pdf"),
            _chunk("d", 0.58, "droit du travail/autre.pdf"),
        ]
        filtered, applied, domains, in_count = filter_candidates_by_query_domains(
            query=query,
            candidates=candidates,
            top_k=10,
            neutral_fallback_max=1,
        )
        self.assertTrue(applied)
        self.assertIn("travail", domains)
        self.assertEqual(in_count, 2)
        self.assertTrue(any("droit du travail" in (c.relative_path or "") for c in filtered))
        self.assertFalse(any("droit penal" in (c.relative_path or "") for c in filtered))
        self.assertLessEqual(
            sum(1 for c in filtered if "autres/" in (c.relative_path or "").replace("\\", "/")),
            1,
        )

    def test_filter_candidates_by_query_domains_penal_includes_procedure_penale(self) -> None:
        query = "quelles sont les categories d infractions du code penal"
        candidates = [
            _chunk("penal_1", 0.70, "droit penal/droit penal.pdf"),
            _chunk("proc_1", 0.68, "Code de procedure penal/code-procedure-penal.pdf"),
            _chunk("travail_1", 0.65, "droit du travail/code.pdf"),
        ]
        filtered, applied, domains, _ = filter_candidates_by_query_domains(
            query=query,
            candidates=candidates,
            top_k=10,
            neutral_fallback_max=0,
        )
        self.assertTrue(applied)
        self.assertIn("penal", domains)
        self.assertEqual(len(filtered), 2)
        self.assertTrue(any("droit penal" in (c.relative_path or "") for c in filtered))
        self.assertTrue(any("procedure penal" in (c.relative_path or "").lower() for c in filtered))
        self.assertFalse(any("droit du travail" in (c.relative_path or "") for c in filtered))

    def test_filter_candidates_by_query_domains_never_falls_back_to_out_domain(self) -> None:
        query = "c quoi le droit du travail"
        candidates = [
            _chunk("penal_only", 0.91, "droit penal/code.pdf"),
            _chunk("electoral_only", 0.89, "Code Electoral/code-electoral.pdf"),
        ]
        filtered, applied, domains, in_count = filter_candidates_by_query_domains(
            query=query,
            candidates=candidates,
            top_k=10,
            neutral_fallback_max=2,
        )
        self.assertTrue(applied)
        self.assertIn("travail", domains)
        self.assertEqual(in_count, 0)
        self.assertEqual(filtered, [])

    def test_select_chunks_adaptive_lowers_threshold_until_target(self) -> None:
        candidates = []
        # 3 chunks above 0.35, then additional chunks between 0.32 and 0.23.
        scores = [0.50, 0.42, 0.37, 0.33, 0.31, 0.29, 0.27, 0.25, 0.23, 0.21]
        for idx, score in enumerate(scores):
            candidates.append(_chunk(f"travail_{idx}", score, "droit du travail/code.pdf"))

        selected, threshold_final, iterations, neutral_added = select_chunks_adaptive(
            candidates,
            min_score_threshold=0.35,
            threshold_floor=0.22,
            threshold_step=0.03,
            target_min=8,
            target_max=10,
            neutral_fallback_max=2,
            article_refs=[],
            exact_matches_by_ref={},
        )
        self.assertGreaterEqual(len(selected), 8)
        self.assertLessEqual(len(selected), 10)
        self.assertLessEqual(threshold_final, 0.35)
        self.assertGreaterEqual(iterations, 1)
        self.assertEqual(neutral_added, 0)

    def test_select_chunks_adaptive_adds_neutral_when_needed(self) -> None:
        candidates = [
            _chunk("in_1", 0.45, "droit du travail/code.pdf"),
            _chunk("in_2", 0.41, "droit du travail/code.pdf"),
            _chunk("in_3", 0.37, "droit du travail/code.pdf"),
            _chunk("in_4", 0.30, "droit du travail/code.pdf"),
            _chunk("in_5", 0.27, "droit du travail/code.pdf"),
            _chunk("in_6", 0.22, "droit du travail/code.pdf"),
            _chunk("n_1", 0.05, "autres/notes.txt"),
            _chunk("n_2", 0.04, "autres/autre.txt"),
            _chunk("out_1", 0.80, "droit penal/code.pdf"),
        ]
        # Candidates are assumed already domain-filtered in pipeline; simulate by excluding out-domain.
        domain_filtered = [c for c in candidates if "droit penal" not in (c.relative_path or "")]
        selected, _, _, neutral_added = select_chunks_adaptive(
            domain_filtered,
            min_score_threshold=0.35,
            threshold_floor=0.22,
            threshold_step=0.03,
            target_min=8,
            target_max=10,
            neutral_fallback_max=2,
            article_refs=[],
            exact_matches_by_ref={},
        )
        self.assertGreaterEqual(len(selected), 8)
        self.assertEqual(neutral_added, 2)
        self.assertFalse(any("droit penal" in (c.relative_path or "") for c in selected))

    def test_select_chunks_adaptive_truncates_to_target_max(self) -> None:
        candidates = [_chunk(f"in_{i}", 0.60 - (i * 0.01), "droit du travail/code.pdf") for i in range(20)]
        selected, _, _, _ = select_chunks_adaptive(
            candidates,
            min_score_threshold=0.10,
            threshold_floor=0.05,
            threshold_step=0.01,
            target_min=8,
            target_max=10,
            neutral_fallback_max=2,
            article_refs=[],
            exact_matches_by_ref={},
        )
        self.assertEqual(len(selected), 10)

    def test_select_chunks_adaptive_preserves_article_reference(self) -> None:
        candidates = [
            _chunk("c1", 0.70, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 12"),
            _chunk("c2", 0.68, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 13"),
            _chunk("c3", 0.67, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 14"),
            _chunk("c4", 0.66, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 15"),
            _chunk("c5", 0.65, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 16"),
            _chunk("c6", 0.64, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 17"),
            _chunk("c7", 0.63, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 18"),
            _chunk("c8", 0.62, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 19"),
            _chunk("article55_exact", 0.10, "Code de procedure penal/code-procedure-penal.pdf", article_hint="Article 55"),
        ]
        article_ref = ("55", False)
        selected, _, _, _ = select_chunks_adaptive(
            candidates,
            min_score_threshold=0.60,
            threshold_floor=0.55,
            threshold_step=0.02,
            target_min=8,
            target_max=10,
            neutral_fallback_max=2,
            article_refs=[article_ref],
            exact_matches_by_ref={article_ref: [candidates[-1]]},
        )
        ids = {chunk.chunk_id for chunk in selected}
        self.assertIn("article55_exact", ids)


if __name__ == "__main__":
    unittest.main()
