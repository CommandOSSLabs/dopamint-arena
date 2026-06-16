import { useCallback, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { useSuiClient } from "@mysten/dapp-kit";
import { useCustomWallet } from "@/contexts/CustomWallet";
import clientConfig from "@/config/clientConfig";
import { useBalance } from "@/contexts/BalanceContext";
import { Transaction } from "@mysten/sui/transactions";

export const useRequestBuck = () => {
  const suiClient = useSuiClient();
  const {
    address,
    isUsingEnoki,
    jwt,
    executeTransactionBlockWithoutSponsorship,
  } = useCustomWallet();

  const { refreshBalance, userCoins } = useBalance();
  const [loading, setLoading] = useState(false);

  const getBuckAirdrop = async () => {
    let tx = new Transaction();
    tx.moveCall({
      target: `${
        import.meta.env.VITE_BLACK_JACK_PACKAGE_ID || ""
      }::test_buck::mint`,
      arguments: [
        tx.object(
          import.meta.env.VITE_BLACK_JACK_TEST_BUCK_MANAGER_ID || ""
        ),
        tx.pure.u64(100000000000),
        tx.pure.address(address!),
      ],
    });
    const result = await executeTransactionBlockWithoutSponsorship({
      tx,
      options: {
        showEvents: true,
      },
    });
  };

  const handleRequestBuck = useCallback(async () => {
    if (!isUsingEnoki || true) {
      try {
        setLoading(true);
        try {
          await getBuckAirdrop();
          toast.success("100 BUCK received");
          await refreshBalance();
          setTimeout(async () => {
            await refreshBalance();
          }, 1000);
        } catch (e) {
          console.log({ address });
          const res = await axios.post(
            "https://faucet.testnet.sui.io/gas",
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
            toast.success("1 SUI received as gas");
            await refreshBalance();
            await getBuckAirdrop();
            toast.success("100 BUCK received");
            setTimeout(async () => {
              await refreshBalance();
            }, 1000);
          } else {
            throw res;
          }
        }
      } catch (e) {
        toast.error("Failed to receive BUCK");
      } finally {
        setLoading(false);
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
    handleRequestBuck,
    loading,
  };
};
