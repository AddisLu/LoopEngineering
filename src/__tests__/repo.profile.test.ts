import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyseRepo } from '../repo/profile/analyse.js';
import { detectEncoding } from '../repo/profile/context.js';
import type { RepoAnalysis, Requirement } from '../repo/profile/types.js';

/**
 * Repo 檔案 stage A on hermetic fixture repos (git init in os.tmpdir(), no network, no model):
 * an MSVC + MIL project, a CMake + CUDA project, an Avalonia app, Python tools, an ini config,
 * a Big5 file, a CRLF/tab file and a history with fix commits.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const roots: string[] = [];

function newRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function put(dir: string, file: string, content: string | Buffer): void {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commitAll(dir: string, msg: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
}

const VCXPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" ToolsVersion="17.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Release|x64">
      <Configuration>Release</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'" Label="Configuration">
    <ConfigurationType>Application</ConfigurationType>
    <PlatformToolset>v143</PlatformToolset>
  </PropertyGroup>
  <ImportGroup Label="ExtensionSettings">
    <Import Project="$(VCTargetsPath)\\BuildCustomizations\\CUDA 12.2.props" />
  </ImportGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <ClCompile>
      <AdditionalIncludeDirectories>$(MIL_PATH)\\..\\include;$(OPENCV_DIR)\\include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Windows</SubSystem>
      <AdditionalDependencies>opencv_world480.lib;mil.lib;kernel32.lib;%(AdditionalDependencies)</AdditionalDependencies>
    </Link>
    <CudaCompile>
      <CodeGeneration>compute_86,sm_86</CodeGeneration>
    </CudaCompile>
  </ItemDefinitionGroup>
  <ItemGroup>
    <ClCompile Include="src\\grab.cpp" />
    <ClCompile Include="src\\legacy.cpp" />
    <ClInclude Include="src\\grab.h" />
  </ItemGroup>
</Project>
`;

const SLN = `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Vision", "Vision.vcxproj", "{11111111-2222-3333-4444-555555555555}"
EndProject
`;

// CRLF line endings, tab indentation, Chinese comments, m_ members, MIL calls
const GRAB_CPP = [
  '#include "grab.h"',
  '#include <Mil.h>',
  '',
  '// 擷取卡初始化',
  'int Grabber::open() {',
  '\tMIL_ID app = MappAlloc(M_NULL, M_DEFAULT, M_NULL);',
  '\tm_system = MsysAlloc(M_DEFAULT, M_SYSTEM_RAPIXOCXP, M_DEV0, M_DEFAULT, M_NULL);',
  '\tm_digitizer = MdigAlloc(m_system, M_DEV0, MIL_TEXT("line.dcf"), M_DEFAULT, M_NULL);',
  '\tm_image = MbufAlloc2d(m_system, m_width, m_height, 8 + M_UNSIGNED, M_IMAGE + M_GRAB, M_NULL);',
  '\t// 檢查錯誤',
  '\tif (MappGetError(M_DEFAULT, M_GLOBAL, M_NULL) != M_NULL_ERROR) {',
  '\t\treturn -1;',
  '\t}',
  '\tMblobCalculate(m_blobContext, m_image, M_NULL, m_blobResult);',
  '\treturn 0;',
  '}',
  '',
].join('\r\n');

const GRAB_H = [
  '#ifndef GRAB_H',
  '#define GRAB_H',
  '// 擷取類別',
  'class Grabber {',
  'public:',
  '\tint open();',
  'private:',
  '\tlong m_system = 0;',
  '\tlong m_digitizer = 0;',
  '\tlong m_image = 0;',
  '\tint m_width = 0;',
  '\tint m_height = 0;',
  '};',
  '#endif',
  '',
].join('\r\n');

const CMAKE = `cmake_minimum_required(VERSION 3.24)
project(cfaoi_ip LANGUAGES CXX CUDA)
set(CMAKE_CXX_STANDARD 17)
find_package(CUDAToolkit REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgproc)
find_package(fmt REQUIRED)
find_library(ORT_LIB onnxruntime QUIET)
add_executable(cfaoi_ip src/main.cpp)
target_link_libraries(cfaoi_ip PRIVATE fmt::fmt)
`;

const IP_MAIN = `#include <iostream>
#include <string>
#include <fmt/core.h>
#include <opencv2/core.hpp>
#include "config_parser.h"

#define ERR_GRAB_TIMEOUT 1203

enum class GrabError {
    Ok = 0,
    Timeout = 1203,
    Lost,
};

static void record_incident(const std::string& kind, const std::string& detail) {
    std::cerr << "[incident] " << kind << detail << std::endl;
}

int parse_frame(const std::string& path) {
    try {
        throw std::runtime_error("bad");
    } catch (const std::exception& e) {
        record_incident("bad_json", e.what());
    }
    return 0;
}

int main(int argc, char** argv) {
    std::string ini = "config/default.ini";
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--ini" && i + 1 < argc) ini = argv[++i];
    }
    if (ini.empty()) {
        std::cerr << "Failed to open config file: " << ini << std::endl;
        return 1;
    }
    fmt::print("pattern pitch {} px\\n", 26);
    return parse_frame(ini);
}
`;

const CONFIG_PARSER = `#pragma once
#include <string>

struct PatternConfig {
    int pitch_x = 0;
};

inline void apply_key(PatternConfig& config, const std::string& key, const std::string& value) {
    if (key == "pitch_x") {
        config.pitch_x = std::stoi(value);
    }
}
`;

const KERNELS_CU = `#include <cuda_runtime.h>
__global__ void kernel_threshold(const unsigned char* in, unsigned char* out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        out[i] = in[i] > 128 ? 255 : 0;
    }
}
`;

const INI = `# Pattern 設定
[Pattern]
# Pattern pitch (px)
pitch_x = 26
pitch_y = 19 ; inline note
`;

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Avalonia" Version="11.2.3" />
    <PackageReference Include="Avalonia.Desktop" Version="11.2.3" />
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.1" />
  </ItemGroup>
</Project>
`;

const PROGRAM_CS = `using Avalonia;
using System;

namespace Control;

sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>().UsePlatformDetect();
}
`;

const APP_CS = `using Avalonia;

namespace Control;

public partial class App : Application
{
    private readonly object _gate = new();
    private int _count;
    private string _name = "";

    public override void Initialize()
    {
        Console.WriteLine("App initialize starting");
    }

    public void LoadRecipe(string path)
    {
        Console.WriteLine("Loading recipe file now");
    }
}
`;

const MEASURE_PY = `import argparse
import numpy as np


def measure_pitch(values):
    """Average pitch."""
    return float(np.mean(values))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    args = ap.parse_args()
    print(f"pitch measured from {args.input}")


if __name__ == "__main__":
    main()
`;

const TEST_PY = `from tools.measure import measure_pitch


def test_measure_pitch():
    assert measure_pitch([1, 3]) == 2.0
`;

let repo: string;
let result: RepoAnalysis;
const req = (kind: Requirement['kind'], name: string, module?: string | null) =>
  result.facets.requirements.find((r) => r.kind === kind && r.name === name && (module === undefined || r.module === module));

beforeAll(() => {
  repo = newRepo('loop-profile-');
  put(repo, '.clang-format', 'BasedOnStyle: LLVM\nIndentWidth: 4\n');
  put(repo, 'vision/Vision.sln', SLN);
  put(repo, 'vision/Vision.vcxproj', VCXPROJ);
  put(repo, 'vision/src/grab.cpp', GRAB_CPP);
  put(repo, 'vision/src/grab.h', GRAB_H);
  // Big5 「中文」 inside a comment, CRLF
  put(repo, 'vision/src/legacy.cpp', Buffer.concat([Buffer.from('// '), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from('\r\nint legacy_value() {\r\n\treturn 0;\r\n}\r\n')]));
  put(repo, 'vision/cams/line.dcf', 'camera config\n');
  put(repo, 'ip/CMakeLists.txt', CMAKE);
  put(repo, 'ip/src/main.cpp', IP_MAIN);
  put(repo, 'ip/src/config_parser.h', CONFIG_PARSER);
  put(repo, 'ip/src/kernels.cu', KERNELS_CU);
  put(repo, 'ip/config/default.ini', INI);
  put(repo, 'control/Control.csproj', CSPROJ);
  put(repo, 'control/Program.cs', PROGRAM_CS);
  put(repo, 'control/App.axaml.cs', APP_CS);
  put(repo, 'py/requirements.txt', 'numpy==1.26.4\nopencv-python>=4.8\n');
  put(repo, 'py/tools/__init__.py', '');
  put(repo, 'py/tools/measure.py', MEASURE_PY);
  put(repo, 'py/tests/test_measure.py', TEST_PY);
  put(repo, 'py/eval_score.py', 'print("score computed for run")\n');
  put(repo, 'py/golden/answers.csv', 'id,label\n1,ok\n');
  put(repo, 'build/generated.cpp', 'int ignored_build_output() { return 0; }\n');
  put(repo, '.gitignore', '');
  commitAll(repo, 'feat: initial import');
  put(repo, 'ip/src/main.cpp', IP_MAIN.replace('return 1;', 'return 2;'));
  commitAll(repo, 'fix: grab timeout handling');
  put(repo, 'ip/src/main.cpp', IP_MAIN.replace('return 1;', 'return 3;'));
  commitAll(repo, '修正 config 讀取錯誤');
  put(repo, 'py/eval_score.py', 'print("score computed for the run")\n');
  commitAll(repo, 'feat: tweak score');
  result = analyseRepo(repo);
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('repo profile — basics', () => {
  it('reports the sha, timing and no warnings', () => {
    expect(result.facets.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(result.facets.built_ms).toBeGreaterThanOrEqual(0);
    expect(result.facets.warnings).toEqual([]);
  });

  it('detects encodings', () => {
    expect(detectEncoding(Buffer.from('abc'))).toBe('ascii');
    expect(detectEncoding(Buffer.from('中文'))).toBe('utf8');
    expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf8_bom');
    expect(detectEncoding(Buffer.from([0x2f, 0x2f, 0xa4, 0xa4, 0xa4, 0xe5]))).toBe('big5');
  });

  it('never throws on a directory that is not a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-profile-nogit-'));
    roots.push(dir);
    const r = analyseRepo(dir);
    expect(r.facets.sha).toBeNull();
    expect(r.facets.warnings.length).toBeGreaterThan(0);
    expect(r.index).toEqual([]);
  });

  it('uses the injected git and survives it failing', () => {
    const calls: string[][] = [];
    const r = analyseRepo(repo, {
      git: (args) => {
        calls.push(args);
        throw new Error('boom');
      },
    });
    expect(calls.some((a) => a.includes('ls-files'))).toBe(true);
    expect(r.facets.warnings.some((w) => w.includes('boom'))).toBe(true);
    expect(r.facets.modules).toEqual([]);
  });
});

describe('repo profile — requirements', () => {
  it('reads the MSVC project: toolset, SDK, platform, CUDA, GPU arch, libs, GUI subsystem', () => {
    expect(req('toolchain', 'Visual Studio 2022 (v143)', 'Vision')).toBeTruthy();
    expect(req('sdk', 'Windows SDK', 'Vision')?.version).toContain('10.0');
    expect(req('arch', 'x64', 'Vision')).toBeTruthy();
    const win = req('os', 'Windows', 'Vision')!;
    expect(win.note).toContain('GUI');
    expect(win.evidence[0]).toMatchObject({ file: 'vision/Vision.vcxproj' });
    const cuda = req('sdk', 'CUDA', 'Vision')!;
    expect(cuda.version).toBe('12.2');
    expect(cuda.evidence[0]!.line).toBeGreaterThan(1);
    const gpu = req('gpu', '最低 GPU 架構 sm_86', 'Vision')!;
    expect(gpu.version).toBe('8.6');
    expect(gpu.note).toBe('RTX 30 系列以上');
    expect(req('library', 'OpenCV', 'Vision')?.version).toBe('4.8.0');
    expect(result.facets.requirements.some((r) => r.name === 'kernel32')).toBe(false);
  });

  it('reads MIL use: board, license, camera and dcf, modules used', () => {
    const mil = req('library', 'MIL', 'Vision')!;
    expect(mil).toBeTruthy();
    expect(mil.note).toContain('Mblob');
    expect(mil.note).toContain('Mdig');
    expect(mil.evidence.some((e) => e.file === 'vision/src/grab.cpp')).toBe(true);
    const board = req('hardware', 'Matrox 擷取卡（M_SYSTEM_RAPIXOCXP）', 'Vision')!;
    expect(board.note).toContain('MIL runtime 授權');
    expect(board.evidence[0]).toMatchObject({ file: 'vision/src/grab.cpp', line: 7 });
    const lic = result.facets.requirements.find((r) => r.kind === 'license' && r.module === 'Vision')!;
    expect(lic.name).toBe('MIL runtime 授權（含 Blob 分析）');
    const cam = req('hardware', '相機', 'Vision')!;
    expect(cam.note).toContain('MdigAlloc');
    expect(cam.note).toContain('line.dcf');
  });

  it('reads CMake: version, standard, CUDA, packages, optional libraries', () => {
    expect(req('toolchain', 'CMake', 'cfaoi_ip')?.version).toBe('3.24');
    expect(req('toolchain', 'C++17', 'cfaoi_ip')).toBeTruthy();
    const cuda = req('sdk', 'CUDA', 'cfaoi_ip')!;
    expect(cuda.evidence.some((e) => e.file === 'ip/CMakeLists.txt')).toBe(true);
    expect(cuda.evidence.length).toBeLessThanOrEqual(3);
    expect(req('library', 'OpenCV', 'cfaoi_ip')?.note).toContain('元件：core, imgproc');
    expect(req('library', 'fmt', 'cfaoi_ip')?.evidence[0]).toMatchObject({ file: 'ip/CMakeLists.txt', line: 6 });
    expect(req('library', 'ONNX Runtime', 'cfaoi_ip')?.note).toContain('選用');
    expect(req('library', 'OpenCV', 'cfaoi_ip')?.note ?? '').not.toContain('選用');
  });

  it('reads the .NET project: runtime and packages', () => {
    const rt = req('runtime', '.NET', 'Control')!;
    expect(rt.version).toBe('8.0');
    expect(rt.note).toContain('.NET 8');
    const av = req('library', 'Avalonia', 'Control')!;
    expect(av.version).toBe('11.2.3');
    expect(av.note).toContain('GUI');
    expect(req('library', 'CommunityToolkit', 'Control')?.version).toBe('8.4.1');
    // net8.0 (no -windows) is cross-platform
    expect(req('os', 'Windows', 'Control')).toBeUndefined();
  });

  it('reads Python requirements', () => {
    expect(req('library', 'numpy', 'py')?.version).toBe('1.26.4');
    expect(req('library', 'opencv-python', 'py')?.version).toBe('>=4.8');
    expect(req('runtime', 'Python', 'py')).toBeTruthy();
    // a manifest exists → imports do not add guessed entries
    expect(req('library', 'numpy', 'py')?.note ?? '').not.toContain('import');
  });

  it('skips build output dirs', () => {
    expect(result.facets.requirements.some((r) => r.evidence.some((e) => e.file.startsWith('build/')))).toBe(false);
    expect(result.facets.modules.some((m) => m.path.startsWith('build'))).toBe(false);
  });
});

describe('repo profile — architecture', () => {
  it('lists modules with kind, output, entry points', () => {
    const by = (n: string) => result.facets.modules.find((m) => m.name === n)!;
    expect(by('Vision')).toMatchObject({ kind: 'vs_project', path: 'vision', output: 'gui_exe', language: 'cpp' });
    expect(by('Vision').evidence[0]).toMatchObject({ file: 'vision/Vision.sln', line: 3 });
    expect(by('cfaoi_ip')).toMatchObject({ kind: 'cmake_target', path: 'ip', output: 'exe', entry_points: ['ip/src/main.cpp'], files: 1 });
    expect(by('Control')).toMatchObject({ kind: 'csproj', path: 'control', output: 'gui_exe', language: 'csharp' });
    expect(by('Control').entry_points).toEqual(expect.arrayContaining(['control/Program.cs', 'control/App.axaml.cs']));
    expect(by('tools')).toMatchObject({ kind: 'python_pkg', path: 'py/tools', output: 'script', entry_points: ['py/tools/measure.py'] });
    expect(by('py')).toMatchObject({ kind: 'dir', language: 'python', output: 'script' });
  });
});

describe('repo profile — style', () => {
  it('profiles the whole repo and each top-level dir', () => {
    const all = result.facets.style.find((s) => s.module === '')!;
    expect(all.files_sampled).toBeGreaterThan(5);
    expect(all.encoding.big5).toBe(1);
    expect(all.encoding.utf8).toBeGreaterThan(0);
    expect(all.languages).toEqual(expect.arrayContaining(['cpp', 'csharp', 'python', 'cuda']));
    expect(all.configs.map((c) => c.file)).toContain('.clang-format');

    const vision = result.facets.style.find((s) => s.module === 'vision')!;
    expect(vision.eol).toBe('crlf');
    expect(vision.indent).toBe('tab');
    expect(vision.header_guard).toBe('ifndef');
    expect(vision.comment_lang).toBe('zh');
    expect(vision.naming.some((n) => n.startsWith('成員變數 m_ 前綴（m_'))).toBe(true);
    expect(vision.error_handling).toContain('MIL：MappGetError 檢查');

    const ip = result.facets.style.find((s) => s.module === 'ip')!;
    expect(ip.eol).toBe('lf');
    expect(ip.indent).toBe('4');
    expect(ip.brace).toBe('same_line');
    expect(ip.header_guard).toBe('pragma_once');
    expect(ip.comment_lang).toBeNull();
    expect(ip.logging).toEqual(expect.arrayContaining(['std::cerr']));
    expect(ip.strings).toContain('std::string');
    expect(ip.error_handling).toContain('例外（throw/try）');
    expect(ip.naming.some((n) => /函式 snake_case/.test(n))).toBe(true);

    const control = result.facets.style.find((s) => s.module === 'control')!;
    expect(control.brace).toBe('next_line');
    expect(control.naming).toEqual(expect.arrayContaining(['私有欄位 _camelCase（_gate）', '方法 PascalCase（Initialize）']));
    expect(control.logging).toContain('Console.WriteLine');
  });
});

describe('repo profile — verify', () => {
  it('finds frameworks, test dirs, commands, headless vs GUI, protected paths', () => {
    const v = result.facets.verify;
    expect(v.frameworks).toEqual([expect.objectContaining({ name: 'pytest', module: 'py' })]);
    expect(v.test_dirs).toContain('py/tests');
    const cmds = v.commands.map((c) => c.command);
    expect(cmds).toContain('cmake -S ip -B ip/build && cmake --build ip/build -j');
    expect(cmds).toContain('dotnet build control/Control.csproj');
    expect(cmds).toContain('msbuild "vision/Vision.sln" /p:Configuration=Release /p:Platform=x64');
    expect(cmds).toContain('python3 -m pytest py/tests');
    const ip = v.headless.find((h) => h.module === 'cfaoi_ip')!;
    expect(ip.how).toContain('cfaoi_ip CLI');
    expect(ip.how).toContain('--ini');
    expect(ip.evidence[0]!.file).toBe('ip/src/main.cpp');
    expect(v.headless.find((h) => h.module === 'tools')?.how).toContain('measure.py');
    expect(v.gui_only).toEqual(expect.arrayContaining(['Control', 'Vision']));
    expect(v.headless.some((h) => h.module === 'Control')).toBe(false);
    expect(v.eval_scripts).toEqual(['py/eval_score.py']);
    expect(v.answer_files).toEqual(['py/golden/answers.csv']);
    expect(v.protected_suggestions).toEqual(['py/eval_score.py', 'py/golden/']);
  });
});

describe('repo profile — hotspots', () => {
  it('ranks files by fix commits', () => {
    const h = result.facets.hotspots;
    expect(h[0]).toMatchObject({ file: 'ip/src/main.cpp', commits: 3, fix_commits: 2 });
    expect(h[0]!.last).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(h.find((x) => x.file === 'py/eval_score.py')).toMatchObject({ commits: 2, fix_commits: 0 });
    expect(h.length).toBeLessThanOrEqual(15);
  });
});

describe('repo profile — code index', () => {
  it('indexes ini params with default and meaning, and where code reads them', () => {
    const p = result.index.find((e) => e.kind === 'param' && e.key === 'pitch_x')!;
    expect(p).toMatchObject({ section: 'Pattern', file: 'ip/config/default.ini', line: 4, value: '26', meaning: 'Pattern pitch (px)', text: 'pitch_x = 26' });
    expect(result.index.find((e) => e.kind === 'param' && e.key === 'pitch_y')).toMatchObject({ value: '19', meaning: null });
    const use = result.index.find((e) => e.kind === 'param_use' && e.key === 'pitch_x')!;
    expect(use).toMatchObject({ section: 'Pattern', file: 'ip/src/config_parser.h', line: 9 });
    expect(use.text).toContain('if (key == "pitch_x")');
  });

  it('indexes incidents, error codes and log messages', () => {
    expect(result.index.find((e) => e.kind === 'incident')).toMatchObject({ key: 'bad_json', file: 'ip/src/main.cpp', section: 'record_incident' });
    expect(result.index.find((e) => e.kind === 'error_code' && e.key === 'ERR_GRAB_TIMEOUT')).toMatchObject({ value: '1203', line: 7 });
    expect(result.index.find((e) => e.kind === 'error_code' && e.key === 'Lost')).toMatchObject({ section: 'GrabError', value: '1204' });
    const logs = result.index.filter((e) => e.kind === 'log').map((e) => e.key);
    expect(logs).toContain('Failed to open config file: {}');
    expect(logs).toContain('pattern pitch {} px');
    expect(logs).toContain('pitch measured from {args.input}');
    expect(logs).toContain('App initialize starting');
    expect(result.index.length).toBeLessThanOrEqual(20_000);
  });
});

describe('repo profile — speed', () => {
  it('analyses a ~400-file repo in under 5 s', () => {
    const dir = newRepo('loop-profile-big-');
    for (let i = 0; i < 400; i++) {
      const mod = `mod${i % 8}`;
      if (i % 4 === 0) put(dir, `${mod}/src/f${i}.py`, `import argparse\n\n\ndef run_${i}(x):\n    print("value is now", x)\n    return x * ${i}\n`);
      else if (i % 4 === 1) put(dir, `${mod}/src/f${i}.h`, `#pragma once\nint calc_${i}(int a);\n`);
      else if (i % 4 === 2) put(dir, `${mod}/src/f${i}.cpp`, `#include "f${i - 1}.h"\n// value ${i}\nint calc_${i}(int a) {\n    if (a < 0) {\n        return -1;\n    }\n    return a + ${i};\n}\n`);
      else put(dir, `${mod}/config/f${i}.ini`, `[Section${i}]\n# meaning ${i}\nkey_${i} = ${i}\n`);
    }
    put(dir, 'CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\nproject(big CXX)\nadd_executable(big mod0/src/f2.cpp)\n');
    commitAll(dir, 'feat: many files');
    const t0 = Date.now();
    const r = analyseRepo(dir);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(r.facets.warnings).toEqual([]);
    expect(r.index.filter((e) => e.kind === 'param').length).toBe(100);
    expect(r.facets.style[0]!.files_sampled).toBe(300);
  });
});
