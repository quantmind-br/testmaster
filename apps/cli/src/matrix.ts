import { ContractError, type MatrixAxes, type MatrixCell } from "@testmaster/contracts";
import type { Command } from "commander";
import { collect, type Options, string, strings } from "./runtime.js";

/** Adds the matrix axes; each repeatable flag adds values to its axis (ADR-032). */
export function matrixOptions(command: Command): Command {
  return command
    .option("--browser <name>", "chromium, firefox or webkit (repeatable)", collect)
    .option("--viewport <WxH>", "Viewport such as 1280x720 (repeatable)", collect)
    .option("--color-scheme <scheme>", "light or dark (repeatable)", collect);
}

/** The axes the flags name, or undefined when none was given; the service validates the ranges. */
export function matrixAxes(options: Options): MatrixAxes | undefined {
  const browsers = strings(options, "browser");
  const viewports = strings(options, "viewport");
  const colorSchemes = strings(options, "colorScheme");
  if (!browsers.length && !viewports.length && !colorSchemes.length) return undefined;
  for (const browser of browsers)
    if (!["chromium", "firefox", "webkit"].includes(browser))
      throw new ContractError("INVALID_ARGUMENT", "Browser must be chromium, firefox or webkit", {
        option: "browser",
      });
  for (const scheme of colorSchemes)
    if (!["light", "dark"].includes(scheme))
      throw new ContractError("INVALID_ARGUMENT", "Color scheme must be light or dark", {
        option: "color-scheme",
      });
  return {
    ...(browsers.length ? { browsers: browsers as NonNullable<MatrixAxes["browsers"]> } : {}),
    ...(viewports.length ? { viewports: viewports.map(viewport) } : {}),
    ...(colorSchemes.length
      ? { colorSchemes: colorSchemes as NonNullable<MatrixAxes["colorSchemes"]> }
      : {}),
  };
}

/** `--reduced-motion` applies to every cell; it is a cell field, not an axis. */
export function reducedMotion(options: Options): MatrixCell["reducedMotion"] {
  const value = string(options, "reducedMotion");
  if (value === undefined) return undefined;
  if (value !== "reduce" && value !== "no-preference")
    throw new ContractError("INVALID_ARGUMENT", "Reduced motion must be reduce or no-preference", {
      option: "reduced-motion",
    });
  return value;
}

function viewport(value: string): { width: number; height: number } {
  const match = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/u.exec(value);
  if (!match)
    throw new ContractError("INVALID_ARGUMENT", "Viewport must be WIDTHxHEIGHT, such as 1280x720", {
      option: "viewport",
    });
  return { width: Number(match[1]), height: Number(match[2]) };
}
