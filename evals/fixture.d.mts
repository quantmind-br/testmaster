export interface Shop {
  url: string;
  dbPath: string;
  close(): Promise<void>;
}
export interface OracleVerdict {
  healthy: boolean;
  defective: boolean;
  [key: string]: unknown;
}
export function startShop(options: { mutant: string; port: number }): Promise<Shop>;
export const checks: Record<string, (shop: Shop) => Promise<OracleVerdict>>;
