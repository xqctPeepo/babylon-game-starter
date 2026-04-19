#!/usr/bin/env python3
"""
Rename first-party .ts modules under src/ to Google snake_case and rewrite
relative import specifiers. Run from repo root: python3 scripts/rename_modules_snake_case.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


def to_snake_stem(stem: str) -> str:
    s = stem.replace("-", "_")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", s)
    return s.lower()


def norm_join(base: str, spec: str) -> str:
    return PurePosixPath(os.path.normpath(PurePosixPath(base) / spec)).as_posix()


def rel_between(from_dir: str, to_file_no_ext: str) -> str:
    rel = PurePosixPath(
        os.path.relpath(PurePosixPath(to_file_no_ext), PurePosixPath(from_dir))
    ).as_posix()
    if not rel.startswith(".") and rel != "":
        rel = "./" + rel
    return rel


FROM_RE = re.compile(r"\bfrom\s+(['\"])(?P<spec>\.[^'\"]+)\1")
IMPORT_CALL_RE = re.compile(r"\bimport\s*\(\s*(['\"])(?P<spec>\.[^'\"]+)\1\s*\)")


def rewrite_typescript(rel_file: str, text: str, rel_map: dict[str, str]) -> str:
    from_dir = str(PurePosixPath(rel_file).parent)

    def repl_from(m: re.Match[str]) -> str:
        spec = m.group("spec")
        q = m.group(1)
        base = norm_join(from_dir, spec)
        if base.endswith(".ts"):
            base = base[:-3]
        if base not in rel_map:
            return m.group(0)
        new_spec = rel_between(from_dir, rel_map[base])
        return m.string[m.start() : m.start(1)] + q + new_spec + q

    text = FROM_RE.sub(repl_from, text)
    text = IMPORT_CALL_RE.sub(repl_from, text)
    return text


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    src = repo / "src"

    moves: list[tuple[Path, Path]] = []
    for path in sorted(src.rglob("*.ts")):
        if path.name.endswith(".d.ts"):
            continue
        new_stem = to_snake_stem(path.stem)
        new_path = path.with_name(f"{new_stem}.ts")
        if new_path != path:
            moves.append((path, new_path))

    for old, new in moves:
        new.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "mv", str(old), str(new)], cwd=repo, check=True)

    rel_map: dict[str, str] = {}
    for old, new in moves:
        old_rel = old.relative_to(src).as_posix()[:-3]
        new_rel = new.relative_to(src).as_posix()[:-3]
        rel_map[old_rel] = new_rel

    exts = {".ts", ".tsx", ".js", ".mjs", ".html", ".json"}
    skip_dirs = {"node_modules", "dist", ".git"}

    for path in sorted(repo.rglob("*")):
        if path.is_dir():
            continue
        if any(p in skip_dirs for p in path.parts):
            continue
        if path.suffix.lower() not in exts:
            continue
        if path.resolve() == Path(__file__).resolve():
            continue

        raw = path.read_text(encoding="utf-8")

        try:
            rel = path.relative_to(src).as_posix()
            if path.suffix in {".ts", ".tsx"}:
                updated = rewrite_typescript(rel, raw, rel_map)
            else:
                updated = raw
                for old_rel, new_rel in sorted(rel_map.items(), key=lambda x: -len(x[0])):
                    updated = updated.replace(old_rel + ".ts", new_rel + ".ts")
                    updated = updated.replace("/" + old_rel + ".ts", "/" + new_rel + ".ts")
        except ValueError:
            updated = raw
            for old_rel, new_rel in sorted(rel_map.items(), key=lambda x: -len(x[0])):
                updated = updated.replace(old_rel, new_rel)
                updated = updated.replace(old_rel + ".ts", new_rel + ".ts")

        if updated != raw:
            path.write_text(updated, encoding="utf-8", newline="\n")

    print(f"Renamed {len(moves)} module(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
