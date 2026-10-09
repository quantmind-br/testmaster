import { startLibrary } from "./index.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex < 0 ? 3000 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
const library = await startLibrary({ port });
console.log(JSON.stringify({ url: library.url, dbPath: library.dbPath }));
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await library.close();
    process.exit(0);
  });
