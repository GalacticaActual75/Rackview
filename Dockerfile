FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ipmitool node-ws novnc \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /var/lib/rackview

WORKDIR /app
COPY server.mjs ipmi.mjs console.mjs ./
COPY web/ ./web/

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
