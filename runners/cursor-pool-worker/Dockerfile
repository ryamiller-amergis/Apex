# My Work cloud-agent image. The Job overrides the command to cursor-run-cli.
# Runtime env: CURSOR_API_KEY, ADO_PAT, REPO_URL, AGENT_*.
#
# Build from repo root:
#   docker build -f runners/cursor-pool-worker/Dockerfile -t apex-cursor-worker:local .

FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION=24.11.0
ARG DOTNET_CHANNEL=8.0

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:/usr/share/dotnet:${PATH}"
ENV DOTNET_ROOT=/usr/share/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      jq \
      libicu74 \
      openssh-client \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      "amd64"|"") node_arch="x64" ;; \
      "arm64") node_arch="arm64" ;; \
      *) echo "Unsupported Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      -o /tmp/node.tar.xz \
 && mkdir -p /usr/local/lib/nodejs \
 && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
 && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/node" /usr/local/bin/node \
 && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/npm" /usr/local/bin/npm \
 && ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}/bin/npx" /usr/local/bin/npx \
 && rm -f /tmp/node.tar.xz \
 && node --version

RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir /usr/share/dotnet \
 && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && rm -f /tmp/dotnet-install.sh \
 && dotnet --list-sdks

# Bake the Cursor agent CLI into the image. Do not reinstall on every Job start.
RUN curl -fsSL https://cursor.com/install | bash \
 && agent --version

WORKDIR /workspace

COPY runners/cursor-pool-worker/git-credential.sh /usr/local/bin/cursor-git-credential
COPY runners/cursor-pool-worker/run-cli.sh /usr/local/bin/cursor-run-cli
COPY runners/cursor-pool-worker/activity-log.mjs /usr/local/bin/cursor-activity-log
COPY runners/cursor-pool-worker/pr-description.md /usr/local/share/apex/pr-description.md
# Windows checkouts add CRLF, which breaks the bash shebang inside Linux.
RUN sed -i 's/\r$//' /usr/local/bin/cursor-git-credential /usr/local/bin/cursor-run-cli /usr/local/bin/cursor-activity-log \
 && chmod +x /usr/local/bin/cursor-git-credential /usr/local/bin/cursor-run-cli /usr/local/bin/cursor-activity-log

ENTRYPOINT ["/usr/local/bin/cursor-run-cli"]
