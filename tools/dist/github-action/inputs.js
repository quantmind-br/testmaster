export class ActionInputError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
    }
}
const ContractError = ActionInputError;
const names = [
    "runtime-manifest",
    "test-ids",
    "all",
    "environment",
    "target-url",
    "commit-sha",
    "checkout-sha",
    "allow-empty",
    "empty-reason",
    "quarantine-policy",
    "publish-check",
    "github-token",
];
export function parseActionInputs(env) {
    for (const key of Object.keys(env).filter((key) => key.startsWith("INPUT_"))) {
        if (!names.some((name) => `INPUT_${name.replace(/ /g, "_").toUpperCase()}` === key))
            throw new ContractError("INVALID_ARGUMENT", "Unknown Action input", { key });
    }
    const values = Object.fromEntries(names.map((name) => [name, env[`INPUT_${name.toUpperCase()}`] ?? ""]));
    const bool = (name) => {
        const value = values[name];
        if (value !== "" && value !== "true" && value !== "false")
            throw new ContractError("INVALID_ARGUMENT", "Action boolean input is invalid", { name });
        return value === "true";
    };
    const repository = env.GITHUB_REPOSITORY;
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
        throw new ContractError("INVALID_ARGUMENT", "GitHub repository context is invalid");
    const commitSha = values["commit-sha"] || env.GITHUB_SHA || "";
    const checkoutSha = values["checkout-sha"] || env.GITHUB_SHA || "";
    if (![commitSha, checkoutSha, env.GITHUB_SHA].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) ||
        checkoutSha !== env.GITHUB_SHA)
        throw new ContractError("POLICY_DENIED", "Action SHA context does not match checkout");
    const manifest = values["runtime-manifest"] ?? "";
    const split = manifest.lastIndexOf("#");
    if (split < 1 || !/^[0-9a-f]{64}$/.test(manifest.slice(split + 1)) || /[\r\n\0]/.test(manifest))
        throw new ContractError("INVALID_ARGUMENT", "runtime-manifest requires PATH#SHA256");
    let ids;
    try {
        ids = JSON.parse(values["test-ids"] || "[]");
    }
    catch {
        throw new ContractError("INVALID_ARGUMENT", "test-ids must be a JSON array");
    }
    if (!Array.isArray(ids) ||
        ids.length > 500 ||
        ids.some((id) => typeof id !== "string" ||
            !/^tst_[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) ||
        new Set(ids).size !== ids.length)
        throw new ContractError("INVALID_ARGUMENT", "test-ids contains malformed or duplicate IDs");
    const all = bool("all");
    if (all && ids.length)
        throw new ContractError("INVALID_ARGUMENT", "all and test-ids are mutually exclusive");
    const targetUrl = values["target-url"];
    if (targetUrl) {
        let url;
        try {
            url = new URL(targetUrl);
        }
        catch {
            throw new ContractError("INVALID_ARGUMENT", "Invalid target URL");
        }
        if (!["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            /[\r\n\0]/.test(targetUrl))
            throw new ContractError("POLICY_DENIED", "Target URL cannot carry credentials");
    }
    const environment = values.environment ?? "";
    if (!environment ||
        environment.length > 200 ||
        /[\r\n\0]/.test(environment) ||
        environment.startsWith("-"))
        throw new ContractError("INVALID_ARGUMENT", "Action environment is invalid");
    const allowEmpty = bool("allow-empty");
    const emptyReason = values["empty-reason"];
    if (emptyReason && (emptyReason.length > 2000 || /[\r\n\0]/.test(emptyReason)))
        throw new ContractError("INVALID_ARGUMENT", "Empty reason is invalid");
    if (allowEmpty && !emptyReason?.trim())
        throw new ContractError("INVALID_ARGUMENT", "allow-empty requires empty-reason");
    const policy = values["quarantine-policy"] || "exclude";
    if (policy !== "exclude" && policy !== "strict")
        throw new ContractError("INVALID_ARGUMENT", "Invalid quarantine policy");
    const publishCheck = bool("publish-check");
    if (publishCheck && !values["github-token"])
        throw new ContractError("UNAUTHENTICATED", "Publication requires an explicit Checks token");
    return {
        runtimeManifest: manifest.slice(0, split),
        manifestSha256: manifest.slice(split + 1),
        testIds: ids,
        all,
        environment,
        commitSha,
        checkoutSha,
        allowEmpty,
        ...(emptyReason ? { emptyReason } : {}),
        quarantinePolicy: policy,
        publishCheck,
        ...(targetUrl ? { targetUrl } : {}),
        ...(values["github-token"] ? { githubToken: values["github-token"] } : {}),
    };
}
export function executionEnvironment(env) {
    // Allowlisted operating-system/tool variables only. No inherited provider/GitHub credentials,
    // dynamic loader injection, Git hooks/config, NODE_OPTIONS or secret setup outputs.
    const result = {
        CI: "true",
        TESTMASTER_OFFLINE: "true",
        TESTMASTER_NO_TELEMETRY: "true",
    };
    for (const key of [
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TZ",
        "TMPDIR",
        "RUNNER_TEMP",
        "TESTMASTER_DATA_DIR",
        "TESTMASTER_PROJECT_ID",
    ])
        if (env[key])
            result[key] = env[key];
    return result;
}
//# sourceMappingURL=inputs.js.map