import { startShop } from "./index.js";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex < 0 ? 3000 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
const shop = await startShop({ port });
console.log(JSON.stringify({ url: shop.url, dbPath: shop.dbPath }));
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await shop.close();
    process.exit(0);
  });
