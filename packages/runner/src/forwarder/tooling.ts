// M0 container verification only; not the production runner protocol harness.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { startForwarder } from "./index.js";

await mkdir("/tmp/home", { recursive: true });
const forwarder = await startForwarder("/run/testmaster/sockets/egress.sock");
const [command, ...args] = process.argv.slice(2);
if (!command) {
  await forwarder.close();
  console.error("CAPABILITY_UNAVAILABLE: attempt harness requires M1");
  process.exitCode = 8;
} else {
  const child = spawn(command, args, { stdio: "inherit" });
  const cancel = () => child.kill("SIGTERM");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 130)));
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await forwarder.close();
  }
}
