/**
 * Plain-language impact of a settings change on reproducibility, cost and data protection
 * (UX-047). Statements describe what the system does for the change; they are shown before the
 * change is saved and never claim that earlier results are recomputed.
 */
export type ImpactArea = "Reproducibility" | "Cost" | "Data protection";
export type ImpactLevel = "none" | "info" | "warning";

export interface Impact {
  readonly area: ImpactArea;
  readonly level: ImpactLevel;
  readonly text: string;
}

export interface EnvironmentSettings {
  readonly name: string;
  readonly baseUrl: string;
  readonly networkProfile: string;
  readonly production: boolean;
}

const networkProfileText: Record<string, string> = {
  public: "the public internet",
  private: "private network ranges",
  "local-loopback": "this host's loopback interface only",
};

export function environmentImpact(
  before: EnvironmentSettings | null,
  after: EnvironmentSettings,
): readonly Impact[] {
  if (before === null)
    return [
      {
        area: "Reproducibility",
        level: "info",
        text: "Creates revision 1 of this environment. Every run records the revision it ran against.",
      },
      {
        area: "Cost",
        level: "none",
        text: "No model usage. Runs use execution time and artifact storage as for any environment.",
      },
      {
        area: "Data protection",
        level: after.production ? "warning" : "info",
        text: `Runs may reach ${networkProfileText[after.networkProfile] ?? after.networkProfile}.${
          after.production
            ? " Production: actions that write need an approval bound to this revision."
            : ""
        }`,
      },
    ];
  const targetChanged = before.baseUrl !== after.baseUrl;
  const networkChanged = before.networkProfile !== after.networkProfile;
  const productionChanged = before.production !== after.production;
  const changed = targetChanged || networkChanged || productionChanged;
  const nameChanged = before.name !== after.name;
  const impacts: Impact[] = [];
  impacts.push({
    area: "Reproducibility",
    level: changed ? "warning" : "info",
    text: changed
      ? "Saving records a new environment revision. Runs already recorded keep the revision they ran against and are not recomputed. Approvals are bound to a revision, so existing approvals do not apply to the new one. New runs use the new settings."
      : nameChanged
        ? "Saving renames the environment and still records a new revision with the same settings. Recorded runs keep theirs."
        : "No setting changed; nothing will be saved.",
  });
  impacts.push({
    area: "Cost",
    level: "none",
    text: "No model usage. Future runs use execution time and artifact storage as before.",
  });
  const protection: string[] = [];
  if (targetChanged)
    protection.push(`Runs will target ${after.baseUrl} instead of ${before.baseUrl}.`);
  if (networkChanged)
    protection.push(
      `Network access changes from ${networkProfileText[before.networkProfile] ?? before.networkProfile} to ${networkProfileText[after.networkProfile] ?? after.networkProfile}.`,
    );
  if (productionChanged)
    protection.push(
      after.production
        ? "Marked production: actions that write need an approval bound to the environment revision, and raw capture needs an approval."
        : "No longer production: write actions no longer need the production approval.",
    );
  impacts.push({
    area: "Data protection",
    level:
      productionChanged && !after.production ? "warning" : protection.length > 0 ? "info" : "none",
    text:
      protection.length > 0
        ? protection.join(" ")
        : "No change to targets, network access or approvals.",
  });
  return impacts;
}

export interface ConsentChange {
  readonly providerId: string;
  readonly remote: boolean;
  readonly baseUrl: string;
  readonly dataClasses: readonly string[];
  readonly allowUnknownCost: boolean;
  readonly revoke: boolean;
}

export function consentImpact(change: ConsentChange): readonly Impact[] {
  if (change.revoke)
    return [
      {
        area: "Reproducibility",
        level: "info",
        text: "Generation and analysis that need this provider stop being available for the project. Recorded results and cached responses are not recalculated.",
      },
      {
        area: "Cost",
        level: "none",
        text: "No further spend with this provider from this project.",
      },
      {
        area: "Data protection",
        level: "info",
        text: "No further data is sent to this provider. Data already sent is not recalled by revoking.",
      },
    ];
  const classes = change.dataClasses.length > 0 ? change.dataClasses.join(", ") : "nothing";
  return [
    {
      area: "Reproducibility",
      level: "info",
      text: "Model output can differ between calls. Runs of recorded tests stay deterministic; only generation and analysis use the model. Earlier results are not recomputed.",
    },
    {
      area: "Cost",
      level: change.allowUnknownCost ? "warning" : "info",
      text: change.allowUnknownCost
        ? "Calls to models with no known price are allowed, so the project budget cannot cap their spend."
        : "Calls to models with no known price are refused, so the budget stays enforceable.",
    },
    {
      area: "Data protection",
      level: change.remote ? "warning" : "info",
      text: change.remote
        ? `These categories are sent to the remote provider ${change.providerId} at ${change.baseUrl}: ${classes}.`
        : `The provider ${change.providerId} runs on this host. These categories are processed locally: ${classes}.`,
    },
  ];
}

export function budgetImpact(before: number | null, after: number): readonly Impact[] {
  return [
    {
      area: "Reproducibility",
      level: "none",
      text: "No effect on recorded results or on how tests replay.",
    },
    {
      area: "Cost",
      level: "info",
      text: `Sets the lifetime token budget of this project to ${after.toLocaleString("en-US")} tokens${
        before === null ? "" : ` (was ${before.toLocaleString("en-US")})`
      }. Model calls that would exceed it are refused before they are sent. Past usage is not recalculated.`,
    },
    { area: "Data protection", level: "none", text: "No change to what is sent to providers." },
  ];
}
