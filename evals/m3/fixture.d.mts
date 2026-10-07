export interface FixturePatch {
  file: string;
  before: string;
  after: string;
}
export interface FixtureCase {
  mutant: string;
  baselinePatches: FixturePatch[];
  patches: FixturePatch[];
  semanticNegative: string;
}
export interface FixtureCorpus {
  semanticPatches: Record<string, FixturePatch[]>;
}
export interface FixtureShop {
  url: string;
  dbPath: string;
  close(): Promise<void>;
  materialized: { directory: string; digests: Record<string, string>; transformationHash: string };
}
export function applyPatches(source: string, patches: FixturePatch[], file: string): string;
export function materialize(
  root: string,
  corpus: FixtureCorpus,
  item: FixtureCase,
  side: string,
  canary?: string,
): Promise<FixtureShop["materialized"]>;
export function startCase(
  root: string,
  corpus: FixtureCorpus,
  item: FixtureCase,
  side: string,
  port?: number,
  canary?: string,
): Promise<FixtureShop>;
export function independentOracle(
  shop: FixtureShop,
  name: string,
): Promise<{ healthy: boolean; defective: boolean; observed: unknown }>;
export function executedProductOracle(
  shop: FixtureShop,
  token: string,
): Promise<{ healthy: boolean; defective: boolean; observed: unknown }>;
