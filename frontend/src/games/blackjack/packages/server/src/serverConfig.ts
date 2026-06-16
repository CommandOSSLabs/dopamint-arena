import { z } from "zod";

const schema = z.object({
  ENOKI_SECRET_KEY: z.string(),
  BLS_PRIVATE_KEY: z.string(),
  BLS_PUBLIC_KEY: z.string(),
  SUI_NETWORK: z.string(),
  BLACK_JACK_PACKAGE_ID: z.string(),
  BLACK_JACK_GAME_MANAGER_ID: z.string(),
  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3001),
});

export const serverConfig = schema.parse({
  ENOKI_SECRET_KEY: process.env.ENOKI_SECRET_KEY,
  BLS_PRIVATE_KEY: process.env.BLS_PRIVATE_KEY,
  BLS_PUBLIC_KEY: process.env.BLS_PUBLIC_KEY,
  SUI_NETWORK: process.env.SUI_NETWORK,
  BLACK_JACK_PACKAGE_ID: process.env.BLACK_JACK_PACKAGE_ID,
  BLACK_JACK_GAME_MANAGER_ID: process.env.BLACK_JACK_GAME_MANAGER_ID,
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN,
  PORT: process.env.PORT,
});
