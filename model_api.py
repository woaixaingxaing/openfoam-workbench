#!/usr/bin/env python3
"""Flow-3D style model-setup backend for the OpenFOAM workbench.

The module is deliberately independent from the HTTP server.  ``openfoam_gui``
injects the few helpers it needs through :func:`configure`, which keeps this
file testable on its own and avoids a circular import.
"""

from __future__ import annotations

import math
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

_DEPS = {}


def configure(**deps):
    _DEPS.update(deps)


def _dep(name):
    return _DEPS[name]


def _err(message, status=400, detail=None):
    return _dep("ApiError")(message, detail=detail, status=status)


def _case(name):
    return _dep("resolve_case")(name)


def _read(path, limit=None):
    return _dep("read_text")(path, limit=limit)


def _now():
    return _dep("now_iso")()


def _foam(case, inner, timeout=90):
    return _dep("foam_run")(case, inner, timeout=timeout)


def _running(name):
    return _dep("running_map")().get(name)


def _base():
    return _dep("BASE")


def _case_re():
    return _dep("CASE_RE")


def _num(value):
    if isinstance(value, list):
        if len(value) == 1:
            return _num(value[0])
        for item in reversed(value):
            n = _num(item)
            if n is not None:
                return n
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _word(value):
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(_word(x) for x in value)
    return str(value).strip().strip('"')


def _fmt_value(value):
    if value is None:
        return ""
    if isinstance(value, list):
        if len(value) == 2 and _word(value[0]) in ("uniform", "nonuniform"):
            inner = value[1]
            if isinstance(inner, list):
                return f"{_word(value[0])} ({' '.join(_word(x) for x in inner)})"
            return f"{_word(value[0])} {_word(inner)}"
        return "(" + " ".join(_fmt_value(x) if isinstance(x, list) else _word(x) for x in value) + ")"
    return str(value)


def _vec(value):
    if isinstance(value, list):
        if len(value) == 2 and _word(value[0]) in ("uniform", "nonuniform"):
            return _vec(value[1])
        nums = [_num(x) for x in value]
        if len(nums) == 3 and all(n is not None for n in nums):
            return [float(n) for n in nums]
    if isinstance(value, str):
        nums = re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", value)
        if len(nums) >= 3:
            return [float(x) for x in nums[:3]]
    return None


# --------------------------------------------------------------------------- #
# OpenFOAM dictionary reader
# --------------------------------------------------------------------------- #

def _strip_comments(text):
    out = []
    i = 0
    n = len(text)
    quote = None
    while i < n:
        ch = text[i]
        if quote:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ('"', "'"):
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "/":
                j = text.find("\n", i)
                if j < 0:
                    break
                i = j
                continue
            if nxt == "*":
                j = text.find("*/", i + 2)
                if j < 0:
                    break
                i = j + 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _clean(text):
    text = _strip_comments(text)
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


_TOKEN_RE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}();]|[^\s{}();]+')


class _Parser:
    def __init__(self, text):
        self.tokens = _TOKEN_RE.findall(_clean(text))
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def pop(self):
        tok = self.peek()
        if tok is not None:
            self.i += 1
        return tok

    def parse(self):
        return self._dict()

    def _dict(self):
        out = {}
        while self.i < len(self.tokens):
            key = self.pop()
            if key == "}":
                break
            if key in (";", "{", "(", ")"):
                continue
            nxt = self.peek()
            if nxt == "{":
                self.pop()
                out[key] = self._dict()
                if self.peek() == ";":
                    self.pop()
            elif nxt == "(":
                out[key] = self._list()
                if self.peek() == ";":
                    self.pop()
            else:
                parts = []
                while self.i < len(self.tokens) and self.peek() not in (";", "}"):
                    tok = self.peek()
                    if tok == "(":
                        parts.append(self._list())
                    elif tok == "{":
                        self.pop()
                        self._dict()
                    else:
                        parts.append(self.pop())
                if self.peek() == ";":
                    self.pop()
                if len(parts) == 1:
                    out[key] = parts[0]
                elif parts:
                    out[key] = parts
        return out

    def _list(self):
        self.pop()
        items = []
        while self.i < len(self.tokens):
            tok = self.peek()
            if tok == ")":
                self.pop()
                break
            if tok == "(":
                items.append(self._list())
            elif tok == "{":
                self.pop()
                items.append(self._dict())
            else:
                items.append(self.pop())
        return items


def parse_dict_text(text):
    return _Parser(text).parse()


# --------------------------------------------------------------------------- #
# blockMesh / polyMesh
# --------------------------------------------------------------------------- #

def _balanced(text, open_pos, open_ch="(", close_ch=")"):
    depth = 0
    i = open_pos
    while i < len(text):
        ch = text[i]
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[open_pos + 1:i], i
        i += 1
    return text[open_pos + 1:], len(text) - 1


def _top_groups(body):
    out = []
    depth = 0
    start = None
    for i, ch in enumerate(body):
        if ch == "(":
            if depth == 0:
                start = i
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and start is not None:
                out.append(body[start:i + 1])
                start = None
    return out


def _numbers(text):
    return [float(x) for x in re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", text)]


def _ints(text):
    return [int(x) for x in re.findall(r"[-+]?\d+", text)]


def _parse_blockmesh(text):
    text = _clean(text)
    vertices = []
    blocks = []
    boundary = []
    m = re.search(r"\bvertices\s*\(", text)
    if m:
        body, _ = _balanced(text, m.end() - 1)
        for group in _top_groups(body):
            nums = _numbers(group)
            if len(nums) >= 3:
                vertices.append([round(x, 9) for x in nums[:3]])
    m = re.search(r"\bblocks\s*\(", text)
    if m:
        body, _ = _balanced(text, m.end() - 1)
        for bm in re.finditer(r"\b(hex|tet|wedge|prism|pyramid)\s*\(([^)]*)\)\s*\(([^)]*)\)", body):
            verts = _ints(bm.group(2))
            cells = _ints(bm.group(3))
            blocks.append({"type": bm.group(1), "vertices": verts, "cells": cells})
    m = re.search(r"\bboundary\s*\(", text)
    if m:
        body, _ = _balanced(text, m.end() - 1)
        for pm in re.finditer(r"([A-Za-z_][\w.-]*)\s*\{([^{}]*)\}", body):
            name = pm.group(1)
            if name == "defaultPatch":
                continue
            block = pm.group(2)
            typ = re.search(r"\btype\s+([A-Za-z_][\w]*)\s*;", block)
            faces = []
            fm = re.search(r"\bfaces\s*\(", block)
            if fm:
                fbody, _ = _balanced(block, fm.end() - 1)
                for face in re.finditer(r"\(([^()]*)\)", fbody):
                    idx = _ints(face.group(1))
                    if idx:
                        faces.append(idx)
            boundary.append({"name": name, "type": typ.group(1) if typ else "patch", "faces": faces})
    return vertices, blocks, boundary


def _poly_patches(case):
    path = case / "constant" / "polyMesh" / "boundary"
    if not path.is_file():
        return []
    text = _clean(_read(path, limit=400000))
    m = re.search(r"\bboundary\s*\(", text)
    if m:
        body, _ = _balanced(text, m.end() - 1)
    else:
        # OpenFOAM 14 writes a bare "6 ( patch {...} ... )" list.
        fm = re.search(r"\bFoamFile\s*\{", text)
        start = 0
        if fm:
            _, fend = _balanced(text, fm.end() - 1, "{", "}")
            start = fend + 1
        lm = re.search(r"\b\d+\s*\(", text[start:])
        if not lm:
            return []
        body, _ = _balanced(text, start + lm.end() - 1)
    out = []
    for pm in re.finditer(r"([A-Za-z_][\w.-]*)\s*\{([^{}]*)\}", body):
        name = pm.group(1)
        if name in ("FoamFile", "defaultPatch"):
            continue
        block = pm.group(2)
        typ = re.search(r"\btype\s+([A-Za-z_][\w]*)\s*;", block)
        nfaces = re.search(r"\bnFaces\s+(\d+)\s*;", block)
        start = re.search(r"\bstartFace\s+(\d+)\s*;", block)
        out.append({
            "name": name,
            "type": typ.group(1) if typ else "patch",
            "nFaces": int(nfaces.group(1)) if nfaces else None,
            "startFace": int(start.group(1)) if start else None,
        })
    return out


def _poly_meta(case):
    path = case / "constant" / "polyMesh" / "owner"
    if not path.is_file():
        return {}
    head = _read(path, limit=8192)
    m = re.search(r'note\s+"([^"]+)"', head)
    out = {}
    if m:
        for key, pattern in (("nPoints", r"nPoints:\s*(\d+)"), ("nCells", r"nCells:\s*(\d+)"),
                             ("nFaces", r"nFaces:\s*(\d+)"), ("nInternalFaces", r"nInternalFaces:\s*(\d+)")):
            mm = re.search(pattern, m.group(1))
            if mm:
                out[key] = int(mm.group(1))
    return out


_SURFACE_CACHE = {}
_SURFACE_LOCK = threading.Lock()
_SURFACE_SKIP = {"empty", "processor", "processorCyclic", "cyclic", "cyclicAMI", "wedge",
                 "symmetry", "symmetryPlane"}


def _poly_surface(case, budget=1100):
    """Return a light-weight boundary surface for the 3D viewport.

    Full polyMesh files can be several megabytes; only a representative sample
    of each non-internal patch is sent to the browser.  The result is cached by
    file timestamps so switching between cases stays fast.
    """
    pm = case / "constant" / "polyMesh"
    points_path = pm / "points"
    faces_path = pm / "faces"
    boundary_path = pm / "boundary"
    if not (points_path.is_file() and faces_path.is_file() and boundary_path.is_file()):
        return None
    try:
        key = (str(pm), tuple((p.stat().st_mtime_ns, p.stat().st_size)
                              for p in (points_path, faces_path, boundary_path)))
    except OSError:
        return None
    with _SURFACE_LOCK:
        cached = _SURFACE_CACHE.get(key)
    if cached is not None:
        return cached

    points_text = _read(points_path, limit=16_000_000)
    if re.search(r"\bformat\s+binary\s*;", points_text[:4000]):
        return None
    points_text = _clean(points_text)
    m = re.search(r"(?m)^\s*(\d+)\s*$", points_text)
    if not m:
        return None
    start = points_text.find("(", m.end())
    if start < 0:
        return None
    body, _ = _balanced(points_text, start)
    coords = []
    for group in _top_groups(body):
        nums = _numbers(group)
        if len(nums) >= 3:
            coords.append([round(nums[0], 7), round(nums[1], 7), round(nums[2], 7)])
    if not coords:
        return None

    patches = [p for p in _poly_patches(case)
               if p.get("startFace") is not None and p.get("nFaces")
               and (p.get("type") or "").lower() not in _SURFACE_SKIP]
    if not patches:
        return None

    # Allocate a face budget, then pick evenly spaced faces inside each patch.
    total = sum(p["nFaces"] for p in patches)
    if total <= budget:
        take = {p["name"]: p["nFaces"] for p in patches}
    else:
        take = {}
        for p in patches:
            share = max(12, int(budget * p["nFaces"] / total))
            take[p["name"]] = min(p["nFaces"], share)
        while sum(take.values()) > budget * 1.25:
            name = max(take, key=lambda k: take[k])
            if take[name] <= 12:
                break
            take[name] = max(12, int(take[name] * 0.85))

    wanted = {}
    for p in patches:
        n = take[p["name"]]
        if n <= 0:
            continue
        if n >= p["nFaces"]:
            local = range(p["nFaces"])
        else:
            step = p["nFaces"] / n
            local = (int(i * step) for i in range(n))
        for i in local:
            wanted[p["startFace"] + i] = (p["name"], i)

    faces_text = _read(faces_path, limit=32_000_000)
    if re.search(r"\bformat\s+binary\s*;", faces_text[:4000]):
        return None
    faces_text = _clean(faces_text)
    m = re.search(r"(?m)^\s*(\d+)\s*$", faces_text)
    if not m:
        return None
    start = faces_text.find("(", m.end())
    if start < 0:
        return None
    body, _ = _balanced(faces_text, start)
    max_wanted = max(wanted) if wanted else -1

    collected = {}
    index = 0
    for fm in re.finditer(r"(\d+)\s*\(([^()]*)\)", body):
        if index > max_wanted:
            break
        if index in wanted:
            idx = _ints(fm.group(2))
            pts = [coords[i] for i in idx if 0 <= i < len(coords)]
            if len(pts) >= 3:
                collected[index] = pts
        index += 1

    out_patches = []
    for p in patches:
        faces = []
        for i in range(p["nFaces"]):
            pts = collected.get(p["startFace"] + i)
            if pts:
                faces.append(pts)
        if faces:
            out_patches.append({
                "name": p["name"],
                "type": p["type"],
                "nFaces": p["nFaces"],
                "sampled": take[p["name"]] < p["nFaces"],
                "faces": faces,
            })
    if not out_patches:
        return None
    xs = [p[0] for p in coords]
    ys = [p[1] for p in coords]
    zs = [p[2] for p in coords]
    surface = {
        "source": "polyMesh",
        "totalFaces": total,
        "sampled": any(p["sampled"] for p in out_patches),
        "patches": out_patches,
        "bounds": {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
    }
    with _SURFACE_LOCK:
        if len(_SURFACE_CACHE) >= 6:
            for old in list(_SURFACE_CACHE)[:2]:
                _SURFACE_CACHE.pop(old, None)
        _SURFACE_CACHE[key] = surface
    return surface


def _mesh(case):
    candidates = [case / "system" / "blockMeshDict", case / "constant" / "polyMesh" / "blockMeshDict"]
    path = next((p for p in candidates if p.is_file()), None)
    vertices, blocks, boundary = ([], [], [])
    if path:
        vertices, blocks, boundary = _parse_blockmesh(_read(path, limit=1200000))
    patches = _poly_patches(case)
    if not patches:
        patches = [{"name": p["name"], "type": p["type"], "nFaces": None, "startFace": None} for p in boundary]
    bounds = None
    if vertices:
        xs = [v[0] for v in vertices]
        ys = [v[1] for v in vertices]
        zs = [v[2] for v in vertices]
        bounds = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}
    cells = None
    block_total = None
    if blocks:
        counts = []
        total = 0
        for block in blocks:
            if len(block["cells"]) >= 3:
                n = block["cells"][0] * block["cells"][1] * block["cells"][2]
                total += n
                counts.append(block["cells"][:3])
        if counts:
            cells = counts[0] if len(counts) == 1 else None
            block_total = total
    poly = _poly_meta(case)
    surface = _poly_surface(case)
    if surface and surface.get("bounds"):
        bounds = surface["bounds"]
    return {
        "blockMeshFile": str(path.relative_to(case)) if path else None,
        "hasPolyMesh": (case / "constant" / "polyMesh" / "points").is_file(),
        "vertices": vertices,
        "blocks": blocks,
        "boundary": boundary,
        "patches": patches,
        "bounds": bounds,
        "cells": cells,
        "cellTotal": poly.get("nCells") or block_total,
        "blockCellTotal": block_total,
        "polyCells": poly.get("nCells"),
        "polyPoints": poly.get("nPoints"),
        "polyFaces": poly.get("nFaces"),
        "surface": surface,
        "blockCount": len(blocks),
        "vertexCount": len(vertices),
        "singleBlock": len(blocks) == 1,
    }


# --------------------------------------------------------------------------- #
# fields
# --------------------------------------------------------------------------- #

FIELD_ORDER = ["U", "p", "k", "epsilon", "omega", "nut", "nuTilda", "T", "alphat"]


def _field_files(case):
    for folder in (case / "0", case / "0.orig"):
        if folder.is_dir():
            out = []
            for path in sorted(folder.iterdir(), key=lambda p: p.name):
                if not path.is_file() or path.name.startswith("."):
                    continue
                try:
                    head = _read(path, limit=1800)
                except OSError:
                    continue
                if re.search(r"class\s+vol(?:Scalar|Vector|Tensor|SymmTensor|SphericalTensor)Field", head):
                    out.append(path)
            if out:
                return folder, out
    return None, []


def _field_kind(cls):
    if "Vector" in cls:
        return "vector"
    if "Tensor" in cls or "SymmTensor" in cls:
        return "tensor"
    if "SphericalTensor" in cls:
        return "spherical"
    return "scalar"


def _parse_field(path):
    text = _read(path, limit=900000)
    d = parse_dict_text(text)
    foam = d.get("FoamFile") or {}
    cls = _word(foam.get("class"))
    bf = d.get("boundaryField") or {}
    patches = []
    if isinstance(bf, dict):
        for name, value in bf.items():
            if not isinstance(value, dict):
                continue
            extras = {}
            for k, v in value.items():
                if k in ("type", "value", "p0"):
                    continue
                formatted = _fmt_value(v)
                # Nested dictionaries cannot be preserved by the simple
                # "key value;" writer; leave them to the advanced editor.
                if not formatted or any(ch in formatted for ch in ";{}"):
                    continue
                extras[k] = formatted
            patches.append({
                "name": name,
                "type": _word(value.get("type")),
                "value": _fmt_value(value.get("value")) if "value" in value else "",
                "p0": _fmt_value(value.get("p0")) if "p0" in value else "",
                "entries": extras,
            })
    return {
        "name": path.name,
        "class": cls,
        "kind": _field_kind(cls),
        "internal": _fmt_value(d.get("internalField")),
        "patches": patches,
    }


def _fields(case):
    folder, files = _field_files(case)
    out = {}
    for path in files:
        try:
            item = _parse_field(path)
        except Exception:
            continue
        out[item["name"]] = item
    ordered = {}
    for name in FIELD_ORDER:
        if name in out:
            ordered[name] = out[name]
    for name in sorted(out):
        if name not in ordered:
            ordered[name] = out[name]
    return {
        "folder": folder.name if folder else None,
        "list": ordered,
        "patches": sorted({p["name"] for f in ordered.values() for p in f["patches"]}),
    }


# --------------------------------------------------------------------------- #
# model summary
# --------------------------------------------------------------------------- #

SOLVERS = [
    "incompressibleFluid", "compressibleFluid", "multiphaseEuler", "multiphaseVoF",
    "shallowWater", "solidDisplacement", "solidEquilibriumDisplacement",
    "isothermalFluid", "movingMesh", "film", "electrostatic", "potentialFoam",
]

RAS_MODELS = [
    "kEpsilon", "kOmega", "kOmegaSST", "realizableKE", "v2f", "SpalartAllmaras",
    "kkLOmega", "LRR", "SSG", "LaunderSharmaKE",
]

LES_MODELS = [
    "Smagorinsky", "WALE", "kEqn", "dynamicKEqn", "dynamicLagrangian",
    "DeardorffDiffStress", "SpalartAllmarasDDES", "SpalartAllmarasIDDES",
]

VISCOSITY_MODELS = ["constant", "Newtonian"]


def _control(case):
    text = _read(case / "system" / "controlDict", limit=600000)
    d = parse_dict_text(text)
    out = {}
    for key in (
        "solver", "application", "startFrom", "startTime", "stopAt", "endTime",
        "deltaT", "adjustTimeStep", "maxCo", "maxDeltaT", "writeControl",
        "writeInterval", "purgeWrite", "writeFormat", "writeCompression",
        "runTimeModifiable",
    ):
        out[key] = _fmt_value(d.get(key))
    out["solver"] = _word(d.get("solver") or d.get("application"))
    for key in ("startTime", "endTime", "deltaT", "maxCo", "maxDeltaT", "writeInterval", "purgeWrite"):
        out[key + "Num"] = _num(d.get(key))
    out["functions"] = d.get("functions") if isinstance(d.get("functions"), dict) else {}
    return out


def _physics(case):
    path = case / "constant" / "momentumTransport"
    if not path.is_file():
        path = case / "constant" / "turbulenceProperties"
    d = parse_dict_text(_read(path, limit=300000)) if path.is_file() else {}
    sim = _word(d.get("simulationType") or "laminar")
    model = ""
    block = d.get(sim) if sim in ("RAS", "LES") else None
    if isinstance(block, dict):
        model = _word(block.get("model"))
    solver = _control(case)["solver"]
    solver_l = solver.lower()
    compressible = solver_l.startswith("compressible") or (
        "compressible" in solver_l and "incompressible" not in solver_l
    )
    if isinstance(d.get("thermoType"), dict):
        compressible = True
    fields = _fields(case)["list"]
    heat = "T" in fields or isinstance(d.get("thermoType"), dict)
    g = parse_dict_text(_read(case / "constant" / "g", limit=20000)) if (case / "constant" / "g").is_file() else {}
    return {
        "simulationType": sim or "laminar",
        "model": model,
        "turbulence": _word((block or {}).get("turbulence")) if isinstance(block, dict) else "",
        "printCoeffs": _word((block or {}).get("printCoeffs")) if isinstance(block, dict) else "",
        "compressible": compressible,
        "heat": heat,
        "gravity": _vec(g.get("value")) or [0.0, 0.0, 0.0],
        "file": str(path.relative_to(case)) if path.is_file() else None,
    }


def _fluid(case):
    path = None
    for name in ("physicalProperties", "transportProperties"):
        candidate = case / "constant" / name
        if candidate.is_file():
            path = candidate
            break
    d = parse_dict_text(_read(path, limit=300000)) if path else {}
    return {
        "file": str(path.relative_to(case)) if path else None,
        "viscosityModel": _word(d.get("viscosityModel") or d.get("transportModel") or "constant"),
        "nu": _num(d.get("nu")),
        "rho": _num(d.get("rho")),
        "hasRho": "rho" in d,
        "thermoType": isinstance(d.get("thermoType"), dict),
    }


def _section_entries(text, section):
    m = re.search(r"\b" + re.escape(section) + r"\s*\{", text)
    if not m:
        return {}
    body, _ = _balanced(text, m.end() - 1, "{", "}")
    out = {}
    for chunk in body.split(";"):
        chunk = re.sub(r"\s+", " ", chunk).strip()
        if not chunk or chunk.startswith("//"):
            continue
        mm = re.match(r"^(\S+)\s+(.+)$", chunk)
        if mm and not mm.group(1).startswith("#") and not mm.group(2).startswith("#"):
            out[mm.group(1)] = mm.group(2).strip()
    return out


def _schemes(case):
    path = case / "system" / "fvSchemes"
    if not path.is_file():
        return {}
    text = _clean(_read(path, limit=500000))
    out = {}
    for section in ("ddtSchemes", "gradSchemes", "divSchemes", "laplacianSchemes",
                    "interpolationSchemes", "snGradSchemes", "fluxRequired"):
        entries = _section_entries(text, section)
        if entries:
            out[section] = entries
    return out


def _solution(case):
    path = case / "system" / "fvSolution"
    if not path.is_file():
        return {}
    d = parse_dict_text(_read(path, limit=500000))
    out = {}
    for section in ("solvers", "PIMPLE", "SIMPLE", "PISO", "relaxationFactors"):
        block = d.get(section)
        if isinstance(block, dict):
            out[section] = {
                k: ({kk: _fmt_value(vv) for kk, vv in v.items()} if isinstance(v, dict) else _fmt_value(v))
                for k, v in block.items()
            }
    return out


def _ranks(case):
    path = case / "system" / "decomposeParDict"
    if not path.is_file():
        return 1
    m = re.search(r"(?m)^\s*numberOfSubdomains\s+(\d+)\s*;", _read(path, limit=100000))
    return int(m.group(1)) if m else 1


def _functions(case):
    functions = _control(case).get("functions") or {}
    out = []
    for name, value in functions.items():
        if not isinstance(value, dict):
            continue
        item = {"name": name, "type": _word(value.get("type"))}
        if item["type"] == "forceCoeffs":
            item["patches"] = [_word(x) for x in (value.get("patches") or [])] if isinstance(value.get("patches"), list) else []
            item["Aref"] = _num(value.get("Aref"))
            item["rhoInf"] = _num(value.get("rhoInf"))
            item["magUInf"] = _num(value.get("magUInf"))
            item["lRef"] = _num(value.get("lRef"))
        out.append(item)
    return out


def api_model(name):
    case = _case(name)
    control = _control(case)
    physics = _physics(case)
    fluid = _fluid(case)
    mesh = _mesh(case)
    fields = _fields(case)
    schemes = _schemes(case)
    solution = _solution(case)
    functions = _functions(case)
    info = _running(case.name)
    warnings = []
    if not mesh["blockMeshFile"]:
        warnings.append("没有 blockMeshDict，3D 视图只能显示已有网格的边界信息。")
    if mesh["blockCount"] > 1:
        warnings.append("多块网格：单元格数量请在“高级字典”中修改 blockMeshDict。")
    if physics["compressible"]:
        warnings.append("可压缩算例的热物性（thermoType）结构较复杂，建议在“高级字典”中核对。")
    if not fields["list"]:
        warnings.append("未找到 0/ 下的体积场文件。")
    return {
        "name": case.name,
        "path": str(case),
        "solver": control["solver"],
        "solverOptions": SOLVERS,
        "control": control,
        "physics": physics,
        "fluid": fluid,
        "mesh": mesh,
        "fields": fields,
        "schemes": schemes,
        "solution": solution,
        "functions": functions,
        "run": {
            "ranks": _ranks(case),
            "running": bool(info),
            "pids": info["pids"] if info else [],
            "state": "running" if info else "ready",
        },
        "rasModels": RAS_MODELS,
        "lesModels": LES_MODELS,
        "viscosityModels": VISCOSITY_MODELS,
        "warnings": warnings,
        "updated": _now(),
    }


# --------------------------------------------------------------------------- #
# validation / write helpers
# --------------------------------------------------------------------------- #

_WORD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.+-]*$")
_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")


def _need_word(value, label):
    value = (value or "").strip()
    if not _WORD_RE.match(value):
        raise _err(f"{label} 名称不合法")
    return value


def _need_num(value, label, minimum=None, maximum=None):
    n = _num(value)
    if n is None or not math.isfinite(n):
        raise _err(f"{label} 需要数字")
    if minimum is not None and n < minimum:
        raise _err(f"{label} 必须 ≥ {minimum:g}")
    if maximum is not None and n > maximum:
        raise _err(f"{label} 必须 ≤ {maximum:g}")
    return n


def _safe_value(value, label="数值"):
    text = str(value).strip()
    if any(ch in text for ch in ";{}"):
        raise _err(f"{label} 含有非法字符")
    return text


def _ensure_not_running(case):
    if _running(case.name):
        raise _err("算例正在运行，请先停止再修改设置")


def _foam_set(case, rel, entries, timeout=180):
    cmds = []
    for entry, value in entries:
        cmds.append(
            f"foamDictionary {shlex.quote(rel)} -entry {shlex.quote(entry)} -set {shlex.quote(str(value))}"
        )
    if not cmds:
        return
    res = _foam(case, " && ".join(cmds), timeout=timeout)
    out = (res.stdout or "") + (res.stderr or "")
    if res.returncode != 0 or "FOAM FATAL" in out:
        raise _err("写入 OpenFOAM 字典失败", detail=out[-1400:])


def _backup(path):
    if not path.is_file():
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = path.with_name(path.name + f".bak-gui-{stamp}")
    try:
        shutil.copy2(path, target)
    except OSError:
        return None
    return target


def _write_text(path, text):
    _backup(path)
    tmp = path.with_name(path.name + ".tmp-gui")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _fmt_number(n):
    if abs(n - round(n)) < 1e-12:
        return str(int(round(n)))
    return f"{n:.12g}"


def _fmt_scalar(n):
    return _fmt_number(float(n))


def _fmt_vector(v):
    return "(" + " ".join(_fmt_number(float(x)) for x in v) + ")"


def _check_scheme_value(value, label):
    text = str(value).strip()
    if not text or any(ch in text for ch in ";{}"):
        raise _err(f"{label} 不是有效的格式")
    return text


# --------------------------------------------------------------------------- #
# section writers
# --------------------------------------------------------------------------- #

def _set_general(case, values):
    control = _control(case)
    entries = []
    solver = values.get("solver")
    if solver is not None:
        solver = _need_word(solver, "求解器")
        if solver not in SOLVERS:
            # Allow newer solver names, but only as a single OpenFOAM word.
            solver = _need_word(solver, "求解器")
        entries.append(("solver", solver))
        if control.get("application"):
            entries.append(("application", solver))
    start = values.get("startTime")
    end = values.get("endTime")
    if start is not None:
        start = _need_num(start, "起始时间", minimum=0)
        entries.append(("startTime", _fmt_scalar(start)))
    if end is not None:
        end = _need_num(end, "结束时间", minimum=0)
        entries.append(("endTime", _fmt_scalar(end)))
    if start is not None and end is not None and end <= start:
        raise _err("结束时间必须大于起始时间")
    if values.get("deltaT") is not None:
        entries.append(("deltaT", _fmt_scalar(_need_num(values["deltaT"], "时间步长", minimum=1e-12))))
    if values.get("maxCo") is not None:
        entries.append(("maxCo", _fmt_scalar(_need_num(values["maxCo"], "最大库朗数", minimum=1e-6))))
    if values.get("maxDeltaT") is not None:
        entries.append(("maxDeltaT", _fmt_scalar(_need_num(values["maxDeltaT"], "最大时间步", minimum=1e-12))))
    if values.get("adjustTimeStep") is not None:
        entries.append(("adjustTimeStep", "yes" if str(values["adjustTimeStep"]) in ("yes", "true", "1", "on") else "no"))
    if values.get("startFrom") is not None:
        start_from = str(values["startFrom"])
        if start_from not in ("startTime", "firstTime", "latestTime"):
            raise _err("起始方式不合法")
        entries.append(("startFrom", start_from))
    if values.get("stopAt") is not None:
        stop_at = str(values["stopAt"])
        if stop_at not in ("endTime", "writeNow", "noWriteNow", "nextWrite"):
            raise _err("停止条件不合法")
        entries.append(("stopAt", stop_at))
    _foam_set(case, "system/controlDict", entries)


def _ensure_momentum_transport(case):
    path = case / "constant" / "momentumTransport"
    if path.is_file():
        return path
    path.write_text(
        "/*--------------------------------*- C++ -*----------------------------------*\\\n"
        "| =========                 |                                                 |\n"
        "| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |\n"
        "|  \\\\    /   O peration     | Website:  https://openfoam.org                  |\n"
        "|   \\\\  /    A nd           | Version:  14                                   |\n"
        "|    \\\\/     M anipulation  |                                                 |\n"
        "\\*---------------------------------------------------------------------------*/\n"
        "FoamFile\n"
        "{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        "    class       dictionary;\n"
        "    location    \"constant\";\n"
        "    object      momentumTransport;\n"
        "}\n\n"
        "simulationType  laminar;\n\n"
        "// ************************************************************************* //\n",
        encoding="utf-8",
    )
    return path


def _ensure_wall_dist(case):
    path = case / "system" / "fvSchemes"
    if not path.is_file():
        return
    text = _read(path, limit=500000)
    if re.search(r"\bwallDist\s*\{", text):
        return
    block = "\nwallDist\n{\n    method          meshWave;\n}\n"
    marker = "// ************************************************************************* //"
    if marker in text:
        text = text.replace(marker, block + "\n" + marker, 1)
    else:
        text = text.rstrip() + "\n" + block
    _write_text(path, text)


def _set_physics(case, values):
    sim = str(values.get("simulationType") or "laminar")
    if sim not in ("laminar", "RAS", "LES"):
        raise _err("物理模型只能是 laminar、RAS 或 LES")
    model = values.get("model")
    if sim in ("RAS", "LES"):
        if not model:
            model = "kOmegaSST" if sim == "RAS" else "Smagorinsky"
        model = _need_word(model, "湍流模型")
        allowed = RAS_MODELS if sim == "RAS" else LES_MODELS
        if model not in allowed:
            raise _err(f"{sim} 模型不支持：{model}")
    path = _ensure_momentum_transport(case)
    text = _read(path, limit=300000)
    d = parse_dict_text(text)
    entries = [("simulationType", sim)]
    if sim in ("RAS", "LES"):
        block = d.get(sim)
        if not isinstance(block, dict):
            # foamDictionary can create a dictionary entry from a literal block.
            literal = "{ model %s; turbulence on; printCoeffs on; }" % model
            _foam_set(case, "constant/momentumTransport", [("simulationType", sim), (sim, literal)])
        else:
            entries.append((f"{sim}/model", model))
            entries.append((f"{sim}/turbulence", "on"))
            entries.append((f"{sim}/printCoeffs", "on"))
    _foam_set(case, "constant/momentumTransport", entries)
    if sim in ("RAS", "LES"):
        _ensure_wall_dist(case)

    gravity = values.get("gravity")
    if gravity is not None:
        if not isinstance(gravity, list) or len(gravity) != 3:
            raise _err("重力需要三个分量")
        gv = [_need_num(x, "重力分量") for x in gravity]
        gpath = case / "constant" / "g"
        if not gpath.is_file():
            gpath.write_text(
                "/*--------------------------------*- C++ -*----------------------------------*\\\n"
                "| =========                 |                                                 |\n"
                "| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |\n"
                "|  \\\\    /   O peration     | Website:  https://openfoam.org                  |\n"
                "|   \\\\  /    A nd           | Version:  14                                   |\n"
                "|    \\\\/     M anipulation  |                                                 |\n"
                "\\*---------------------------------------------------------------------------*/\n"
                "FoamFile\n"
                "{\n"
                "    version     2.0;\n"
                "    format      ascii;\n"
                "    class       uniformDimensionedVectorField;\n"
                "    location    \"constant\";\n"
                "    object      g;\n"
                "}\n\n"
                "dimensions      [0 1 -2 0 0 0 0];\n"
                "value           (0 -9.81 0);\n\n"
                "// ************************************************************************* //\n",
                encoding="utf-8",
            )
        _foam_set(case, "constant/g", [("value", _fmt_vector(gv))])


def _set_fluid(case, values):
    path = None
    for name in ("physicalProperties", "transportProperties"):
        candidate = case / "constant" / name
        if candidate.is_file():
            path = candidate
            break
    if path is None:
        raise _err("找不到 constant/physicalProperties 或 transportProperties")
    entries = []
    if values.get("nu") is not None:
        entries.append(("nu", _fmt_scalar(_need_num(values["nu"], "运动黏度", minimum=1e-15))))
    if values.get("rho") is not None:
        entries.append(("rho", _fmt_scalar(_need_num(values["rho"], "密度", minimum=1e-12))))
    if values.get("viscosityModel") is not None:
        vm = str(values["viscosityModel"])
        if vm not in VISCOSITY_MODELS:
            raise _err("黏度模型目前支持 constant / Newtonian")
        entries.append(("viscosityModel", vm))
    _foam_set(case, str(path.relative_to(case)), entries)
    if values.get("rho") is not None:
        control = _control(case)
        if isinstance(control.get("functions"), dict) and "forceCoeffs" in control["functions"]:
            _foam_set(case, "system/controlDict", [("functions/forceCoeffs/rhoInf", _fmt_scalar(float(values["rho"])))])


def _set_initial(case, values):
    fields = values.get("fields") or {}
    if not isinstance(fields, dict):
        raise _err("初始条件格式不正确")
    folder, files = _field_files(case)
    if not folder or folder.name != "0":
        raise _err("没有 0/ 目录，无法修改初始条件")
    known = {p.name: p for p in files}
    for name, value in fields.items():
        if name not in known:
            raise _err(f"字段不存在：{name}")
        info = _parse_field(known[name])
        if info["kind"] == "vector":
            vec = _vec(value) if not isinstance(value, str) else _vec(value)
            if vec is None:
                nums = _numbers(str(value))
                if len(nums) != 3:
                    raise _err(f"{name} 需要三个分量")
                vec = nums
            text = f"uniform {_fmt_vector(vec)}"
        elif info["kind"] == "scalar":
            text = f"uniform {_fmt_scalar(_need_num(value, name))}"
        else:
            text = _safe_value(value, name)
            if not text.startswith(("uniform", "nonuniform")):
                text = f"uniform {text}"
        _foam_set(case, f"0/{name}", [("internalField", text)])


NO_VALUE_BC = {
    "zeroGradient", "slip", "noSlip", "empty", "symmetry", "symmetryPlane",
    "wedge", "cyclic", "cyclicAMI", "processor", "processorCyclic", "calculated",
    "fixedFluxPressure", "fixedGradient", "uniformFixedValue",
}
VALUE_BC = {
    "fixedValue", "inletOutlet", "outletInlet", "pressureInletOutletVelocity",
    "pressureInletUniformVelocity", "flowRateInletVelocity", "surfaceNormalFixedValue",
    "movingWallVelocity", "rotatingWallVelocity", "translatingWallVelocity",
    "totalPressure", "totalTemperature", "uniformTotalPressure", "advective",
    "waveTransmissive", "timeVaryingMappedFixedValue", "uniformInletOutlet",
    "kqRWallFunction", "epsilonWallFunction", "omegaWallFunction", "nutkWallFunction",
    "nutUWallFunction", "nutUSpaldingWallFunction", "nutLowReWallFunction",
    "alphatWallFunction", "temperatureCoupledBase", "externalWallHeatFluxTemperature",
}


def _patch_block(name, typ, value, p0, extra, indent="    "):
    lines = [f"{indent}{name}", f"{indent}{{"]
    lines.append(f"{indent}    type            {typ};")
    if typ == "totalPressure":
        if not p0:
            raise _err(f"{name}: totalPressure 需要 p0")
        lines.append(f"{indent}    p0              {p0};")
    elif typ not in NO_VALUE_BC:
        if not value:
            raise _err(f"{name}: {typ} 需要 value")
        lines.append(f"{indent}    value           {value};")
    for key, val in (extra or {}).items():
        try:
            key = _need_word(key, "边界附加项")
            text_value = _safe_value(val, key)
        except ApiError:
            # Keep going: a nested dictionary or malformed legacy entry is
            # better skipped than blocking the whole save.
            continue
        lines.append(f"{indent}    {key:<15} {text_value};")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def _rewrite_patch(text, patch, block):
    m = re.search(r"\bboundaryField\s*\{", text)
    if not m:
        raise _err("字段文件没有 boundaryField")
    body, end = _balanced(text, m.end() - 1, "{", "}")
    pm = re.search(r"(?m)^([ \t]*)" + re.escape(patch) + r"\s*\{", body)
    if pm:
        pstart = pm.start()
        pbody, pend = _balanced(body, pm.end() - 1, "{", "}")
        new_body = body[:pstart] + block + body[pend + 1:]
    else:
        # Insert before the closing brace of boundaryField.
        new_body = body.rstrip() + "\n\n" + block + "\n"
    return text[:m.end() - 1] + "{" + new_body + "}" + text[end + 1:]


def _set_boundary(case, values):
    field = values.get("field")
    patches = values.get("patches") or []
    if not field or not isinstance(patches, list):
        raise _err("边界条件格式不正确")
    path = case / "0" / field
    if not path.is_file():
        raise _err(f"字段文件不存在：0/{field}")
    info = _parse_field(path)
    known = {p["name"] for p in info["patches"]}
    text = _read(path, limit=900000)
    for item in patches:
        if not isinstance(item, dict):
            continue
        name = item.get("patch")
        if name not in known:
            raise _err(f"边界不存在：{name}")
        typ = _need_word(item.get("type"), "边界类型")
        if typ not in NO_VALUE_BC and typ not in VALUE_BC:
            raise _err(f"不支持的边界类型：{typ}")
        raw_value = item.get("value")
        if info["kind"] == "vector" and typ not in NO_VALUE_BC:
            vec = _vec(raw_value)
            if vec is None:
                raise _err(f"{name}: 速度边界需要三个分量")
            value = f"uniform {_fmt_vector(vec)}"
        elif info["kind"] == "scalar" and typ not in NO_VALUE_BC:
            value = f"uniform {_fmt_scalar(_need_num(raw_value, name))}"
        else:
            value = _safe_value(raw_value) if raw_value else ""
            if value and not value.startswith(("uniform", "nonuniform", "(")):
                value = f"uniform {value}"
        p0 = item.get("p0")
        if p0:
            p0 = _safe_value(p0)
            if not p0.startswith(("uniform", "nonuniform")):
                p0 = f"uniform {p0}"
        block = _patch_block(name, typ, value, p0, item.get("extra") or {})
        text = _rewrite_patch(text, name, block)
    _write_text(path, text)


def _set_scheme_default(case, section, value):
    value = _check_scheme_value(value, section)
    _foam_set(case, "system/fvSchemes", [(f"{section}/default", value)])


def _set_div_scheme(case, key, value):
    value = _check_scheme_value(value, key)
    path = case / "system" / "fvSchemes"
    text = _read(path, limit=500000)
    m = re.search(r"\bdivSchemes\s*\{", text)
    if not m:
        raise _err("fvSchemes 中没有 divSchemes")
    body, end = _balanced(text, m.end() - 1, "{", "}")
    pattern = re.compile(r"(?m)^([ \t]*)" + re.escape(key) + r"[ \t]+[^;]*;")
    if pattern.search(body):
        body = pattern.sub(lambda mm: f"{mm.group(1)}{key} {value};", body, count=1)
    else:
        body = body.rstrip() + f"\n    {key} {value};\n"
    _write_text(path, text[:m.end() - 1] + "{" + body + "}" + text[end + 1:])


def _set_numerics(case, values):
    schemes = values.get("schemes") or {}
    for section, value in schemes.items():
        if section not in ("ddtSchemes", "gradSchemes", "laplacianSchemes",
                           "interpolationSchemes", "snGradSchemes"):
            raise _err(f"未知格式节：{section}")
        _set_scheme_default(case, section, value)
    for key, value in (values.get("div") or {}).items():
        _set_div_scheme(case, key, value)
    algorithm = values.get("algorithm") or {}
    if algorithm:
        name = algorithm.get("name") or "PIMPLE"
        if name not in ("PIMPLE", "SIMPLE", "PISO"):
            raise _err("算法只能是 PIMPLE、SIMPLE 或 PISO")
        entries = []
        for key in ("nOuterCorrectors", "nCorrectors", "nNonOrthogonalCorrectors"):
            if algorithm.get(key) is not None:
                n = _need_num(algorithm[key], key, minimum=0)
                if abs(n - round(n)) > 1e-9:
                    raise _err(f"{key} 需要整数")
                entries.append((f"{name}/{key}", str(int(round(n)))))
        _foam_set(case, "system/fvSolution", entries)
    solvers = values.get("solvers") or {}
    for field, cfg in solvers.items():
        if not _FIELD_RE.match(field):
            raise _err(f"求解器字段不合法：{field}")
        if isinstance(cfg, dict):
            _set_solver_config(case, field, cfg)


def _set_solver_config(case, field, cfg):
    path = case / "system" / "fvSolution"
    text = _read(path, limit=500000)
    m = re.search(r"\bsolvers\s*\{", text)
    if not m:
        raise _err("fvSolution 中没有 solvers")
    body, end = _balanced(text, m.end() - 1, "{", "}")
    exact = re.search(r"(?m)^([ \t]*)" + re.escape(field) + r"\s*\{", body)
    values = {}
    if cfg.get("solver") is not None:
        values["solver"] = _need_word(cfg["solver"], "线性求解器")
    if cfg.get("smoother") is not None:
        values["smoother"] = _need_word(cfg["smoother"], "平滑器")
    if cfg.get("tolerance") is not None:
        values["tolerance"] = _fmt_scalar(_need_num(cfg["tolerance"], "容差", minimum=0))
    if cfg.get("relTol") is not None:
        values["relTol"] = _fmt_scalar(_need_num(cfg["relTol"], "相对容差", minimum=0))
    if not values:
        return
    if exact:
        entries = [(f"solvers/{field}/{key}", value) for key, value in values.items()]
        _foam_set(case, "system/fvSolution", entries)
        return
    if "solver" not in values:
        raise _err(f"fvSolution 中没有 {field} 求解器，新增时必须提供 solver")
    lines = [f"    {field}", "    {"]
    for key in ("solver", "smoother", "tolerance", "relTol"):
        if key in values:
            lines.append(f"        {key:<15} {values[key]};")
    lines.append("    }")
    new_body = body.rstrip() + "\n\n" + "\n".join(lines) + "\n"
    _write_text(path, text[:m.end() - 1] + "{" + new_body + "}" + text[end + 1:])


def _set_output(case, values):
    entries = []
    if values.get("writeControl") is not None:
        wc = str(values["writeControl"])
        if wc not in ("timeStep", "runTime", "adjustableRunTime", "clockTime", "cpuTime"):
            raise _err("写出控制方式不合法")
        entries.append(("writeControl", wc))
    if values.get("writeInterval") is not None:
        entries.append(("writeInterval", _fmt_scalar(_need_num(values["writeInterval"], "写出间隔", minimum=1e-9))))
    if values.get("purgeWrite") is not None:
        n = _need_num(values["purgeWrite"], "保留数量", minimum=0)
        if abs(n - round(n)) > 1e-9:
            raise _err("保留数量需要整数")
        entries.append(("purgeWrite", str(int(round(n)))))
    if values.get("writeFormat") is not None:
        wf = str(values["writeFormat"])
        if wf not in ("ascii", "binary"):
            raise _err("写出格式只能是 ascii 或 binary")
        entries.append(("writeFormat", wf))
    if values.get("writeCompression") is not None:
        wc = str(values["writeCompression"])
        if wc not in ("on", "off"):
            raise _err("压缩选项只能是 on 或 off")
        entries.append(("writeCompression", wc))
    if values.get("runTimeModifiable") is not None:
        entries.append(("runTimeModifiable", "yes" if str(values["runTimeModifiable"]) in ("yes", "true", "1", "on") else "no"))
    _foam_set(case, "system/controlDict", entries)

    force = values.get("forceCoeffs")
    if isinstance(force, dict):
        control = _control(case)
        functions = control.get("functions") or {}
        if "forceCoeffs" not in functions:
            if force.get("enabled"):
                raise _err("当前算例没有 forceCoeffs 函数，请先在“高级字典”中添加")
            return
        fentries = []
        if force.get("patches") is not None:
            patches = force["patches"]
            if isinstance(patches, str):
                patches = [x for x in re.split(r"[\s,]+", patches) if x]
            if not isinstance(patches, list) or not patches:
                raise _err("力系数至少需要一个边界")
            for p in patches:
                _need_word(p, "力系数边界")
            fentries.append(("functions/forceCoeffs/patches", "(" + " ".join(patches) + ")"))
        for key in ("Aref", "rhoInf", "magUInf", "lRef"):
            if force.get(key) is not None:
                fentries.append((f"functions/forceCoeffs/{key}", _fmt_scalar(_need_num(force[key], key, minimum=0))))
        _foam_set(case, "system/controlDict", fentries)


def _set_mesh(case, values):
    cells = values.get("cells")
    if cells is None:
        return
    if not isinstance(cells, list) or len(cells) != 3:
        raise _err("网格数量需要三个整数")
    counts = []
    for value in cells:
        n = _need_num(value, "网格数量", minimum=1)
        if abs(n - round(n)) > 1e-9:
            raise _err("网格数量需要整数")
        counts.append(int(round(n)))
    path = case / "system" / "blockMeshDict"
    if not path.is_file():
        path = case / "constant" / "polyMesh" / "blockMeshDict"
    if not path.is_file():
        raise _err("没有 blockMeshDict")
    text = _read(path, limit=1200000)
    m = re.search(r"\bblocks\s*\(", text)
    if not m:
        raise _err("blockMeshDict 中没有 blocks")
    body, end = _balanced(text, m.end() - 1)
    bm = re.search(r"\b(hex|tet|wedge|prism|pyramid)\s*\(([^)]*)\)\s*\(([^)]*)\)", body)
    if not bm:
        raise _err("无法识别 blockMesh 块")
    new_body = body[:bm.start(3)] + " ".join(str(x) for x in counts) + body[bm.end(3):]
    _write_text(path, text[:m.end() - 1] + "(" + new_body + ")" + text[end + 1:])


# --------------------------------------------------------------------------- #
# public save / create / blockMesh
# --------------------------------------------------------------------------- #

def api_model_save(name, section, values):
    case = _case(name)
    _ensure_not_running(case)
    if not isinstance(values, dict):
        raise _err("设置内容格式不正确")
    if section == "general":
        _set_general(case, values)
    elif section == "physics":
        _set_physics(case, values)
    elif section == "fluid":
        _set_fluid(case, values)
    elif section == "initial":
        _set_initial(case, values)
    elif section == "boundary":
        _set_boundary(case, values)
    elif section == "numerics":
        _set_numerics(case, values)
    elif section == "output":
        _set_output(case, values)
    elif section == "mesh":
        _set_mesh(case, values)
    else:
        raise _err(f"未知设置分区：{section}")
    return api_model(case.name)


def _template_dirs():
    root = Path("/opt/openfoam14/tutorials")
    out = []
    for solver in ("incompressibleFluid", "compressibleFluid", "multiphaseEuler", "multiphaseVoF"):
        base = root / solver
        if not base.is_dir():
            continue
        try:
            entries = sorted(base.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        for path in entries:
            if path.is_dir() and (path / "system" / "controlDict").is_file():
                out.append({"id": f"tutorial:{solver}/{path.name}", "name": path.name,
                            "solver": solver, "kind": "tutorial"})
    return out


def api_templates():
    existing = []
    for path in sorted(_base().iterdir(), key=lambda p: p.name.lower()):
        if not path.is_dir() or not (path / "system" / "controlDict").is_file():
            continue
        try:
            solver = _control(path)["solver"]
        except Exception:
            solver = ""
        existing.append({"id": f"existing:{path.name}", "name": path.name,
                         "solver": solver, "kind": "existing"})
    return {"templates": existing + _template_dirs()}


def _ignore_copy(dirname, names):
    ignored = set()
    for name in names:
        if name.startswith("processor") or name.startswith("log"):
            ignored.add(name)
        elif name in ("postProcessing", "images", "VTK"):
            ignored.add(name)
        elif name.endswith(".foam") or ".bak" in name or name.endswith(".tmp-gui"):
            ignored.add(name)
        elif re.fullmatch(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", name) and name != "0":
            ignored.add(name)
    return ignored


def api_create(values):
    if not isinstance(values, dict):
        raise _err("创建参数格式不正确")
    name = (values.get("name") or "").strip()
    if not _case_re().match(name):
        raise _err("算例名称不合法（字母开头，仅限字母、数字、点、下划线、短横线）")
    dst = _base() / name
    if dst.exists():
        raise _err(f"算例已存在：{name}")
    template = (values.get("template") or "").strip()
    if not template:
        raise _err("请选择模板")
    if template.startswith("existing:"):
        src = _base() / template.split(":", 1)[1]
        if not src.is_dir():
            raise _err("模板算例不存在")
    elif template.startswith("tutorial:"):
        rel = template.split(":", 1)[1]
        if "/" not in rel or ".." in rel.split("/"):
            raise _err("模板路径不合法")
        src = Path("/opt/openfoam14/tutorials") / rel
        if not src.is_dir():
            raise _err("教程模板不存在")
    else:
        raise _err("模板格式不合法")
    if _running(name):
        raise _err("同名算例正在运行")
    warnings = []
    try:
        shutil.copytree(src, dst, ignore=_ignore_copy)
        if (dst / "0.orig").is_dir() and not (dst / "0").exists():
            shutil.copytree(dst / "0.orig", dst / "0")
        if values.get("solver"):
            _set_general(dst, {"solver": values["solver"]})
        general = {}
        for key in ("startTime", "endTime", "deltaT", "maxCo", "maxDeltaT"):
            if values.get(key) is not None:
                general[key] = values[key]
        if general:
            _set_general(dst, general)
        if values.get("simulationType"):
            _set_physics(dst, {
                "simulationType": values["simulationType"],
                "model": values.get("model"),
            })
        fluid = {}
        for key in ("nu", "rho", "viscosityModel"):
            if values.get(key) is not None:
                fluid[key] = values[key]
        if fluid:
            try:
                _set_fluid(dst, fluid)
            except Exception as exc:
                warnings.append(f"流体属性未写入：{exc}")
        if values.get("runBlockMesh") and (dst / "system" / "blockMeshDict").is_file():
            res = api_blockmesh(name, quiet=True)
            if not res.get("ok"):
                warnings.append("blockMesh 未成功，请查看日志")
    except Exception:
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        raise
    return {"ok": True, "name": name, "warnings": warnings, "model": api_model(name)}


def api_blockmesh(name, quiet=False):
    case = _case(name)
    _ensure_not_running(case)
    path = case / "system" / "blockMeshDict"
    if not path.is_file():
        path = case / "constant" / "polyMesh" / "blockMeshDict"
    if not path.is_file():
        raise _err("该算例没有 blockMeshDict")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_name = f"log.blockMesh.gui-{stamp}"
    res = _foam(case, f"blockMesh > {shlex.quote(log_name)} 2>&1", timeout=900)
    log = case / log_name
    text = _read(log, limit=600000) if log.is_file() else (res.stdout or "") + (res.stderr or "")
    ok = res.returncode == 0 and "FOAM FATAL" not in text and "FOAM exiting" not in text
    lines = text.splitlines()[-120:]
    if not ok and not quiet:
        raise _err("blockMesh 失败", detail=lines[-30:])
    return {
        "ok": ok,
        "log": log_name,
        "lines": lines,
        "mesh": _mesh(case),
    }
