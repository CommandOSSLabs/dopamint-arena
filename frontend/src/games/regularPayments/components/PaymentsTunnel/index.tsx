import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClientQuery,
  useSuiClient,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import {
  formatAddress,
  isValidSuiAddress,
  SUI_DECIMALS,
  SUI_TYPE_ARG,
  toHex,
} from "@mysten/sui/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChallengeState, PaymentsTunnelState } from "../PaymentsWindow";
import {
  ChartLineIcon,
  ChartNetwork,
  CopyIcon,
  Loader,
  PlayOff,
} from "lucide-react";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { PACKAGE_ID } from "../../utils/config";
import { useForm, type Message } from "react-hook-form";
import type { Party } from "../../utils/Protocol";

interface PaymentsTunnelFormProps {
  amount: string;
  address: string;
}

interface PaymentsTunnelProps {
  ws: WebSocket;
  challenge: ChallengeState;
  setChallenge: React.Dispatch<React.SetStateAction<ChallengeState>>;
  setTunnel: React.Dispatch<React.SetStateAction<PaymentsTunnelState | null>>;
}

export function PaymentsTunnel({
  ws,
  challenge,
  setChallenge,
  setTunnel,
}: PaymentsTunnelProps) {
  const challengeRef = useRef(challenge);

  const currentAccount = useCurrentAccount();
  const suiClient = useSuiClient();
  const signAndExecuteTransaction = useSignAndExecuteTransaction();

  const balance = useSuiClientQuery("getBalance", {
    owner: currentAccount?.address as string,
  });

  const {
    register,
    formState: { isSubmitting, isDirty, isValid },
    handleSubmit,
  } = useForm<PaymentsTunnelFormProps>();

  const available =
    Number(balance.data?.totalBalance || 0) / 10 ** SUI_DECIMALS;

  const openChannel = async (values: PaymentsTunnelFormProps) => {
    const tx = new Transaction();

    // send an invitation
    await new Promise((resolve) => {
      ws.send(
        JSON.stringify({
          type: "challenge.create",
          targetWallet: values.address,
          game: "payments",
        }),
      );

      const subscribeAccept = setInterval(() => {
        if (challengeRef.current.found) {
          clearInterval(subscribeAccept);

          resolve(challengeRef);
        }
      }, 5000);
    });

    // handle moveCall
    {
      const [coin] = tx.splitCoins(tx.gas, [
        Number(values.amount) * 10 ** SUI_DECIMALS,
      ]);

      tx.moveCall({
        target: `${PACKAGE_ID}::payment_channel::create_channel`,
        typeArguments: [SUI_TYPE_ARG],
        arguments: [
          tx.pure.vector("u8", currentAccount!.publicKey.slice(1)),
          tx.pure.address(challengeRef.current.found!.opponentWallet),
          coin,
        ],
      });
    }

    // handle update tunnel
    {
      const { digest } = await signAndExecuteTransaction.mutateAsync({
        transaction: tx,
      });

      const { objectChanges } = await suiClient.waitForTransaction({
        digest,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });

      const tunnelObject = objectChanges?.find(
        (object) => object.type === "created",
      );

      if (!tunnelObject || !challengeRef.current.found?.matchId) {
        throw "not found tunnel channel";
      }

      // update status tunnel & notify to user
      ws.send(
        JSON.stringify({
          type: "tunnel.opened",
          matchId: challengeRef.current.found.matchId,
          tunnelId: tunnelObject.objectId,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "relay",
          matchId: challengeRef.current.found.matchId,
          payload: JSON.stringify({
            tunnelId: tunnelObject.objectId,
            amount: values.amount,
            pkB: currentAccount!.publicKey.slice(1),
          }),
        }),
      );

      // get relay from B and update tunnel state
      await new Promise((resolve) => {
        let subscribeRelay = setInterval(() => {
          if (challengeRef.current.relay) {
            const parseRelay = JSON.parse(challengeRef.current.relay.payload);

            setTunnel({
              id: tunnelObject.objectId,
              totalBalance: BigInt(
                (Number(values.amount) + Number(parseRelay.amount)) *
                  10 ** SUI_DECIMALS,
              ),
              initialBalances: {
                a: BigInt(Number(values.amount) * 10 ** SUI_DECIMALS),
                b: BigInt(Number(parseRelay.amount) * 10 ** SUI_DECIMALS),
              },
              coinType: SUI_TYPE_ARG,
            });

            clearInterval(subscribeRelay);

            resolve(parseRelay);
          }
        }, 5000);
      });
    }
  };

  const joinChannel = async (
    values: PaymentsTunnelFormProps,
    matchId: string,
  ) => {
    // accept an invitation
    const getRelay = await new Promise<{
      tunnelId: string;
      amount: string;
      pkB: Uint8Array<ArrayBuffer>;
    }>((resolve) => {
      ws.send(
        JSON.stringify({
          type: "challenge.accept",
          matchId,
        }),
      );

      const subscribeRelay = setInterval(() => {
        if (challengeRef.current.relay) {
          const parseRelay = JSON.parse(challengeRef.current.relay.payload);

          clearInterval(subscribeRelay);

          resolve(parseRelay);
        }
      }, 5000);
    });

    // handle moveCall
    {
      const tx = new Transaction();

      const [coin] = tx.splitCoins(tx.gas, [
        Number(values.amount) * 10 ** SUI_DECIMALS,
      ]);

      tx.moveCall({
        target: `${PACKAGE_ID}::payment_channel::join_channel`,
        typeArguments: [SUI_TYPE_ARG],
        arguments: [
          tx.object(getRelay.tunnelId),
          tx.pure.vector(
            "u8",
            challengeRef.current.session.getPublicKey().toRawBytes(),
          ),
          coin,
        ],
      });

      await signAndExecuteTransaction.mutateAsync({
        transaction: tx,
      });

      ws.send(
        JSON.stringify({
          type: "relay",
          matchId: challengeRef.current.found!.matchId,
          payload: JSON.stringify({
            amount: values.amount,
            pkB: currentAccount!.publicKey.slice(1),
          }),
        }),
      );
    }

    setTunnel({
      id: getRelay.tunnelId,
      totalBalance: BigInt(values.amount + getRelay.amount),
      initialBalances: {
        a: BigInt(values.amount),
        b: BigInt(getRelay.amount),
      },
      coinType: SUI_TYPE_ARG,
    });
  };

  // update reference to get values inside closure or something...
  useEffect(() => {
    challengeRef.current = challenge;
  }, [challenge]);

  return (
    <div className="space-y-6 p-4 text-sm">
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-[11px] uppercase text-arena-muted">My Session</p>

          <div className="flex items-center gap-2">
            <p>{formatAddress(challenge.session.toSuiAddress())}</p>

            <button
              onClick={() => {
                navigator.clipboard
                  .writeText(challenge.session.toSuiAddress())
                  .then(() => {
                    alert("Text successfully copied!");
                  })
                  .catch(() => {
                    alert("Failed to copy text: ");
                  });
              }}
            >
              <CopyIcon className="size-3.5" />
            </button>
          </div>
        </div>

        {!challenge?.incoming && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase text-arena-muted">To Account</p>

            <input
              className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 w-full text-arena-text"
              placeholder="Enter address"
              {...register("address", { required: true })}
            />
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[11px] uppercase text-arena-muted">
            Deposit Amount
          </div>

          <input
            type="number"
            placeholder="Enter amount"
            className="rounded border border-arena-edge bg-arena-bg px-2 py-1.5 w-full"
            {...register("amount", { required: true, min: 0.1 })}
          />

          <div className="text-xs text-right font-medium text-slate-500">
            Avaiable: {available.toFixed(3)} SUI
          </div>

          <div className="rounded border border-arena-muted/35 p-2 text-xs text-arena-muted">
            Funds will be locked inside the payment channel until settlement.
          </div>
        </div>
      </div>

      <button
        // disabled={isSubmitting || !isDirty || !isValid}
        className={`w-full h-9 rounded flex items-center justify-center gap-2 ${challenge.incoming ? "bg-yellow-500" : "bg-arena-accent"} font-medium text-arena-bg disabled:opacity-70`}
        onClick={handleSubmit(async (values) => {
          try {
            if (!currentAccount) throw "not found account conditions";

            if (challenge.incoming) {
              await joinChannel(values, challenge.incoming.matchId);
            } else {
              await openChannel(values);
            }

            // setTunnel({
            //   id:
            // })
          } catch (error) {
            console.error(error);
          }
        })}
      >
        {isSubmitting && <Loader className="animate-spin size-5 text-white" />}

        {challenge.incoming ? "Accept Invitation" : "Open Channel"}
      </button>
    </div>
  );
}
