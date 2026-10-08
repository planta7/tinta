FROM mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

USER root
RUN test "$(node --version)" = "v24.21.0" \
    && npm install --global pnpm@10.34.6
RUN mkdir /workspace && chown pwuser:pwuser /workspace
WORKDIR /workspace
COPY --chown=pwuser:pwuser . .
USER pwuser
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "verify", "--suite", "infrastructure"]
