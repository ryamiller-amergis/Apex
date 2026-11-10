---
adr-number: ADR-pending
status: Accepted
date: 2026-11-05
slug: build-preview-origin-access
approved-by: Phase 2 product owner
approval-source: Cursor session approval on 2026-11-05
---

# Build Preview Origin and Access

## Status

Accepted for the Phase 2 pilot.

## Context

Generated applications execute code that Apex did not author. They need normal browser behavior, API requests, cookies or session state, streaming, and WebSockets, but they must not inherit Apex cookies, storage, origin privileges, provider credentials, or management tokens.

Phase 1 serves token-gated static assets and places a bearer token in the preview URL. Long-lived URL credentials can leak through history, logs, screenshots, referrers, and copied links. A subdomain of the Apex registrable domain would also remain in the same browser site and could interact with parent-domain cookies.

## Decision Drivers

- Keep generated JavaScript outside the Apex origin and browser site.
- Authorize every preview viewer against the current build.
- Support API traffic, cookies, streaming, and WebSockets through one stable URL.
- Revoke access immediately when a preview expires, is cancelled, is accepted, or is superseded.
- Keep provider endpoints, handles, and management tokens server-side.

## Considered Options

### Serve previews under the Apex origin

This gives generated code access to an origin that carries Apex state. Rejected.

### Use a subdomain under the Apex registrable domain

Origins differ, but the browser site and parent-domain cookie boundary remain shared. Rejected.

### Use a separate registrable preview domain behind an Apex gateway

The gateway authorizes the viewer, maps an opaque host to a verified instance, and proxies application traffic. Chosen.

## Decision Outcome

Chosen option: **Apex-authorized gateway on a separate registrable preview domain**.

Example:

`https://p-<opaque-key>.<apex-preview-domain>/`

Rules:

- The sandbox has no anonymous or browser-discoverable ingress. For the pilot, its application port uses the provider's Entra-protected endpoint.
- A dedicated preview gateway calls that endpoint with its managed identity. The provider endpoint and sandbox handle remain server-side, and direct requests without the gateway identity must receive `401` or `403`.
- The gateway is the only browser entry point. Private provider connectivity remains the preferred production topology when available.
- Apex issues a 60-second, single-use launch ticket after checking project assignment and `builds:view`.
- The gateway exchanges the ticket, redirects to a clean URL, and uses a host-only, Secure, HttpOnly, short-lived preview cookie. Persistent bearer credentials and provider session identifiers never appear in the final URL.
- The cookie is renewable for 15 minutes but cannot outlive the preview instance.
- The gateway strips caller-supplied identity headers and injects one signed, short-lived synthetic preview assertion.
- The synthetic subject is pseudonymous and distinct for each viewer and preview instance. Browser verification uses a separate principal.
- The assertion contains no real Entra token, OID, email, production role, or personal data.
- Requester and project-assigned users with `builds:view` may view the preview. Revision and acceptance controls remain requester/admin-only.
- Expired or revoked mappings return `410 Gone`; unauthorized viewers receive `403`.
- `frame-ancestors` permits only approved Apex origins, and referrer policy prevents ticket leakage.
- The iframe may add `allow-same-origin` only after the separate registrable domain is active. It must not add top-navigation, unrestricted popups, downloads, or other capabilities without a specific requirement.

Browser-cookie behavior is a pilot condition, not an assumption. The pilot must test managed Chrome and Edge plus required Safari/Firefox coverage for third-party cookie blocking, partitioned cookies, redirects, reloads, WebSockets, and opening the preview in a new tab. If the supported fleet cannot retain a safe iframe session, the product must use a top-level preview or another gateway session mechanism before production.

## Consequences

### Positive

- Generated code cannot read Apex cookies or storage.
- Preview URLs remain stable while provider instances change.
- Authorization, revocation, identity, and protocol handling have one owner.
- Provider management tokens never reach the browser.

### Negative

- A separate domain, certificates, gateway, and browser-session exchange are required.
- Third-party cookie restrictions require explicit compatibility testing.
- Proxy support for streaming and WebSockets must be proven.
- The gateway becomes a critical runtime dependency.

## References

- `src/client/components/BuildSandboxPreview.tsx`
- `src/server/routes/buildPreviewAssets.ts`
- `src/server/services/builds/buildReadAccess.ts`
- `design-docs/build-deployment-callback.md`
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors
- https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies
