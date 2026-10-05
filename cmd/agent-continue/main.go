package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/mattn/go-isatty"

	"github.com/fishinggoing/agent-continue/internal/app"
	"github.com/fishinggoing/agent-continue/internal/cli"
	"github.com/fishinggoing/agent-continue/internal/server"
)

func main() {
	if err := run(); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"status": "failed", "error": err.Error()})
		os.Exit(cli.ExitCode(err))
	}
}
func run() error {
	args := os.Args[1:]
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	streams := cli.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, Interactive: isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stderr.Fd())}
	if handled, err := cli.ExecuteContext(ctx, args, streams, os.LookupEnv); handled {
		return err
	}
	stop()
	command, flags, e := app.ParseArgs(args)
	if e != nil {
		return e
	}
	if command == "serve" {
		listen := flags["listen"]
		if listen == "" {
			listen = "127.0.0.1:8080"
		}
		return server.Run(listen, os.Getenv("AGENT_CONTINUE_TOKEN"))
	}
	report, e := app.Execute(args)
	if e != nil {
		return e
	}
	if report["command"] == "help" {
		fmt.Println(report["usage"])
		fmt.Println(cli.Usage)
		return nil
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
