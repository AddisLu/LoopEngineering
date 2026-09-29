#!/usr/bin/env bash
# Build arith_kernel, run the CPU cross-check, then best-effort profile it
# with Nsight Compute. Correctness (4x PASS) is the hard gate; NCU is
# best-effort and must never fail the script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# DGX Spark (and many CUDA hosts) don't put the toolkit on PATH by default.
export PATH="/usr/local/cuda/bin:${PATH}"

NVCC_BIN="$(command -v nvcc || true)"
if [ -z "$NVCC_BIN" ]; then
    echo "nvcc not found on PATH (checked /usr/local/cuda/bin too)" >&2
    exit 1
fi

echo "== Building arith_kernel =="
"$NVCC_BIN" -O3 -lineinfo -arch=sm_121 -o arith_kernel arith_kernel.cu

echo "== Running correctness check =="
./arith_kernel

echo "== Correctness check passed, looking for Nsight Compute =="
NCU_BIN="$(command -v ncu || true)"
if [ -z "$NCU_BIN" ]; then
    echo "NCU SKIPPED: ncu not found on PATH (checked /usr/local/cuda/bin too)"
    exit 0
fi

run_ncu() {
    # $1 = log file, remaining args = ncu section/set flags
    local log="$1"
    shift
    set +e
    "$NCU_BIN" "$@" --export arith_report --force-overwrite ./arith_kernel >"$log" 2>&1
    local status=$?
    set -e
    return $status
}

show_ncu_log() {
    # ncu captures the target app's stdout in its log; ./arith_kernel above is
    # the single canonical printer of the PASS/FAIL lines, so strip them (and
    # the "N=..." header) here to avoid printing them a second time.
    grep -vE '^(vec_(add|sub|mul|div): |N=[0-9])' "$1" || true
}

echo "== Profiling with Nsight Compute (--set full) =="
if run_ncu ncu_full.log --set full; then
    NCU_OK=1
elif grep -qi "ERR_NVGPUCTRPERM" ncu_full.log; then
    echo "NCU SKIPPED: ERR_NVGPUCTRPERM — this host denies GPU performance counter access (needs elevated privileges / NVreg_RestrictProfilingToAdminUsers=0)"
    show_ncu_log ncu_full.log
    exit 0
else
    echo "-- --set full failed/unsupported, falling back to --section SpeedOfLight --section LaunchStats --"
    show_ncu_log ncu_full.log
    if run_ncu ncu_fallback.log --section SpeedOfLight --section LaunchStats; then
        NCU_OK=1
    elif grep -qi "ERR_NVGPUCTRPERM" ncu_fallback.log; then
        echo "NCU SKIPPED: ERR_NVGPUCTRPERM — this host denies GPU performance counter access (needs elevated privileges / NVreg_RestrictProfilingToAdminUsers=0)"
        show_ncu_log ncu_fallback.log
        exit 0
    else
        echo "NCU SKIPPED: ncu failed for an unexpected reason (see below); arithmetic correctness already passed"
        show_ncu_log ncu_fallback.log
        exit 0
    fi
fi

if [ "${NCU_OK:-0}" -eq 1 ] && [ -f arith_report.ncu-rep ]; then
    echo "== Nsight Compute report written to arith_ncu/arith_report.ncu-rep =="
    echo "== SpeedOfLight / LaunchStats summary =="
    # NOTE: use `sed -n '1,Np'`, not `head`: head closes the pipe early and the
    # ncu import process dies with SIGPIPE (141), which `set -o pipefail` would
    # turn into a script failure. sed drains stdin to EOF. The import is only a
    # summary display (the hard gates — correctness + report export — already
    # passed), so its status is exempted; it must never flip the exit code.
    { "$NCU_BIN" --import arith_report.ncu-rep --page details 2>&1 || true; } \
        | sed -n '1,100p'
    echo "== Key metrics (Compute (SM) Throughput / Memory Throughput / Achieved Occupancy / Duration) =="
    { "$NCU_BIN" --import arith_report.ncu-rep --page details 2>&1 || true; } \
        | grep -E 'Duration|Compute \(SM\) Throughput|Memory Throughput|Achieved Occupancy' \
        | sed -n '1,80p' || true
else
    echo "NCU SKIPPED: no report file produced despite a zero exit status"
fi
