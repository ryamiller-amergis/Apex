# Local Studio Edit Loop — Slice 1 Contract Record

Status: Red  
Scope: Provider-neutral editable preview session contract and cloud portability  
Implementation boundary: No Docker, Azure, route, database-schema, or client implementation in this slice

## Outcome

This slice defines the runtime boundary needed to let an agent update a draft
application while the Build Workspace preview remains open.

The user experience is provider-independent:

1. Apex materializes a writable workspace from an immutable source snapshot.
2. The provider starts the Golden Stack development profile.
3. HTTP, WebSocket, and Vite HMR transport checks must all pass.
4. An agent submits ordered, content-addressed change sets.
5. Each accepted change set advances the workspace version in the same session.
6. The draft can be reconstructed from the base snapshot and its change sets.
7. Quality tasks use stable task identifiers rather than provider commands.
8. The editable draft never satisfies `preview_ready`; production build,
   browser verification, and atomic preview replacement remain required.

## Provider Contract

`EditablePreviewSessionProvider` owns only the editable compute session:

- `start`
- `inspect`
- `applyChangeSet`
- `runTask`
- `renew`
- `suspend`
- `resume`
- `destroy`

The provider receives opaque artifact and database grants. It does not receive a
public preview URL, host filesystem path, Docker mount, cloud resource ID, or
arbitrary shell command through the shared contract.

Workspace writes use both an idempotency key and an expected workspace version.
Equivalent retries return the same result. A stale expected version or changed
payload for a reused key returns a non-retryable conflict.

## Cloud Portability Requirements

The local Docker adapter and cloud sandbox adapter must pass the same provider
conformance suite.

- Source state is an immutable base snapshot plus ordered change-set artifacts.
- Provider observations expose opaque references, never URLs or local paths.
- The workspace is writable but ephemeral; Apex-owned artifacts are the
  recovery source after suspend, expiry, or provider loss.
- The development profile comes from a versioned Golden Stack manifest.
- HTTP, WebSocket, and Vite HMR are required capabilities.
- The preview gateway owns browser-facing URLs and WebSocket forwarding.
- Provider-specific process, port, volume, and credential details stay inside
  the adapter.
- Synthetic preview data remains isolated behind an opaque database grant.
- TTL, renewal, suspension, destruction, and idempotency are common behavior.
- Egress remains denied unless an explicit preview policy allows a host.

`start` has ensure semantics keyed by `correlation.sessionId`. An Apex process
restart must not create a second workspace or change the browser-facing route
when the provider still has a healthy session. The local adapter recovers the
workspace version and ordered change sets from provider-owned Docker state. A
cloud adapter must recover the same data from its durable control plane. If the
provider finds only a partial or unhealthy session, it removes that session and
creates one replacement.

The Azure pilot must prove writable workspace behavior, HMR WebSocket upgrade
and reconnect, long-lived process supervision, and reconstruction from source
artifacts after both Apex and worker restarts before it can claim parity with
the local provider.

## Red Evidence

The contract and portability invariant tests compile. The in-memory provider is
an explicit red-phase placeholder, so its conformance tests fail on start.

Expected failing behaviors:

- materialize and inspect a ready editable session
- apply and replay a change set
- reject stale writes and changed idempotency replays
- run stable quality tasks and complete lifecycle operations

## Next Green Slice

Slice 2 implements the in-memory provider and makes the provider conformance
suite pass. It does not start Docker or expose a user-facing editor. The Docker
writable-workspace adapter and a real Vite HMR browser proof follow only after
the provider behavior is green.
