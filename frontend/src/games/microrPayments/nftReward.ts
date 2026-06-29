import { mintMtpsNft } from "@/onchain/mtps";
import type { SignExec } from "@/onchain/tunnelTx";
import type { NftReward } from "./types";

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
      "[micro-payments] sponsored mint_nft failed, retrying with wallet gas:",
      sponsorErr,
    );
    return mintNftReward({
      signExec: opts.walletSignExec,
      reward: opts.reward,
    });
  }
}

/** Azuki collection metadata (tokens #1–#55) — on-chain IPFS, same source OpenSea indexes. */
export const NFT_REWARD_CATALOG: readonly NftReward[] = [
  {
    title: "Azuki #1",
    description:
      "Hair: Pink Hairband · Clothing: White Qipao with Fur · Eyes: Daydreaming · Mouth: Lipstick · Offhand: Gloves · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-1.png",
  },
  {
    title: "Azuki #2",
    description:
      "Hair: Pink Flowy · Ear: Red Tassel · Clothing: Vest · Eyes: Ruby · Mouth: Chewing · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-2.png",
  },
  {
    title: "Azuki #3",
    description:
      "Hair: Green Spiky · Headgear: Frog Headband · Neck: Frog Headphones · Clothing: Green Yukata · Eyes: Careless · Mouth: Grass · Offhand: Katana · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-3.png",
  },
  {
    title: "Azuki #4",
    description:
      "Hair: Brown Dreadlocks · Clothing: White Qipao with Fur · Eyes: Lightning · Mouth: Smirk · Offhand: Katana · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-4.png",
  },
  {
    title: "Azuki #5",
    description:
      "Hair: Blonde Swept Back · Face: Red Stripes Face Paint · Clothing: Red Perfecto Jacket · Eyes: Suspicious · Mouth: Chuckle · Offhand: Leather Katana · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-5.png",
  },
  {
    title: "Azuki #6",
    description:
      "Hair: Teal Bun · Clothing: Alpine Jacket · Eyes: Calm · Mouth: Tongue Out · Offhand: Leather Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-6.png",
  },
  {
    title: "Azuki #7",
    description:
      "Hair: Orange Samurai · Headgear: Full Bandana · Clothing: Light Kimono · Eyes: Suspicious · Mouth: Bubble Gum · Offhand: Leather Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-7.png",
  },
  {
    title: "Azuki #8",
    description:
      "Hair: Silver Pixie · Face: Blush · Clothing: Hoodie · Neck: Choker · Eyes: Relaxed · Mouth: Grass · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-8.png",
  },
  {
    title: "Azuki #9",
    description:
      "Type: Blue · Hair: Silver Spiky · Clothing: White Yukata · Eyes: Chill · Mouth: Chuckle · Offhand: Bat · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-9.png",
  },
  {
    title: "Azuki #10",
    description:
      "Hair: Green Samurai · Headgear: Black Bucket Hat · Clothing: Blue Kimono · Eyes: Closed · Mouth: Chuckle · Offhand: Sakura Katana · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-10.png",
  },
  {
    title: "Azuki #11",
    description:
      "Hair: Orange Swept Back · Clothing: White Hoodie · Eyes: Pensive · Mouth: Wheat Straw · Offhand: Golden Hook Sword · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-11.png",
  },
  {
    title: "Azuki #12",
    description:
      "Hair: Blonde Swept Back · Clothing: Black Yukata · Eyes: Suspicious · Mouth: Relaxed · Offhand: Sakura Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-12.png",
  },
  {
    title: "Azuki #13",
    description:
      "Hair: Teal Long · Clothing: Light Kimono · Eyes: Tired · Mouth: Not Bad · Offhand: Bat · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-13.png",
  },
  {
    title: "Azuki #14",
    description:
      "Hair: Blonde Bob · Face: Red Fang Face Paint · Clothing: Light Kimono · Eyes: Closed · Mouth: Smile · Offhand: Guitar · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-14.png",
  },
  {
    title: "Azuki #15",
    description:
      "Hair: Purple Bun · Clothing: Hoodie · Neck: Choker · Eyes: Ruby · Mouth: Grin · Offhand: Banner · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-15.png",
  },
  {
    title: "Azuki #16",
    description:
      "Hair: Braids · Headgear: Distressed Beanie · Ear: Small Hoop · Clothing: Black Perfecto Jacket · Eyes: Closed · Mouth: 420 · Offhand: Boombox · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-16.png",
  },
  {
    title: "Azuki #17",
    description:
      "Hair: Silver Disheveled · Clothing: Denim Jacket · Eyes: Pierced Eyebrow · Mouth: Wheat Straw · Offhand: Bokken · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-17.png",
  },
  {
    title: "Azuki #18",
    description:
      "Hair: Black Disheveled · Face: Blue Sunglasses · Clothing: Red Kimono · Neck: Chain · Eyes: Determined · Mouth: Closed · Offhand: Lantern · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-18.png",
  },
  {
    title: "Azuki #19",
    description:
      "Hair: Silver Bun · Ear: Red Cylinder · Face: Red Fang Face Paint · Neck: Tribal Tattoo · Clothing: Red Qipao with Fur · Eyes: Determined · Mouth: Smoking · Offhand: Floorsweeper · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-19.png",
  },
  {
    title: "Azuki #20",
    description:
      "Hair: Blue Half Bun · Clothing: Camo Hoodie · Eyes: Bored · Mouth: Smirk · Offhand: Zanbato · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-20.png",
  },
  {
    title: "Azuki #21",
    description:
      "Hair: Powder Blue Swept Back · Neck: Zen Headphones · Clothing: Green Yukata · Eyes: Tired · Mouth: Tactical Knife · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-21.png",
  },
  {
    title: "Azuki #22",
    description:
      "Hair: Blue Short Spiky · Headgear: Chef Headband · Clothing: Azuki Tech Jacket · Eyes: Indifferent · Mouth: Relaxed · Offhand: Leather Katana · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-22.png",
  },
  {
    title: "Azuki #23",
    description:
      "Hair: Black Hairband · Clothing: Black Qipao · Eyes: Amethyst · Mouth: Whistling · Offhand: Hand Seal · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-23.png",
  },
  {
    title: "Azuki #24",
    description:
      "Hair: Maroon Bun · Headgear: Pointy Straw Hat · Clothing: Turquoise Kimono · Eyes: Joyful · Mouth: Frown · Offhand: Banner · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-24.png",
  },
  {
    title: "Azuki #25",
    description:
      "Hair: Maroon Half Bun · Neck: Zen Headphones · Clothing: Cloud Poncho · Eyes: Closed · Mouth: Closed · Offhand: Lantern · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-25.png",
  },
  {
    title: "Azuki #26",
    description:
      "Hair: Blue Half Bun · Clothing: Blue Qipao · Eyes: Striking · Mouth: Smile · Offhand: Shuriken · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-26.png",
  },
  {
    title: "Azuki #27",
    description:
      "Hair: Brown Blonde Flowy · Face: Sleep Mask · Clothing: Black Qipao · Eyes: Closed · Mouth: Lipstick · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-27.png",
  },
  {
    title: "Azuki #28",
    description:
      "Hair: Brown Messy · Clothing: Black Yukata · Eyes: Determined · Mouth: Smoking · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-28.png",
  },
  {
    title: "Azuki #29",
    description:
      "Hair: Silver Disheveled · Face: Reading Glasses · Clothing: Kimono with Jacket · Eyes: Indifferent · Mouth: Closed · Offhand: Floorsweeper · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-29.png",
  },
  {
    title: "Azuki #30",
    description:
      "Hair: Brown Disheveled · Face: Red Stripes Face Paint · Clothing: Azuki Sweater · Eyes: Bored · Mouth: Relaxed · Offhand: Banner · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-30.png",
  },
  {
    title: "Azuki #31",
    description:
      "Hair: Brown Blonde Flowy · Neck: Koi Tattoo · Clothing: Blue Qipao · Eyes: Closed · Mouth: Smirk · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-31.png",
  },
  {
    title: "Azuki #32",
    description:
      "Hair: Blue Nightshade Flowy · Headgear: Black Bucket Hat · Clothing: Red Hoodie · Eyes: Relaxed · Mouth: Relaxed · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-32.png",
  },
  {
    title: "Azuki #33",
    description:
      "Hair: Teal Hairband · Ear: Corded Earbuds · Clothing: Red Floral Kimono · Eyes: Closed · Mouth: Face Mask · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-33.png",
  },
  {
    title: "Azuki #34",
    description:
      "Hair: Orange Short Spiky · Headgear: Sloth Headband · Clothing: Dress Shirt · Eyes: Chill · Mouth: Grass · Offhand: Banner · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-34.png",
  },
  {
    title: "Azuki #35",
    description:
      "Hair: Orange Samurai · Ear: Chill · Clothing: Maroon Yukata · Eyes: Tired · Mouth: Relaxed · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-35.png",
  },
  {
    title: "Azuki #36",
    description:
      "Hair: Buzzcut · Headgear: IKZ Baseball Cap · Face: Black Glasses · Clothing: Black Kimono · Eyes: Indifferent · Mouth: Closed · Offhand: Boombox · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-36.png",
  },
  {
    title: "Azuki #37",
    description:
      "Hair: Pink Bangs · Clothing: White Hoodie · Eyes: Ruby · Mouth: Tongue Out · Offhand: Floorsweeper · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-37.png",
  },
  {
    title: "Azuki #38",
    description:
      "Hair: Indigo Bangs · Clothing: Camo Tech Jacket · Eyes: Joyful · Mouth: Smirk · Offhand: Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-38.png",
  },
  {
    title: "Azuki #39",
    description:
      "Hair: Pink Flowy · Clothing: Light Armor · Eyes: Closed · Mouth: Tongue Out · Offhand: Leather Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-39.png",
  },
  {
    title: "Azuki #40",
    description:
      "Hair: Brown Long · Special: Fireflies · Clothing: Straw Poncho · Eyes: Tired · Mouth: Long Stubble · Offhand: Lantern · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-40.png",
  },
  {
    title: "Azuki #41",
    description:
      "Hair: Blonde Long · Clothing: Green Yukata · Eyes: Tired · Mouth: Grass · Offhand: Bat · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-41.png",
  },
  {
    title: "Azuki #42",
    description:
      "Hair: Orange Pixie · Headgear: Backwards Cap · Clothing: Azuki Sweater · Eyes: Amethyst · Mouth: Smirk · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-42.png",
  },
  {
    title: "Azuki #43",
    description:
      "Hair: Brown Blonde Flowy · Ear: Stud · Clothing: Black Qipao · Eyes: Determined · Mouth: Laughing · Offhand: Bean Juice · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-43.png",
  },
  {
    title: "Azuki #44",
    description:
      "Hair: Blonde Flowy · Neck: Red Panda Headphones · Clothing: Turquoise Kimono · Eyes: Determined · Mouth: Frown · Offhand: Lantern · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-44.png",
  },
  {
    title: "Azuki #45",
    description:
      "Hair: Purple Dreadlocks · Neck: Zen Headphones · Clothing: Turquoise Kimono with Bow · Eyes: Hopeful · Mouth: Laughing · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-45.png",
  },
  {
    title: "Azuki #46",
    description:
      "Hair: Indigo Ponytail · Clothing: Frog T-Shirt · Eyes: Striking · Mouth: Tongue Out · Offhand: Hand Seal · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-46.png",
  },
  {
    title: "Azuki #47",
    description:
      "Hair: Purple Spiky · Clothing: Brown Yukata · Eyes: Bored · Mouth: Growl · Offhand: Skateboard · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-47.png",
  },
  {
    title: "Azuki #48",
    description:
      "Hair: Brown Samurai · Headgear: Straw Hat · Clothing: Green Yukata · Eyes: Determined · Mouth: Scroll · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-48.png",
  },
  {
    title: "Azuki #49",
    description:
      "Hair: Maroon Disheveled · Clothing: Hoshi Jacket · Eyes: Careless · Mouth: Growl · Offhand: Shuriken · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-49.png",
  },
  {
    title: "Azuki #50",
    description:
      "Hair: Indigo Bangs · Headgear: Full Bandana · Clothing: Turquoise Kimono · Eyes: Determined · Mouth: Wheat Straw · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-50.png",
  },
  {
    title: "Azuki #51",
    description:
      "Hair: Indigo Bangs · Clothing: Black Ninja Top · Eyes: Relaxed · Mouth: Lipstick · Offhand: Sakura Katana · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-51.png",
  },
  {
    title: "Azuki #52",
    description:
      "Hair: Blue Short Spiky · Headgear: Red Panda Baseball Cap · Clothing: Yellow Jumpsuit · Eyes: Careless · Mouth: Whistling · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-52.png",
  },
  {
    title: "Azuki #53",
    description:
      "Hair: Brown Messy · Face: Blue Sunglasses · Clothing: Bloody Bomber · Eyes: Determined · Mouth: Chuckle · Offhand: Hand Wrap · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-53.png",
  },
  {
    title: "Azuki #54",
    description:
      "Hair: Violet Flowy · Clothing: Sloth Kimono · Eyes: Calm · Mouth: Smile · Offhand: Guitar · Background: Dark Blue",
    imageUrl: "/games/microPayments/rewards/image-54.png",
  },
  {
    title: "Azuki #55",
    description:
      "Hair: Brown Fluffy · Clothing: Alpine Jacket · Eyes: Indifferent · Mouth: Smirk · Offhand: Boombox · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-55.png",
  },
  {
    title: "Azuki #56",
    description:
      "Hair: Black Disheveled · Headgear: IKZ Baseball Cap · Clothing: Black Hoodie · Eyes: Tired · Mouth: Face Mask · Offhand: Gloves · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-56.png",
  },
  {
    title: "Azuki #57",
    description:
      "Hair: Brown Ponytail · Face: Black Glasses · Clothing: Light Kimono · Eyes: Pierced Eyebrow · Mouth: Scroll · Offhand: Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-57.png",
  },
  {
    title: "Azuki #58",
    description:
      "Hair: Green Fluffy · Clothing: Suit with Turtleneck · Eyes: Tired · Mouth: Smoking · Offhand: Guitar · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-58.png",
  },
  {
    title: "Azuki #59",
    description:
      "Hair: Blonde Long · Headgear: Backwards Cap · Face: Eye Patch · Clothing: White T-Shirt · Eyes: Closed · Mouth: Pout · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-59.png",
  },
  {
    title: "Azuki #60",
    description:
      "Hair: Purple Spiky · Clothing: Green Yukata · Eyes: Bored · Mouth: Smoking · Offhand: Coin · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-60.png",
  },
  {
    title: "Azuki #61",
    description:
      "Hair: Green Samurai · Face: Eye Patch · Clothing: Red Kimono · Neck: Chain · Eyes: Closed · Mouth: Meh · Offhand: Banner · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-61.png",
  },
  {
    title: "Azuki #62",
    description:
      "Type: Blue · Hair: Silver Short Spiky · Clothing: Blue Kimono · Eyes: Meditating · Mouth: Smirk · Offhand: Coin · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-62.png",
  },
  {
    title: "Azuki #63",
    description:
      "Hair: Magenta Flowy · Clothing: Cat Kimono · Eyes: Hopeful · Mouth: Closed · Offhand: Monk Staff · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-63.png",
  },
  {
    title: "Azuki #64",
    description:
      "Hair: Orange Samurai · Clothing: Black Hoodie · Eyes: Indifferent · Mouth: Face Mask · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-64.png",
  },
  {
    title: "Azuki #65",
    description:
      "Hair: Black Swept Back · Clothing: Cat Yukata · Eyes: Determined · Mouth: Whistling · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-65.png",
  },
  {
    title: "Azuki #66",
    description:
      "Hair: Blonde Short Spiky · Clothing: Green Yukata · Eyes: Meditating · Mouth: Not Bad · Offhand: Coin · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-66.png",
  },
  {
    title: "Azuki #67",
    description:
      "Hair: Black Bangs · Clothing: Tank Top with Jacket · Eyes: Amethyst · Mouth: Lipstick · Offhand: Hand Wrap · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-67.png",
  },
  {
    title: "Azuki #68",
    description:
      "Hair: Brown Ponytail · Clothing: Yellow Bikini · Eyes: Striking · Mouth: Grass · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-68.png",
  },
  {
    title: "Azuki #69",
    description:
      "Hair: Brown Disheveled · Clothing: Hawaiian Shirt · Eyes: Indifferent · Mouth: 420 · Offhand: Hand Seal · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-69.png",
  },
  {
    title: "Azuki #70",
    description:
      "Hair: Teal Bun · Neck: Tribal Tattoo · Clothing: Red Floral Kimono · Eyes: Determined · Mouth: Lipstick · Offhand: Banner · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-70.png",
  },
  {
    title: "Azuki #71",
    description:
      "Hair: Indigo Disheveled · Neck: Towel · Clothing: Brown Yukata · Eyes: Focused · Mouth: Relaxed · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-71.png",
  },
  {
    title: "Azuki #72",
    description:
      "Hair: Blue Bun · Clothing: Blue Kimono with Bow · Eyes: Determined · Mouth: Grass · Offhand: Lantern · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-72.png",
  },
  {
    title: "Azuki #73",
    description:
      "Hair: Maroon Ponytail · Face: Red Stripes Face Paint · Clothing: Turquoise Kimono with Bow · Eyes: Calm · Mouth: Frown · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-73.png",
  },
  {
    title: "Azuki #74",
    description:
      "Hair: Indigo Disheveled · Clothing: Black Kimono · Eyes: Determined · Mouth: Relaxed · Offhand: Lantern · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-74.png",
  },
  {
    title: "Azuki #75",
    description:
      "Hair: Black Swept Back · Clothing: White T-Shirt · Eyes: Pensive · Mouth: Pout · Offhand: Shuriken · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-75.png",
  },
  {
    title: "Azuki #76",
    description:
      "Hair: Silver Bangs · Headgear: Ayaigasa · Clothing: Black Qipao · Eyes: Closed · Mouth: Bubble Gum · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-76.png",
  },
  {
    title: "Azuki #77",
    description:
      "Hair: Brown Messy · Headgear: Backwards Cap · Ear: Chill · Clothing: Azuki Sweater · Eyes: Careless · Mouth: 420 · Offhand: Fireball · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-77.png",
  },
  {
    title: "Azuki #78",
    description:
      "Hair: Orange Short Spiky · Clothing: Red Perfecto Jacket · Eyes: Focused · Mouth: Stubble · Offhand: Hook Sword · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-78.png",
  },
  {
    title: "Azuki #79",
    description:
      "Hair: Orange Swept Back · Clothing: White Hoodie · Eyes: Chill · Mouth: Whistling · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-79.png",
  },
  {
    title: "Azuki #80",
    description:
      "Hair: Teal Long · Ear: Chill · Clothing: Red Kimono · Neck: Chain · Eyes: Meditating · Mouth: Pout · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-80.png",
  },
  {
    title: "Azuki #81",
    description:
      "Hair: Brown Flowy · Clothing: Lavender Kimono with Bow · Eyes: Joyful · Mouth: Scroll · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-81.png",
  },
  {
    title: "Azuki #82",
    description:
      "Hair: Indigo Bangs · Clothing: Frog Hoodie · Eyes: Closed · Mouth: Smile · Offhand: Lantern · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-82.png",
  },
  {
    title: "Azuki #83",
    description:
      "Hair: Orange Samurai · Headgear: Horns · Clothing: Kimono with Jacket · Eyes: Focused · Mouth: Relaxed · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-83.png",
  },
  {
    title: "Azuki #84",
    description:
      "Hair: Green Half Bun · Headgear: Full Bandana · Clothing: Suikan · Eyes: Closed · Mouth: Smoking · Offhand: Lantern · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-84.png",
  },
  {
    title: "Azuki #85",
    description:
      "Hair: Pink Samurai · Headgear: Cat Baseball Cap · Clothing: Red Hoodie · Eyes: Tired · Mouth: Chuckle · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-85.png",
  },
  {
    title: "Azuki #86",
    description:
      "Hair: Black Fluffy · Ear: Small Hoop · Clothing: Camo Tech Jacket · Eyes: Meditating · Mouth: Chuckle · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-86.png",
  },
  {
    title: "Azuki #87",
    description:
      "Hair: Indigo Long · Special: Fireflies · Headgear: Fur Bucket Hat · Face: Round Purple Sunglasses · Clothing: Vegan Mink Coat · Eyes: Meditating · Mouth: Smoking · Offhand: Fireball · Background: Cool Gray",
    imageUrl: "/games/microPayments/rewards/image-87.png",
  },
  {
    title: "Azuki #88",
    description:
      "Hair: Purple Bangs · Headgear: Backwards Cap · Clothing: Hoodie with Bag · Eyes: Relaxed · Mouth: Relaxed · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-88.png",
  },
  {
    title: "Azuki #89",
    description:
      "Hair: Green Samurai · Headgear: Fur Bucket Hat · Clothing: Blue Kimono · Eyes: Suspicious · Mouth: Meh · Offhand: Leather Katana · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-89.png",
  },
  {
    title: "Azuki #90",
    description:
      "Type: Red · Hair: Silver Pixie · Clothing: Red Floral Kimono · Eyes: Ruby · Mouth: Smirk · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-90.png",
  },
  {
    title: "Azuki #91",
    description:
      "Hair: Blonde Flowy · Clothing: Red Qipao with Fur · Eyes: Closed · Mouth: Toothpick · Offhand: Bean Juice · Background: Off White A",
    imageUrl: "/games/microPayments/rewards/image-91.png",
  },
  {
    title: "Azuki #92",
    description:
      "Hair: Pink Hairband · Clothing: Denim Jacket · Eyes: Calm · Mouth: Face Mask · Offhand: Katana · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-92.png",
  },
  {
    title: "Azuki #93",
    description:
      "Hair: Powder Blue Swept Back · Clothing: Blue Kimono · Eyes: Focused · Mouth: Meh · Offhand: Sakura Katana · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-93.png",
  },
  {
    title: "Azuki #94",
    description:
      "Hair: Blue Bun · Face: Seer Eyeband · Clothing: Hoodie · Neck: Choker · Eyes: Closed · Mouth: Laughing · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-94.png",
  },
  {
    title: "Azuki #95",
    description:
      "Hair: Brown Bangs · Clothing: Blue Qipao · Eyes: Concerned · Mouth: Smirk · Background: Off White D",
    imageUrl: "/games/microPayments/rewards/image-95.png",
  },
  {
    title: "Azuki #96",
    description:
      "Hair: Brown Spiky · Clothing: White Hoodie · Eyes: Pensive · Mouth: Gaiter · Offhand: Zanbato · Background: Off White C",
    imageUrl: "/games/microPayments/rewards/image-96.png",
  },
  {
    title: "Azuki #97",
    description:
      "Hair: Silver Swept Back · Clothing: Red Panda T-Shirt · Eyes: Closed · Mouth: Toothpick · Offhand: Zanbato · Background: Dark Blue",
    imageUrl: "/games/microPayments/rewards/image-97.png",
  },
  {
    title: "Azuki #98",
    description:
      "Hair: Blonde Short Spiky · Clothing: Fur Hoodie · Eyes: Determined · Mouth: Face Mask · Offhand: Coin · Background: Dark Purple",
    imageUrl: "/games/microPayments/rewards/image-98.png",
  },
  {
    title: "Azuki #99",
    description:
      "Type: Red · Hair: Magenta Messy · Clothing: Azuki Track Jacket · Eyes: Focused · Mouth: Relaxed · Offhand: Sake · Background: Red",
    imageUrl: "/games/microPayments/rewards/image-99.png",
  },
  {
    title: "Azuki #100",
    description:
      "Hair: Blue Bob · Neck: Chill Headphones · Clothing: Stitched Samurai Armor · Eyes: Glowing · Mouth: Lipstick · Background: Off White B",
    imageUrl: "/games/microPayments/rewards/image-100.png",
  },
] as const;
