import { EnokiClient } from "@mysten/enoki";
import { serverConfig } from "./serverConfig";

export const enokiClient = new EnokiClient({
  apiKey: serverConfig.ENOKI_SECRET_KEY,
});
