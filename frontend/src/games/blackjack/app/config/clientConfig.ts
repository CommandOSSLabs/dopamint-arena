import { z } from "zod";

const clientConfigSchema = z.object({
  SUI_NETWORK: z.string(),
  SUI_NETWORK_NAME: z.enum(["mainnet", "testnet", "devnet"]),
});

const clientConfig = clientConfigSchema.parse({
  SUI_NETWORK: import.meta.env.VITE_SUI_NETWORK,
  SUI_NETWORK_NAME: import.meta.env.VITE_SUI_NETWORK_NAME,
});

export default clientConfig;
