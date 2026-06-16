import { useCallback } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { useSuiClient } from "@mysten/dapp-kit";
import { useCustomWallet } from "@/contexts/CustomWallet";
import clientConfig from "@/config/clientConfig";
import { useBalance } from "@/contexts/BalanceContext";

export const useRequestSui = () => {
  const suiClient = useSuiClient();
  const { address, isUsingEnoki, jwt } = useCustomWallet();
  const { refreshBalance } = useBalance();

  const handleRequestSui = useCallback(async () => {
    if (!isUsingEnoki || true) {
      // all go here for now, no enoki sponsor for now.
      console.log("https://faucet.devnet.sui.io/gas");
      try {
        const res = await axios.post(
          "https://faucet.devnet.sui.io/gas",
          {
            FixedAmountRequest: {
              recipient: address!,
            },
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
        if (res.status === 201) {
          toast.success("10 SUI received");
          await refreshBalance();
          setTimeout(async () => {
            await refreshBalance();
          }, 1000);
        } else {
          throw res;
        }
      } catch (e) {
        console.log(e);
        toast.error("Failed to receive SUI");
      }
      return;
    }

    console.log({
      enokiApiKey: clientConfig.ENOKI_API_KEY,
      jwt,
    });

    try {
      const resp = await axios.get(
        "https://pocs-faucet.vercel.app/api/faucet",
        {
          headers: {
            "Enoki-api-key": clientConfig.ENOKI_API_KEY,
            Authorization: `Bearer ${jwt}`,
          },
        }
      );

      await suiClient.waitForTransaction({
        digest: resp.data.txDigest,
      });
      await refreshBalance();
      toast.success("SUI received");
    } catch (err) {
      console.error(err);
      toast.error("Failed to receive SUI");
    }
  }, [address, isUsingEnoki, jwt, refreshBalance, suiClient]);

  return {
    handleRequestSui,
  };
};
