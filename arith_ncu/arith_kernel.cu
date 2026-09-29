// CUDA arithmetic micro-benchmark: vec_add / vec_sub / vec_mul / vec_div
// over N = 1<<22 float elements, each op a grid-stride-loop kernel using
// float4 (128-bit) loads/stores with a scalar tail for any n % 4 remainder.
// Build: nvcc -O3 -lineinfo -arch=sm_121 -o arith_kernel arith_kernel.cu
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cuda_runtime.h>

#define N (1 << 22)
#define DEFAULT_THREADS_PER_BLOCK 256
#define TOLERANCE 1e-5

#define CUDA_CHECK(call)                                                     \
    do {                                                                     \
        cudaError_t err__ = (call);                                          \
        if (err__ != cudaSuccess) {                                          \
            fprintf(stderr, "CUDA error at %s:%d: %s\n", __FILE__, __LINE__, \
                    cudaGetErrorString(err__));                              \
            exit(1);                                                         \
        }                                                                    \
    } while (0)

// Each kernel walks the bulk of the array as float4 (128-bit) loads/stores —
// one grid-stride loop over n/4 vector groups — then a second grid-stride
// loop mops up the [n/4*4, n) tail with scalar accesses, so n need not be a
// multiple of 4. cudaMalloc buffers are always sufficiently aligned for
// float4 reinterpretation.
__global__ void vec_add(const float *a, const float *b, float *c, int n) {
    const int n4 = n / 4;
    const float4 *a4 = reinterpret_cast<const float4 *>(a);
    const float4 *b4 = reinterpret_cast<const float4 *>(b);
    float4 *c4 = reinterpret_cast<float4 *>(c);
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n4;
         i += blockDim.x * gridDim.x) {
        float4 av = a4[i];
        float4 bv = b4[i];
        c4[i] = make_float4(av.x + bv.x, av.y + bv.y, av.z + bv.z, av.w + bv.w);
    }
    const int tail_start = n4 * 4;
    for (int i = tail_start + blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] + b[i];
    }
}

__global__ void vec_sub(const float *a, const float *b, float *c, int n) {
    const int n4 = n / 4;
    const float4 *a4 = reinterpret_cast<const float4 *>(a);
    const float4 *b4 = reinterpret_cast<const float4 *>(b);
    float4 *c4 = reinterpret_cast<float4 *>(c);
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n4;
         i += blockDim.x * gridDim.x) {
        float4 av = a4[i];
        float4 bv = b4[i];
        c4[i] = make_float4(av.x - bv.x, av.y - bv.y, av.z - bv.z, av.w - bv.w);
    }
    const int tail_start = n4 * 4;
    for (int i = tail_start + blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] - b[i];
    }
}

__global__ void vec_mul(const float *a, const float *b, float *c, int n) {
    const int n4 = n / 4;
    const float4 *a4 = reinterpret_cast<const float4 *>(a);
    const float4 *b4 = reinterpret_cast<const float4 *>(b);
    float4 *c4 = reinterpret_cast<float4 *>(c);
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n4;
         i += blockDim.x * gridDim.x) {
        float4 av = a4[i];
        float4 bv = b4[i];
        c4[i] = make_float4(av.x * bv.x, av.y * bv.y, av.z * bv.z, av.w * bv.w);
    }
    const int tail_start = n4 * 4;
    for (int i = tail_start + blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] * b[i];
    }
}

// b[] is generated as fabsf(cosf(i * 0.013f)) + 1.0f, i.e. always in [1, 2],
// so the denominator stays > 0.5 by construction and division can never hit
// (or straddle) zero — no NaN/Inf, no near-zero blow-ups.
__global__ void vec_div(const float *a, const float *b, float *c, int n) {
    const int n4 = n / 4;
    const float4 *a4 = reinterpret_cast<const float4 *>(a);
    const float4 *b4 = reinterpret_cast<const float4 *>(b);
    float4 *c4 = reinterpret_cast<float4 *>(c);
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n4;
         i += blockDim.x * gridDim.x) {
        float4 av = a4[i];
        float4 bv = b4[i];
        c4[i] = make_float4(fdividef(av.x, bv.x), fdividef(av.y, bv.y),
                             fdividef(av.z, bv.z), fdividef(av.w, bv.w));
    }
    const int tail_start = n4 * 4;
    for (int i = tail_start + blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = fdividef(a[i], b[i]);
    }
}

static bool verify(const char *name, const float *c_gpu, const float *a,
                    const float *b, int n, char op) {
    double max_err = 0.0;
    int first_bad = -1;
    for (int i = 0; i < n; ++i) {
        float ref;
        switch (op) {
            case '+': ref = a[i] + b[i]; break;
            case '-': ref = a[i] - b[i]; break;
            case '*': ref = a[i] * b[i]; break;
            case '/': ref = a[i] / b[i]; break;
            default:  ref = 0.0f; break;
        }
        double err = fabs((double)c_gpu[i] - (double)ref);
        if (err > max_err) max_err = err;
        if (err > TOLERANCE && first_bad < 0) first_bad = i;
    }
    bool ok = first_bad < 0;
    printf("%s: %s (max abs err = %.3e)\n", name, ok ? "PASS" : "FAIL", max_err);
    if (!ok) {
        fprintf(stderr, "  first mismatch at i=%d: gpu=%f\n", first_bad,
                c_gpu[first_bad]);
    }
    return ok;
}

int main(int argc, char **argv) {
    int threads_per_block = DEFAULT_THREADS_PER_BLOCK;
    if (argc > 1) {
        threads_per_block = atoi(argv[1]);
        if (threads_per_block <= 0) threads_per_block = DEFAULT_THREADS_PER_BLOCK;
    }

    const int n = N;
    const size_t bytes = (size_t)n * sizeof(float);

    float *h_a = (float *)malloc(bytes);
    float *h_b = (float *)malloc(bytes);
    float *h_c = (float *)malloc(bytes);
    if (!h_a || !h_b || !h_c) {
        fprintf(stderr, "host allocation failed\n");
        return 1;
    }

    srand(42);
    for (int i = 0; i < n; ++i) {
        h_a[i] = (float)rand() / (float)RAND_MAX * 10.0f - 5.0f;
        // Deterministic, strictly positive: [1, 2] — safe vec_div denominator.
        h_b[i] = fabsf(cosf((float)i * 0.013f)) + 1.0f;
    }

    float *d_a, *d_b, *d_c;
    CUDA_CHECK(cudaMalloc((void **)&d_a, bytes));
    CUDA_CHECK(cudaMalloc((void **)&d_b, bytes));
    CUDA_CHECK(cudaMalloc((void **)&d_c, bytes));
    CUDA_CHECK(cudaMemcpy(d_a, h_a, bytes, cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(d_b, h_b, bytes, cudaMemcpyHostToDevice));

    int blocks = (n + threads_per_block - 1) / threads_per_block;
    const int max_blocks = 1024; // keep it a genuine grid-stride loop
    if (blocks > max_blocks) blocks = max_blocks;

    printf("N=%d threads_per_block=%d blocks=%d\n", n, threads_per_block, blocks);

    bool all_pass = true;

    vec_add<<<blocks, threads_per_block>>>(d_a, d_b, d_c, n);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    CUDA_CHECK(cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost));
    all_pass &= verify("vec_add", h_c, h_a, h_b, n, '+');

    vec_sub<<<blocks, threads_per_block>>>(d_a, d_b, d_c, n);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    CUDA_CHECK(cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost));
    all_pass &= verify("vec_sub", h_c, h_a, h_b, n, '-');

    vec_mul<<<blocks, threads_per_block>>>(d_a, d_b, d_c, n);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    CUDA_CHECK(cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost));
    all_pass &= verify("vec_mul", h_c, h_a, h_b, n, '*');

    vec_div<<<blocks, threads_per_block>>>(d_a, d_b, d_c, n);
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    CUDA_CHECK(cudaMemcpy(h_c, d_c, bytes, cudaMemcpyDeviceToHost));
    all_pass &= verify("vec_div", h_c, h_a, h_b, n, '/');

    cudaFree(d_a);
    cudaFree(d_b);
    cudaFree(d_c);
    free(h_a);
    free(h_b);
    free(h_c);

    return all_pass ? 0 : 1;
}
