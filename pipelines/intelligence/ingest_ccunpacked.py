#!/usr/bin/env python3
"""
Pilot — ccunpacked Knowledge Ingestion (Phase 2.2)

Ingests the ccunpacked Claude Code architecture reference into the
knowledge layer (pages + content_chunks tables).

Source: externalized ccunpacked scrape output
Target: knowledge.pages (type='concept') + knowledge.content_chunks

Tracks provenance per Section 39.4.

Usage:
    PILOT_CCUNPACKED_SOURCE=/path/to/ccunpacked_scrape python ingest_ccunpacked.py
    python ingest_ccunpacked.py --source-dir /path/to   # Custom source
    python ingest_ccunpacked.py --dry-run               # Print without DB writes
    python ingest_ccunpacked.py --reference-only         # Ingest compiled reference only
"""

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

PARSER_VERSION = "0.1.0"
CHUNK_SIZE = 1500  # chars per chunk (roughly ~375 tokens)
CHUNK_OVERLAP = 200

# ─── Category mapping from directory names ───
CATEGORY_MAP = {
    "agent_loop": ["claude-code", "agent-loop", "architecture"],
    "architecture": ["claude-code", "architecture", "design"],
    "commands": ["claude-code", "commands", "cli"],
    "tools": ["claude-code", "tools", "api"],
    "hidden_features": ["claude-code", "features", "undocumented"],
}

DEFAULT_SOURCE = os.environ.get("PILOT_CCUNPACKED_SOURCE", "")


def get_db():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


def clean_content(raw: str) -> str:
    """Clean HTML/markdown noise from scraped content."""
    # Strip common HTML artifacts
    text = re.sub(r"<[^>]+>", "", raw)
    # Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def extract_title(content: str, filename: str) -> str:
    """Extract title from content or filename."""
    # Try first heading
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    if match:
        return match.group(1).strip()
    # Fall back to filename
    return filename.replace(".html", "").replace(".txt", "").replace("_", " ").title()


def ingest_file(
    cur, filepath: Path, category: str, tags: list[str], dry_run: bool, workspace_id: str
) -> int:
    """Ingest a single file as a knowledge page with chunks."""
    raw = filepath.read_text(encoding="utf-8", errors="replace")
    content = clean_content(raw)

    if len(content) < 50:
        return 0  # skip near-empty files

    title = extract_title(content, filepath.name)
    page_id = str(uuid.uuid4())

    if dry_run:
        chunks = chunk_text(content)
        print(f"  [{category}] {title} — {len(content)} chars, {len(chunks)} chunks")
        return len(chunks)

    # Insert page
    cur.execute(
        """INSERT INTO pages (id, workspace_id, type, title, compiled_truth, tags)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (
            page_id,
            workspace_id,
            "concept",
            title,
            content[:500],  # first 500 chars as initial compiled truth
            json.dumps(tags),
        ),
    )

    # Insert chunks
    chunks = chunk_text(content)
    for i, chunk in enumerate(chunks):
        cur.execute(
            """INSERT INTO content_chunks (id, page_id, content, chunk_index, metadata)
               VALUES (%s, %s, %s, %s, %s)""",
            (
                str(uuid.uuid4()),
                page_id,
                chunk,
                i,
                json.dumps(
                    {
                        "source_file": str(filepath.name),
                        "category": category,
                        "workspaceId": workspace_id,
                    }
                ),
            ),
        )

    return len(chunks)


def ingest_reference(cur, source_dir: str, dry_run: bool, workspace_id: str) -> int:
    """Ingest the compiled reference book."""
    ref_path = Path(source_dir) / "CCUnpacked_Reference.md"
    if not ref_path.exists():
        print(f"  Reference file not found: {ref_path}")
        return 0

    content = ref_path.read_text(encoding="utf-8")
    title = "Claude Code Architecture Reference (CCUnpacked)"
    page_id = str(uuid.uuid4())
    tags = ["claude-code", "architecture", "reference", "comprehensive"]

    chunks = chunk_text(content)

    if dry_run:
        print(f"  [reference] {title} — {len(content)} chars, {len(chunks)} chunks")
        return len(chunks)

    cur.execute(
        """INSERT INTO pages (id, workspace_id, type, title, compiled_truth, tags)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (page_id, workspace_id, "concept", title, content[:500], json.dumps(tags)),
    )

    for i, chunk in enumerate(chunks):
        cur.execute(
            """INSERT INTO content_chunks (id, page_id, content, chunk_index, metadata)
               VALUES (%s, %s, %s, %s, %s)""",
            (
                str(uuid.uuid4()),
                page_id,
                chunk,
                i,
                json.dumps(
                    {
                        "source_file": "CCUnpacked_Reference.md",
                        "category": "reference",
                        "workspaceId": workspace_id,
                    }
                ),
            ),
        )

    return len(chunks)


def log_ingestion(
    cur, source: str, item_count: int, status: str, workspace_id: str, error: str | None = None
):
    """Record ingestion provenance."""
    record_id = str(uuid.uuid4())
    metadata = {
        "workspaceId": workspace_id,
        "sourceHash": f"sha256:{hashlib.sha256(source.encode('utf-8')).hexdigest()}",
        "parserVersion": PARSER_VERSION,
        "credentialBoundary": "no_session_or_token_material_in_evidence",
    }
    cur.execute(
        """INSERT INTO ingestion_records
           (id, source_origin, source_type, is_public, parser_version,
            fetched_at, parsed_at, item_count, status, error, metadata)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            record_id,
            source,
            "import",
            False,  # scraped/curated content, not public API
            PARSER_VERSION,
            datetime.now(timezone.utc),
            datetime.now(timezone.utc),
            item_count,
            status,
            error,
            json.dumps(metadata),
        ),
    )
    append_ingestion_evidence_item(
        cur,
        record_id=record_id,
        source=source,
        item_count=item_count,
        status=status,
        workspace_id=workspace_id,
        error=error,
    )


def append_ingestion_evidence_item(
    cur,
    *,
    record_id: str,
    source: str,
    item_count: int,
    status: str,
    workspace_id: str,
    error: str | None,
) -> None:
    evidence_status = normalized_status(status)
    evidence_type = f"knowledge_ingestion_{evidence_status or 'finalized'}"
    metadata = {
        "ingestionRecordId": record_id,
        "sourceType": "import",
        "parserVersion": PARSER_VERSION,
        "status": status,
        "itemCount": item_count,
        "hasError": bool(error),
        "sourceHash": f"sha256:{hashlib.sha256(source.encode('utf-8')).hexdigest()}",
        "productionReady": False,
        "credentialBoundary": "no_session_or_token_material_in_evidence",
    }
    content_hash = (
        f"sha256:{hashlib.sha256(stable_json(metadata).encode('utf-8')).hexdigest()}"
    )
    summary = (
        f"ccunpacked knowledge ingestion record {record_id} finalized with status {status} "
        f"and {item_count} pages."
    )
    if error:
        summary = (
            f"{summary} Error details are retained on ingestion_records and excluded from "
            "evidence metadata."
        )

    cur.execute(
        """
        INSERT INTO evidence_items
          (workspace_id, evidence_type, source_type, title, summary, redaction_state,
           sensitivity, content_hash, replay_ref, metadata, observed_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            workspace_id,
            evidence_type,
            "ccunpacked_ingestion",
            f"ccunpacked knowledge ingestion {status}",
            summary,
            "redacted",
            "sensitive",
            content_hash,
            f"knowledge-ingestion:{record_id}:{evidence_status}",
            json.dumps(metadata),
            datetime.now(timezone.utc),
        ),
    )


def normalized_status(status: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in status.lower()).strip("_")


def stable_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(description="Ingest ccunpacked into knowledge layer")
    parser.add_argument(
        "--source-dir",
        default=DEFAULT_SOURCE,
        help="Path to externalized ccunpacked_scrape/ source",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reference-only", action="store_true", help="Only ingest compiled reference")
    parser.add_argument("--workspace-id", help="Workspace id for scoped knowledge and evidence rows")
    args = parser.parse_args()

    if not args.source_dir:
        parser.error("--source-dir or PILOT_CCUNPACKED_SOURCE is required")
    if not args.dry_run and not args.workspace_id:
        parser.error("--workspace-id is required for non-dry-run ingestion")

    source_dir = os.path.abspath(args.source_dir)
    output_dir = os.path.join(source_dir, "output")

    print(f"Pilot ccunpacked Ingestion v{PARSER_VERSION}")
    print(f"  Source: {source_dir}")
    print(f"  Workspace: {args.workspace_id or 'dry-run'}")
    print(f"  Dry run: {args.dry_run}")
    print()

    conn = None if args.dry_run else get_db()
    cur = conn.cursor() if conn else None

    total_chunks = 0
    total_pages = 0

    try:
        # Ingest compiled reference
        print("Ingesting compiled reference...")
        ref_chunks = ingest_reference(cur, source_dir, args.dry_run, args.workspace_id or "")
        total_chunks += ref_chunks
        if ref_chunks > 0:
            total_pages += 1

        if not args.reference_only:
            # Ingest individual output files
            # Files are flat in output/ with category prefix: agent_loop_0.html, commands_35.txt
            print("\nIngesting output files...")
            text_exts = {".html", ".txt", ".md"}
            by_category: dict[str, list[Path]] = {}

            if os.path.isdir(output_dir):
                for filepath in sorted(Path(output_dir).iterdir()):
                    if not filepath.is_file() or filepath.suffix.lower() not in text_exts:
                        continue
                    # Extract category from filename prefix: "agent_loop_0.html" -> "agent_loop"
                    name = filepath.stem
                    parts = name.rsplit("_", 1)
                    category = parts[0] if len(parts) > 1 and parts[1].isdigit() else name
                    by_category.setdefault(category, []).append(filepath)

                for category, files in sorted(by_category.items()):
                    tags = CATEGORY_MAP.get(category, ["claude-code", category])
                    print(f"\n  Category: {category} ({len(files)} files)")
                    for filepath in files:
                        chunks = ingest_file(
                            cur,
                            filepath,
                            category,
                            tags,
                            args.dry_run,
                            args.workspace_id or "",
                        )
                        if chunks > 0:
                            total_chunks += chunks
                            total_pages += 1
            else:
                print(f"  Output directory not found: {output_dir}")

        if cur and not args.dry_run:
            log_ingestion(cur, source_dir, total_pages, "parsed", args.workspace_id)
            conn.commit()

        print(f"\nDone: {total_pages} pages, {total_chunks} chunks")

    except Exception as e:
        if conn:
            conn.rollback()
            if cur:
                log_ingestion(cur, source_dir, 0, "failed", args.workspace_id or "", str(e))
                conn.commit()
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
