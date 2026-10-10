# 02: Shared GitHub resolver with separate API and git origins

**What to build:** Prefactor. Extract the intent handoff's repository resolver into a shared, exported module and extend it as the spec's GitHub integration describes: durable repository key to normalized remote to the active GitHub connector, parsing scp, `ssh://host[:port]` and `https://host[:port]` remotes, and returning both the connector's API origin and its git origin. The git origin yields the clone URL: `https://github.com/<owner>/<name>.git` for an `api.github.com` connector, and the API base without `/api/v3` for GitHub Enterprise Server. Intent handoff behaves exactly as before.

**Blocked by:** 01

**Status:** resolved

- [ ] Intent handoff uses the shared resolver with no behaviour change (its existing tests pass unchanged)
- [ ] Table tests cover github.com SSH and HTTPS, GitHub Enterprise Server scp, `ssh://` and HTTPS origins with ports, a missing remote, and a connector repository list
- [ ] Clone URLs are never built from `api.github.com` and never include `/api/v3`
- [ ] Repository eligibility (durable key present and resolvable) is exposed for later callers

## Answer

Done in `fcd52cb` on `feat/sf-001-cloud-agent-runs`. A pure resolver returns owner, name, connector, API base, git origin and clone URL, or an ineligibility reason (`repository_key_missing`, `repository_remote_missing`, `repository_remote_invalid`, `github_connector_unavailable`). An injectable service exposes `resolve` and `eligibility` per workspace. Intent handoff uses it with unchanged error strings; `ssh://` and ported remotes now resolve. GitHub Enterprise Cloud data-residency hosts (`*.ghe.com`) are not special-cased.
