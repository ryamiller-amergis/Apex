# Apex Load Test Runner — FEAT-002
#
# Base: grafana/k6 (official k6 image)
# Adds: Apex entrypoint stub that wraps k6 execution with
#       pre-run setup (dispatch message ingestion) and
#       post-run callback to the Apex API.
#
# This image is published to the Apex ACR as apex-lt-runner:<tag>
# and referenced by the Container Apps Job in infra/load-test.tf.
# Pin the digest in lt_runner_image after publishing (TBI-002 D4).
#
# Build:
#   docker build -t <acr>.azurecr.io/apex-lt-runner:<tag> -f runner/Dockerfile runner/
#
# Push:
#   docker push <acr>.azurecr.io/apex-lt-runner:<tag>
#   # Record digest: docker inspect --format='{{index .RepoDigests 0}}' ...

FROM grafana/k6:0.55.0

# Switch to root for setup; k6 image uses non-root 'k6' user by default.
USER root

# Install curl and jq for the entrypoint callback logic.
RUN apk add --no-cache curl jq bash

# Copy entrypoint into a well-known location; kept separate from k6 binary paths.
COPY entrypoint.sh /apex/entrypoint.sh
RUN chmod +x /apex/entrypoint.sh

# Scripts directory: the entrypoint writes the dispatched k6 script here
# before executing it. Volume mount or ephemeral; no PII is retained.
RUN mkdir -p /apex/scripts && chown k6:k6 /apex/scripts && chown k6:k6 /apex

# Drop back to the non-root k6 user for execution.
USER k6

# The entrypoint:
#   1. Reads dispatch message from the Service Bus queue (via runner MI).
#   2. Resolves Key Vault secret refs into the k6 environment.
#   3. Writes the script to /apex/scripts/test.js.
#   4. Runs: k6 run /apex/scripts/test.js
#   5. Posts a completion/heartbeat callback to APEX_CALLBACK_URL.
#
# FEAT-008 will replace this stub with the full implementation.
ENTRYPOINT ["/apex/entrypoint.sh"]
