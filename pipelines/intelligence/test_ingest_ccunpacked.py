#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path
from typing import Any
from unittest import TestCase, main


def load_ingester():
    spec = importlib.util.spec_from_file_location(
        "ingest_ccunpacked",
        Path(__file__).with_name("ingest_ccunpacked.py"),
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


ingester = load_ingester()

WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"


class FakeCursor:
    def __init__(self):
        self.calls: list[tuple[str, tuple[Any, ...] | None]] = []

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        normalized = " ".join(sql.split())
        self.calls.append((normalized, params))

    def calls_containing(self, fragment: str) -> list[tuple[str, tuple[Any, ...] | None]]:
        return [(sql, params) for sql, params in self.calls if fragment in sql]


class CcUnpackedIngestionTests(TestCase):
    def test_ingest_file_writes_workspace_scoped_page_and_chunk_metadata(self) -> None:
        cur = FakeCursor()
        with tempfile.TemporaryDirectory() as tmp:
            filepath = Path(tmp) / "architecture_0.md"
            filepath.write_text(
                "# Runtime Design\n"
                "This reference material describes a long enough architecture section "
                "to become a knowledge page with one or more chunks.",
                encoding="utf-8",
            )

            chunks = ingester.ingest_file(
                cur,
                filepath,
                "architecture",
                ["claude-code", "architecture"],
                False,
                WORKSPACE_ID,
            )

        self.assertGreater(chunks, 0)

        page_insert = cur.calls_containing("INSERT INTO pages")[0]
        page_params = page_insert[1]
        assert page_params is not None
        self.assertIn("workspace_id", page_insert[0])
        self.assertEqual(page_params[1], WORKSPACE_ID)

        chunk_insert = cur.calls_containing("INSERT INTO content_chunks")[0]
        chunk_params = chunk_insert[1]
        assert chunk_params is not None
        metadata = json.loads(chunk_params[4])
        self.assertEqual(metadata["workspaceId"], WORKSPACE_ID)
        self.assertEqual(metadata["category"], "architecture")

    def test_log_ingestion_appends_redacted_workspace_evidence(self) -> None:
        cur = FakeCursor()
        source = "/private/tmp/ccunpacked_scrape"

        ingester.log_ingestion(cur, source, 3, "parsed", WORKSPACE_ID)

        record_insert = cur.calls_containing("INSERT INTO ingestion_records")[0]
        record_params = record_insert[1]
        assert record_params is not None
        record_metadata = json.loads(record_params[10])
        self.assertEqual(record_metadata["workspaceId"], WORKSPACE_ID)
        self.assertNotIn(source, json.dumps(record_metadata))

        evidence_insert = cur.calls_containing("INSERT INTO evidence_items")[0]
        evidence_params = evidence_insert[1]
        assert evidence_params is not None
        evidence_metadata = json.loads(evidence_params[9])
        self.assertEqual(evidence_params[0], WORKSPACE_ID)
        self.assertEqual(evidence_params[1], "knowledge_ingestion_parsed")
        self.assertEqual(evidence_params[2], "ccunpacked_ingestion")
        self.assertEqual(evidence_params[5], "redacted")
        self.assertEqual(evidence_params[6], "sensitive")
        self.assertEqual(evidence_metadata["itemCount"], 3)
        self.assertNotIn(source, evidence_params[4])
        self.assertNotIn(source, json.dumps(evidence_metadata))


if __name__ == "__main__":
    main()
