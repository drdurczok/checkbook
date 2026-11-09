FROM rust:1.96-bookworm AS builder

WORKDIR /build

RUN apt-get update \
    && apt-get install --no-install-recommends -y clang cmake mold \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
# The builder has no database, so the SQLx `query!` macros must compile against the
# committed offline metadata in `.sqlx/` rather than a live connection.
COPY .sqlx ./.sqlx
ENV SQLX_OFFLINE=true
# Mirror CI: rustc 1.96 needs a 1 GiB worker-thread stack and serial builds.
# GNU ld 2.40 crashes even on proc-macro links in the runner CT, while rust-lld
# crashes on the Typst graph, so route all links through mold.
ENV RUST_MIN_STACK=1073741824
ENV CARGO_BUILD_JOBS=1
ENV RUSTFLAGS="-Clinker=clang -Clink-arg=-fuse-ld=mold"

# RUST_MIN_STACK sizes only rustc's worker threads. The main thread (resolver,
# LLVM under opt-level=3) follows this stack limit: at Docker's default 8 MiB
# it overflows, dying with SIGSEGV or bogus diagnostics (phantom E0425s in
# pxfm, crashes in axum/typst). Verified locally: 8 MiB fails, unlimited works.
RUN ulimit -s unlimited && cargo build --locked --release --bin checkbook

FROM debian:bookworm-slim AS production

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 checkbook \
    && useradd --system --uid 10001 --gid checkbook --home-dir /var/lib/checkbook checkbook \
    && mkdir -p /var/lib/checkbook/backups /var/lib/checkbook/data-loads \
    && chown -R checkbook:checkbook /var/lib/checkbook

COPY --from=builder /build/target/release/checkbook /usr/local/bin/checkbook

USER checkbook:checkbook
WORKDIR /var/lib/checkbook

ENV LISTEN_ADDRESS=0.0.0.0:8000 \
    BACKUP_ADMIN_ROOT=/var/lib/checkbook/backups

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8000/health/ready"]

ENTRYPOINT ["checkbook"]
CMD ["serve"]
