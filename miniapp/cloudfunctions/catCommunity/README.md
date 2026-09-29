# catCommunity — isolated, real-identity community backend

This function is deployed separately to `cloud1-d6gpjpxunc74669d7` and remains outside the original deployment manifest. It does not read, migrate, mutate, or seed any `catOnline`, identification, household, medical, or original user collection. There is no demo identity or content fallback. User identity comes only from the current invocation's trusted second handler argument, parsed by the official SDK; client-supplied identity fields and a warm instance's `cloud.getWXContext()`/`process.env` identity are not accepted. Signed operator actions have a separate authorization path and never accept an actual WeChat caller.

The current handler is `isolated-entry.main`. Final live feature-flag readbacks and photo-sharing acceptance results are recorded in [`docs/social-photo-sharing-research.md`](../../../docs/social-photo-sharing-research.md). This README describes the contract and procedure, not a claim that media is currently enabled.

## Deployment status — 2026-09-29

- User explicitly authorized cloud deployment/testing. `tools/deploy_cat_community.py` created only four new ADMINONLY collections and four compound indexes, deployed source-only with remote dependency installation to Nodejs20.19, and downloaded/verified source/config files by SHA-256. The current manifest contains **15** runtime/config files, including `request-context.js`, `isolated-entry.js`, `request-worker.js` and `worker-env.js`. Dedicated independent secrets remain server-only. Dependencies are pinned to `wx-server-sdk@4.0.2`, `@cloudbase/node-sdk@3.17.2` and `sharp@0.35.4`.
- Actual WeChat identity, approved text publication, public homepage, approved comment/reply, exact reply lookup and idempotent retry were tested. This is one real account, not two synthetic accounts; zero self-notifications does not establish cross-account delivery. Earlier pending visibility and direct client database read/write denials also remain valid. The labelled text post, two comments and isolated quotas were precisely removed and absence verified.
- `CAT_COMMUNITY_MEDIA_ENABLED` defaults closed and enables only for the literal string `true`. `mediaContext`, photo publication and trusted photo approval are refused while closed. Text-only publication does not request media configuration and retains the ordinary moderation requirement. Rejecting pending content remains possible.
- Storage remains **PRIVATE**. Historical attempts to add a namespace-wide client-write prohibition were rejected by `ModifyStorageSafeRule` (`InvalidParameter`, `rule invalid`), and the equivalent `ModifyResourcePermission` call did not produce the intended rule in either read API. No custom rule is claimed. The current release route instead verifies PRIVATE ownership of **existing server-created immutable display objects**, unpredictable new names, exact byte readback and approved-record-only projection. It does not require every client create under a directory name to be forbidden, and it does not relax ownership or make the bucket public. See the gates below.
- WeChat official `cloud_fn_inc_deploy` for `config.json` completed successfully after native confirmation. Live `security.msgSecCheck` explicitly passed the labelled text post and comments. The ordinary CloudBase CLI alone does not apply `permissions.openapi`.
- **Historical evidence, not the current gate readback:** an earlier short-lived signed operator probe exercised actual Sharp encoding, SDK upload and exact hash/size readback using a fixed synthetic image. The then-current client downloaded it, overwrite was denied and deletion returned failure; administrator readback proved it unchanged before exact cleanup and 404 confirmation. Both flags were closed after that run. A later pre-isolation probe was rejected at the operator-identity guard before storage I/O. Neither result alone proves the newly deployed worker/download route or a full user photo publication.
- Request isolation fixes the warm-instance identity/token issue; the 15-file deployment and handler were verified. Live probe/release and complete photo-flow outcomes must be read from the current research/acceptance document, not inferred from offline tests. Two-real-account delivery/isolation and physical-device UX are separate outstanding acceptance checks unless explicitly recorded there. Deployment is not WeChat publication or review submission. Earlier evidence remains in [`docs/social-original-integration.md`](../../../docs/social-original-integration.md).

## Per-request identity and SDK isolation

`request-context.js` uses `@cloudbase/node-sdk.parseContext` on the platform's second argument (`environment`, or validated legacy `environ`). Missing/malformed context and conflicting environment IDs fail closed. Event fields named `openid`, `context`, `environment`, or similar cannot replace the platform argument. Ordinary actions still require an authenticated WeChat identity; absence of OPENID alone never authorizes an operator action.

Because SDK internals also read tokens from `process.env`, `isolated-entry.main` starts a fresh `worker_threads` Worker for every accepted request. Its independent environment contains only the five application configuration keys, necessary runtime/CA/path keys and the selected current invocation's identity/token fields. No `SHARE_ENV`, global credential mutation, parent WX/TCB-token fallback or credential queue is used. Only the complete SCF server-role `TENCENTCLOUD_SECRETID`/`TENCENTCLOUD_SECRETKEY`/`TENCENTCLOUD_SESSIONTOKEN` tuple may fall back to platform process values when the current context provides none; partial tuples are rejected and never mixed. The SDK is first loaded inside that worker.

The entrypoint bounds payload/result size, caps active workers at two per instance and terminates each worker after a result, error or 55-second deadline. SDK stdout/stderr and error stacks are not forwarded. Offline real-Worker A → operator → B tests establish isolation mechanics, not a claim of successful live authentication or two-account behavior.

## Deployment gates (authorization received; incomplete gates remain closed)

1. Set a dedicated stable `CAT_COMMUNITY_OWNER_SECRET` of at least 32 bytes and `CLOUDBASE_ENV_ID`. Never put the secret into client code. Changing it changes pseudonymous identities and request keys.
2. Create **only** these new collections with **ADMINONLY** access (`database.rules.json`, both client read and client write false): `cc_posts_private`, `cc_comments_private`, `cc_notifications_private`, `cc_limits_private`. A repository rule file does not apply cloud permissions by itself. All public reads are mediated by this function's whitelist.
3. Add compound indexes (all trailing ordering fields descending): posts `(status, createdAt DESC, _id DESC)` and `(author.id, createdAt DESC, _id DESC)`; comments `(postId, status, createdAt DESC, _id DESC)`; notifications `(recipientId, createdAt DESC, _id DESC)`. Verify the deployed database supports the lexicographic cursor query. Do not replace it with unbounded fetches.
4. Keep the bucket's existing **PRIVATE** creator/administrator permissions and verify both storage read APIs agree. Pending originals are owned by their authenticated uploader; clients must not overwrite other owners' files. Verify a real authenticated client cannot overwrite or delete an **existing server-created** display probe, then verify its bytes are unchanged and unsigned HTTPS access is refused. Every approved display file receives a fresh server-generated 256-bit nonce; a client-created file at a similar path is neither a reviewed object nor a public post. Namespace-wide rejection of all client creates is not required by this immutable-object route. The private database, exact submission digest, server promotion/readback and approved-record whitelist are all still required. Do not broaden original storage rules. The app reuploads selected local images to its own issued pending prefix; arbitrary existing file IDs are not accepted. After business ACL checks, the function signs eligible projected images; no public bucket or cross-user client read exception is needed.
5. Enable the WeChat `security.msgSecCheck` permission and validate its version-2 response in the real environment. Only a successful, explicit `pass` is approved; errors, missing permission, unsupported responses, and manual-review suggestions stay pending.
6. To operate manual review, configure a **different** stable `CAT_COMMUNITY_REVIEW_SECRET` of at least 32 bytes in the function. `tools/community_review.py` uses an authorized local CloudBase CLI login, reads the current secret into memory and never asks for it on the command line. Keep the local review reports private. The legacy `sign-review.cjs` remains a lower-level offline signing utility; signing alone is neither review nor publication.
7. Use `tools/community_media_release.py --step enable` with fresh real-client probe evidence, not a raw environment update. It verifies the current handler/runtime, deployed hashes, four ADMINONLY collections, both PRIVATE storage readbacks, client overwrite/delete-denial evidence, post-attempt exact object bytes and unsigned access denial. Both flags must first be closed; the tool changes only the feature flags while preserving freshly read function settings and confirms the result. It explicitly records one-real-account coverage, not two. The normal deployment closes media again; re-enablement requires renewed verification. Any failed or uncertain gate remains closed until resolved.

## Deliberate first-slice limits

- **Every new production image post starts pending until trusted human review.** File magic, digest, and size checks are not moderation. There is no client or member action to approve content. The implemented `reviewPost` administrator entrypoint requires a short-lived signed request and explicit human text/image-review attestations; it verifies stored source digests, strips EXIF/GPS by re-encoding (the existing `catOnline/sanitize.js` convention), uploads immutable server-owned copies under `community-approved/<postId>/`, then atomically approves the post. No original unreviewed image is exposed in the global feed. The local review CLI makes this workflow operable; it does not automatically perform human moderation or certify service-category compliance.
- Pending/rejected posts and source-photo previews are visible only to their author through the function's ACL-filtered, signed projection. Source file IDs stay internal to that projection/signing path. Public text-only posts require verified text approval. Public projections exclude internal request digests, moderation details, and asset digests.
- Cat snapshots contain only `name`, `breed`, `coatColor`; local ID, medical history, location, contact information fields, and arbitrary additional data are discarded. Free text must also pass platform moderation; automatic PII detection is not promised.
- Post bodies: 1,200 UTF-16 units; comments: 300; up to three images, each 5 MB. Captions are optional when photos are present. Transactional daily limits: 12 posts / 120 comments, with minimum gaps of 10 / 2 seconds. Publication attempts also consume a separate atomic 30/day, 2-second-gap budget **before** paid text review or image I/O, including failed attempts. Exactly matched already-committed retries consume neither budget; changed content produces `IDEMPOTENCY_CONFLICT`.
- All image reads use SDK-issued HTTPS URLs internally and `bounded-media.js`, not unbounded `cloud.downloadFile` buffers. Signing has a 5-second deadline; the transfer has a 10-second hard deadline and at most 5 MB + one sentinel byte consumed before abort. No redirects, compressed expansion, partial HTTP responses, user-provided URLs or arbitrary file paths are accepted. An empty/unavailable/oversized stream is never an approval. See the current acceptance document for live-transfer evidence; historical pre-worker failures and closed flags do not describe the current run.
- Comments/replies require an approved public post and approved same-post parent; only one reply level. Only verified approved comments are stored. Unavailable/undecided comment review returns `MODERATION_UNAVAILABLE`; rejected text returns `CONTENT_REJECTED`. Keep the user's input for retry instead of creating a comment that has no review path. No likes, DMs, reporting/admin console, delete UI, or automatic image approval is included. Notifications only arise from approved comments, target the post/parent author, exclude self-notifications, and recheck visibility on read. Only the recipient can mark a notification read.
- Lists use signed, scope-bound keyset cursors ordered by `(createdAt DESC, _id DESC)`, default 20 / max 50 items (comment pages default 30). Post cards show latest three approved comments; details return the first 30 with `nextCommentsCursor`, and `listComments` retrieves older pages. Comment cursors are bound to the post and every page rechecks that the post is still public. Notification links may request a specific approved same-post comment and its approved top-level parent without scanning or exposing unrelated history.

## Client contract

Call `wx.cloud.callFunction({ name: 'catCommunity', data: { action, ...arguments } })`. Results are `{ok:true,data}` or `{ok:false,error:{code,message}}`.

| Action | Arguments | Data |
| --- | --- | --- |
| `identity` | none | `{user:{id,nickname}}` |
| `mediaContext` | none | `{cloudPathPrefix,maxPhotos,maxBytes,acceptedMime}` |
| `publishPost` | `{requestId,content,photos?,cat?,consent:true}` | `{post,idempotent}` |
| `listPosts` | `{filter:'all'|'mine',cursor?,limit?}` | `{posts,nextCursor}` |
| `getPost` | `{postId,commentId?}` | `{post,comments,nextCommentsCursor,targetComment,targetParent,targetUnavailable}` |
| `listComments` | `{postId,cursor?,limit?}` | `{comments,nextCursor}` |
| `addComment` | `{requestId,postId,content,parentId?}` | `{comment,idempotent}` |
| `listNotifications` | `{cursor?,limit?}` | `{notifications,nextCursor}` |
| `markNotification` | `{id}` | `{id,read:true}` |

Request IDs match `[A-Za-z0-9._:-]{8,100}`. Upload filenames appended to `cloudPathPrefix` match `[A-Za-z0-9_-]{8,100}.(jpg|jpeg|png|webp)`. Persist the request ID for ambiguous/network retries; use a fresh one when the user edits content.

`getPost` treats an explicitly requested malformed, missing, unapproved or other-post comment as unavailable, without preventing an otherwise readable story from opening. `targetParent` is null unless it is an approved same-post top-level parent. Without a requested target both target fields are null and `targetUnavailable` is false. Owners may still view their pending/rejected post, but no comment history or target is returned for a non-public post; `listComments` refuses it even for its owner. Notification rows carry `commentId`; clients should pass it only as lookup context, never treat it as permission.

Post projection: `{id,content,photos:[signedHttpsUrl],photoExpiresAt?,photosUnavailable?,cat:null|{name,breed,coatColor},author:{id,nickname},status:'approved'|'pending'|'rejected',createdAt,comments,commentCount}`. The pure core uses file IDs internally; the cloud entrypoint signs only the ACL-filtered projection. Signing failures omit unavailable photos, never return an unapproved source or log signed URLs. `photoExpiresAt` is the earliest local refresh deadline across the available photos, calculated from each signing batch's start plus the smaller of a valid provider `maxAge` and the requested 300 seconds. A missing provider lifetime uses the requested bound; explicitly invalid lifetimes or URLs already expired when all batches finish are omitted. This is a conservative client refresh deadline, not verified evidence of actual provider-side URL expiry. The client accepts only HTTPS projections and renews via `getPost`, never raw file-ID signing. Cards allow one automatic recovery per parent-supplied media version, deduplicated manual retry and safe preview without resetting comment drafts. All dates are UTC ISO strings. A successful pending submission is **not** a public publication; show “已提交，审核后公开”.

## Trusted manual review procedure

Run the following from the repository root with an authorized local CloudBase CLI login. Substitute the exact identifiers/hash/report path returned by the tool. No secret or privileged signature belongs in command arguments, frontend files or logs.

1. List only the isolated pending community submissions. `--limit` is bounded to 50, and `nextAfter` can be supplied as `--after` for the next page:

   ```powershell
   python tools/community_review.py --env-id cloud1-d6gpjpxunc74669d7 list --limit 20
   ```

2. Prepare a local report for one exact post. This is read-only in the cloud. Downloads are constrained to the current bucket/pending paths, bounded in size/time, and checked against `sourceAssets` size, MIME and SHA-256. The tool rereads the post to detect a preparation race:

   ```powershell
   python tools/community_review.py --env-id cloud1-d6gpjpxunc74669d7 prepare --post "post_待审编号"
   ```

   Open the returned `report` HTML. Inspect **all** visible text, the cat card and **every original photo** for inappropriate content, identifiable faces/addresses/contact details and material unsuitable for public sharing. Do not approve from a filename, unrelated thumbnail or generated description. Reports and original bytes are saved under Git-ignored `artifacts/community-review/`; they contain private submissions and may retain original metadata. Keep them local and remove the exact report directory under the operator's retention policy after review. The report has no automatic approval button.

3. Only after actual human inspection, explicitly approve with the current `requestHash` and prepared `manifest`:

   ```powershell
   python tools/community_review.py --env-id cloud1-d6gpjpxunc74669d7 approve --apply --post "post_待审编号" --request-hash "64位请求哈希" --report-manifest "D:\实际报告目录\manifest.json" --reason "已人工检查全文及全部照片，允许公开" --reviewed-text --reviewed-images
   ```

   Both attestations, `--apply` and the matching prepared manifest are required. They are human declarations, not automated moderation. The tool verifies the local report and current cloud source bytes, fetches the secret into memory, signs a four-minute HMAC request and passes it through a short-lived temporary file. It invokes **only** `catCommunity`; signatures and signed image URLs are not printed. The cloud entrypoint still rejects any WeChat caller, requires the independent valid HMAC, caps expiry to five minutes and binds the exact post/hash/decision/reason/review ID. Missing OPENID alone grants no authority. A closed media gate causes photo approval to fail; the review tool never enables it.

4. Approval re-downloads original bytes, checks submission size and SHA-256, strips metadata by re-encoding, and uploads each JPEG to a fresh server-generated 256-bit nonce plus content-hash filename. It re-downloads the returned file ID and verifies exact length/hash before atomically changing a still-pending matching post. PRIVATE protection of those existing server-owned objects, together with the non-predictable names and approved database projection, supplies the display integrity boundary; directory naming alone supplies none. Changed originals, missing assets, encoding/upload/readback failures and concurrent review conflicts do not publish the post. The tool reports success only after the exact post/hash/review ID is read back. An ambiguous invocation requires checking current status before retrying. Identical successful low-level review retries are idempotent; failed/racing promotions can leave unreachable server copies, so never run broad bucket cleanup.

5. To reject an exact pending submission, no image-approval attestations are required:

   ```powershell
   python tools/community_review.py --env-id cloud1-d6gpjpxunc74669d7 reject --apply --post "post_待审编号" --request-hash "64位请求哈希" --reason "照片含可识别的家庭门牌，请处理后重新投稿"
   ```

   Rejection updates only the matching pending post and never uploads images. Already approved/rejected posts cannot be overridden by this first-slice workflow. Public takedown/appeals require a separate audited operator mechanism, not direct client updates.

For low-level diagnostics, `sign-review.cjs` can still create a signed payload using a securely supplied local secret, without network calls. Its output is a short-lived privileged credential and must not be printed into shared logs. Prefer the review tool above for routine operation because it also verifies the actual prepared report and cloud result.

## Operator storage probe and controlled media release

`storage-probe.js` is not a client feature. It rejects any WeChat OPENID, requires the separate review secret with a distinct HMAC domain, a maximum five-minute expiry, and exactly the signed probe fields. It accepts no caller image, cloud path or database identifier and only processes an embedded synthetic 8×8 image. `CAT_COMMUNITY_STORAGE_PROBE_ENABLED` defaults false. The normal deployment explicitly sets both this flag and user media false.

The standard deployment closes both flags. For an authorized diagnostic deployment, `--storage-probe` enables only the signed probe while leaving user media closed:

```powershell
python tools/deploy_cat_community.py --env-id cloud1-d6gpjpxunc74669d7 --apply --step deploy --storage-probe
python tools/community_storage_probe.py --env-id cloud1-d6gpjpxunc74669d7 --apply --step run
```

The probe tool requires its flag already enabled and user media closed, signs through a temporary file, emits no signature/secret and writes an exact synthetic-object cleanup record under `artifacts/community-integration/`. After that server probe, an actual authenticated WeChat client must attempt overwrite/delete of that **same existing object**. Record observed denials and the exact digest/size in the fresh evidence file; do not turn failed automation or offline simulation into a claimed permission result.

Close the probe **before** attempting release. Preserve the exact synthetic object until the release tool has performed the post-client-attempt readback:

```powershell
python tools/community_storage_probe.py --env-id cloud1-d6gpjpxunc74669d7 --apply --step close
python tools/community_media_release.py --env-id cloud1-d6gpjpxunc74669d7 --apply --step enable --evidence "D:\实际验证证据路径.json"
```

The release tool checks evidence age (at most one hour), the target environment and synthetic-object scope, exactly one real-account probe, authenticated overwrite/delete denials, matching deployed source hashes, correct isolated handler/runtime, ADMINONLY collections and both unchanged PRIVATE storage readbacks. It re-downloads the exact object to verify bytes after the client attempts, checks unsigned HTTPS access is denied, freshly rereads all function configuration to detect concurrent edits, and only then sets media true/probe false and verifies the complete settings. It never approves a post. This is not two-account acceptance, a WeChat version release or proof that pending cross-user reads have been tested with a second account. Record full photo upload/review/feed and second-account results separately.

After the evidence has served its purpose, individually remove the exact synthetic probe object and verify absence; never run broad bucket cleanup. Probe success alone does not open media. The emergency close operation does not need release evidence and preserves unrelated function settings:

```powershell
python tools/community_media_release.py --env-id cloud1-d6gpjpxunc74669d7 --apply --step disable
```

The older optional `deploy_cat_community.py --step storage` custom-rule experiment is not required by this PRIVATE/immutable-object release route. Do not rerun rule mutation to bypass failed evidence or broaden the original bucket's permissions.

Local tests require no SDK credentials and make no cloud writes:

```sh
node --test miniapp/tests/community-backend.test.cjs
node --test miniapp/tests/community-integration.test.cjs
node --test miniapp/tests/community-request-context.test.cjs miniapp/tests/community-worker.test.cjs
python -m pytest -q tests/test_deploy_cat_community.py tests/test_community_storage_probe.py tests/test_community_review.py tests/test_community_media_release.py
```

The cross-layer suite invokes the real original-app adapter and this function's entrypoint/repository against in-memory CloudBase/WeChat I/O and a controlled core clock. It covers two synthetic identities, private image review and signed public copies, replies/notifications, response-loss retries after client reload (including an intervening different comment), and comment-moderation outages. The image case executes this function's actual sanitizer using the locally installed `catOnline/node_modules/sharp`; it is explicitly skipped if that dependency is absent. This is not proof of deployed permissions, production transaction behavior, platform moderation or real two-account operation.
