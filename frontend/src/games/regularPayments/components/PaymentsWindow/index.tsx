import type { GameWindowProps } from "../../../types";
import { PaymentsTransfer } from "../PaymentsTransfer";
import { useEffect, useMemo, useState } from "react";
import { PaymentsTunnel } from "../PaymentsTunnel";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, toHex } from "@mysten/sui/utils";
import type { Party } from "../../utils/Protocol";
import {
  useCurrentAccount,
  useSignPersonalMessage,
  useSignTransaction,
} from "@mysten/dapp-kit";
import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { verify } from "sui-tunnel-ts/core/crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { bcs } from "@mysten/sui/bcs";

export interface PaymentsTunnelState {
  id: string; // tunnel object id

  // matchId: string;
  // signer_A: Ed25519Keypair;
  // signer_B: Ed25519Keypair;

  // management balance
  totalBalance: bigint;
  initialBalances: {
    a: bigint;
    b: bigint;
  };

  coinType: string; // "0x2::sui::SUI"
}

export interface ChallengeState {
  session: Ed25519Keypair;
  error?: {
    code: "target_offline";
    type: "error";
  };
  incoming?: {
    fromWallet: string;
    matchId: string;
    type: "challenge.incoming";
  };
  found?: {
    matchId: string;
    opponentWallet: string;
    role: Party;
    type: "match.found";
  };
  relay?: {
    matchId: string;
    payload: string; // JSON.stringify
    type: "relay";
  };
}

/**
 * Reference game stub. To add a game: copy this folder, rename it, swap this
 * content for your game UI, and call register() in index.ts. The `_props`
 * (windowId, onClose) are how a real game would settle and close itself.
 */
export function PaymentsWindow(_props: GameWindowProps) {
  const [tunnel, setTunnel] = useState<PaymentsTunnelState | null>(null);

  const signPersonalMessage = useSignPersonalMessage();
  const signTransaction = useSignTransaction();

  const ws = useMemo(
    () =>
      new WebSocket(
        //
        // "ws://0.0.0.0:8080/v1/mp",
        "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp",
      ),
    [],
  );
  const currentAccount = useCurrentAccount();

  const [challenge, setChallenge] = useState<ChallengeState>({
    session: new Ed25519Keypair(),
  });

  // Auto create session
  useEffect(() => {
    const onMessage = async (event: MessageEvent<any>) => {
      if (!currentAccount?.address) return;

      const data = JSON.parse(event.data) as
        | {
            type: "challenge";
            nonce: string;
          }
        | {
            fromWallet: string;
            game: "payments";
            matchId: string;
            type: "challenge.incoming";
          }
        | {
            type: "error";
            code: "target_offline";
          }
        | {
            game: "payments";
            matchId: string;
            opponentWallet: string;
            role: Party;
            type: "match.found";
          }
        | {
            matchId: string;
            payload: string; // JSON.stringify
            type: "relay";
          };

      if (data.type === "challenge") {
        const signature = await challenge.session.sign(
          new TextEncoder().encode(data.nonce),
        );

        const result = await signPersonalMessage.mutateAsync({
          message: new TextEncoder().encode(data.nonce),
        });

        const parsed = parseSerializedSignature(result.signature);
        const pk_hex = toHex(currentAccount.publicKey.slice(1));
        const sig_hex = toHex(parsed.signature as never);

        // console.log(parsed);
        // console.log(parsed.signature?.length);

        // console.log({
        //   pk_hex,
        //   sig_hex,
        // });

        // console.log({
        //   pubkey: toHex(challenge.session.getPublicKey().toRawBytes()),
        //   sig: toHex(signature),
        // });

        // return;
        ws.send(
          JSON.stringify({
            type: "connect",

            // ---- not work
            wallet: currentAccount.address,
            pubkey: pk_hex,
            sig: sig_hex,

            // ---- work
            // wallet: challenge.session.toSuiAddress(),
            // pubkey: toHex(challenge.session.getPublicKey().toRawBytes()),
            // sig: toHex(signature),
            nonce: data.nonce,
          }),
        );
      }

      if (data.type === "challenge.incoming") {
        setChallenge((prev) => ({
          ...prev,
          incoming: data,
        }));
      }

      if (data.type === "relay") {
        setChallenge((prev) => ({
          ...prev,
          relay: data,
        }));
      }

      if (data.type === "match.found") {
        setChallenge((prev) => ({
          ...prev,
          found: data,
        }));
      }

      console.log("adada", data);

      if (data.type === "error" && data.code === "target_offline") {
        setChallenge((prev) => ({
          ...prev,
          error: data,
        }));
      }
    };

    ws.addEventListener("message", onMessage);

    return () => {
      ws.removeEventListener("message", onMessage);
    };
  }, [currentAccount]);

  // console.log("challenge", challenge);

  return (
    <>
      {tunnel?.id ? (
        <PaymentsTransfer tunnel={tunnel} setTunnel={setTunnel} />
      ) : (
        <PaymentsTunnel
          ws={ws}
          challenge={challenge}
          setChallenge={setChallenge}
          setTunnel={setTunnel}
        />
      )}
    </>
  );
}
