import { createServer } from "node:http";

// Synthetic local demonstration; a semantic-negative run keeps HTTP 200 but changes its state.
createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      status: process.env.TESTMASTER_EXAMPLE_DEFECT === "true" ? "degraded" : "ok",
    }),
  );
}).listen(18080, "0.0.0.0");
