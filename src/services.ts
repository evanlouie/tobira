import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Kagi } from "./kagi/client.ts";
import { KagiHttp } from "./kagi/http.ts";
import { Auth } from "./utils/auth.ts";

export const AuthLive = Auth.layer.pipe(Layer.provide(BunServices.layer));
export const KagiLive = Kagi.layer.pipe(
  Layer.provide(KagiHttp.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AuthLive),
);
export const AppLive = Layer.mergeAll(KagiLive, AuthLive, BunServices.layer);
