import { Effect, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { Kagi } from "../src/kagi/client.ts";
import { KagiHttp } from "../src/kagi/http.ts";
import { Auth } from "../src/utils/auth.ts";

export const authTest = Layer.succeed(Auth, { token: Effect.succeed(Redacted.make("test-token")) });
export const httpTest = (client: HttpClient.HttpClient) =>
  KagiHttp.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(authTest),
  );
export const kagiTest = (client: HttpClient.HttpClient) =>
  Kagi.layer.pipe(Layer.provide(httpTest(client)));
