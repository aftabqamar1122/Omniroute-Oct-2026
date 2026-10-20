import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = path.join(process.cwd(), "src/shared/services/cliRuntime.ts");

interface MockSpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

const originalSpawn = childProcess.spawn;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalEnv = { ...process.env };

async function importFresh(label: string) {
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}-${Math.random()}`);
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function restorePlatform() {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
}

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

test.afterEach(() => {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  restorePlatform();
  restoreEnv();
});

test("#17157 isWindows() evaluates dynamically at runtime", async () => {
  const cliRuntime = await importFresh("isWindows-dynamic");

  setPlatform("win32");
  assert.equal(cliRuntime.isWindows(), true, "should be true when process.platform is win32");

  setPlatform("linux");
  assert.equal(cliRuntime.isWindows(), false, "should be false when process.platform is linux");

  setPlatform("darwin");
  assert.equal(cliRuntime.isWindows(), false, "should be false when process.platform is darwin");
});

test("#17157 getKnownToolPaths returns Windows binary candidates when on Windows", async () => {
  setPlatform("win32");
  const cliRuntime = await importFresh("known-paths-win32");
  const candidates = cliRuntime.getKnownToolPaths("claude");

  assert.ok(candidates.length > 0, "Windows known paths should not be empty");
  assert.ok(
    candidates.some((p: string) => p.includes("claude.exe") || p.includes("claude.cmd")),
    `Expected Windows candidate (.exe or .cmd), got: ${JSON.stringify(candidates)}`
  );
  assert.ok(
    candidates.some((p: string) => p.includes(path.join(".local", "bin", "claude.exe"))),
    "Should include .local/bin/claude.exe candidate on Windows"
  );
});

test("#17157 locateCommand uses where.exe on Windows", async () => {
  setPlatform("win32");
  const spawnCalls: MockSpawnCall[] = [];
  childProcess.spawn = (command: string, args: string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options });
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", "C:\\Users\\tester\\.local\\bin\\claude.exe\r\n");
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("locate-where-exe");
  const result = await cliRuntime.locateCommand("claude", {});

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, "C:\\Users\\tester\\.local\\bin\\claude.exe");
  assert.equal(result.reason, null);

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "where.exe");
  assert.deepEqual(spawnCalls[0].args, ["claude"]);
  assert.equal(Boolean(spawnCalls[0].options.shell), false);
});

test("#17157 locateCommand prefers Windows executable extensions from where.exe output", async () => {
  setPlatform("win32");
  childProcess.spawn = () => {
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", "C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n");
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("locate-where-preferred-ext");
  const result = await cliRuntime.locateCommand("claude", {});

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, "C:\\npm\\claude.cmd");
});

test("#17157 locateCommand normalizes MSYS2 paths returned by where.exe on Windows", async () => {
  setPlatform("win32");
  childProcess.spawn = () => {
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit("data", "/c/Users/tester/.local/bin/claude.exe\r\n");
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("locate-msys2");
  const result = await cliRuntime.locateCommand("claude", {});

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, "C:\\Users\\tester\\.local\\bin\\claude.exe");
});

test("#17157 locateCommand returns not_found when where.exe yields no paths", async () => {
  setPlatform("win32");
  childProcess.spawn = () => {
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:events").EventEmitter)();
    child.stderr = new (require("node:events").EventEmitter)();
    child.kill = () => true;
    setImmediate(() => {
      child.emit("close", 1);
    });
    return child;
  };
  syncBuiltinESMExports();

  const cliRuntime = await importFresh("locate-not-found");
  const result = await cliRuntime.locateCommand("nonexistent-tool", {});

  assert.equal(result.installed, false);
  assert.equal(result.commandPath, null);
  assert.equal(result.reason, "not_found");
});

test("#17157 verifies source files do not contain bare build-foldable process.platform expressions", () => {
  const cliRuntimeSrc = fs.readFileSync(
    path.join(process.cwd(), "src/shared/services/cliRuntime.ts"),
    "utf8"
  );
  const npmPrefixSrc = fs.readFileSync(
    path.join(process.cwd(), "src/shared/services/cliRuntimeNpmPrefix.ts"),
    "utf8"
  );
  const winNodeSrc = fs.readFileSync(
    path.join(process.cwd(), "src/shared/services/cliRuntimeWindowsNode.ts"),
    "utf8"
  );

  assert.doesNotMatch(
    cliRuntimeSrc,
    /const\s+isWindows\s*=\s*\(\)\s*=>\s*process\.platform\s*===\s*["']win32["']/
  );
  assert.doesNotMatch(
    npmPrefixSrc,
    /const\s+isWindows\s*=\s*\(\)\s*:\s*boolean\s*=>\s*process\.platform\s*===\s*["']win32["']/
  );
  assert.doesNotMatch(winNodeSrc, /process\.platform\s*!==\s*["']win32["']/);
});
