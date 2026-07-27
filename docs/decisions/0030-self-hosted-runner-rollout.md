# 0030. The rollout runs on a self-hosted runner, not an SSH push

Status: Accepted — 2026-07-27

Supersedes the delivery mechanism in [deployment.md](../deployment.md) §3. Builds on [ADR 0029](./0029-cloudflare-tunnel-as-the-production-edge.md), which established that the host is reached outbound-only.

## Context

[deployment.md](../deployment.md) §3 specified that the deploy job "connects over SSH — host and key held in repository secrets." That assumes GitHub's runners can open a connection to the server. They cannot.

The deploy target is a home server whose public address is IPv6 (`curl ifconfig.me` returns a `2607:fea8::/32` address). **GitHub-hosted runners are IPv4-only** — they have no IPv6 outbound connectivity — so a cloud runner cannot reach it at that address at all. The host does also sit behind a residential IPv4 (`curl -4 ifconfig.me`), but that address is dynamic: pinning it in a repository secret means the deploy silently breaks on every DHCP lease change, and the failure presents as a connection timeout indistinguishable from a firewall problem.

Neither fact was known when §3 was written. Both were established during Phase 6, after the SSH job had already been implemented and committed.

The remaining options were a DDNS-updated DNS record (which must be grey-cloud, since Cloudflare's proxy will not carry SSH — and which republishes the home IP that ADR 0029 deliberately hid), SSH tunnelled through the existing `cloudflared` (correct, but adds an Access application, a service token, and three more secrets), or inverting the direction of the connection.

## Decision

Delivery inverts: the server pulls instead of being pushed to. The `deploy` job splits in two.

- **`publish`** runs on `ubuntu-latest` with `packages: write`. It builds the image and pushes it to GHCR under an immutable `:<sha>` and a moving `:main`, and exports the SHA tag as a job output.
- **`rollout`** runs on a **repository-scoped self-hosted runner** on the deploy host, labelled `backburner-prod`, with `packages: read`. It authenticates to GHCR with the job's own `GITHUB_TOKEN`, syncs `main`'s compose file into the deploy directory, runs `docker compose pull && docker compose --profile prod up -d` with `APP_IMAGE` pinned to the published SHA, waits on the container healthcheck, and drops its registry credentials.

Both jobs keep `needs: [test, criteria]` transitively, so a red suite is still structurally un-deployable. `rollout` is additionally gated on a `DEPLOY_ENABLED` repository variable, so the pipeline stays green before the runner exists and can be disabled during a server migration without editing the workflow.

The split is not incidental. Building in the cloud keeps the toolchain, the build load, and the disk churn off a machine that also serves the operator's other sites; the runner does nothing but pull and restart. It also means the server needs no long-lived registry credential, so the GHCR package can remain private.

## Security posture

A self-hosted runner on a **public** repository is a genuine hazard, and it is mitigated rather than ignored. For `pull_request` events GitHub evaluates the workflow file *as it exists in the PR branch*, so an untrusted fork could otherwise add `runs-on: self-hosted` to any job and execute on the host.

- **Fork pull request workflows from outside collaborators is set to "Require approval for all outside collaborators."** Nothing from a fork runs without an explicit human click. This is the control that actually closes the attack; the rest is defence in depth.
- `publish` is gated to `push` on `main`, which a fork cannot trigger, and `rollout` reaches the runner only through `needs: publish`.
- The runner is registered to this repository alone, not to the account, so no other project can schedule work on it.
- Registry credentials are dropped in an `always()` step, so they do not outlive the job on a shared machine.

## Alternatives considered

- **DDNS plus a grey-cloud DNS record.** Keeps §3 literally intact, but republishes the home IP that ADR 0029 removed from public view, adds a DDNS updater as a new failure mode, and still leaves an inbound SSH port open on a residential connection.
- **SSH through the existing Cloudflare Tunnel** (`cloudflared access ssh`). Technically the most conservative — push-based, no GitHub agent on the box, no inbound port — and the right answer if the public-repo fork risk could not be mitigated. Rejected on setup cost under a deadline: an Access application, a service token, and three additional secrets, versus a runner the operator already knows how to install.
- **Building the image on the runner.** Removes GHCR entirely, but puts the full Node toolchain and build load on the server, loses the immutable published artifact that makes rollback a tag change, and loses cloud build caching.

## Consequences

- No inbound connectivity is required, so the IPv6-native address and the dynamic IPv4 both stop mattering. This is strictly more robust than the SSH design it replaces, not merely a workaround.
- `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and `DEPLOY_KNOWN_HOSTS` are no longer used. The deploy path holds **no** repository secrets beyond the automatic `GITHUB_TOKEN`.
- A new operational dependency: if the runner service is down, `rollout` fails after 15 minutes rather than deploying. That is loud, which is the intent — a silent skip would let `main` drift ahead of production while appearing green.
- The invariant from §3 holds unchanged: the deployed commit equals `main` HEAD, the workflow is the only deploy path, and it deploys exactly the SHA it built.
- The fork-approval setting is now load-bearing. If it is ever relaxed while the runner is registered, the host is exposed. It is recorded here because a repository setting has no other home in version control.
