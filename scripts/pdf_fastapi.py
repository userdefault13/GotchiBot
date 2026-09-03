#!/usr/bin/env python3
"""
Optional FastAPI surface for the PDF tool (same semantics as CLI/MCP).

  .venv-pdf/bin/pip install -r requirements/pymupdf-api.txt
  .venv-pdf/bin/uvicorn scripts.pdf_fastapi:app --app-dir . --port 8765

Not started by GotchiBot by default — prefer MCP/CLI.
"""
from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import pdf_tool as pt  # noqa: E402

app = FastAPI(title="gotchibot-pdf", version="2.0.0")
CFG = pt.load_cfg(ROOT)
READ = CFG.get("allowReadRoots") or ["."]
DEFAULT_MAX = int(CFG.get("maxOutputTokens") or 12000)


def _capture(fn) -> dict[str, Any]:
    f = io.StringIO()
    with redirect_stdout(f):
        fn()
    return json.loads(f.getvalue())


def _pdf(path: str) -> Path:
    try:
        return pt.resolve_in(path, READ, ROOT, must_exist=True)
    except SystemExit as e:
        raise HTTPException(400, str(e)) from e


class ReadBody(BaseModel):
    path: str
    pages: list[int] = Field(..., description="1-indexed pages")
    format: str = "markdown"
    max_tokens: int = DEFAULT_MAX


class SearchBody(BaseModel):
    path: str
    query: str
    max_hits: int = 40


class TablesBody(BaseModel):
    path: str
    page: int


class ChunksBody(BaseModel):
    path: str
    pages: str | None = None
    max_tokens: int = DEFAULT_MAX


@app.get("/health")
def health() -> dict[str, Any]:
    fitz = pt.import_fitz()
    return {"ok": bool(fitz), "pymupdf": bool(fitz)}


@app.get("/pdf/info")
def pdf_info(path: str) -> dict[str, Any]:
    p = _pdf(path)
    data = pt.get_structured(p, ROOT, CFG)
    return pt.truncate_by_tokens(
        {
            "ok": True,
            "doc_id": data["doc_id"],
            "path": data["path"],
            "title": data["title"],
            "pages": data["pages"],
            "toc": data["toc"],
            "scanned": data["scanned"],
            "scanned_pages": data["scanned_pages"],
            "metadata": data.get("metadata") or {},
        },
        DEFAULT_MAX,
    )


@app.post("/pdf/search")
def pdf_search(body: SearchBody) -> dict[str, Any]:
    p = _pdf(body.path)
    return _capture(lambda: pt.cmd_search(p, body.query, body.max_hits, CFG, ROOT))


@app.post("/pdf/read-pages")
def pdf_read_pages(body: ReadBody) -> dict[str, Any]:
    p = _pdf(body.path)
    return _capture(
        lambda: pt.cmd_read_pages(
            p, None, body.pages, body.format, body.max_tokens, ROOT, CFG
        )
    )


@app.post("/pdf/tables")
def pdf_tables(body: TablesBody) -> dict[str, Any]:
    p = _pdf(body.path)
    return _capture(lambda: pt.cmd_tables(p, body.page, ROOT, CFG, DEFAULT_MAX))


@app.post("/pdf/chunks")
def pdf_chunks(body: ChunksBody) -> dict[str, Any]:
    p = _pdf(body.path)
    return _capture(lambda: pt.cmd_chunks(p, body.pages, ROOT, CFG, body.max_tokens))
