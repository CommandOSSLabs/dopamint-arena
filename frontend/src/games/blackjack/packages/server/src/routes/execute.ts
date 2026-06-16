import { json } from "../router";
import { enokiClient } from "../enokiClient";

interface ExecuteBody {
  digest: string;
  signature: string;
}

export const execute = async (request: Request) => {
  const { digest, signature } = (await request.json()) as ExecuteBody;
  try {
    const result = await enokiClient.executeSponsoredTransaction({
      digest,
      signature,
    });
    return json({ digest: result.digest }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: "Could not execute sponsored transaction block." }, 500);
  }
};
