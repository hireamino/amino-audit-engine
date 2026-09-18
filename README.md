# HireAmino audit engine

This repository is the canonical JavaScript implementation of HireAmino's email-posture calculation and findings contract. It is deliberately a portable, single-file ESM domain engine: no HTML, routes, rate limiting, persistence, metrics, GitHub Action commands, tenant state, or Cloudflare bindings live here.

The distributable artifact is [`src/engine.mjs`](src/engine.mjs) itself. There is no build step and no generated header. Consumers copy that file byte-for-byte from an exact commit SHA; [`engine.provenance.json`](engine.provenance.json) records its extraction source, artifact hash, and contract version separately.

## Stable interface

```js
import { createAuditEngine, createDefaultAdapters, contractVersion } from "./src/engine.mjs";

const engine = createAuditEngine({
  dns: {
    query(name, rrtype),
    meta(name, rrtype),
  },
  http: {
    mtaSts(domain, dns),
    robots(domain, dns),
    rdap(domain),
  },
  clock: {
    nowMs(),
  },
});

const audit = await engine.auditDomain("example.com");
const score = await engine.buckets("example.com");

// Create the real adapters and engine inside each request/audit boundary.
export async function handleAudit(domain) {
  return createAuditEngine(createDefaultAdapters()).auditDomain(domain);
}
```

`contractVersion` is a string describing the adapter and exported-result contract. Contract 1.4.0 retains the 1.3 DNS and public-address rules and adds three reviewed rules: DNSSEC, Reputation, and CAA findings use the `domain_posture` lane; the website observation distinguishes authoritative absence from lookup failure and address refusal; and RDAP has one response shape, `{status, data} | null`.

### Result metadata

Every `auditDomain()` finding carries a `lane` from the closed enum `outbound_auth | inbound_transport | domain_posture | brand_optional | outside_sending_posture`. SPF, DKIM, and DMARC are outbound authentication; MTA-STS, TLS-RPT, Transport, and MX are inbound transport; DNSSEC, Reputation, and CAA are domain posture; BIMI is an optional brand control; and AI visibility is outside sending posture. Reverse-DNS findings retain their `Transport` area but use `outside_sending_posture`. An unmapped area is a contract error and fails closed.

Every audit result also carries exactly:

```js
observations: {
  mta_sts_policy: "checked" | "unavailable" | "not_applicable",
  robots: "checked" | "unavailable" | "not_applicable",
  rdap: "checked" | "unavailable" | "not_applicable",
}
```

`checked` means the purpose-specific HTTP port returned a response of any status, including 404, malformed content, or a wrong content type. For the website/robots observation, authoritative NOERROR or NXDOMAIN metadata with no A/AAAA answers is `not_applicable`; a failed lookup, a missing `meta` port, a refused address, or a failed fetch is `unavailable`. MTA-STS deliberately keeps its existing rule: an advertised policy whose host has no usable address is `unavailable`, while a true null MX, NXDOMAIN, or NOERROR with no advertised TXT is `not_applicable`. RDAP is `checked` for any non-null wrapper and `unavailable` for `null`. DNS `inconclusive` remains a separate, unchanged result driven only by critical SPF/DMARC/MX lookups.

`buckets()` remains a flat score object and adds a `lanes` map for its nine scored buckets. Its values use the same lane enum.

### DNS port

- `query(name, rrtype) -> Promise<string[]>` returns the normalized record strings used by the existing resolver contract.
- `meta(name, rrtype) -> Promise<{status, ad, error}>` returns DNS RCODE, authenticated-data state, and transport-error state. It supports the existing inconclusive-audit behavior.
- The injected DNS adapter owns DNS transport, caching, in-flight request deduplication, timeout, retry, and resolver selection. `createDefaultAdapters()` retains the existing per-instance cache of in-flight DNS promises.
- That cache lasts for the adapter's entire lifetime and has no TTL or eviction. Production consumers must create adapters per audit and must never share a default-adapter engine instance across requests; doing so would serve stale DNS records on later audits.

### HTTP ports

HTTP operations are purpose-specific instead of exposing an arbitrary fetch primitive:

- `mtaSts(domain, dns) -> Promise<{status, contentType, body} | null>`
- `robots(domain, dns) -> Promise<{status, body} | null>`
- `rdap(domain) -> Promise<{status, data} | null>`

The engine retains one post-resolution `publicAddressState()` SSRF guard and invokes it before calling either domain-controlled HTTP port (`mtaSts` or `robots`). Its four frozen network lists mirror `amino-skills/conformance/address-contract.json` at the exact pin, and CI proves deep equality and all 120 reviewed rows through the real guard. IPv4 and IPv6 are parsed strictly; malformed answers, special-use ranges, mixed public/non-public answers, prefixes, brackets, and zone IDs fail closed. Python and JavaScript agree on all 36 differential forms, including refusing both zone-ID forms. Host adapters own transport, redirect and timeout policy and return normalized responses; the engine consistently enforces accepted status, content type, and response-size limits. RDAP uses a fixed provider host and receives an encoded domain from the default adapter. The default RDAP adapter returns a status-carrying wrapper for non-OK HTTP results (so a 404 is `checked` but emits no finding), returns `{status, data: null}` for malformed JSON after a response, and returns `null` only when no HTTP response was obtained.

### Clock port

`clock.nowMs() -> number` supplies Unix time in milliseconds for registration-age and expiration calculations. Tests freeze this value; production adapters use the host clock.

Metrics are not an engine port. A host may record a privacy-limited completion only after `auditDomain()` succeeds. Domain, DNS records, and tenant identity must not be added to that metric contract.

## Compatibility exports

Migration callers may continue to import:

```js
auditDomain(domain, query)
buckets(domain, query)
mtaStsPolicyProblems(policy)
```

When `query` is omitted, `auditDomain()` and `buckets()` use `createDefaultAdapters()`, preserving the current GitHub Action behavior. When a legacy fixture resolver is supplied, HTTP defaults to unavailable and the clock is frozen at zero; this makes the long-standing fixture interface genuinely offline. Deterministic success-path callers can attach purpose-specific `query.http` and `query.clock` ports during migration.

**Compatibility trap:** passing a real resolver as `query` disables HTTP and freezes the clock unless that function also carries explicit `query.http` and `query.clock` ports. The historical `/audit` calling pattern `auditDomain(domain, makeResolver())` must **not** be carried into a consumer migration: it would silently disable MTA-STS policy retrieval, robots checks, and meaningful RDAP time calculations. Production consumers must call `createAuditEngine(createDefaultAdapters())` and must not use the compatibility exports. Those exports exist only for the unchanged `amino-skills` corpus runner and will be removed in contract `2.0.0` after that runner adopts `createAuditEngine()`.

## Failure semantics

Contract 1.4 preserves the existing fail-soft finding behavior while reporting observation state separately:

- If no `v=STSv1` TXT record is obtained and `dns.meta()` reports `error`, SERVFAIL, REFUSED, FORMERR, or any status other than NOERROR (0) or NXDOMAIN (3), the engine reports “Unable to confirm MTA-STS policy”, sets the observation to `unavailable`, skips the policy fetch, and excludes `MTA_STS` from the gap. A true null MX takes precedence. With no `meta` port, the compatibility result remains authoritative absence.
- A failed, rejected, incorrectly typed, or otherwise unusable MTA-STS response becomes `null` and produces the existing “policy file not retrievable” finding when the TXT record advertises a policy.
- Website A/AAAA lookups consume the same authoritative-status rule as MTA-STS. Authoritative no-answer is `not_applicable`; lookup failure, missing metadata, refused answers, or a failed robots fetch is `unavailable`; any HTTP response is `checked`.
- RDAP accepts only `{status, data}` or `null`. A bare object is not interpreted as registration data, and a failed RDAP request produces no domain-age or expiration finding.
- DNSSEC, Reputation, and CAA findings use `domain_posture`; BIMI remains `brand_optional`, and the reverse-DNS title exception remains `outside_sending_posture`.
- A failed robots request produces no AI-crawler finding.
- DNS transport errors continue to drive the existing `inconclusive` fields through `dns.meta`.

## Product contract

The reviewed corpus in the exact-SHA-pinned [`hireamino/amino-skills`](https://github.com/hireamino/amino-skills) repository is the product contract. If this engine and that corpus disagree, the engine is wrong. CI therefore runs the unchanged corpus and all mutation canaries for both shipping JavaScript surface labels.

Run every contract gate with:

```sh
npm test
```

The test command fetches the pinned corpus and immutable extraction baseline when local copies are not provided. It proves source provenance, reviewed aggregate changes, network denial and both independent positive controls, clock determinism, mutation-canary coverage, success- and failure-path output equivalence, boundary behavior, default-adapter lookup outcomes, strict address-table equality and real-path rows, production calling conventions, compatibility behavior, DNS in-flight deduplication, findings inventory, compatibility exports, and ambient-I/O purity.

## Consumer and service boundary

The web audit and GitHub Action will later become thin host adapters around an exact-SHA copy of this file. The Action remains in-process and offline-capable. WHI-44 may separately wrap the same engine as one Cloudflare Posture Audit service for console/backend use; authentication, tenant authorization, quotas, persistence, scheduling, and operational telemetry belong to that service boundary, not this engine.

### Consumer-migration merge gates

- Production uses `createAuditEngine(createDefaultAdapters())`; no real resolver is passed through a compatibility export.
- Adapters are created per request, proven against the old engine, so a DNS change between audits is observed instead of being hidden by a shared cache.
- The pinned corpus, mutation canaries, boundary fixtures, production-path equivalence, inventory, SSRF, rollback, and hosted checks all pass on the exact consumer PR head.

### Consumer pin-bump runbook

Update the Action and site independently, each in its own PR, and pin the eventual engine **merge commit**, never a PR head or tag. In each consumer, replace the committed engine artifact byte-for-byte and update all of these locations together:

| Consumer | Authoritative pin/hash locations | Test mirrors that must agree |
|---|---|---|
| `hireamino/amino-audit-action` | `.github/amino-audit-engine.pin`; `vendor/amino-audit-engine/provenance.json`; `scripts/verify-pinned-engine.sh` (`EXPECTED_HASH`); `test/engine-source-contract.mjs` (pin, hash, and contract-version literals) | `scripts/canary-fetch-pinned-engine.sh` healthy-copy hash; contract-version expectations in `test/engine-equivalence.mjs` and `test/production-wiring.mjs` |
| `hireamino/amino-site` | `.github/amino-audit-engine.pin`; `vendor/amino-audit-engine/provenance.json`; `scripts/verify-pinned-engine.sh` (`EXPECTED_HASH`); `test/engine-source-contract.mjs` (pin, hash, and contract-version literals) | `scripts/canary-fetch-pinned-engine.sh` healthy-copy hash; contract-version expectations in `test/engine-equivalence.mjs` and `test/production-wiring.mjs` |

For both consumers, verify the committed `vendor/amino-audit-engine/engine.mjs` is byte-identical to `src/engine.mjs` fetched anonymously at the pin; prove the fetched checkout resolves to the exact pin; run the pinned corpus and all canaries against the shipped copy; and keep `.github/amino-skills.pin` unchanged unless a separately approved scope says otherwise. A consumer pin bump is not complete if any pin, provenance, expected hash, canary mirror, or contract-version assertion still describes the prior engine.

## License

Apache License 2.0, matching the existing public HireAmino repositories. See [`LICENSE`](LICENSE).
