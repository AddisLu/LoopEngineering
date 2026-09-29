// CUDA arithmetic micro-benchmark: vec_add / vec_sub / vec_mul / vec_div
// over N = 1<<22 float elements, each op a grid-stride-loop kernel.
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

__global__ void vec_add(const float *a, const float *b, float *c, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] + b[i];
    }
}

__global__ void vec_sub(const float *a, const float *b, float *c, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] - b[i];
    }
}

__global__ void vec_mul(const float *a, const float *b, float *c, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = a[i] * b[i];
    }
}

// b is shifted by +1.0f before dividing so the denominator can never land on
// (or straddle) zero for the random inputs generated below, avoiding NaN/Inf.
__global__ void vec_div(const float *a, const float *b, float *c, int n) {
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n;
         i += blockDim.x * gridDim.x) {
        c[i] = fdividef(a[i], b[i] + 1.0f);
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
            case '/': ref = a[i] / (b[i] + 1.0f); break;
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
        h_b[i] = (float)rand() / (float)RAND_MAX * 10.0f - 5.0f;
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
