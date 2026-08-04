import { spawn } from "node:child_process";
import path from "node:path";

function readPort(value) {
  const port = Number.parseInt(value ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return String(port);
}

const cliPath = path.resolve("node_modules", "vinext", "dist", "cli.js");
const args = [
  cliPath,
  "dev",
  "--port",
  readPort(process.env.PORT),
  "--hostname",
  process.env.HOST?.trim() || "localhost",
];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error("Unable to start the development server:", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
