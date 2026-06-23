import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { Dispatch, RefObject, SetStateAction, useState } from "react";
import { SUI_TYPE_ARG, toHex } from "@mysten/sui/utils";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { MpClient, resolveMpWsUrl } from "@/pvp/mpClient";
import { resolveBackendUrl } from "@/backend/controlPlane";
import { Loader2Icon } from "lucide-react";
import { depositStake, openAndFundSharedTunnel } from "@/onchain/tunnelTx";
import { fromHex } from "sui-tunnel-ts/core";
import { PaymentsTunnelState } from "../PaymentsWindow";
import { DefaultFundTunnel } from "../../utils/config";

interface PaymentsFindingProps {
  mpClientRef: RefObject<MpClient | null>;
  setTunnel: Dispatch<SetStateAction<PaymentsTunnelState | null>>;
}
export function PaymentsFinding({
  mpClientRef,
  setTunnel,
}: PaymentsFindingProps) {
  const currentAccount = useCurrentAccount();
  const suiClient = useSuiClient();
  const signAndExecuteTransaction = useSignAndExecuteTransaction();

  const [loading, setLoading] = useState<string>();

  const connectMP = async () => {
    const ephemeral: KeyPair = generateKeyPair();
    const mp = new MpClient(
      resolveMpWsUrl(resolveBackendUrl()),
      currentAccount!.address,
      ephemeral,
    );
    mpClientRef.current = mp;
    await mp.connect();

    return {
      ephemeral,
      mp,
    };
  };

  return (
    <div className="space-y-4 mt-10 p-4">
      <div className="text-center">
        <h2 className="wal-doto text-lg text-slate-50 uppercase">
          Payments Puzzle
        </h2>

        <p className="text-xs leading-relaxed text-slate-400">
          Battle another player using real blockchain data • Solve transaction
          puzzles before the timer expires • Win rewards from your opponent's
          balance
        </p>
      </div>

      <div className="flex gap-3 flex-wrap justify-center text-sm">
        <button
          className="bg-arena-accent font-medium px-4 h-9 rounded-lg disabled:opacity-45"
          onClick={async () => {
            try {
              if (!currentAccount?.address) return;

              setLoading("play_online");

              // connect WS
              const { mp, ephemeral } = await connectMP();

              const match = await mp.quickMatch("payments");
              const channel = mp.channel(match.matchId);

              // both A & B must sign to get tunnelId
              const getTunnelId = await new Promise<string>((resolve) => {
                let tunnelId: string;

                channel.sendPeer({
                  t: "hello",
                  ephemeralPubkey: toHex(ephemeral.publicKey),
                });

                channel.onPeer(async (event) => {
                  if (match.role === "A") {
                    // create channel
                    if (event.t === "hello") {
                      tunnelId = await openAndFundSharedTunnel({
                        reads: suiClient as never,
                        signExec: async (tx) => {
                          return await signAndExecuteTransaction.mutateAsync({
                            transaction: tx,
                          });
                        },
                        partyA: {
                          address: currentAccount.address,
                          publicKey: ephemeral.publicKey,
                        },
                        partyB: {
                          address: match.opponentWallet,
                          publicKey: fromHex(event.ephemeralPubkey),
                        },
                        amount: BigInt(DefaultFundTunnel),
                      });

                      mp.announceTunnel(match.matchId, tunnelId);
                      channel.sendPeer({ t: "open", tunnelId });
                    }

                    // waiting for B deposit
                    if (event.t === "ready" && tunnelId) {
                      resolve(tunnelId);
                    }
                  }

                  if (match.role === "B") {
                    // waiting for A create channel, then you'll deposit into
                    if (event.t === "open") {
                      await depositStake({
                        signExec: async (tx) => {
                          return await signAndExecuteTransaction.mutateAsync({
                            transaction: tx,
                          });
                        },
                        tunnelId: event.tunnelId,
                        amount: BigInt(DefaultFundTunnel),
                      });

                      channel.sendPeer({ t: "ready" });

                      resolve(event.tunnelId);
                    }
                  }
                });
              });

              // get tunnel object & update state
              {
                const tunnelObject = await suiClient.getObject({
                  id: getTunnelId,
                  options: {
                    showContent: true,
                  },
                });

                const tunnelFields = tunnelObject.data?.content?.[
                  "fields" as never
                ] as unknown as {
                  party_a: { fields: { address: string } };
                  party_b: { fields: { address: string } };

                  party_a_deposit: string;
                  party_b_deposit: string;

                  balance: string;
                  created_at: string;
                };

                setTunnel({
                  tunnelId: getTunnelId,
                  channel,
                  ephemeral,
                  created_at: Number(tunnelFields.created_at),
                  totalBalance: BigInt(tunnelFields.balance),

                  initialBalances: {
                    a: BigInt(tunnelFields.party_a_deposit),
                    b: BigInt(tunnelFields.party_b_deposit),
                  },
                  initialAddress: {
                    a: tunnelFields.party_a.fields.address,
                    b: tunnelFields.party_b.fields.address,
                  },

                  coinType: SUI_TYPE_ARG,
                });
              }
            } catch (error) {
              console.error("error", error);
            } finally {
              setLoading(undefined);
            }
          }}
        >
          <div className="flex gap-2">
            {loading === "play_online" ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : null}
            Play Online (PvP)
          </div>
        </button>

        <button
          className="bg-yellow-500 text-arena-bg font-semibold px-4 h-9 rounded-lg disabled:opacity-45"
          disabled={true}
        >
          Play Bot (Soon)
        </button>
      </div>
    </div>
  );
}
