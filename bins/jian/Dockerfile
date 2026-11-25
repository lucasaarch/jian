# The Rust gateway, with its Postgres inside. Build from the repository root:
#
#   docker build -f bins/jian/Dockerfile -t jian-gateway .
#
# The build downloads the Postgres archive that goes into the binary from GitHub, which rate
# limits anonymous callers. Pass a token as a build secret when the build runs where many do
# (CI, a shared NAT); it is not stored in the image:
#
#   docker build -f bins/jian/Dockerfile --secret id=github_token,env=GITHUB_TOKEN -t jian-gateway .
#
# Run it with a volume on /data: the cluster, the unpacked server and the password live there.
#
#   docker run -v jian-data:/data -p 4410:4410 jian-gateway
#
# Set DATABASE_URL to use a Postgres you run yourself; the embedded one then does not start.

FROM rust:1.98.0-bookworm AS build
WORKDIR /src
# Only what the Cargo workspace needs; the Node apps and packages are not part of this image.
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
COPY bins bins
COPY packages/remote-core/native packages/remote-core/native
RUN --mount=type=secret,id=github_token \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    if [ -f /run/secrets/github_token ]; then GITHUB_TOKEN="$(cat /run/secrets/github_token)"; export GITHUB_TOKEN; fi \
    && cargo build --release --locked -p jian \
    && cp target/release/jian /jian

FROM debian:bookworm-slim
# tini is PID 1: it forwards SIGTERM to the gateway and reaps the Postgres processes that outlive
# it, which a gateway as PID 1 would leave as zombies. ca-certificates is for outgoing TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# initdb refuses to run as root, so the gateway does not either.
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin jian \
    && mkdir /data && chown jian:jian /data
COPY --from=build /jian /usr/local/bin/jian
USER jian
ENV JIAN_DATA_DIR=/data
VOLUME /data
EXPOSE 4410
# Under the 10 s `docker stop` allows: 8 s to drain requests, then the database stops.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jian"]
CMD ["--addr", "0.0.0.0:4410"]
