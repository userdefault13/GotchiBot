#!/usr/bin/env python3
"""
GotchiBot PDF tool — structured extract for agents (not raw wall-of-text).

Subcommands:
  check | info | search | read-pages | tables | chunks | render

Pages are **1-indexed** for agent-facing commands. JSON on stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def out(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def load_cfg(root: Path) -> dict:
    p = root / "config" / "pymupdf.json"
    defaults = {
        "allowReadRoots": [".", "~/Downloads", "~/Dev", "~/Documents"],
        "allowWriteRoots": [".", "build", "assets", "output", "sessions", "tmp", "var"],
        "defaultRenderDir": "build/pdf",
        "cacheDir": "var/pdf-cache",
        "chunkTokens": {"min": 400, "max": 800, "overlap": 80},
        "maxOutputTokens": 12000,
        "scannedTextThreshold": 40,
    }
    if not p.is_file():
        return defaults
    data = json.loads(p.read_text())
    for k, v in defaults.items():
        data.setdefault(k, v)
    return data


def expand_root(s: str, repo: Path) -> Path:
    s = s.replace("~", str(Path.home()))
    p = Path(s)
    return (repo / p).resolve() if not p.is_absolute() else p.resolve()


def under_roots(path: Path, roots: list[str], repo: Path) -> bool:
    try:
        path = path.resolve()
    except OSError:
        return False
    for r in roots:
        base = expand_root(r, repo)
        try:
            path.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def resolve_in(path_s: str, roots: list[str], repo: Path, *, must_exist: bool) -> Path:
    p = Path(path_s).expanduser()
    p = (Path.cwd() / p).resolve() if not p.is_absolute() else p.resolve()
    if must_exist and not p.is_file():
        die(f"file not found: {p}")
    if not under_roots(p, roots, repo):
        die(f"path outside allowlist: {p}")
    return p


def import_fitz():
    try:
        import pymupdf as fitz  # type: ignore

        return fitz
    except ImportError:
        try:
            import fitz  # type: ignore

            return fitz
        except ImportError:
            return None


def token_estimate(text: str) -> int:
    # Rough GPT-ish estimate; good enough for agent budgeting.
    t = text or ""
    return max(1, (len(t) + 3) // 4) if t.strip() else 0


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_path(repo: Path, cfg: dict, digest: str, name: str) -> Path:
    d = expand_root(cfg.get("cacheDir") or "var/pdf-cache", repo) / digest[:16]
    d.mkdir(parents=True, exist_ok=True)
    return d / name


def load_cache(path: Path) -> Any | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def save_cache(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False))


def parse_pages_1based(s: str | None, page_count: int) -> list[int]:
    """Return 0-based indices from 1-based CLI/MCP input."""
    if not s:
        return list(range(page_count))
    out: list[int] = []
    for part in str(s).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
            for n in range(lo, hi + 1):
                if 1 <= n <= page_count:
                    out.append(n - 1)
        else:
            n = int(part)
            if 1 <= n <= page_count:
                out.append(n - 1)
    # also accept JSON array style passed as "3,4,5"
    if not out:
        die(f"no valid 1-based pages in {s!r} (doc has {page_count})")
    return out


def parse_pages_list(pages: list[int] | None, page_count: int) -> list[int]:
    if not pages:
        return list(range(page_count))
    out = []
    for n in pages:
        n = int(n)
        if 1 <= n <= page_count:
            out.append(n - 1)
    if not out:
        die(f"no valid 1-based pages (doc has {page_count})")
    return out


def toc_map(doc) -> list[dict]:
    toc = []
    try:
        for level, title, page in doc.get_toc() or []:
            toc.append({"level": level, "title": str(title).strip(), "page": int(page)})
    except Exception:
        pass
    return toc


def section_for_page(toc: list[dict], page_1: int) -> str | None:
    """Section at the *start* of page_1: last TOC entry with page < page_1,
    else first entry on page_1."""
    before = None
    first_on = None
    for item in toc:
        p = item["page"]
        if p < page_1:
            before = item["title"]
        elif p == page_1 and first_on is None:
            first_on = item["title"]
        elif p > page_1:
            break
    return before or first_on


def classify_page(page, threshold: int) -> dict:
    text = page.get_text("text") or ""
    chars = len(text.strip())
    images = page.get_images(full=True) or []
    scanned = chars < threshold and len(images) > 0
    return {
        "chars": chars,
        "images": len(images),
        "scanned_likely": scanned,
    }


def block_type(block: dict, avg_size: float) -> str:
    lines = block.get("lines") or []
    if not lines:
        return "paragraph"
    spans = []
    for ln in lines:
        for sp in ln.get("spans") or []:
            spans.append(sp)
    if not spans:
        return "paragraph"
    text = "".join(sp.get("text") or "" for sp in spans).strip()
    sizes = [float(sp.get("size") or 0) for sp in spans if sp.get("size")]
    size = max(sizes) if sizes else avg_size
    flags = [int(sp.get("flags") or 0) for sp in spans]
    bold = any(f & 2 ** 4 for f in flags)  # bit 4 often bold in MuPDF
    # list heuristic
    if re.match(r"^(\u2022|\-|\*|\d+[\.\)])\s+", text):
        return "list"
    if size >= avg_size * 1.25 or (bold and size >= avg_size * 1.1 and len(text) < 120):
        return "header"
    return "paragraph"


def _norm_title(s: str) -> str:
    s = re.sub(r"^[\d\.\)]+\s*", "", (s or "").strip().lower())
    return re.sub(r"\s+", " ", s)


def match_toc_title(text: str, toc: list[dict], page_1: int) -> str | None:
    """If block text matches a TOC entry, return that title (prefer same page)."""
    nt = _norm_title(text)
    if not nt or len(nt) > 160 or len(nt) < 8:
        return None
    same_page = [t for t in toc if t["page"] == page_1]
    rest = [t for t in toc if t["page"] != page_1]
    for t in same_page + rest:
        title = t["title"]
        nt2 = _norm_title(title)
        if not nt2 or len(nt2) < 8:
            continue
        if nt == nt2 or nt.startswith(nt2) or nt2.startswith(nt) or nt2 in nt or nt in nt2:
            return title
    return None


def extract_page_blocks(
    page, page_1: int, section: str | None, toc: list[dict] | None = None
) -> tuple[list[dict], str | None]:
    toc = toc or []
    d = page.get_text("dict") or {}
    blocks_in = d.get("blocks") or []
    sizes = []
    for b in blocks_in:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines") or []:
            for sp in ln.get("spans") or []:
                if sp.get("size"):
                    sizes.append(float(sp["size"]))
    avg = sum(sizes) / len(sizes) if sizes else 11.0
    out = []
    for b in blocks_in:
        if b.get("type") == 1:
            continue
        if b.get("type") != 0:
            continue
        parts = []
        for ln in b.get("lines") or []:
            line_txt = "".join(sp.get("text") or "" for sp in (ln.get("spans") or []))
            parts.append(line_txt)
        text = "\n".join(parts).strip()
        if not text:
            continue
        bbox = b.get("bbox") or [0, 0, 0, 0]
        typ = block_type(b, avg)
        toc_hit = match_toc_title(text, toc, page_1)
        if toc_hit:
            section = toc_hit
            if typ == "paragraph" and len(text) < 120:
                typ = "header"
        elif typ == "header" and len(text) < 160:
            # Prefer TOC labels when present; only invent section from headers if no TOC.
            if not toc:
                section = text
        out.append(
            {
                "page": page_1,
                "section": section,
                "type": typ,
                "text": text,
                "bbox": [round(float(x), 2) for x in bbox],
                "token_estimate": token_estimate(text),
            }
        )
    return out, section


def extract_tables_page(page, page_1: int) -> list[dict]:
    tables_out = []
    try:
        tf = page.find_tables()
    except Exception:
        return tables_out
    try:
        tables = list(tf.tables) if hasattr(tf, "tables") else list(tf)
    except Exception:
        return tables_out
    for i, t in enumerate(tables):
        try:
            data = t.extract()
        except Exception:
            continue
        # markdown
        if not data:
            continue
        header = data[0]
        md_lines = [
            "| " + " | ".join(str(c or "").replace("\n", " ") for c in header) + " |",
            "| " + " | ".join("---" for _ in header) + " |",
        ]
        for row in data[1:]:
            md_lines.append(
                "| " + " | ".join(str(c or "").replace("\n", " ") for c in row) + " |"
            )
        bbox = getattr(t, "bbox", None) or [0, 0, 0, 0]
        tables_out.append(
            {
                "page": page_1,
                "index": i,
                "type": "table",
                "markdown": "\n".join(md_lines),
                "rows": data,
                "bbox": [round(float(x), 2) for x in bbox],
                "token_estimate": token_estimate("\n".join(md_lines)),
            }
        )
    return tables_out


def build_structured(doc, path: Path, cfg: dict, pages_0: list[int] | None = None) -> dict:
    toc = toc_map(doc)
    threshold = int(cfg.get("scannedTextThreshold") or 40)
    page_idxs = pages_0 if pages_0 is not None else list(range(doc.page_count))
    elements: list[dict] = []
    page_meta = []
    section = None
    scanned_pages = 0
    for i in page_idxs:
        page = doc.load_page(i)
        page_1 = i + 1
        section = section_for_page(toc, page_1) or section
        cls = classify_page(page, threshold)
        if cls["scanned_likely"]:
            scanned_pages += 1
        page_meta.append({"page": page_1, **cls})
        blocks, section = extract_page_blocks(page, page_1, section, toc)
        elements.extend(blocks)
        for tb in extract_tables_page(page, page_1):
            elements.append(
                {
                    "page": page_1,
                    "section": section,
                    "type": "table",
                    "text": tb["markdown"],
                    "bbox": tb["bbox"],
                    "token_estimate": tb["token_estimate"],
                    "table": {"index": tb["index"], "rows": tb["rows"]},
                }
            )
    meta = doc.metadata or {}
    title = (meta.get("title") or "").strip() or path.name
    return {
        "doc_id": path.name,
        "path": str(path),
        "title": title,
        "pages": doc.page_count,
        "toc": toc,
        "scanned": scanned_pages >= max(1, len(page_idxs) // 2),
        "scanned_pages": scanned_pages,
        "page_meta": page_meta,
        "elements": elements,
        "metadata": {k: v for k, v in meta.items() if v},
    }


def chunk_elements(doc_id: str, elements: list[dict], cfg: dict) -> list[dict]:
    """Heading-aware chunks ~400–800 tokens with overlap."""
    cmin = int(cfg.get("chunkTokens", {}).get("min", 400))
    cmax = int(cfg.get("chunkTokens", {}).get("max", 800))
    overlap = int(cfg.get("chunkTokens", {}).get("overlap", 80))
    chunks: list[dict] = []
    buf: list[dict] = []
    buf_tokens = 0
    current_section = None

    def flush(force: bool = False) -> None:
        nonlocal buf, buf_tokens
        if not buf:
            return
        if not force and buf_tokens < cmin:
            return
        text = "\n\n".join(b["text"] for b in buf)
        page = buf[0]["page"]
        section = buf[0].get("section")
        typ = "mixed" if len({b["type"] for b in buf}) > 1 else buf[0]["type"]
        bboxes = [b.get("bbox") for b in buf if b.get("bbox")]
        chunks.append(
            {
                "doc_id": doc_id,
                "page": page,
                "pages": sorted({b["page"] for b in buf}),
                "section": section,
                "type": typ,
                "text": text,
                "token_estimate": token_estimate(text),
                "bbox": bboxes[0] if len(bboxes) == 1 else None,
                "bboxes": bboxes if len(bboxes) > 1 else None,
            }
        )
        # overlap: keep tail elements until ~overlap tokens
        if overlap <= 0 or force:
            buf, buf_tokens = [], 0
            return
        keep: list[dict] = []
        kept = 0
        for b in reversed(buf):
            keep.insert(0, b)
            kept += b.get("token_estimate") or token_estimate(b["text"])
            if kept >= overlap:
                break
        buf = keep
        buf_tokens = sum(b.get("token_estimate") or token_estimate(b["text"]) for b in buf)

    for el in elements:
        # new header section → flush previous if substantial
        if el["type"] == "header" and buf_tokens >= cmin:
            flush(force=True)
            current_section = el["text"]
        elif el.get("section"):
            current_section = el["section"]

        # tables: own chunk if large
        te = el.get("token_estimate") or token_estimate(el["text"])
        if el["type"] == "table" and te >= cmin:
            flush(force=True)
            chunks.append(
                {
                    "doc_id": doc_id,
                    "page": el["page"],
                    "pages": [el["page"]],
                    "section": el.get("section") or current_section,
                    "type": "table",
                    "text": el["text"],
                    "token_estimate": te,
                    "bbox": el.get("bbox"),
                }
            )
            continue

        if buf_tokens + te > cmax and buf_tokens >= cmin:
            flush(force=True)

        buf.append(el)
        buf_tokens += te
        if buf_tokens >= cmax:
            flush(force=True)

    flush(force=True)
    return chunks


def truncate_by_tokens(payload: dict, max_tokens: int) -> dict:
    """Ensure payload stays under max_tokens; set truncated + hint."""
    raw = json.dumps(payload, ensure_ascii=False)
    est = token_estimate(raw)
    if est <= max_tokens:
        payload["truncated"] = False
        payload["token_estimate"] = est
        return payload

    # Prefer trimming lists: chunks, pages, content, hits, tables
    hint = "Request fewer pages (pdf_read_pages) or smaller --max-tokens / --max-hits."
    for key in ("chunks", "pages", "content", "hits", "tables", "elements"):
        if key not in payload or not isinstance(payload[key], list):
            continue
        items = payload[key]
        kept = []
        # rebuild estimate roughly
        base = {k: v for k, v in payload.items() if k != key}
        for it in items:
            trial = {**base, key: kept + [it], "truncated": True}
            if token_estimate(json.dumps(trial, ensure_ascii=False)) > max_tokens:
                break
            kept.append(it)
        payload[key] = kept
        payload["truncated"] = True
        payload["hint"] = hint
        payload["token_estimate"] = token_estimate(json.dumps(payload, ensure_ascii=False))
        return payload

    payload["truncated"] = True
    payload["hint"] = hint
    # last resort: drop heavy fields
    for key in ("elements", "chunks", "tables", "content"):
        if key in payload:
            payload[key] = []
    payload["token_estimate"] = token_estimate(json.dumps(payload, ensure_ascii=False))
    return payload


def open_doc(path: Path):
    fitz = import_fitz()
    if not fitz:
        die("pymupdf not installed — see: .venv-pdf/bin/pip install -r requirements/pymupdf.txt")
    # Quiet optional pymupdf_layout nudge on stderr during agent tool calls.
    import warnings

    warnings.filterwarnings("ignore", message=".*pymupdf_layout.*")
    return fitz.open(path)


def cmd_check() -> None:
    fitz = import_fitz()
    if not fitz:
        out(
            {
                "ok": False,
                "error": "pymupdf not installed",
                "hint": "python3 -m venv .venv-pdf && .venv-pdf/bin/pip install -r requirements/pymupdf.txt",
            }
        )
        sys.exit(1)
    ver = getattr(fitz, "VersionBind", None) or str(getattr(fitz, "version", "?"))
    out({"ok": True, "pymupdf": str(ver), "python": sys.executable})


def get_structured(path: Path, repo: Path, cfg: dict, *, use_cache: bool = True) -> dict:
    digest = file_sha256(path)
    cpath = cache_path(repo, cfg, digest, "structured.json")
    if use_cache:
        cached = load_cache(cpath)
        if cached and cached.get("sha256") == digest:
            return cached["data"]
    doc = open_doc(path)
    try:
        data = build_structured(doc, path, cfg)
    finally:
        doc.close()
    if use_cache:
        save_cache(cpath, {"sha256": digest, "saved_at": time.time(), "data": data})
    return data


def cmd_info(path: Path, repo: Path, cfg: dict) -> None:
    data = get_structured(path, repo, cfg)
    out(
        truncate_by_tokens(
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
            int(cfg.get("maxOutputTokens") or 12000),
        )
    )


def cmd_search(path: Path, query: str, max_hits: int, cfg: dict, repo: Path) -> None:
    doc = open_doc(path)
    try:
        hits = []
        for i in range(doc.page_count):
            page = doc.load_page(i)
            rects = page.search_for(query) or []
            if not rects:
                continue
            # snippet: nearby text
            full = page.get_text("text") or ""
            idx = full.lower().find(query.lower())
            if idx >= 0:
                lo = max(0, idx - 80)
                hi = min(len(full), idx + len(query) + 80)
                snippet = full[lo:hi].replace("\n", " ").strip()
            else:
                snippet = full[:160].replace("\n", " ").strip()
            for r in rects:
                hits.append(
                    {
                        "page": i + 1,
                        "snippet": snippet,
                        "bbox": [round(float(x), 2) for x in r],
                    }
                )
                if len(hits) >= max_hits:
                    break
            if len(hits) >= max_hits:
                break
        payload = {
            "ok": True,
            "doc_id": path.name,
            "path": str(path),
            "query": query,
            "hits": hits,
            "count": len(hits),
            "truncated": len(hits) >= max_hits,
            "hint": "Raise --max-hits or narrow the query." if len(hits) >= max_hits else None,
        }
        out(truncate_by_tokens(payload, int(cfg.get("maxOutputTokens") or 12000)))
    finally:
        doc.close()


def cmd_read_pages(
    path: Path,
    pages_spec: str | None,
    pages_list: list[int] | None,
    fmt: str,
    max_tokens: int,
    repo: Path,
    cfg: dict,
) -> None:
    data = get_structured(path, repo, cfg)
    n = data["pages"]
    if pages_list is not None:
        idxs = parse_pages_list(pages_list, n)
    else:
        idxs = parse_pages_1based(pages_spec, n)

    pages_out = []
    for i in idxs:
        page_1 = i + 1
        els = [e for e in data["elements"] if e["page"] == page_1]
        section = els[0].get("section") if els else section_for_page(data["toc"], page_1)
        if fmt == "markdown":
            parts = []
            for e in els:
                if e["type"] == "header":
                    parts.append(f"## {e['text']}")
                elif e["type"] == "table":
                    parts.append(e["text"])
                elif e["type"] == "list":
                    parts.append(e["text"])
                else:
                    parts.append(e["text"])
            text = "\n\n".join(parts)
        else:
            text = "\n\n".join(e["text"] for e in els)
        pages_out.append(
            {
                "page": page_1,
                "section": section,
                "type": "page",
                "text": text,
                "token_estimate": token_estimate(text),
                "elements": [
                    {
                        "type": e["type"],
                        "section": e.get("section"),
                        "text": e["text"],
                        "bbox": e.get("bbox"),
                        "token_estimate": e.get("token_estimate"),
                    }
                    for e in els
                ],
            }
        )

    payload = {
        "ok": True,
        "doc_id": data["doc_id"],
        "path": data["path"],
        "format": fmt,
        "pages": pages_out,
    }
    out(truncate_by_tokens(payload, max_tokens))


def cmd_tables(path: Path, page_1: int, repo: Path, cfg: dict, max_tokens: int) -> None:
    doc = open_doc(path)
    try:
        if page_1 < 1 or page_1 > doc.page_count:
            die(f"page out of range: {page_1} (1..{doc.page_count})")
        page = doc.load_page(page_1 - 1)
        tables = extract_tables_page(page, page_1)
        payload = {
            "ok": True,
            "doc_id": path.name,
            "path": str(path),
            "page": page_1,
            "tables": tables,
            "count": len(tables),
        }
        out(truncate_by_tokens(payload, max_tokens))
    finally:
        doc.close()


def cmd_chunks(
    path: Path,
    pages_spec: str | None,
    repo: Path,
    cfg: dict,
    max_tokens: int,
) -> None:
    data = get_structured(path, repo, cfg)
    n = data["pages"]
    idxs = set(parse_pages_1based(pages_spec, n)) if pages_spec else None
    elements = data["elements"]
    if idxs is not None:
        elements = [e for e in elements if (e["page"] - 1) in idxs]
    chunks = chunk_elements(data["doc_id"], elements, cfg)
    payload = {
        "ok": True,
        "doc_id": data["doc_id"],
        "path": data["path"],
        "chunks": chunks,
        "count": len(chunks),
    }
    out(truncate_by_tokens(payload, max_tokens))


def cmd_render(path: Path, page_1: int, out_path: Path, dpi: float, repo: Path, write_roots: list[str]) -> None:
    parent = out_path.parent.resolve()
    if not under_roots(parent, write_roots, repo):
        die(f"output outside allowlist: {out_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = open_doc(path)
    try:
        if page_1 < 1 or page_1 > doc.page_count:
            die(f"page out of range: {page_1} (1..{doc.page_count})")
        pix = doc.load_page(page_1 - 1).get_pixmap(dpi=dpi)
        pix.save(str(out_path))
        out(
            {
                "ok": True,
                "doc_id": path.name,
                "path": str(path),
                "page": page_1,
                "out": str(out_path.resolve()),
                "dpi": dpi,
                "width": pix.width,
                "height": pix.height,
            }
        )
    finally:
        doc.close()


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    cfg = load_cfg(repo)
    read_roots = cfg.get("allowReadRoots") or ["."]
    write_roots = cfg.get("allowWriteRoots") or [".", "build"]
    default_max = int(cfg.get("maxOutputTokens") or 12000)

    ap = argparse.ArgumentParser(prog="pdf_tool.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check")

    p_info = sub.add_parser("info")
    p_info.add_argument("pdf")
    p_info.add_argument("--no-cache", action="store_true")

    p_search = sub.add_parser("search")
    p_search.add_argument("pdf")
    p_search.add_argument("query")
    p_search.add_argument("--max-hits", type=int, default=40)
    p_search.add_argument("--max-tokens", type=int, default=default_max)

    p_read = sub.add_parser("read-pages", aliases=["text"])
    p_read.add_argument("pdf")
    p_read.add_argument(
        "--pages",
        help="1-based pages, e.g. 3-7 or 3,4,5 (default: all — may truncate)",
    )
    p_read.add_argument("--format", choices=["text", "markdown"], default="markdown")
    p_read.add_argument("--max-tokens", type=int, default=default_max)

    p_tables = sub.add_parser("tables")
    p_tables.add_argument("pdf")
    p_tables.add_argument("--page", type=int, required=True, help="1-based page")
    p_tables.add_argument("--max-tokens", type=int, default=default_max)

    p_chunks = sub.add_parser("chunks")
    p_chunks.add_argument("pdf")
    p_chunks.add_argument("--pages", help="optional 1-based page filter")
    p_chunks.add_argument("--max-tokens", type=int, default=default_max)
    p_chunks.add_argument("--no-cache", action="store_true")

    p_render = sub.add_parser("render")
    p_render.add_argument("pdf")
    p_render.add_argument("--page", type=int, default=1, help="1-based page")
    p_render.add_argument("--out", required=True)
    p_render.add_argument("--dpi", type=float, default=144.0)

    args = ap.parse_args()

    if args.cmd == "check":
        cmd_check()
        return

    pdf = resolve_in(args.pdf, read_roots, repo, must_exist=True)

    if args.cmd == "info":
        if args.no_cache:
            # bust by rebuilding without read
            digest = file_sha256(pdf)
            cpath = cache_path(repo, cfg, digest, "structured.json")
            if cpath.exists():
                cpath.unlink()
        cmd_info(pdf, repo, cfg)
    elif args.cmd == "search":
        cmd_search(pdf, args.query, args.max_hits, cfg, repo)
    elif args.cmd in ("read-pages", "text"):
        cmd_read_pages(
            pdf,
            args.pages,
            None,
            args.format,
            args.max_tokens,
            repo,
            cfg,
        )
    elif args.cmd == "tables":
        cmd_tables(pdf, args.page, repo, cfg, args.max_tokens)
    elif args.cmd == "chunks":
        if args.no_cache:
            digest = file_sha256(pdf)
            cpath = cache_path(repo, cfg, digest, "structured.json")
            if cpath.exists():
                cpath.unlink()
        cmd_chunks(pdf, args.pages, repo, cfg, args.max_tokens)
    elif args.cmd == "render":
        outp = Path(args.out).expanduser()
        outp = (Path.cwd() / outp).resolve() if not outp.is_absolute() else outp.resolve()
        cmd_render(pdf, args.page, outp, args.dpi, repo, write_roots)
    else:
        die(f"unknown cmd: {args.cmd}")


if __name__ == "__main__":
    main()
