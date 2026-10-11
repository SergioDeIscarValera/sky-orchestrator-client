# soc-web (ADR-0016, ADR-0015): the console built once and served by an
# unprivileged nginx; the Supabase address and key arrive at start (FR-DEP-04).
#   docker build -f apps/soc-web/Dockerfile .

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /web
RUN corepack enable
COPY apps/soc-web/package.json apps/soc-web/pnpm-lock.yaml apps/soc-web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/soc-web ./
RUN pnpm build && pnpm budget && pnpm secrets

FROM nginxinc/nginx-unprivileged:1.31.6-alpine3.24-slim@sha256:1517d8c358e2e093957ebee087afa9eb19a32f5d7ecb711b7429e369cb998224
COPY apps/soc-web/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 apps/soc-web/nginx/soc-web.sh /usr/local/bin/soc-web
COPY --from=build /web/dist /usr/share/nginx/html
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["soc-web"]
