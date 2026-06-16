import { bcs, fromHEX, toHEX } from "@mysten/bcs";

export const ID = bcs.fixedArray(32, bcs.u8()).transform({
  input: (id: string) => fromHEX(id),
  output: (id) => toHEX(Uint8Array.from(id)),
});

export const CloseTunnelRequest = bcs.struct("CloseTunnelRequest", {
  tunnel_id: ID,
  partyA_withdraw_amount: bcs.u64(),
  partyB_withdraw_amount: bcs.u64(),
});

export const createCloseTunnelRequest = ({
  tunnel_id,
  partyA_withdraw_amount,
  partyB_withdraw_amount,
}: {
  tunnel_id: string;
  partyA_withdraw_amount: number;
  partyB_withdraw_amount: number;
}) => {
  return CloseTunnelRequest.serialize({
    tunnel_id: ID.fromHex(tunnel_id),
    partyA_withdraw_amount: partyA_withdraw_amount,
    partyB_withdraw_amount: partyB_withdraw_amount,
  });
};
