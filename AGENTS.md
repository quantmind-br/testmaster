# TestMaster development premises

Operator decisions that every change must respect. They are final: do not reopen them in a change, a review or a plan.

## No timeout cuts work in progress

- A model call has no deadline. It runs until the provider answers. Only an explicit cancellation by the caller can stop it: Ctrl-C, a client disconnect, or a run or job cancel. This holds for:
  - the gateway, which has no `deadlineMs`;
  - the provider transport, which turns off undici's header and body timeouts;
  - analysis, healing, proposal, normalization, code-generation and exploration jobs;
  - every surface: MCP, CLI, REST, portal and evals.
- No surface accepts or forwards a model deadline. Do not add `deadlineMs`, `--deadline-ms`, a time-limit field, or a default timeout to a model operation.
- Waiting for a model answer is not charged to any other deadline. Agent-mode attempts and explorations pause their clock (`AttemptClock`) while an answer is pending.
- A job that runs a model keeps its lease alive while the call runs. A second caller waits for the job to settle instead of giving up.
- Server routes that run a model hold their socket open past the server's idle timeout.

## Safeguards must earn their place

A safeguard needs a concrete, named benefit, such as data integrity, security isolation, or a bounded resource that would otherwise be exhausted. A timeout or limit whose only effect is to interrupt work that is making progress has no benefit, so do not add one.

When you meet such a safeguard, report it and propose removing it. Do not tune its value.
