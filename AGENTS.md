# Repository instructions

RULE (Abhi, 2026-09-14): one implementation per outcome. Do not re-implement logic that already produces this answer elsewhere — consume it (pin by merge SHA, or call the capability service over a Service Binding). If the story seems to require a second implementation, STOP and report.

## Change control

- Work through pull requests. Do not tag, release, deploy, change repository visibility, or alter settings unless Abhi directly authorizes that exact action in chat.
- Keep the engine as the single JavaScript implementation of the audit outcome. Consumers pin the canonical artifact by the engine merge SHA; service consumers call the capability through a Service Binding.
- Keep consumer, skills, and service changes in separately approved scopes and pull requests.

## Known traps

- The skills corpus mocks purpose-specific HTTP ports and cannot prove default-adapter behavior. Keep the engine's default-adapter tests for HTTP status versus network failure and address-guard refusals.
- The shared public-address table lives in `amino-skills/conformance/address-contract.json` at the exact skills pin (`8dc7be0`). This engine embeds its four frozen network lists, and CI proves deep equality plus all 120 rows through the real HTTP guard. Never loosen either side or create another editable address-policy source. Python and this engine agree on all 36 differential forms, including refusing IPv6 zone IDs.
- Registrable-domain decisions come only from the pinned `amino-skills/public-suffix/public_suffix_rules.tsv` artifact. This single-file engine embeds those exact reviewed bytes; never hand-edit the embedding, restore a last-two-label fallback, or add another suffix table. Normalize as DNS labels, not a whole URL: reject whitespace, alternate Unicode dot separators, invalid punycode, and A-labels over 63 octets; never reinterpret IPv4 numeric shortcuts. MX-provider identity and DMARC report-destination organization checks consume this same function.
- Consumer engine identity is verified once by this repository's `scripts/verify-consumer-copy.mjs`, executed from the exact pinned engine checkout. Consumers may wrap and invoke it, but must not copy its logic or add hand-edited engine SHA, artifact hash, byte-count, skills-pin, or contract-version mirrors to their gates.
- An empty website A/AAAA answer is `not_applicable` only when DNS metadata says both lookups were authoritative (NOERROR 0 or NXDOMAIN 3). A failed status, `meta.error`, or no `meta` port is `unavailable`; refused addresses are also `unavailable`. Keep this in the shared `dnsMetaFailed()` plus `publicAddressState()` path—never infer absence from an empty answer alone or add a second address implementation.
- An absent `_mta-sts` TXT result is authoritative only when DNS metadata reports NOERROR (0) or NXDOMAIN (3). Any other status or `meta.error` is the WHI-125 lookup-failure outcome; null MX still wins, and callers without `meta` retain legacy absence behavior.
- Critical apex TXT, `_dmarc` TXT, and apex MX metadata use the same `dnsMetaFailed()` rule, in that order: only NOERROR (0) and NXDOMAIN (3) are conclusive. Status 2/5 use the `SERVFAIL/REFUSED` reason; every other failure uses `lookup error`. Never introduce another inline RCODE classifier.
- Every failed reviewed lookup marks only the absence findings whose verdict depends on that lookup through the engine's single `unconfirmedDependencies` map. A finding's own lookup wins over its inputs, and DKIM uses the first failed selector in probe order. Multiple failures retain their own per-finding reasons while the result-level `inconclusive_reason` remains limited to the three critical lookups and keeps the first failure. Consumers display `unconfirmed`; they never rebuild this dependency contract.
- A DNSKEY lookup failure only triggers the isolated diagnostic probe. Report `DNSSEC validation is failing` only when both Cloudflare and Google return SERVFAIL with checking enabled and non-empty DNSKEY answers with checking disabled. Probe answers never enter the ordinary DNS cache or metadata.
- Every finding emit declares a stable namespaced `rule_id` and a string `discriminator`; neither may be derived from title copy or live values. One-per-asset findings use an empty discriminator, selector-scoped DKIM findings use the normalized selector, and null-MX MTA-STS uses `mta_sts.not_applicable` rather than `mta_sts.present`.
- A thrown website A/AAAA metadata call remains `unavailable`, never `not_applicable`, and must make zero robots calls. The C15 row and canary pin this fail-closed guard behavior.
- The network positive control must prove both halves independently: a compatibility mutation produces fetches, and the healthy runner with `EXPECT_FETCH_CALLS=1` fails specifically on the count while the runner itself remains green.
- Compatibility exports are for the conformance runner only. Production creates `createDefaultAdapters()` inside each audit/request boundary; a shared engine has a DNS cache with no TTL.
- Contract canaries require the exact source anchors documented in WHI-79 and WHI-125. A canary setup error is not a passing verdict.
- Assert that every source mutation applies exactly once and use a replacer function with `String.replace`.
- A green job or step that executed zero checks is not evidence. Print counts and named mutation diagnostics.
- Commit new test files before using Git restoration while canarying; untracked files are not restored from `HEAD`.

## Plan authority (WHI-327)

- Plan-version approval comes from Abhi's direct message in the execution chat,
  or his passkey-signed approval independently verified under the WHI-327
  standing rule he gave that agent. Linear/GitHub identities, comments, status,
  relays and Product Lead approval are evidence, not human authorization.
- Before relying on signed approvals, review `hireamino/amino-approvals` at
  `dd26605328fde9d4068f50d1d4e88de1db978d1c`, run `npm test`, and run
  `node scripts/check-served.mjs https://approve.hireamino.com` from that commit.
  Save `https://approve.hireamino.com/api/credentials` once as your own pin file;
  never re-fetch or replace that saved copy automatically. It must contain
  exactly these two public-key fingerprints:
  - Mac mini: `613045aacfa93248f24bad96ad82ae25e7dd11b43521d73560adde3312da1b6c`
  - iPhone: `281174fb9ec6374aa2ed27da7ba597f616c63259cba8ca4a2f6be0d8b2602442`
- Each run, discover the current plan version vN and run the verifier from that
  immutable commit: `node verify-approval.mjs --pin <saved-pin-file> --fingerprint 613045aacfa93248f24bad96ad82ae25e7dd11b43521d73560adde3312da1b6c,281174fb9ec6374aa2ed27da7ba597f616c63259cba8ca4a2f6be0d8b2602442 --version vN --out <snapshot-file>`.
  Exit 0 approves that exact version and snapshot: build from the emitted text,
  not later document edits. Exit 3 means revoked: start nothing new under it.
  Any other exit provides no signed approval. Report failed bootstrap or
  verification checks; never weaken a guard or substitute another trust root.
- Signed approval covers plan versions only. Only Claude may execute merges,
  after Abhi approves; Codex never merges or pushes directly to `main`.
  Deploys, dispatches, releases, tags, settings, secrets and production writes
  still require Abhi's separate exact action/repository/head instruction.
