import { defineConfig } from "vitest/config";

const common = {
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
};

export default defineConfig({
  test: {
    // Third-party packages that publish a `source` export condition pointing at raw TypeScript
    // inside node_modules must be transformed by Vite, since Node refuses to strip types there.
    server: {
      deps: { inline: [/@modelcontextprotocol\/sdk/, /eventsource-parser/, /eventsource/] },
    },
    projects: [
      {
        extends: true,
        ...common,
        test: {
          name: "unit",
          include: ["{packages,apps,fixtures,tools,validation}/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.docker.test.ts", "**/*.live.test.ts"],
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        ...common,
        test: {
          name: "docker",
          include: ["{packages,apps,fixtures,tools,validation}/**/*.docker.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 300_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        ...common,
        test: {
          name: "live",
          include: ["{packages,apps,fixtures,tools,validation,evals}/**/*.live.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
