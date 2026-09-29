import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { runSandbox, sandboxSettings, stripImageBanner, type DockerRunner } from '../exec/sandbox.js';

/**
 * NVIDIA's CUDA / NGC images print a license banner from their entrypoint before every command.
 * It filled the top of every 試跑 and verification output and used up the kept head of it; the
 * sandbox now drops it — only when the output starts with it, and never what follows the license.
 */

const CUDA_BANNER = `
==========
== CUDA ==
==========

CUDA Version 13.0.0

Container image Copyright (c) 2016-2023, NVIDIA CORPORATION & AFFILIATES. All rights reserved.

This container image and its contents are governed by the NVIDIA Deep Learning Container License.
By pulling and using the container, you accept the terms and conditions of this license:
https://developer.nvidia.com/ngc/nvidia-deep-learning-container-license

A copy of this license is made available in this container at /NGC-DL-CONTAINER-LICENSE for your convenience.

`;

const PYTORCH_BANNER = `=============
== PyTorch ==
=============

NVIDIA Release 24.01 (build 80741402)
PyTorch Version 2.2.0a0+81ea7a4

Container image Copyright (c) 2023, NVIDIA CORPORATION & AFFILIATES. All rights reserved.

This container image and its contents are governed by the NVIDIA Deep Learning Container License.
By pulling and using the container, you accept the terms and conditions of this license:
https://developer.nvidia.com/ngc/nvidia-deep-learning-container-license

WARNING: The NVIDIA Driver was not detected.  GPU functionality will not be available.
`;

describe('stripImageBanner', () => {
  it('drops the CUDA banner and keeps the command output from its first line', () => {
    expect(stripImageBanner(`${CUDA_BANNER}== Building arith_kernel ==\nvec_add: PASS\n`)).toBe('== Building arith_kernel ==\nvec_add: PASS\n');
  });

  it('keeps what the entrypoint says after the license (a missing driver is worth seeing)', () => {
    const out = stripImageBanner(`${PYTORCH_BANNER}\npython train.py\n`);
    expect(out.startsWith('WARNING: The NVIDIA Driver was not detected.')).toBe(true);
    expect(out).toContain('python train.py');
  });

  it('leaves any other output alone — including a banner-looking block that is not at the start', () => {
    expect(stripImageBanner('== Building ==\nok\n')).toBe('== Building ==\nok\n');
    const late = `step 1\n${CUDA_BANNER}`;
    expect(stripImageBanner(late)).toBe(late);
    const noLicense = '==========\n== Tool ==\n==========\nplain output\n';
    expect(stripImageBanner(noLicense)).toBe(noLicense);
  });
});

describe('runSandbox output', () => {
  let db: Database.Database;
  let work: string;
  beforeEach(() => {
    db = openTestDb();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-exec-banner-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('comes back without the image banner', async () => {
    const runner: DockerRunner = async () => ({ code: 0, output: `${CUDA_BANNER}vec_add: PASS\n`, truncated: false, timedOut: false, aborted: false });
    const r = await runSandbox({ ...sandboxSettings(db), enabled: true }, { workdir: work, command: 'bash run.sh' }, { runner, uid: 1, gid: 1 });
    expect(r.output).toBe('vec_add: PASS\n');
  });
});
