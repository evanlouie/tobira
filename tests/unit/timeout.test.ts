import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { withTimeout } from "../../src/utils/timeout.ts";

describe("Effect timeouts", () => {
  test("returns a completed operation", async () => {
    expect(await Effect.runPromise(withTimeout(Effect.succeed("ok"), 100, "too slow"))).toBe("ok");
  });

  test("interrupts the operation and runs finalizers before returning TimeoutError", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const operation = Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Deferred.succeed(finalized, void 0)));
        const fiber = yield* Effect.forkChild(
          Effect.flip(withTimeout(operation, 5, "operation timed out")),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(5);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "TimeoutError",
          message: "operation timed out",
        });
        expect(yield* Deferred.isDone(finalized)).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("preserves an operation's typed failure", async () => {
    expect(
      await Effect.runPromise(Effect.flip(withTimeout(Effect.fail("original"), 100, "timeout"))),
    ).toBe("original");
  });
});
