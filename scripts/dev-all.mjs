#!/usr/bin/env node
/**
 * Run the app and the execution worker together.
 *
 *   npm run dev:all
 *
 * One Ctrl+C stops both. Output is prefixed so you can tell which
 * process is talking.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const procs = [];

function start(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32",
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const forward = (stream, target) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) target.write(prefix + line + "\n");
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    console.log(`${prefix}exited (${signal ?? code})`);
    shutdown();
  });
  procs.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of procs) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 300);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("worker", "npx", ["tsx", "watch", "src/worker/index.ts"], "35");
start("web", "npm", ["run", "dev"], "36");

console.log("klyz dev: web on http://localhost:3000, worker consuming workflow-executions");
