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

echo "== Profiling with Nsight Compute (--set full) =="
if run_ncu ncu_full.log --set full; then
    NCU_OK=1
elif grep -qi "ERR_NVGPUCTRPERM" ncu_full.log; then
    echo "NCU SKIPPED: ERR_NVGPUCTRPERM — this host denies GPU performance counter access (needs elevated privileges / NVreg_RestrictProfilingToAdminUsers=0)"
    cat ncu_full.log
    exit 0
else
    echo "-- --set full failed/unsupported, falling back to --section SpeedOfLight --section LaunchStats --"
    cat ncu_full.log
    if run_ncu ncu_fallback.log --section SpeedOfLight --section LaunchStats; then
        NCU_OK=1
    elif grep -qi "ERR_NVGPUCTRPERM" ncu_fallback.log; then
        echo "NCU SKIPPED: ERR_NVGPUCTRPERM — this host denies GPU performance counter access (needs elevated privileges / NVreg_RestrictProfilingToAdminUsers=0)"
        cat ncu_fallback.log
        exit 0
    else
        echo "NCU SKIPPED: ncu failed for an unexpected reason (see below); arithmetic correctness already passed"
        cat ncu_fallback.log
        exit 0
    fi
fi

if [ "${NCU_OK:-0}" -eq 1 ] && [ -f arith_report.ncu-rep ]; then
    echo "== Nsight Compute report written to arith_ncu/arith_report.ncu-rep =="
    echo "== ncu --import arith_report.ncu-rep --page details | head -100 =="
    "$NCU_BIN" --import arith_report.ncu-rep --page details | head -100
else
    echo "NCU SKIPPED: no report file produced despite a zero exit status"
fi
