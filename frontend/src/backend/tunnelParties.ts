// Pure extractor for the two seats' public keys from a Tunnel Move object's content
// (SuiClient.getObject showContent). Used by the verify panel; kept pure for unit tests.
export interface PartyKey {
  publicKey: Uint8Array;
  scheme: number;
}
export interface TunnelParties {
  partyA: PartyKey;
  partyB: PartyKey;
}

function seat(fields: any, key: string): PartyKey {
  const f = fields?.[key]?.fields;
  if (!f || !Array.isArray(f.public_key)) {
    throw new Error(`tunnel object missing ${key}.public_key`);
  }
  return {
    publicKey: Uint8Array.from(f.public_key as number[]),
    scheme: Number(f.signature_type ?? 0),
  };
}

/** `content` is `getObject(...).data.content` (a moveObject). Throws if it is not a Tunnel. */
export function partiesFromTunnelObject(content: any): TunnelParties {
  const fields = content?.fields;
  return { partyA: seat(fields, "party_a"), partyB: seat(fields, "party_b") };
}
