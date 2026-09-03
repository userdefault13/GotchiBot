---
name: pymupdf
description: >-
  Structured PDF tools for agents (info/search/read_pages/tables/chunks/render)
  via PyMuPDF. Prefer small tools over dumping whole PDFs. Load for contracts,
  papers, RAG chunking, or page-grounded citations.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: pdf
---

# PyMuPDF agent tools (pymupdf)

## Architecture

```
PDF → classify (digital vs scan, pages, TOC)
    → extract (PyMuPDF blocks + tables)
    → normalize (reading order, tables → markdown)
    → optional chunks (~400–800 tokens, heading-aware, overlap)
    → tool API (CLI / MCP / optional FastAPI)
```

Cache: `var/pdf-cache/<sha16>/structured.json` (per file hash). Never send raw PDF bytes to the LLM unless multimodal on selected rendered pages.

## Prerequisites

```bash
python3 -m venv .venv-pdf
.venv-pdf/bin/pip install -r requirements/pymupdf.txt
./scripts/gotchibot pdf check
```

Optional HTTP: `.venv-pdf/bin/pip install -r requirements/pymupdf-api.txt` then uvicorn `scripts.pdf_fastapi:app`.

## Agent tools (1-indexed pages)

| Tool | Purpose |
| --- | --- |
| `pdf_info` | pages, title, TOC, `scanned` flag |
| `pdf_search` | page hits + short snippets + bbox |
| `pdf_read_pages` | text/markdown for specific pages; caps ~8k–16k tokens (`truncated` + hint) |
| `pdf_tables` | tables on one page → markdown + JSON rows |
| `pdf_chunks` | RAG chunks with `doc_id`, `page`, `section`, `type`, `token_estimate` |
| `pdf_render` | page → PNG for visual verify / grounding |
| `pdf_check` | venv / pymupdf health |

### Chunk record shape

```json
{
  "doc_id": "contract-2024.pdf",
  "page": 12,
  "section": "Limitation of Liability",
  "type": "paragraph",
  "text": "...",
  "token_estimate": 312
}
```

## Exact commands

```bash
./scripts/gotchibot pdf check
./scripts/gotchibot pdf info path/to/file.pdf
./scripts/gotchibot pdf search path/to/file.pdf "liability"
./scripts/gotchibot pdf read-pages path/to/file.pdf --pages 3-7
./scripts/gotchibot pdf tables path/to/file.pdf --page 4
./scripts/gotchibot pdf chunks path/to/file.pdf
./scripts/gotchibot pdf render path/to/file.pdf --out build/pdf/p3.png --page 3
```

`text` is an alias of `read-pages`. Paths confined by [`config/pymupdf.json`](config/pymupdf.json).

## Workflow

1. `pdf_info` — size / scanned / TOC.
2. `pdf_search` — locate sections.
3. `pdf_read_pages` on a few pages only (never dump whole books).
4. `pdf_tables` when you need grid data.
5. `pdf_chunks` for RAG ingest.
6. `pdf_render` when extractors change or citations need visual check.

If `truncated: true`, request fewer pages or lower `--max-tokens`.

## Forbidden

- Global pip / installs outside `.venv-pdf` without Julius
- Paths outside allowReadRoots / allowWriteRoots
- Inventing PDF contents without running the tool
- Dumping entire multi-hundred-page PDFs into the model context
