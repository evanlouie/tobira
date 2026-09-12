#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";
import { Boolean, Cause, Console, Effect, Layer, Logger } from "effect";
import { runCli } from "./cli/app.ts";
import { AppLive } from "./services.ts";

runCli.pipe(
  Effect.flatMap((code) =>
    Effect.sync(() => {
      process.exitCode = code;
    }),
  ),
  Effect.provide(
    Layer.merge(AppLive, Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  ),
  Effect.tapCause((cause) =>
    Boolean.match(Cause.hasInterruptsOnly(cause), {
      onTrue: () => Effect.void,
      onFalse: () => Console.error(Cause.pretty(cause)),
    }),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
