import { mintMtpsNft } from "@/onchain/mtps";
import type { SignExec } from "@/onchain/tunnelTx";
import { NFT_REWARD_CATALOG } from "./nftRewardCatalog";
import type { NftReward } from "./types";

export { NFT_REWARD_CATALOG };

/** Uniform pick across Azuki #1–#100 — independent of stream tick count. */
export function pickNftReward(): NftReward {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const idx = buf[0]! % NFT_REWARD_CATALOG.length;
  return NFT_REWARD_CATALOG[idx]!;
}

export async function mintNftReward(opts: {
  signExec: SignExec;
  reward: NftReward;
}): Promise<{ digest: string }> {
  return mintMtpsNft({
    signExec: opts.signExec,
    title: opts.reward.title,
    description: opts.reward.description,
    imageUrl: opts.reward.imageUrl,
  });
}

/** Gas-sponsored mint first; wallet-paid fallback when the sponsor allowlist is stale. */
export async function mintNftRewardToMiner(opts: {
  sponsoredSignExec: SignExec;
  walletSignExec: SignExec;
  reward: NftReward;
}): Promise<{ digest: string }> {
  try {
    return await mintNftReward({
      signExec: opts.sponsoredSignExec,
      reward: opts.reward,
    });
  } catch (sponsorErr) {
    console.warn(
      "[regular-payments] sponsored mint_nft failed, retrying with wallet gas:",
      sponsorErr,
    );
    return mintNftReward({
      signExec: opts.walletSignExec,
      reward: opts.reward,
    });
  }
}