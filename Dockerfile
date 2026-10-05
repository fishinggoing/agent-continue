FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /agent-continue ./cmd/agent-continue

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 agent
RUN mkdir -p /var/lib/agent-continue && chmod 0700 /var/lib/agent-continue && chown agent:agent /var/lib/agent-continue
ENV AGENT_CONTINUE_DATA_DIR=/var/lib/agent-continue
COPY --from=build /agent-continue /usr/local/bin/agent-continue
USER agent
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/agent-continue"]
CMD ["serve", "--listen", "0.0.0.0:8080"]
