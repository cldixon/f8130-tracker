# Build for the Go firehose consumer.
#
# Explicit, for the same reason web/Dockerfile is: this repository holds a Go
# module and a Node workspace side by side, and build detection picks whichever
# it finds first.

FROM golang:1.26 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY commitment commitment
COPY ingest ingest
COPY cmd cmd
RUN CGO_ENABLED=0 go build -o /out/ingest ./cmd/ingest

# Distroless rather than scratch: the consumer makes outbound TLS calls to
# resolve identities, so it needs a CA bundle.
FROM gcr.io/distroless/static-debian12

COPY --from=build /out/ingest /ingest
ENTRYPOINT ["/ingest"]
CMD ["run"]
