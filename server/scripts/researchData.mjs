#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
  fileURLToPath(new URL('../src/research/agentDataCli.ts', import.meta.url)),
  ...process.argv.slice(2),
], { cwd: server, stdio: 'inherit', windowsHide: true });
child.on('error', () => { process.stderr.write('研究入口无法启动，请检查 server 依赖。\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
