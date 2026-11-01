#!/usr/bin/env python3
"""OpenFOAM 工作台 — a local web GUI for OpenFOAM cases (stdlib only).

Serves a single-page app plus a small JSON API over HTTP. It is intended to run
inside WSL where OpenFOAM is installed; the browser runs on Windows.
"""

import json
import mimetypes
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import threading
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import model_api

DEFAULT_APP_HOME = Path.home() / "OpenFOAM"
APP_HOME = Path(os.environ.get("OPENFOAM_WORKBENCH_HOME", DEFAULT_APP_HOME)).expanduser()
BASE = Path(os.environ.get("OPENFOAM_WORKBENCH_CASES", APP_HOME / "mcp-cases")).expanduser()
GUI_DIR = Path(__file__).resolve().parent
STATIC_DIR = GUI_DIR / "static"
FOAM_BASHRC = os.environ.get("OPENFOAM_BASHRC", "/opt/openfoam14/etc/bashrc")
PV_RENDER = GUI_DIR / "_pv_render.py"
PVPYTHON = os.environ.get("OPENFOAM_PVPYTHON", "/usr/bin/pvpython")
RUN_HOME = os.environ.get("OPENFOAM_WORKBENCH_RUN_HOME", os.environ.get("HOME", str(Path.home())))
HOST, PORT = "0.0.0.0", 8848
CASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SERVER_START = time.time()

START_TIME_RE = re.compile(r"^Time = ([-+0-9.eE]+)s?\s*$")
SOLVE_RE = re.compile(r"Solving for (\w+), Initial residual = ([^,]+), Final residual = ([^,]+), No Iterations (\d+)")
EXEC_RE = re.compile(r"ExecutionTime = ([-+0-9.eE]+) s")
CO_RE = re.compile(r"Courant Number .*?max: ([-+0-9.eE]+)")
DT_RE = re.compile(r"^deltaT = ([-+0-9.eE]+)")
CONT_RE = re.compile(r"time step continuity errors : sum local = ([-+0-9.eE]+), global = ([-+0-9.eE]+)")
FATAL_RE = re.compile(r"FOAM FATAL (?:IO )?ERROR|Fatal error|FOAM exiting", re.I)
FORCE_COL_RE = re.compile(r"^#\s*Aref\s*:\s*([-+0-9.eE]+)")

SIZE_CACHE = {}
SIZE_LOCK = threading.Lock()
RUN_CACHE = {"at": 0.0, "data": {}}
RUN_LOCK = threading.Lock()
STOPPING = set()
STOP_LOCK = threading.Lock()
ENV_CACHE = {}
JOBS = {}
JOBS_LOCK = threading.Lock()
RENDER_SEM = threading.Semaphore(2)
PROGRESS_CACHE = {}


class ApiError(Exception):
    def __init__(self, message, detail=None, status=400):
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.status = status


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def now_iso(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else time.time()).astimezone().isoformat(timespec="seconds")


def read_text(path, limit=None):
    path = Path(path)
    with open(path, "rb") as fh:
        data = fh.read(limit) if limit else fh.read()
    return data.decode("utf-8", errors="replace")


def tail_text(path, max_bytes=256 * 1024):
    path = Path(path)
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
            return fh.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def tail_lines(path, n=300):
    n = max(1, min(int(n), 5000))
    text = tail_text(path, 4 * 1024 * 1024)
    lines = text.splitlines()
    return lines[-n:]


def numeric_dirs(path):
    path = Path(path)
    out = []
    try:
        entries = list(os.scandir(path))
    except OSError:
        return out
    for e in entries:
        if not e.is_dir(follow_symlinks=False):
            continue
        try:
            value = float(e.name)
        except ValueError:
            continue
        if value == value and abs(value) != float("inf"):
            out.append((value, e.name))
    out.sort(key=lambda x: x[0])
    return out


def max_time(path):
    dirs = numeric_dirs(path)
    return dirs[-1][0] if dirs else None


def resolve_case(name):
    name = (name or "").strip()
    if not CASE_RE.match(name):
        raise ApiError("算例名称不合法")
    case = BASE / name
    if not case.is_dir() or not (case / "system" / "controlDict").is_file():
        raise ApiError(f"算例不存在：{name}", status=404)
    return case


def bash_run(cmd, timeout=60, cwd=None, env=None):
    full_env = os.environ.copy()
    full_env.update({"HOME": RUN_HOME, "LANG": "C.UTF-8"})
    if env:
        full_env.update(env)
    return subprocess.run(
        ["/bin/bash", "-lc", cmd],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
        env=full_env,
    )


def foam_run(case, inner, timeout=60):
    cmd = f"source {FOAM_BASHRC} >/dev/null 2>&1 && cd {shlex.quote(str(case))} && {inner}"
    return bash_run(cmd, timeout=timeout)


def float_or_none(value):
    try:
        result = float(value)
        return result if result == result else None
    except (TypeError, ValueError):
        return None


def parse_control(case):
    text = read_text(case / "system" / "controlDict", limit=300000)
    head = text.split("\nfunctions", 1)[0]

    def entry(key):
        m = re.search(r"(?m)^\s*" + re.escape(key) + r"\s+([^;]+);", head)
        if not m:
            return None
        return m.group(1).strip().strip('"')

    raw = {k: entry(k) for k in (
        "solver", "startFrom", "startTime", "stopAt", "endTime", "deltaT",
        "adjustTimeStep", "maxCo", "maxDeltaT", "writeControl", "writeInterval", "purgeWrite",
    )}
    for key in ("startTime", "endTime", "deltaT", "maxCo", "maxDeltaT", "writeInterval", "purgeWrite"):
        raw[key + "Num"] = float_or_none(raw.get(key))
    return raw


def mesh_info(case):
    logs = sorted(case.glob("log.checkMesh*"), key=lambda p: p.stat().st_mtime if p.exists() else 0)
    if not logs:
        return {"checked": False, "cells": None, "points": None, "faces": None, "ok": None, "log": None}
    log = logs[-1]
    text = tail_text(log, 400000)
    def grab(pattern):
        m = re.search(pattern, text, re.M)
        return int(m.group(1)) if m else None
    ok = "Mesh OK" in text and "FOAM FATAL" not in text
    return {
        "checked": True,
        "cells": grab(r"^\s*cells:\s+(\d+)"),
        "points": grab(r"^\s*points:\s+(\d+)"),
        "faces": grab(r"^\s*faces:\s+(\d+)"),
        "ok": ok,
        "log": log.name,
        "log_mtime": now_iso(log.stat().st_mtime),
    }


def case_size_mb(case):
    key = str(case)
    st = case.stat()
    now = time.time()
    with SIZE_LOCK:
        cached = SIZE_CACHE.get(key)
        if cached and now - cached[0] < 120 and cached[1] == st.st_mtime:
            return cached[2]
    total = 0
    try:
        for root, dirs, files in os.walk(case):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    mb = round(total / 1048576, 1)
    with SIZE_LOCK:
        SIZE_CACHE[key] = (now, st.st_mtime, mb)
    return mb


def _cmdline(pid):
    try:
        return (Path("/proc") / pid / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def running_map(force=False):
    now = time.time()
    with RUN_LOCK:
        if not force and now - RUN_CACHE["at"] < 0.7:
            return RUN_CACHE["data"]
    found = {}
    base = str(BASE) + os.sep
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        cmd = _cmdline(entry.name)
        if "foamRun" not in cmd and "mpirun" not in cmd:
            continue
        try:
            cwd = os.readlink(entry / "cwd")
        except OSError:
            continue
        if not cwd.startswith(base):
            continue
        case_dir = Path(cwd)
        if not (case_dir / "system" / "controlDict").is_file():
            continue
        name = case_dir.name
        ranks = 1
        m = re.search(r"-np\s+(\d+)", cmd)
        if m:
            ranks = int(m.group(1))
        item = found.setdefault(name, {"pids": [], "ranks": ranks, "cmd": cmd[:300]})
        item["pids"].append(int(entry.name))
        if m:
            item["ranks"] = int(m.group(1))
    with RUN_LOCK:
        RUN_CACHE["at"] = now
        RUN_CACHE["data"] = found
    return found


def log_files(case):
    files = []
    for path in case.glob("log*"):
        if path.is_file():
            try:
                st = path.stat()
            except OSError:
                continue
            files.append({"name": path.name, "size": st.st_size, "mtime": now_iso(st.st_mtime), "ts": st.st_mtime})
    files.sort(key=lambda x: (x["name"] != "log.foamRun", -x["ts"]))
    for f in files:
        f.pop("ts", None)
    return files


def latest_dirs(case):
    return max_time(case), max_time(case / "processor0")


def source_for_render(case):
    root = max_time(case)
    proc = max_time(case / "processor0")
    if proc is not None and (root is None or proc > root + 1e-9):
        return "decomposed"
    if root is None and proc is not None:
        return "decomposed"
    return "reconstructed"


def fields_in(case, source):
    dirs = numeric_dirs(case if source == "reconstructed" else case / "processor0")
    if not dirs:
        return []
    tdir = (case if source == "reconstructed" else case / "processor0") / dirs[-1][1]
    fields = []
    try:
        files = sorted((p for p in tdir.iterdir() if p.is_file()), key=lambda p: p.name)
    except OSError:
        return []
    for path in files:
        if path.name.startswith(".") or path.name in {"uniform"}:
            continue
        header = read_text(path, limit=1500)
        if re.search(r"class\s+(volScalarField|volVectorField|volTensorField|volSymmTensorField|volSphericalTensorField)", header):
            fields.append(path.name)
    order = {"U": 0, "p": 1, "vorticity": 2}
    fields.sort(key=lambda x: (order.get(x, 10), x))
    return fields


def case_images(case):
    out = []
    patterns = [case / "images", case]
    seen = set()
    for folder in patterns:
        if not folder.is_dir():
            continue
        try:
            entries = list(folder.iterdir())
        except OSError:
            continue
        for path in entries:
            if not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
                continue
            if path in seen:
                continue
            seen.add(path)
            try:
                st = path.stat()
            except OSError:
                continue
            out.append({
                "name": path.name,
                "path": str(path),
                "size": st.st_size,
                "mtime": now_iso(st.st_mtime),
                "ts": st.st_mtime,
                "url": media_url(path, st),
            })
    out.sort(key=lambda x: -x["ts"])
    for item in out:
        item.pop("ts", None)
    return out[:60]


def media_url(path, st=None):
    path = Path(path)
    if st is None:
        st = path.stat()
    return f"/media?path={path.as_posix()}&v={int(st.st_mtime)}-{st.st_size}"


def quick_state(case, control, running):
    info = running.get(case.name)
    with STOP_LOCK:
        stopping = case.name in STOPPING
    if info:
        return "stopping" if stopping else "running"
    log = case / "log.foamRun"
    state = "ready"
    last = None
    if log.is_file():
        text = tail_text(log, 200 * 1024)
        times = START_TIME_RE.findall(text)
        last = float_or_none(times[-1]) if times else None
        fatal = FATAL_RE.search(text)
        ended = re.search(r"(?m)^End\s*$", text) is not None
        end_time = control.get("endTimeNum")
        if fatal:
            state = "error"
        elif ended or (last is not None and end_time is not None and last >= end_time - 1e-6):
            state = "completed"
        elif last is not None and last > (control.get("startTimeNum") or 0) + 1e-9:
            state = "stopped"
    root, proc = latest_dirs(case)
    latest = max([x for x in (root, proc, last) if x is not None], default=None)
    if state == "ready" and latest is not None and (control.get("endTimeNum") or 0) > 0:
        if latest >= control["endTimeNum"] - 1e-6:
            state = "completed"
    return state


def summarize_case(case, running):
    control = parse_control(case)
    state = quick_state(case, control, running)
    root, proc = latest_dirs(case)
    log = case / "log.foamRun"
    last_log = None
    if log.is_file():
        m = START_TIME_RE.findall(tail_text(log, 80 * 1024))
        if m:
            last_log = float_or_none(m[-1])
    latest = max([x for x in (root, proc, last_log) if x is not None], default=None)
    mesh = mesh_info(case)
    st = case.stat()
    info = running.get(case.name)
    return {
        "name": case.name,
        "solver": control.get("solver"),
        "endTime": control.get("endTimeNum"),
        "startTime": control.get("startTimeNum"),
        "latest": latest,
        "latestRoot": root,
        "latestProc": proc,
        "running": bool(info),
        "ranks": info["ranks"] if info else None,
        "state": state,
        "cells": mesh.get("cells"),
        "meshOk": mesh.get("ok"),
        "images": len(case_images(case)),
        "modified": now_iso(st.st_mtime),
        "ts": st.st_mtime,
    }


# --------------------------------------------------------------------------- #
# progress
# --------------------------------------------------------------------------- #

def progress_for(case):
    log = case / "log.foamRun"
    control = parse_control(case)
    end_time = control.get("endTimeNum") or 0.0
    start_time = control.get("startTimeNum") or 0.0
    running = running_map()
    info = running.get(case.name)
    with STOP_LOCK:
        stopping = case.name in STOPPING
    result = {
        "state": "ready", "time": None, "lastTime": None, "startTime": start_time, "endTime": end_time,
        "pct": 0.0, "dt": None, "co": None, "coMean": None, "p": None, "residuals": {},
        "history": [], "exec": None, "eta": None, "rate": None, "pids": [], "ranks": None,
        "updated": None, "log": log.name if log.exists() else None, "error": None, "finished": False,
        "logSize": None, "iterations": 0,
    }
    if info:
        result["pids"] = info["pids"]
        result["ranks"] = info["ranks"]
    if not log.is_file():
        if info:
            result["state"] = "stopping" if stopping else "running"
        return result

    st = log.stat()
    cache_key = str(case)
    cache = PROGRESS_CACHE.get(cache_key)
    if cache and cache[0] == st.st_mtime and cache[1] == st.st_size and not info:
        return cache[2]

    text = tail_text(log, 6 * 1024 * 1024)
    lines = text.splitlines()
    history = []
    current = None
    meta = {}
    last_exec = None
    first_exec = None
    last_time = None
    first_time = None
    last_dt = None
    last_co = None
    last_co_mean = None
    fatal = None
    ended = False
    p_final = None

    def finish_current():
        nonlocal current
        if current is not None:
            history.append(current)
            current = None

    for line in lines:
        m = START_TIME_RE.match(line)
        if m:
            finish_current()
            t = float_or_none(m.group(1))
            if t is None:
                continue
            current = {"t": t}
            current.update({k: v for k, v in meta.items() if v is not None})
            meta = {}
            last_time = t
            if first_time is None:
                first_time = t
            continue
        if current is not None:
            sm = SOLVE_RE.search(line)
            if sm:
                field = sm.group(1)
                final = float_or_none(sm.group(3))
                if final is not None:
                    current[field] = final
                    if field == "p":
                        p_final = final
                continue
            cm = CONT_RE.search(line)
            if cm:
                val = float_or_none(cm.group(1))
                if val is not None:
                    current["cont"] = val
                continue
        em = EXEC_RE.search(line)
        if em:
            ex = float_or_none(em.group(1))
            if ex is not None:
                last_exec = ex
                if first_exec is None:
                    first_exec = ex
                if current is not None:
                    current["exec"] = ex
            continue
        com = CO_RE.search(line)
        if com:
            last_co = float_or_none(com.group(1))
            meta["co"] = last_co
            mean_m = re.search(r"mean:\s*([-+0-9.eE]+)", line)
            if mean_m:
                last_co_mean = float_or_none(mean_m.group(1))
                meta["coMean"] = last_co_mean
            continue
        dtm = DT_RE.match(line)
        if dtm:
            last_dt = float_or_none(dtm.group(1))
            meta["dt"] = last_dt
            continue
        if FATAL_RE.search(line):
            fatal = line.strip()[:240]
            continue
        if re.match(r"^End\s*$", line):
            ended = True

    finish_current()
    history = history[-320:]
    current_values = history[-1] if history else {}
    residuals = {k: v for k, v in current_values.items() if k not in {"t", "exec", "co", "coMean", "dt", "cont"} and isinstance(v, float)}
    dt = current_values.get("dt", last_dt)
    co = current_values.get("co", last_co)
    co_mean = current_values.get("coMean", last_co_mean)
    if p_final is None:
        p_final = residuals.get("p")

    rate = None
    if first_exec is not None and last_exec is not None and last_time is not None and first_time is not None:
        d_exec = last_exec - first_exec
        if d_exec > 0.2 and last_time > first_time:
            rate = (last_time - first_time) / d_exec

    state = "ready"
    if info:
        state = "stopping" if stopping else "running"
    elif fatal:
        state = "error"
    elif ended or (last_time is not None and end_time and last_time >= end_time - 1e-6):
        state = "completed"
    elif last_time is not None and last_time > start_time + 1e-9:
        state = "stopped"

    pct = 0.0
    if last_time is not None and end_time:
        span = end_time - start_time
        if span > 0:
            pct = min(100.0, max(0.0, (last_time - start_time) / span * 100.0))
    eta = None
    if state in ("running", "stopping") and rate and last_time is not None:
        remaining = end_time - last_time
        if remaining > 0 and rate > 0:
            eta = remaining / rate

    result.update({
        "state": state,
        "time": last_time,
        "lastTime": last_time,
        "pct": round(pct, 3),
        "dt": dt,
        "co": co,
        "coMean": co_mean,
        "p": p_final if p_final is not None else residuals.get("p"),
        "residuals": residuals,
        "history": history,
        "exec": last_exec,
        "eta": eta,
        "rate": rate,
        "updated": now_iso(st.st_mtime),
        "error": fatal,
        "finished": ended,
        "logSize": st.st_size,
        "iterations": len(history),
    })
    if not info:
        PROGRESS_CACHE[cache_key] = (st.st_mtime, st.st_size, result)
    return result


# --------------------------------------------------------------------------- #
# force coefficients
# --------------------------------------------------------------------------- #

def force_datasets(case):
    out = []
    post = case / "postProcessing"
    if not post.is_dir():
        return out
    for path in post.rglob("*.dat"):
        if "force" not in path.parent.name.lower() and "force" not in path.name.lower():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.parent.relative_to(post).as_posix()
        header = []
        rows = 0
        aref = None
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                if line.startswith("#"):
                    header.append(line.rstrip())
                    am = FORCE_COL_RE.match(line)
                    if am:
                        aref = float_or_none(am.group(1))
                elif line.strip():
                    rows += 1
        cols = None
        for h in reversed(header):
            clean = [c.strip() for c in h.lstrip("#").split("\t") if c.strip()]
            if not clean:
                clean = [c.strip() for c in h.lstrip("#").split() if c.strip()]
            if "Cd" in clean and "Cl" in clean:
                cols = clean
                break
        if not cols:
            continue
        out.append({
            "id": rel,
            "file": str(path),
            "name": path.name,
            "label": rel,
            "rows": rows,
            "Aref": aref,
            "mtime": now_iso(st.st_mtime),
            "ts": st.st_mtime,
            "columns": cols,
        })
    out.sort(key=lambda x: -x["ts"])
    for item in out:
        item.pop("ts", None)
    return out


def load_forces(case, dataset_id=None):
    datasets = force_datasets(case)
    if not datasets:
        return {"available": False, "datasets": [], "data": None}
    chosen = None
    if dataset_id:
        for d in datasets:
            if d["id"] == dataset_id:
                chosen = d
                break
    if chosen is None:
        chosen = datasets[0]
    cols = chosen.get("columns") or ["Time", "Cm", "Cd", "Cl"]
    try:
        i_cd, i_cl = cols.index("Cd"), cols.index("Cl")
    except ValueError:
        i_cd, i_cl = 2, 3
    times, cd, cl = [], [], []
    with open(chosen["file"], "r", errors="replace") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) <= max(i_cd, i_cl):
                continue
            t = float_or_none(parts[0])
            c_d = float_or_none(parts[i_cd])
            c_l = float_or_none(parts[i_cl])
            if t is None or c_d is None or c_l is None:
                continue
            times.append(t)
            cd.append(c_d)
            cl.append(c_l)
    n = len(times)
    stats = {}
    if n:
        mean_cd = sum(cd) / n
        amp = (max(cl) - min(cl)) / 2
        stats = {
            "cdMean": mean_cd,
            "cdMin": min(cd),
            "cdMax": max(cd),
            "clAmp": amp,
            "clMin": min(cl),
            "clMax": max(cl),
            "tMin": times[0],
            "tMax": times[-1],
            "n": n,
        }
        crossings = []
        for i in range(1, n):
            if cl[i - 1] < 0 <= cl[i]:
                denom = cl[i] - cl[i - 1]
                frac = (0 - cl[i - 1]) / denom if denom else 0
                crossings.append(times[i - 1] + frac * (times[i] - times[i - 1]))
        if len(crossings) >= 2:
            periods = [crossings[i] - crossings[i - 1] for i in range(1, len(crossings))]
            periods = [p for p in periods if p > 0]
            if periods:
                stats["period"] = sum(periods[-6:]) / len(periods[-6:])
                stats["cycles"] = len(periods)
    stride = max(1, n // 1600)
    sample = {
        "t": times[::stride],
        "cd": cd[::stride],
        "cl": cl[::stride],
    }
    if sample["t"] and sample["t"][-1] != times[-1]:
        sample["t"].append(times[-1])
        sample["cd"].append(cd[-1])
        sample["cl"].append(cl[-1])
    return {
        "available": True,
        "datasets": datasets,
        "data": {
            "id": chosen["id"],
            "file": chosen["file"],
            "Aref": chosen["Aref"],
            "columns": chosen["columns"],
            "mtime": chosen["mtime"],
            "rows": n,
            "stats": stats,
            "sample": sample,
        },
    }


# --------------------------------------------------------------------------- #
# dictionaries
# --------------------------------------------------------------------------- #

def dict_files(case):
    out = []
    for group, folder in (("system", case / "system"), ("constant", case / "constant"), ("0", case / "0")):
        if not folder.is_dir():
            continue
        try:
            entries = sorted(folder.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for path in entries:
            if not path.is_file() or path.name.startswith("."):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if st.st_size > 1_500_000:
                continue
            out.append({
                "path": f"{group}/{path.name}",
                "group": group,
                "name": path.name,
                "size": st.st_size,
                "mtime": now_iso(st.st_mtime),
            })
    priority = {"system/controlDict": 0, "system/fvSolution": 1, "system/fvSchemes": 2,
                "system/decomposeParDict": 3, "constant/transportProperties": 4}
    out.sort(key=lambda x: (priority.get(x["path"], 5), x["group"], x["name"]))
    return out


def safe_dict_path(case, rel):
    rel = unquote(rel or "").replace("\\", "/")
    if rel.startswith("/") or ".." in rel.split("/"):
        raise ApiError("字典路径不合法")
    parts = rel.split("/")
    if len(parts) != 2 or parts[0] not in {"system", "constant", "0"}:
        raise ApiError("只允许编辑 system/、constant/ 与 0/ 下的文件")
    path = (case / rel).resolve()
    try:
        path.relative_to(case.resolve())
    except ValueError:
        raise ApiError("字典路径越界")
    if not path.is_file():
        raise ApiError(f"文件不存在：{rel}", status=404)
    return path, rel


# --------------------------------------------------------------------------- #
# jobs: render / checkMesh
# --------------------------------------------------------------------------- #

def new_job(kind, case_name, **meta):
    jid = secrets.token_hex(4)
    job = {
        "id": jid, "kind": kind, "case": case_name, "status": "queued",
        "created": now_iso(), "started": None, "finished": None,
        "message": "", "result": None, "log": [], "duration": None,
    }
    job.update(meta)
    with JOBS_LOCK:
        JOBS[jid] = job
        if len(JOBS) > 80:
            for old in sorted(JOBS.values(), key=lambda j: j["created"])[:-60]:
                JOBS.pop(old["id"], None)
    thread = threading.Thread(target=_job_worker, args=(jid,), daemon=True)
    thread.start()
    return jid


def update_job(jid, **fields):
    with JOBS_LOCK:
        job = JOBS.get(jid)
        if job:
            job.update(fields)


def _job_worker(jid):
    with JOBS_LOCK:
        job = dict(JOBS.get(jid) or {})
    if not job:
        return
    kind = job["kind"]
    started = time.time()
    update_job(jid, status="running", started=now_iso())
    try:
        if kind == "render":
            result = do_render(jid, job)
        elif kind == "checkmesh":
            result = do_checkmesh(jid, job)
        else:
            raise ApiError(f"未知任务类型：{kind}")
        update_job(jid, status="done", result=result, finished=now_iso(),
                   duration=round(time.time() - started, 1))
    except Exception as exc:  # noqa: BLE001
        message = exc.message if isinstance(exc, ApiError) else f"{type(exc).__name__}: {exc}"
        detail = getattr(exc, "detail", None)
        update_job(jid, status="error", message=message, result={"detail": detail},
                   finished=now_iso(), duration=round(time.time() - started, 1))


def do_render(jid, job):
    case = resolve_case(job["case"])
    params = job.get("params") or {}
    source = source_for_render(case)
    root, proc = latest_dirs(case)
    times = numeric_dirs(case if source == "reconstructed" else case / "processor0")
    if not times:
        raise ApiError("没有可渲染的时间目录")
    foam_file = case / f"{case.name}.foam"
    if not foam_file.exists():
        foam_file.write_text("", encoding="utf-8")
    field = params.get("field") or "U"
    colormap = params.get("colormap") or "coolwarm"
    component = params.get("component") or "Magnitude"
    width = int(params.get("width") or 1600)
    height = int(params.get("height") or 900)
    background = "dark" if params.get("background", True) else "light"
    requested_time = params.get("time")
    if requested_time in (None, "", "latest"):
        time_value = times[-1][0]
    else:
        time_value = float(requested_time)
        time_value = min((x[0] for x in times), key=lambda x: abs(x - time_value))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_field = re.sub(r"[^A-Za-z0-9_-]+", "_", field)
    image_dir = case / "images"
    image_dir.mkdir(exist_ok=True)
    out = image_dir / f"gui_{safe_field}_{time_value:g}_{stamp}.png"
    pv_params = {
        "foam_file": str(foam_file),
        "decomposed": source == "decomposed",
        "field": field,
        "time": str(time_value),
        "colormap": colormap,
        "component": component,
        "width": width,
        "height": height,
        "background": background,
        "mode": "auto",
        "case_name": case.name,
        "out": str(out),
    }
    env = os.environ.copy()
    env.update({"HOME": RUN_HOME, "LANG": "C.UTF-8"})
    with RENDER_SEM:
        update_job(jid, message=f"ParaView 正在渲染 {field} @ t={time_value:g} s")
        proc_res = subprocess.run(
            [PVPYTHON, "--force-offscreen-rendering", str(PV_RENDER), json.dumps(pv_params)],
            capture_output=True, text=True, errors="replace", timeout=900, env=env,
        )
    stdout = (proc_res.stdout or "").splitlines()
    update_job(jid, log=stdout[-30:])
    payload = None
    for line in stdout:
        if line.startswith("OFMCP_RESULT "):
            try:
                payload = json.loads(line[len("OFMCP_RESULT "):])
            except json.JSONDecodeError:
                continue
    if payload is None:
        err = (proc_res.stderr or "").strip()[-800:] or (proc_res.stdout or "").strip()[-800:] or "ParaView 未返回结果"
        raise ApiError(f"渲染失败：{err}", detail=stdout[-12:])
    if payload.get("error"):
        raise ApiError(f"渲染失败：{payload['error']}")
    if not out.exists():
        raise ApiError("渲染结束但图像文件不存在", detail=stdout[-12:])
    st = out.stat()
    update_job(jid, message=f"渲染完成：{out.name}（{st.st_size / 1024:.0f} KB）")
    return {
        "image": {
            "name": out.name,
            "path": str(out),
            "size": st.st_size,
            "mtime": now_iso(st.st_mtime),
            "url": media_url(out, st),
        },
        "time": payload.get("time"),
        "field": field,
        "color": payload.get("color"),
        "source": source,
        "fields": payload.get("fields"),
        "image_path": str(out),
        "range": payload.get("color", {}).get("range") if payload.get("color") else None,
    }


def do_checkmesh(jid, job):
    case = resolve_case(job["case"])
    info = running_map(force=True).get(case.name)
    if info:
        raise ApiError("求解正在进行，停止后再检查网格")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_name = f"log.checkMesh.gui-{stamp}"
    update_job(jid, message="正在运行 checkMesh")
    cmd = f"source {FOAM_BASHRC} >/dev/null 2>&1 && cd {shlex.quote(str(case))} && checkMesh > {shlex.quote(log_name)} 2>&1"
    res = bash_run(cmd, timeout=600)
    path = case / log_name
    if not path.exists():
        raise ApiError("checkMesh 未生成日志", detail=(res.stdout + res.stderr)[-800:])
    lines = tail_lines(path, 120)
    text = tail_text(path, 400000)
    mesh = {
        "cells": None, "points": None, "faces": None, "ok": "Mesh OK" in text and "FOAM FATAL" not in text,
        "log": log_name,
    }
    for key, pattern in (("cells", r"^\s*cells:\s+(\d+)"), ("points", r"^\s*points:\s+(\d+)"),
                         ("faces", r"^\s*faces:\s+(\d+)")):
        m = re.search(pattern, text, re.M)
        if m:
            mesh[key] = int(m.group(1))
    update_job(jid, message="网格检查完成")
    return {"mesh": mesh, "lines": lines, "ok": mesh["ok"], "log": log_name}


# --------------------------------------------------------------------------- #
# run / stop / copy
# --------------------------------------------------------------------------- #

def ensure_decompose_dict(case, ranks):
    path = case / "system" / "decomposeParDict"
    if not path.exists():
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
            "    format      ascii;\n"
            "    class       dictionary;\n"
            "    location    \"system\";\n"
            "    object      decomposeParDict;\n"
            "}\n\n"
            f"numberOfSubdomains  {ranks};\n\n"
            "method          scotch;\n\n"
            "// ************************************************************************* //\n",
            encoding="utf-8",
        )
        return
    text = read_text(path)
    m = re.search(r"(?m)^\s*numberOfSubdomains\s+(\d+)\s*;", text)
    if m and int(m.group(1)) != ranks:
        foam_run(case, f"foamDictionary system/decomposeParDict -entry numberOfSubdomains -set {ranks}", timeout=30)


def start_case(name, ranks, start_from):
    case = resolve_case(name)
    info = running_map(force=True).get(case.name)
    with STOP_LOCK:
        stopping = case.name in STOPPING
    if info or stopping:
        raise ApiError("算例正在运行")
    control = parse_control(case)
    end_time = control.get("endTimeNum")
    if end_time is None:
        raise ApiError("controlDict 中 endTime 无效")
    ranks = int(ranks or 1)
    cores = os.cpu_count() or 1
    if ranks < 1 or ranks > cores:
        raise ApiError(f"核数需在 1 到 {cores} 之间")
    start_from = start_from or "latestTime"
    if start_from not in {"latestTime", "startTime", "firstTime"}:
        raise ApiError("起始方式无效")

    root, proc = latest_dirs(case)
    proc_dirs = sorted([p for p in case.glob("processor*") if p.is_dir()],
                       key=lambda p: int(p.name.replace("processor", "") or 0))
    if ranks > 1:
        if proc_dirs and len(proc_dirs) != ranks:
            raise ApiError(f"该算例已按 {len(proc_dirs)} 核分解，请选择 {len(proc_dirs)} 核，或先删除 processor* 目录重新分解")
        ensure_decompose_dict(case, ranks)
    else:
        log_time = None
        log = case / "log.foamRun"
        if log.is_file():
            mt = START_TIME_RE.findall(tail_text(log, 200 * 1024))
            log_time = float_or_none(mt[-1]) if mt else None
        if start_from == "latestTime" and (root is None or root == 0) and log_time:
            raise ApiError("该算例的结果位于 processor* 目录，需并行启动或先 reconstructPar")

    if start_from == "startTime":
        target = control.get("startTimeNum") or 0.0
    elif start_from == "firstTime":
        target = root if root is not None else 0.0
    else:
        target = max([x for x in (root, proc) if x is not None], default=0.0)
    if end_time and target >= end_time - 1e-9:
        raise ApiError(f"起始时间 {target:g} s 已达到结束时间 {end_time:g} s，请先在“运行参数”里增大结束时间")
    if control.get("startTimeNum") is not None and end_time and start_from == "startTime" and control["startTimeNum"] >= end_time:
        raise ApiError("startTime 不小于 endTime，请修正运行参数")

    # Set the start policy and make sure the required start time exists.
    res = foam_run(case, f"foamDictionary system/controlDict -entry startFrom -set {start_from}", timeout=30)
    if res.returncode != 0:
        raise ApiError("写入 startFrom 失败", detail=(res.stdout + res.stderr)[-800:])

    log = case / "log.foamRun"
    if ranks > 1:
        match = re.search(r"(?m)^\s*numberOfSubdomains\s+(\d+)\s*;", read_text(case / "system" / "decomposeParDict"))
        dict_ranks = int(match.group(1)) if match else ranks
        if dict_ranks != ranks:
            raise ApiError("decomposeParDict 核数与所选核数不一致")
        proc_dir = case / "processor0"
        proc_times = numeric_dirs(proc_dir)
        root_times = numeric_dirs(case)
        tol = max(1e-9, abs(target) * 1e-9)
        start_root_name = next((name for value, name in root_times if abs(value - target) <= tol), None)
        start_proc_name = next((name for value, name in proc_times if abs(value - target) <= tol), None)
        if start_proc_name and (proc_dir / start_proc_name).is_dir():
            need_decompose = False
        elif start_root_name:
            need_decompose = True
        else:
            raise ApiError(f"找不到起始时间目录 t={target:g} s，无法启动")
        if need_decompose:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            dlog = case / f"log.decomposePar.gui-{stamp}"
            time_arg = start_root_name
            cmd = (f"source {FOAM_BASHRC} >/dev/null 2>&1 && cd {shlex.quote(str(case))} && "
                   f"decomposePar -force -time {shlex.quote(time_arg)} > {shlex.quote(dlog.name)} 2>&1")
            update = bash_run(cmd, timeout=900)
            if update.returncode != 0 or not (proc_dir / time_arg).exists():
                tail = tail_lines(dlog, 40) if dlog.exists() else (update.stdout + update.stderr).splitlines()[-40:]
                raise ApiError("并行分解失败", detail=tail)
    else:
        if start_from == "latestTime" and proc is not None and (root is None or proc > root + 1e-9):
            raise ApiError("最新结果位于 processor* 目录，请用并行模式继续，或先执行 reconstructPar")
        if start_from == "latestTime" and root is None:
            raise ApiError("没有找到可继续的根目录时间，请改用“从头开始”")

    if log.exists():
        rotated = case / f"log.foamRun.{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        try:
            log.rename(rotated)
        except OSError:
            try:
                log.unlink()
            except OSError:
                pass
    run_cmd = (f"source {FOAM_BASHRC} >/dev/null 2>&1 && cd {shlex.quote(str(case))} && "
               "ulimit -s unlimited 2>/dev/null; export OMP_NUM_THREADS=1; ")
    if ranks > 1:
        run_cmd += f"exec mpirun -np {ranks} foamRun -parallel"
    else:
        run_cmd += "exec foamRun"
    env = os.environ.copy()
    env.update({"HOME": RUN_HOME, "LANG": "C.UTF-8"})
    header = f"# OpenFOAM Workbench start {now_iso()}  ranks={ranks}  startFrom={start_from}\n"
    with open(log, "ab") as fh:
        fh.write(header.encode("utf-8"))
        proc = subprocess.Popen(
            ["/bin/bash", "-lc", run_cmd],
            cwd=str(case), stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
            start_new_session=True, env=env,
        )
    time.sleep(1.4)
    running_map(force=True)
    if proc.poll() is not None:
        tail = tail_lines(log, 50)
        raise ApiError("求解器启动后立即退出", detail=tail)
    return {
        "ok": True,
        "message": f"已启动 {ranks} 核求解（{start_from}）",
        "pid": proc.pid,
        "ranks": ranks,
        "log": log.name,
    }


def stop_case(name, timeout=20):
    case = resolve_case(name)
    info = running_map(force=True).get(case.name)
    if not info:
        return {"ok": True, "message": "算例当前未在运行"}
    pids = info["pids"]
    with STOP_LOCK:
        STOPPING.add(case.name)
    groups = set()
    for pid in pids:
        try:
            groups.add(os.getpgid(pid))
        except OSError:
            pass
    def signal_all(sig):
        for pg in groups:
            try:
                os.killpg(pg, sig)
            except OSError:
                pass
        for pid in pids:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
    signal_all(signal.SIGINT)
    deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.5)
        if not running_map(force=True).get(case.name):
            with STOP_LOCK:
                STOPPING.discard(case.name)
            return {"ok": True, "message": "求解已停止，已写出的时间目录保留"}
    signal_all(signal.SIGTERM)
    deadline = time.time() + 6
    while time.time() < deadline:
        time.sleep(0.5)
        if not running_map(force=True).get(case.name):
            with STOP_LOCK:
                STOPPING.discard(case.name)
            return {"ok": True, "message": "求解已终止（SIGTERM）"}
    signal_all(signal.SIGKILL)
    time.sleep(0.7)
    running_map(force=True)
    with STOP_LOCK:
        STOPPING.discard(case.name)
    if running_map(force=True).get(case.name):
        raise ApiError("停止失败，仍有进程在运行")
    return {"ok": True, "message": "求解已强制结束"}


def copy_case(name, new_name):
    src = resolve_case(name)
    new_name = (new_name or "").strip()
    if not CASE_RE.match(new_name):
        raise ApiError("新算例名称不合法")
    dst = BASE / new_name
    if dst.exists():
        raise ApiError(f"目标算例已存在：{new_name}")
    if running_map(force=True).get(name):
        raise ApiError("运行中的算例不能复制")
    src_mb = case_size_mb(src)
    if src_mb > 4096:
        raise ApiError(f"算例 {src_mb} MB，超过 4 GB，暂不复制")
    res = subprocess.run(["cp", "-a", str(src), str(dst)], capture_output=True, text=True, timeout=900)
    if res.returncode != 0:
        raise ApiError("复制失败", detail=(res.stdout + res.stderr)[-800:])
    foam = dst / f"{dst.name}.foam"
    try:
        foam.touch()
    except OSError:
        pass
    return {"ok": True, "name": new_name, "message": f"已复制为 {new_name}"}


def launch_paraview(name):
    case = resolve_case(name)
    foam = case / f"{case.name}.foam"
    if not foam.exists():
        try:
            foam.touch()
        except OSError as exc:
            raise ApiError(f"无法创建 .foam 文件：{exc}")
    env_prefix = (
        "export DISPLAY=:0; export WAYLAND_DISPLAY=wayland-0; "
        "export XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir; export PULSE_SERVER=/mnt/wslg/PulseServer; "
    )
    cmd = (f"source {FOAM_BASHRC} >/dev/null 2>&1 && cd {shlex.quote(str(case))} && {env_prefix}"
           f"nohup paraview {shlex.quote(foam.name)} > /tmp/openfoam-paraview.log 2>&1 & echo $!")
    res = bash_run(cmd, timeout=20)
    pid = (res.stdout or "").strip().splitlines()[-1] if res.stdout.strip() else None
    if not pid or not pid.isdigit():
        raise ApiError("ParaView 启动失败", detail=(res.stdout + res.stderr)[-800:])
    time.sleep(1.5)
    try:
        os.kill(int(pid), 0)
    except OSError:
        log = tail_text("/tmp/openfoam-paraview.log", 8000)
        raise ApiError("ParaView 启动后立即退出", detail=log[-800:])
    return {"ok": True, "pid": int(pid), "message": "ParaView 正在 WSLg 中打开，窗口可能需要几秒"}


def open_folder(name):
    case = resolve_case(name)
    unc = "\\\\wsl.localhost\\OpenFOAM-Ubuntu" + str(case).replace("/", "\\")
    exe = Path("/mnt/c/Windows/explorer.exe")
    if not exe.exists():
        raise ApiError("无法访问 Windows 资源管理器")
    try:
        subprocess.Popen([str(exe), unc], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise ApiError(f"打开文件夹失败：{exc}")
    return {"ok": True, "path": unc}


def environment_info():
    if ENV_CACHE and time.time() - ENV_CACHE.get("_at", 0) < 15:
        return {k: v for k, v in ENV_CACHE.items() if k != "_at"}
    version = ENV_CACHE.get("version") or "?"
    if version == "?":
        res = bash_run(f"source {FOAM_BASHRC} >/dev/null 2>&1 && echo $WM_PROJECT_VERSION", timeout=15)
        if res.stdout.strip():
            version = res.stdout.strip().splitlines()[-1]
    mem_total = mem_avail = None
    try:
        for line in read_text("/proc/meminfo").splitlines():
            if line.startswith("MemTotal:"):
                mem_total = round(int(line.split()[1]) / 1048576, 1)
            elif line.startswith("MemAvailable:"):
                mem_avail = round(int(line.split()[1]) / 1048576, 1)
    except OSError:
        pass
    disk_total = disk_free = None
    try:
        usage = shutil.disk_usage("/home")
        disk_total = round(usage.total / 1073741824, 1)
        disk_free = round(usage.free / 1073741824, 1)
    except OSError:
        pass
    load = [round(x, 2) for x in os.getloadavg()] if hasattr(os, "getloadavg") else []
    ENV_CACHE.update({
        "version": version,
        "cores": os.cpu_count(),
        "host": os.uname().nodename,
        "memTotal": mem_total,
        "memAvail": mem_avail,
        "diskTotal": disk_total,
        "diskFree": disk_free,
        "load": load,
        "pvpython": Path(PVPYTHON).exists(),
        "paraview": Path("/usr/bin/paraview").exists(),
        "caseRoot": str(BASE),
        "uptime": round(time.time() - SERVER_START, 1),
        "_at": time.time(),
    })
    return {k: v for k, v in ENV_CACHE.items() if k != "_at"}


def list_cases():
    if not BASE.is_dir():
        return []
    running = running_map()
    cases = []
    for entry in BASE.iterdir():
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if not (entry / "system" / "controlDict").is_file():
            continue
        try:
            cases.append(summarize_case(entry, running))
        except Exception:  # noqa: BLE001
            continue
    cases.sort(key=lambda c: (-c["ts"], c["name"]))
    for c in cases:
        c.pop("ts", None)
    return cases


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

def api_state():
    return {
        "env": environment_info(),
        "cases": list_cases(),
        "serverTime": now_iso(),
        "guiVersion": "1.0",
    }


def api_case(name):
    case = resolve_case(name)
    control = parse_control(case)
    running = running_map()
    source = source_for_render(case)
    root, proc = latest_dirs(case)
    times_root = [t for t, _ in numeric_dirs(case)]
    times_render = [t for t, _ in numeric_dirs(case if source == "reconstructed" else case / "processor0")]
    fields = fields_in(case, source)
    images = case_images(case)
    mesh = mesh_info(case)
    decompose_path = case / "system" / "decomposeParDict"
    decomp_ranks = None
    if decompose_path.exists():
        m = re.search(r"(?m)^\s*numberOfSubdomains\s+(\d+)\s*;", read_text(decompose_path))
        if m:
            decomp_ranks = int(m.group(1))
    proc_dirs = [p for p in case.glob("processor*") if p.is_dir()]
    foam = case / f"{case.name}.foam"
    if not foam.exists():
        try:
            foam.touch()
        except OSError:
            pass
    forces = force_datasets(case)
    return {
        "name": case.name,
        "path": str(case),
        "control": control,
        "solver": control.get("solver"),
        "endTime": control.get("endTimeNum"),
        "startTime": control.get("startTimeNum"),
        "latestRoot": root,
        "latestProc": proc,
        "latest": max([x for x in (root, proc) if x is not None], default=None),
        "timesRoot": times_root[-400:],
        "timesRender": times_render[-400:],
        "source": source,
        "fields": fields,
        "images": images,
        "logs": log_files(case),
        "dicts": dict_files(case),
        "mesh": mesh,
        "forces": forces,
        "progress": progress_for(case),
        "running": running.get(case.name),
        "sizeMb": case_size_mb(case),
        "modified": now_iso(case.stat().st_mtime),
        "decomposeRanks": decomp_ranks,
        "processorDirs": len(proc_dirs),
        "foamFile": str(foam),
        "hasLog": (case / "log.foamRun").exists(),
    }


def api_log(name, filename, n):
    case = resolve_case(name)
    filename = filename or "log.foamRun"
    if "/" in filename or filename.startswith(".") or not filename.startswith("log"):
        raise ApiError("日志文件名不合法")
    path = case / filename
    if not path.is_file():
        raise ApiError(f"日志不存在：{filename}", status=404)
    lines = tail_lines(path, n)
    st = path.stat()
    return {
        "file": filename,
        "lines": lines,
        "size": st.st_size,
        "mtime": now_iso(st.st_mtime),
        "files": log_files(case),
        "running": bool(running_map().get(case.name)),
    }


def api_dict(name, rel):
    case = resolve_case(name)
    path, rel = safe_dict_path(case, rel)
    st = path.stat()
    return {"path": rel, "text": read_text(path, limit=1_400_000), "mtime": now_iso(st.st_mtime), "size": st.st_size}


def api_dict_save(name, rel, text):
    case = resolve_case(name)
    path, rel = safe_dict_path(case, rel)
    if not isinstance(text, str) or len(text) > 1_400_000:
        raise ApiError("内容为空或过大")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(path.name + f".bak-{stamp}")
    try:
        shutil.copy2(path, backup)
    except OSError:
        backup = None
    tmp = path.with_name(f".{path.name}.tmp-{secrets.token_hex(3)}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return {"ok": True, "path": rel, "backup": backup.name if backup else None, "message": "已保存；运行中的算例将按 runTimeModifiable 生效"}


def api_control(name, key, value):
    case = resolve_case(name)
    allowed_num = {
        "startTime": (0, None), "endTime": (0, None), "deltaT": (1e-12, None),
        "maxCo": (1e-9, None), "maxDeltaT": (1e-12, None), "writeInterval": (1e-12, None),
        "purgeWrite": (0, None),
    }
    allowed_enum = {
        "startFrom": {"startTime", "firstTime", "latestTime"},
        "adjustTimeStep": {"yes", "no"},
        "stopAt": {"endTime", "writeNow", "noWriteNow", "nextWrite"},
        "writeControl": {"timeStep", "runTime", "adjustableRunTime", "clockTime", "cpuTime"},
    }
    key = (key or "").strip()
    value = str(value).strip()
    control = parse_control(case)
    if key in allowed_num:
        num = float_or_none(value)
        if num is None:
            raise ApiError(f"{key} 需要数字")
        low, high = allowed_num[key]
        if low is not None and num < low:
            raise ApiError(f"{key} 必须 ≥ {low}")
        if key == "purgeWrite" and (num < 0 or abs(num - round(num)) > 1e-9):
            raise ApiError("purgeWrite 需要非负整数")
        if key == "endTime" and control.get("startTimeNum") is not None and num <= control["startTimeNum"]:
            raise ApiError("endTime 必须大于 startTime")
        if key == "startTime" and control.get("endTimeNum") is not None and num >= control["endTimeNum"]:
            raise ApiError("startTime 必须小于 endTime")
        value = f"{num:g}"
    elif key in allowed_enum:
        if value not in allowed_enum[key]:
            raise ApiError(f"{key} 允许的值为：{', '.join(sorted(allowed_enum[key]))}")
    else:
        raise ApiError("该参数不允许在此修改")
    res = foam_run(case, f"foamDictionary system/controlDict -entry {key} -set {shlex.quote(value)}", timeout=30)
    out = (res.stdout or "") + (res.stderr or "")
    if res.returncode != 0 or "FOAM FATAL" in out:
        raise ApiError(f"写入 {key} 失败", detail=out[-800:])
    return {"ok": True, "key": key, "value": value, "control": parse_control(case)}


def api_forces(name, dataset):
    case = resolve_case(name)
    result = load_forces(case, dataset)
    if not result.get("available"):
        raise ApiError("该算例还没有力系数数据（postProcessing）", status=404)
    return result


def api_job_start(kind, name, params):
    case = resolve_case(name)
    if kind == "render":
        if not params.get("field"):
            raise ApiError("缺少渲染字段")
        source = source_for_render(case)
        fields = fields_in(case, source)
        if params["field"] not in fields:
            raise ApiError(f"字段 {params['field']} 在最新时间不存在")
        if not Path(PVPYTHON).exists() or not PV_RENDER.exists():
            raise ApiError("ParaView 渲染环境不可用")
        if running_map(force=True).get(name) and source == "decomposed":
            params = dict(params)
            params["note"] = "求解运行中，渲染的是已写出的最新时间"
        jid = new_job("render", name, params=params, title=f"{params['field']} 云图")
    elif kind == "checkmesh":
        jid = new_job("checkmesh", name, title="网格检查")
    else:
        raise ApiError("未知任务类型")
    return {"id": jid}


def api_job_get(jid):
    with JOBS_LOCK:
        job = JOBS.get(jid)
        if not job:
            raise ApiError("任务不存在或已过期", status=404)
        return json.loads(json.dumps(job))


# --------------------------------------------------------------------------- #
# Flow-3D style model setup
# --------------------------------------------------------------------------- #

model_api.configure(
    BASE=BASE,
    resolve_case=resolve_case,
    read_text=read_text,
    bash_run=bash_run,
    foam_run=foam_run,
    now_iso=now_iso,
    ApiError=ApiError,
    running_map=running_map,
    parse_control=parse_control,
    numeric_dirs=numeric_dirs,
    CASE_RE=CASE_RE,
)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpenFOAMWorkbench/1.0"

    def log_message(self, fmt, *args):  # noqa: A003
        if "/api/progress" in (self.path or "") or "/api/state" in (self.path or ""):
            return
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, status, body, content_type="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, data, status=200):
        self._send(status, json.dumps(data, ensure_ascii=False, default=str))

    def error(self, message, status=400, detail=None):
        self.send_json({"error": message, "detail": detail}, status)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        q = {k: v[-1] for k, v in query.items()}
        try:
            if path in ("/", "/index.html"):
                index = STATIC_DIR / "index.html"
                if not index.exists():
                    self.error("前端文件缺失", 500)
                    return
                self._send(200, index.read_bytes(), "text/html; charset=utf-8")
                return
            if path in ("/model", "/model.html"):
                page = STATIC_DIR / "model.html"
                if not page.exists():
                    self.error("模型设置页面缺失", 500)
                    return
                self._send(200, page.read_bytes(), "text/html; charset=utf-8")
                return
            if path in ("/app.css", "/app.js", "/model.css", "/model.js"):
                asset = STATIC_DIR / path.lstrip("/")
                if not asset.is_file():
                    self.error("前端资源缺失", 404)
                    return
                if path.endswith(".css"):
                    ctype = "text/css; charset=utf-8"
                else:
                    ctype = "application/javascript; charset=utf-8"
                self._send(200, asset.read_bytes(), ctype)
                return
            if path == "/favicon.ico":
                self._send(204, b"", "image/x-icon")
                return
            if path == "/api/health":
                self.send_json({"ok": True, "time": now_iso(), "uptime": round(time.time() - SERVER_START, 1)})
                return
            if path == "/api/state":
                self.send_json(api_state())
                return
            if path == "/api/case":
                self.send_json(api_case(q.get("name", "")))
                return
            if path == "/api/model":
                self.send_json(model_api.api_model(q.get("name", "")))
                return
            if path == "/api/templates":
                self.send_json(model_api.api_templates())
                return
            if path == "/api/progress":
                self.send_json(progress_for(resolve_case(q.get("name", ""))))
                return
            if path == "/api/log":
                self.send_json(api_log(q.get("name", ""), q.get("file"), q.get("n", 300)))
                return
            if path == "/api/dict":
                self.send_json(api_dict(q.get("name", ""), q.get("file", "")))
                return
            if path == "/api/forces":
                self.send_json(api_forces(q.get("name", ""), q.get("dataset")))
                return
            if path == "/api/job":
                self.send_json(api_job_get(q.get("id", "")))
                return
            if path == "/media":
                self.serve_media(q.get("path", ""))
                return
            self.error("接口不存在", 404)
        except ApiError as exc:
            self.error(exc.message, exc.status, exc.detail)
        except subprocess.TimeoutExpired as exc:
            self.error(f"命令超时：{exc.cmd}", 500)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.error(f"服务器错误：{type(exc).__name__}: {exc}", 500)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 2_000_000:
                raise ApiError("请求过大", 413)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                raise ApiError("请求 JSON 无效")
            if not isinstance(data, dict):
                raise ApiError("请求 JSON 需为对象")
            if path == "/api/run":
                self.send_json(start_case(data.get("name", ""), data.get("ranks", 1), data.get("startFrom", "latestTime")))
                return
            if path == "/api/stop":
                self.send_json(stop_case(data.get("name", "")))
                return
            if path == "/api/control":
                self.send_json(api_control(data.get("name", ""), data.get("key", ""), data.get("value", "")))
                return
            if path == "/api/model/save":
                self.send_json(model_api.api_model_save(
                    data.get("name", ""), data.get("section", ""), data.get("values") or {}))
                return
            if path == "/api/create":
                self.send_json(model_api.api_create(data.get("values") or {}))
                return
            if path == "/api/blockmesh":
                self.send_json(model_api.api_blockmesh(data.get("name", "")))
                return
            if path == "/api/dict/save":
                self.send_json(api_dict_save(data.get("name", ""), data.get("file", ""), data.get("text", "")))
                return
            if path == "/api/copy":
                self.send_json(copy_case(data.get("name", ""), data.get("newName", "")))
                return
            if path == "/api/job":
                self.send_json(api_job_start(data.get("kind", ""), data.get("name", ""), data.get("params") or {}))
                return
            if path == "/api/paraview":
                self.send_json(launch_paraview(data.get("name", "")))
                return
            if path == "/api/openfolder":
                self.send_json(open_folder(data.get("name", "")))
                return
            self.error("接口不存在", 404)
        except ApiError as exc:
            self.error(exc.message, exc.status, exc.detail)
        except subprocess.TimeoutExpired as exc:
            self.error(f"命令超时：{exc.cmd}", 500)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.error(f"服务器错误：{type(exc).__name__}: {exc}", 500)

    def serve_media(self, raw_path):
        try:
            path = Path(unquote(raw_path)).resolve()
        except (ValueError, OSError):
            self.error("路径无效", 400)
            return
        allowed = False
        allowed_roots = [BASE.resolve()]
        for root in allowed_roots:
            try:
                path.relative_to(root)
                allowed = True
                break
            except ValueError:
                continue
        if not allowed or not path.is_file():
            self.error("文件不存在或不允许访问", 404)
            return
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"}:
            self.error("不支持的文件类型", 403)
            return
        st = path.stat()
        size = st.st_size
        etag = f'"{int(st.st_mtime)}-{size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            spec = range_header[6:].split(",")[0].strip()
            if "-" in spec:
                left, right = spec.split("-", 1)
                try:
                    if left:
                        start = int(left)
                    if right:
                        end = int(right)
                except ValueError:
                    start, end = 0, size - 1
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "public, max-age=120")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    GUI_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"OpenFOAM Workbench listening on http://{HOST}:{PORT}", flush=True)
    print(f"Cases: {BASE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
