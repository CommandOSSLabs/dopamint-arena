import { z } from "zod";

const schema = z.object({
  SUI_NETWORK: z.string(),
  SUI_NETWORK_NAME: z.enum(["mainnet", "testnet", "devnet"]),
  ENOKI_API_KEY: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
});

const clientConfig = schema.parse({
  SUI_NETWORK: import.meta.env.VITE_SUI_NETWORK,
  SUI_NETWORK_NAME: import.meta.env.VITE_SUI_NETWORK_NAME,
  ENOKI_API_KEY: import.meta.env.VITE_ENOKI_API_KEY,
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});

export default clientConfig;
