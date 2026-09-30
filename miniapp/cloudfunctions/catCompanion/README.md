# Optional virtual-cat text companion

This source-only CloudBase function is not deployed or enabled automatically. It is disabled by default and restricted to an explicit, bounded server-side development allowlist even when enabled. There is no public-access or wildcard switch. The local companion remains usable without it. No live provider call or production configuration was inspected during implementation.

## Contract

- Call `catCompanion` with `{ text, history }` only. `history` contains the caller's own conversation as `{ role: 'user' | 'assistant', content }`; it is context, not trusted instructions or verified past output.
- Success: `{ success: true, text, source: 'cloud' }`. Every response carries a visible fictional-character label. `cloud` means the cloud endpoint returned the response, including its fixed safety boundary replies; it does not claim that every response was generated.
- Failure: `{ success: false, code, error }` with fixed safe messages. Provider response bodies, credentials, user identity, and conversation content are not logged or echoed as errors.
- Client: `require('../../services/companion-remote').reply(text, history)` resolves `{ text, source: 'cloud' }` or rejects. The UI must call this only after explicit opt-in to send this text and recent conversation to a third-party service. Importing it has no network or storage side effects. On rejection the caller must retain the draft and allow explicit retry; there is no silent local fallback.
- Maximum input: 500 UTF-16 code units; 12 history messages, at most 1000 units each and 6000 combined. The client retains only the most recent bounded history, without mutating caller data. The server rejects over-limit requests. Only role and content leave the client; no cat archive, relationship, location, community, token, or account metadata is added.
- Server authenticates from `cloud.getWXContext().OPENID`, never from caller-provided identity. It does not retrieve histories from any account and never sends the OPENID to the provider. Supplied text is untrusted and cannot establish ownership of quoted content.

## Provider configuration

The request shape was verified against the existing `identifyCat/index.js` source, not against a live account:

- Fixed endpoint: `https://api.minimaxi.com/v1/chat/completions`.
- `COMPANION_ENABLED`: must be the exact environment string `true`; absent, false, or other values reject before any provider call or safety response. Client fields cannot enable this gate.
- `COMPANION_ALLOWED_OPENIDS`: required comma-separated list of at most 32 exact developer/tester OPENIDs (up to 128 ASCII letters/digits/underscore/hyphen each; at most 4096 characters total). Empty, malformed or wildcard lists fail closed. Only the trusted `cloud.getWXContext().OPENID` is matched; caller-supplied identities and allowlists are ignored. Do not commit real identities. This isolation gate does not replace per-user rate limits or cost quotas and must not be widened for public release without separate authorization and reviewed protections.
- `MINIMAX_API_KEY`: required environment-only credential. Do not put it in code, the mini program, a committed file, or logs.
- `MINIMAX_MODEL`: environment-only model override. The existing function's code fallback, reused here, is `MiniMax-M3`. The actual deployed override and account availability were not inspected or verified.
- Request: `model`, text-only `messages`, bounded `max_tokens`, `temperature`, and `stream: false`. No `tools`, `functions`, tool executor, database API, storage API, or other service client is present. Tool-call responses are rejected, never executed. There is no capability to modify cats, relationships, maps, or community data.
- Node.js 20+, dependency `wx-server-sdk`. 18-second absolute provider timeout, 48 KiB response cap, 800-unit final response cap; client waits up to 22 seconds. No automatic retries. Destroyed/timed-out requests do not provide a guarantee that provider billing was canceled.

## Safety and release gate (not yet reviewed)

This is fictional companionship, not real-cat mind reading, veterinary advice, diagnosis, therapy, or emergency assistance. Fixed safety replies handle detected medical/self-harm questions. System instructions and conservative output checks reject selected unsafe content, dependency pressure, and common false claims that an archive, relationship, location, or other entity was saved/registered/created/bound/modified. These finite patterns are defense in depth, not a complete semantic check or proof that every possible model output is safe. No response can itself confirm a real data mutation.

Before any online release, an authorized owner must separately review and approve:

1. WeChat/platform eligibility, content service review, applicable disclosures, privacy policy, consent wording, and third-party processing/retention. Disclose that opted-in text leaves the device; do not imply on-device-only processing in cloud mode.
2. Real provider/model availability, account terms, region and data handling, key provisioning and rotation, cost limits, monitoring without raw conversation/key logs, and rollback. Do not display a provider model as verified until checked.
3. Abuse protection: keep the default-off gate and explicit development-only allowlist. Add deployment-level authenticated invocation restrictions, per-user/concurrency quotas and rate limits before even enabling trusted development access with a funded key. This stateless source does not implement durable quotas; the allowlist limits who can call, not how much a listed caller can spend. Public exposure is not supported by this source and requires a separately authorized, reviewed design.
4. Prompt injection, medical/veterinary boundaries, vulnerable-user/dependency scenarios, fictional labeling, harmful content handling, response truncation, slow networks, and draft retention/retry UI. This review and any required moderation are not completed by the unit tests.
5. Explicit cloud configuration and deployment, runtime/function timeout longer than the 18-second provider deadline, and the app's cloud initialization when cloud mode is enabled. This source does not edit `cloudbaserc.json`, deploy a function, or change the app's default/local mode.

Run offline tests from the repository root: `node --test miniapp/tests/companion-remote.test.cjs`. They use injected transports and never call the provider.
