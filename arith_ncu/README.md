# arith_ncu — CUDA add/sub/mul/div benchmark + Nsight Compute profile

Standalone CUDA program that runs four elementwise kernels — `vec_add`,
`vec_sub`, `vec_mul`, `vec_div` — over `N = 1<<22` (≈4.19M) `float` elements,
cross-checks each result against a CPU reference, then (best-effort) profiles
the kernels with Nsight Compute (`ncu`).

## Files

- `arith_kernel.cu` — the four kernels (grid-stride loop, 256 threads/block by
  default, configurable via `argv[1]`) plus a `main()` that allocates/copies
  the input, runs each kernel, copies the result back, and verifies it
  against a CPU loop with `1e-5` tolerance. `a[i]` is uniform random in
  `[-5, 5)`; `b[i] = fabsf(cosf(i * 0.013f)) + 1.0f` is deterministic and
  always in `[1, 2]`. `vec_div` therefore divides by a denominator that is
  `> 0.5` by construction — it can never reach zero, straddle zero, or produce
  NaN/Inf or near-zero blow-ups.
- `run_ncu.sh` — builds with `nvcc -O3 -lineinfo -arch=sm_121`, runs the
  correctness check, then profiles with `ncu --set full` (falling back to
  `--section SpeedOfLight --section LaunchStats` if `--set full` isn't
  supported on this toolkit/driver combo).

## Build & run

```bash
bash arith_ncu/run_ncu.sh
```

This is the single entry point: it builds, runs the correctness check
(prints one `PASS`/`FAIL` line per op), and profiles with `ncu` if available.

To build/run manually instead:

```bash
cd arith_ncu
nvcc -O3 -lineinfo -arch=sm_121 -o arith_kernel arith_kernel.cu
./arith_kernel            # optional argv[1] = threads per block (default 256)
```

Exit code is non-zero if any op's CPU cross-check fails.

## Environment notes (NVIDIA DGX Spark / GB10)

This target is `sm_121` (compute capability 12.1, GB10 Grace Blackwell), not
the datacenter Blackwell `sm_100` — the `-arch=sm_121` flag matters. The
toolkit is typically installed at `/usr/local/cuda` without being on `PATH`;
`run_ncu.sh` adds `/usr/local/cuda/bin` to `PATH` itself so it works whether
or not your shell already has it.

GB10 has no discrete VRAM — CPU and GPU share 128 GB of LPDDR5x over
NVLink-C2C at ≈273 GB/s. That ceiling (not a datacenter HBM number) is the
right one to compare memory-bound kernels against.

## Reading the Nsight Compute report

`run_ncu.sh` exports `arith_report.ncu-rep` and prints a SpeedOfLight /
LaunchStats summary — the first 100 lines of
`ncu --import arith_report.ncu-rep --page details` piped through
`sed -n '1,100p'` (`head` would close the pipe early and kill `ncu` with
SIGPIPE under `set -o pipefail`) — followed by the key metric lines.
To reopen it later:

```bash
ncu --import arith_ncu/arith_report.ncu-rep --page details | less
# or open arith_ncu/arith_report.ncu-rep in the Nsight Compute GUI
```

Key metrics per kernel, in order of what to check first:

1. **SOL (Speed of Light) Compute % and Memory %** — the top-line roofline
   numbers. All four kernels here are single elementwise ops on three
   float arrays (2 reads + 1 write per element, ~1 FLOP), so they're
   memory-bandwidth-bound: expect **Memory % ≫ Compute %**. On GB10's
   unified-memory bus, achieved bandwidth should be judged against
   ≈273 GB/s, not a discrete-GPU HBM figure.
2. **Achieved Occupancy** vs theoretical occupancy — with 256 threads/block
   and a grid capped at 1024 blocks (see `arith_kernel.cu`), check this isn't
   being left on the table; low achieved occupancy relative to theoretical
   usually means too few resident blocks/waves to hide memory latency.
3. **Waves Per SM** — how many full waves of blocks the grid launches across
   all 48 SMs. A launch that's well under one wave leaves SMs idle; this is
   the first thing to check if SOL Memory % looks lower than the roofline
   suggests it should.
4. **DRAM/L2 throughput** (Memory Workload Analysis section) — confirms
   whether the kernel is actually saturating the unified-memory path, and
   whether L2 (24 MB on GB10) is absorbing any reuse (it shouldn't, for this
   access pattern — each element is touched once).

If `ncu` isn't installed or the host denies GPU performance counter access
(`ERR_NVGPUCTRPERM` — common in containers/VMs without
`--cap-add=SYS_ADMIN` or without `NVreg_RestrictProfilingToAdminUsers=0`),
`run_ncu.sh` prints `NCU SKIPPED: <reason>` and still exits 0: the
arithmetic correctness check is the hard gate, profiling is best-effort.
