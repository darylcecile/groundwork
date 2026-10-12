FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/tools --no-audit --no-fund --save-exact \
    @github/copilot@1.0.95 @github/copilot-sdk@1.0.19 @opencode/cli@2.0.26 bun@1.3.14
ENV PATH="/opt/tools/node_modules/.bin:${PATH}" CI=true COPILOT_AUTO_UPDATE=false
COPY native.mjs /opt/tools/native.mjs
RUN mkdir -p /opt/runtime /run/credentials /workspace /logs/agent \
    && ln -s /opt/tools/native.mjs /opt/runtime/native.mjs \
    && printf '#!/bin/sh\nexec node /opt/tools/native.mjs gh "$@"\n' > /usr/local/bin/gh \
    && chmod 755 /usr/local/bin/gh \
    && printf '#!/bin/sh\nexec bun /opt/groundwork/skills/verify-work/verify.mjs "$@"\n' > /usr/local/bin/groundwork \
    && chmod 755 /usr/local/bin/groundwork \
    && chown -R node:node /workspace /logs/agent /run/credentials
WORKDIR /workspace
CMD ["sleep", "infinity"]
