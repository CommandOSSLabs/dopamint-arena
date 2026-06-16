import { json } from "../router";
import { enokiClient } from "../enokiClient";

interface SponsorTxRequestBody {
  network: "mainnet" | "testnet" | "devnet";
  txBytes: string;
  sender: string;
  allowedAddresses?: string[];
}

export const sponsor = async (request: Request) => {
  const { network, txBytes, sender, allowedAddresses } =
    (await request.json()) as SponsorTxRequestBody;
  try {
    const resp = await enokiClient.createSponsoredTransaction({
      network,
      transactionKindBytes: txBytes,
      sender,
      allowedAddresses,
    });
    return json(resp, 200);
  } catch (error) {
    console.error(error);
    return json({ error: "Could not create sponsored transaction block." }, 500);
  }
};
