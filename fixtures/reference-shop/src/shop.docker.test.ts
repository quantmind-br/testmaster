import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type Browser, chromium } from "playwright-core";
import { expect, it } from "vitest";
import { browserChecks } from "../oracle/index.js";
import { startShop } from "./index.js";

const exec = promisify(execFile);
const image =
  "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";

it("independent browser oracle detects UI regressions and preserves popup/frame/file flows", async () => {
  const { stdout: gatewayOutput } = await exec("docker", [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const gateway = gatewayOutput.trim();
  const id = `reference-shop-browser-${process.pid}`;
  const temporary = await mkdtemp(join(tmpdir(), "shop-browser-"));
  let browser: Browser | undefined;
  try {
    await exec(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        id,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        "127.0.0.1::3000",
        "--init",
        "--user",
        "pwuser",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--security-opt",
        `seccomp=${resolve("containers/seccomp_profile.json")}`,
        "--shm-size",
        "512m",
        image,
        "npx",
        "-y",
        "playwright@1.63.0",
        "run-server",
        "--unsafe",
        "--port",
        "3000",
        "--host",
        "0.0.0.0",
      ],
      { timeout: 300000 },
    );
    const { stdout } = await exec("docker", ["port", id, "3000/tcp"]);
    const port = stdout.trim().split(":").at(-1);
    const endpoint = `ws://127.0.0.1:${port}/`;
    const logs = spawn("docker", ["logs", "--follow", id]);
    const ready = Promise.withResolvers<void>();
    let output = "";
    const observe = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Listening on")) ready.resolve();
    };
    logs.stdout.on("data", observe);
    logs.stderr.on("data", observe);
    logs.once("error", ready.reject);
    logs.once("exit", () => ready.reject(new Error(`Browser server exited: ${output}`)));
    try {
      await ready.promise;
    } finally {
      logs.kill();
    }
    // The host firewall denies bridge ingress; tunnel only this gateway via the loopback Playwright connection.
    browser = await chromium.connect(endpoint, {
      timeout: 10000,
      exposeNetwork: gateway,
      headers: { "x-playwright-launch-options": JSON.stringify({ chromiumSandbox: true }) },
    });
    const { stdout: browserArguments } = await exec("docker", [
      "exec",
      id,
      "node",
      "-e",
      "const fs=require('node:fs');for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');if(args[0]?.includes('chrome-headless-shell')&&!args.some(a=>a.startsWith('--type=')))console.log(JSON.stringify(args));}catch{}}",
    ]);
    const argumentsByProcess = browserArguments
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(argumentsByProcess.length).toBeGreaterThan(0);
    for (const args of argumentsByProcess) expect(args).not.toContain("--no-sandbox");
    for (const [mutant, expected] of [
      ["healthy", []],
      ["no-password-validation", ["browserPasswordValidation"]],
      ["toast-without-persist", ["browserOrderPersistence"]],
      ["selector-drift", ["checkoutSelector"]],
    ] as const) {
      const shop = await startShop({ port: 0, host: gateway, mutant });
      const url = shop.url;
      try {
        const results = await browserChecks({ browser, url, dbPath: shop.dbPath });
        expect(results.filter((result) => result.defective).map((result) => result.check)).toEqual(
          expected,
        );
        if (mutant !== "healthy") continue;
        const context = await browser.newContext({ acceptDownloads: true });
        try {
          const page = await context.newPage();
          await page.goto(`${url}/login`);
          await page.getByLabel("Password", { exact: true }).fill("correct-password");
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await page.getByTestId("catalog-ready").waitFor();
          const popupPromise = page.waitForEvent("popup");
          await page.getByRole("link", { name: "Terms", exact: true }).click();
          const popup = await popupPromise;
          await popup.getByRole("heading", { name: "Shop terms" }).waitFor();
          await popup.close();
          await page.getByTestId("add-p1").click();
          await page.getByTestId("toast").filter({ hasText: "Added to cart" }).waitFor();
          await page.getByRole("link", { name: "Cart", exact: true }).click();
          const frame = page.frameLocator('iframe[title="Delivery options"]');
          await frame.getByLabel("Delivery option").selectOption("Express");
          await frame.getByRole("button", { name: "Confirm delivery" }).click();
          expect(await frame.locator("output").textContent()).toBe("Confirmed");
          await page.getByRole("link", { name: "Profile", exact: true }).click();
          const file = join(temporary, "profile.txt");
          await writeFile(file, "independent profile bytes\n");
          await page.getByTestId("profile-upload").setInputFiles(file);
          await page.getByTestId("upload-size").filter({ hasText: "26" }).waitFor();
          const downloadPromise = page.waitForEvent("download");
          await page.getByTestId("profile-download").click();
          const download = await downloadPromise;
          expect(download.suggestedFilename()).toBe("profile.bin");
          const stream = await download.createReadStream();
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          expect(Buffer.concat(chunks).toString()).toBe("independent profile bytes\n");
        } finally {
          await context.close();
        }
      } finally {
        await shop.close();
      }
    }
  } finally {
    await browser?.close();
    await exec("docker", ["rm", "-f", id]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}, 300000);
