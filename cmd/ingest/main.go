// Command ingest consumes a PDS firehose and maintains the f8130 derived index.
//
// Two subcommands:
//
//	ingest run       consume from the stored cursor, resuming where it left off
//	ingest reindex   discard the index and rebuild it from sequence zero
//
// The second exists to keep an architectural claim honest. The index is
// derived, never authoritative, and the way to know that is still true is to
// throw it away on purpose and watch it come back.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/bluesky-social/indigo/atproto/identity"

	"github.com/cldixon/f8130-tracker/ingest"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: ingest [run|reindex]\n\n")
		fmt.Fprintf(os.Stderr, "environment:\n")
		fmt.Fprintf(os.Stderr, "  DATABASE_URL  PostgreSQL connection string (required)\n")
		fmt.Fprintf(os.Stderr, "  PDS_HOST      firehose origin, e.g. ws://pds.railway.internal:3000 (required)\n")
		fmt.Fprintf(os.Stderr, "  LOG_LEVEL     debug|info|warn|error (default info)\n")
		fmt.Fprintf(os.Stderr, "  F8130_REINDEX =1 forces reindex regardless of the subcommand\n")
	}
	flag.Parse()

	cmd := flag.Arg(0)
	if cmd == "" {
		cmd = "run"
	}
	// A deployed service has a fixed start command, so the only way to ask a
	// running container for a rebuild is a variable. Same shape as SEED_RESET
	// on the seed job: set it, redeploy, unset it.
	if os.Getenv("F8130_REINDEX") == "1" {
		cmd = "reindex"
	}
	if cmd != "run" && cmd != "reindex" {
		flag.Usage()
		return fmt.Errorf("unknown command %q", cmd)
	}

	logger := newLogger()
	slog.SetDefault(logger)

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	host := os.Getenv("PDS_HOST")
	if host == "" {
		return fmt.Errorf("PDS_HOST is required")
	}

	// Cancel on SIGINT/SIGTERM so an in-flight commit finishes its transaction
	// rather than being torn out mid-write.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := ingest.Open(ctx, dsn)
	if err != nil {
		return err
	}
	defer store.Close()

	if err := store.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	if cmd == "reindex" {
		logger.Warn("discarding the derived index and replaying from sequence zero")
		if err := store.Reset(ctx); err != nil {
			return fmt.Errorf("reset: %w", err)
		}
	}

	consumer := &ingest.Consumer{
		Store:     store,
		Directory: identity.DefaultDirectory(),
		Logger:    logger,
		Host:      host,
	}

	logger.Info("starting ingest", "command", cmd, "host", host)
	if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}

	logger.Info("shutting down cleanly")
	return nil
}

func newLogger() *slog.Logger {
	level := slog.LevelInfo
	switch os.Getenv("LOG_LEVEL") {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}
