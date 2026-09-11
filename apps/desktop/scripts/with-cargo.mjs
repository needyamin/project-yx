import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const cargoBin = join(homedir(), ".cargo", "bin");
const current = process.env.Path ?? process.env.PATH ?? "";
const parts = current.split(delimiter).filter(Boolean);
if (!parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) {
  const next = `${cargoBin}${delimiter}${current}`;
  process.env.PATH = next;
  process.env.Path = next;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: with-cargo.mjs <command> [args...]");
  process.exit(1);
}

// Windows needs shell for .cmd shims; pass one string to avoid DEP0190.
const child =
  process.platform === "win32"
    ? spawn(args.join(" "), { stdio: "inherit", shell: true, env: process.env })
    : spawn(args[0], args.slice(1), {
        stdio: "inherit",
        shell: false,
        env: process.env,
      });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
