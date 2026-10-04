# One image for all three "machines" (laptop, devbox, pi): sshd, the three harnesses at pinned
# versions, and faplex itself from this checkout. Build context is the repo root.
# Everything is installed here: the compose network is internal, so nothing can be fetched at run time.
FROM node:24-bookworm-slim

ARG CLAUDE_VERSION=2.1.289
ARG CODEX_VERSION=0.160.0
ARG OPENCODE_VERSION=2.0.22
ARG BUN_VERSION=1.4.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server openssh-client ca-certificates curl unzip git procps less ripgrep jq tini bubblewrap \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd

RUN useradd -m -s /bin/bash dev
USER dev
WORKDIR /home/dev
ENV HOME=/home/dev
ENV PATH=/home/dev/.local/bin:/home/dev/.bun/bin:/home/dev/.npm-global/bin:$PATH
RUN mkdir -p /home/dev/.local/bin /home/dev/.npm-global

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
RUN npm config set prefix /home/dev/.npm-global \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && ln -s /home/dev/.npm-global/bin/codex /home/dev/.local/bin/codex
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"
# npm rather than `bun add -g`: bun skips the package's postinstall (which fetches the platform binary).
RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
    && ln -s /home/dev/.npm-global/bin/opencode /home/dev/.local/bin/opencode
RUN claude --version && codex --version && opencode --version

# --- ssh between machines: one keypair baked into the image, so every machine trusts every other
USER root
RUN ssh-keygen -A && printf '%s\n' 'PasswordAuthentication no' 'MaxSessions 20' 'AcceptEnv LANG LC_* TERM COLORTERM' > /etc/ssh/sshd_config.d/e2e.conf
USER dev
RUN mkdir -m 700 /home/dev/.ssh && ssh-keygen -q -t ed25519 -N '' -f /home/dev/.ssh/id_ed25519 -C e2e \
    && cp /home/dev/.ssh/id_ed25519.pub /home/dev/.ssh/authorized_keys \
    && printf '%s\n' 'Host *' '  StrictHostKeyChecking no' '  UserKnownHostsFile /dev/null' '  LogLevel ERROR' > /home/dev/.ssh/config \
    && chmod 600 /home/dev/.ssh/config /home/dev/.ssh/authorized_keys

# --- faplex from this checkout (dependencies first, for layer caching)
COPY --chown=dev:dev package.json bun.lock bunfig.toml tsconfig.json /home/dev/faplex/
RUN cd /home/dev/faplex && bun install --frozen-lockfile
COPY --chown=dev:dev src /home/dev/faplex/src
COPY --chown=dev:dev bin /home/dev/faplex/bin
RUN ln -s /home/dev/faplex/bin/faplex /home/dev/.local/bin/faplex

# --- harness config, daemons and seed
COPY --chown=dev:dev e2e/machine/home/ /home/dev/
COPY e2e/machine/entrypoint.sh e2e/machine/start.sh e2e/machine/seed.ts /e2e/
USER root
ENTRYPOINT ["tini", "--", "/e2e/entrypoint.sh"]
