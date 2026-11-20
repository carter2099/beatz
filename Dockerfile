FROM golang:1.26.11-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/beatz .

# Pinned by digest: security-watch moves it (base-digest) when a newer image clears Debian
# findings. On 2026-11-20 the newest static-debian12 still shipped tzdata 2026b and
# ca-certificates 20250419~deb12u1, both already updated by Debian LTS advisories.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931

COPY --from=build /out/beatz /beatz
ENV BEATZ_ADDR=:30142 \
    BEATZ_MEDIA_ROOT=/music \
    BEATZ_DATA_ROOT=/data
EXPOSE 30142
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/beatz", "healthcheck", "http://127.0.0.1:30142/healthz"]
ENTRYPOINT ["/beatz"]
