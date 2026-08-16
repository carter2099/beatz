FROM golang:1.26.6-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/beats .

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/beats /beats
ENV BEATS_ADDR=:30142 \
    BEATS_MEDIA_ROOT=/music
EXPOSE 30142
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/beats", "healthcheck", "http://127.0.0.1:30142/healthz"]
ENTRYPOINT ["/beats"]
