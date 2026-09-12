import { Duration, Effect } from "effect";
import { TimeoutError } from "./errors.ts";

/** Timeout interrupts the operation and waits for its resource finalizers. */
export const withTimeout = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  milliseconds: number,
  message: string,
) =>
  operation.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(milliseconds),
      orElse: () => Effect.fail(new TimeoutError({ message })),
    }),
  );
