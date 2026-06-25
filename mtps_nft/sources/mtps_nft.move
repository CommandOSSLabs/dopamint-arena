/// MtpsNFT — a free, permissionlessly-minted collectible for Dopamint mini-games. Anyone calls
/// `mint_nft` to mint a `(title, description, image_url)` NFT to themselves, so a game can let
/// players mint their own collectible with no backend round-trip. Split out of the MTPS coin
/// contract into its own package (the coin contract shouldn't carry an unrelated NFT).
///
/// Minting is open, but fields are validated — non-empty title and image, bounded lengths — so it
/// isn't a pure free-form data dump (the review concern). `store` so the NFT can be traded.
module mtps_nft::mtps_nft {
    use sui::url::{Self, Url};
    use sui::event;
    use std::string::{Self, String};

    /// A minted collectible. Metadata is set once at mint and never mutated.
    public struct MtpsNFT has key, store {
        id: UID,
        title: String,
        description: String,
        image_url: Url,
    }

    /// Emitted on every `mint_nft` so wallets/indexers can surface the new collectible.
    public struct NftMinted has copy, drop {
        object_id: ID,
        creator: address,
        title: String,
    }

    /// `title` is empty.
    const E_EMPTY_TITLE: u64 = 0;
    /// `image_url` is empty.
    const E_EMPTY_IMAGE_URL: u64 = 1;
    /// A field exceeds its byte-length bound.
    const E_FIELD_TOO_LONG: u64 = 2;

    const MAX_TITLE_LEN: u64 = 128;
    const MAX_DESCRIPTION_LEN: u64 = 512;
    const MAX_IMAGE_URL_LEN: u64 = 512;

    /// Permissionless: anyone mints a `(title, description, image_url)` NFT to THEMSELVES. UTF-8
    /// bytes in; transferred to the caller. Aborts on an empty title/image or an over-length field.
    #[allow(lint(self_transfer))]
    public fun mint_nft(
        title: vector<u8>,
        description: vector<u8>,
        image_url: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(title.length() > 0, E_EMPTY_TITLE);
        assert!(image_url.length() > 0, E_EMPTY_IMAGE_URL);
        assert!(title.length() <= MAX_TITLE_LEN, E_FIELD_TOO_LONG);
        assert!(description.length() <= MAX_DESCRIPTION_LEN, E_FIELD_TOO_LONG);
        assert!(image_url.length() <= MAX_IMAGE_URL_LEN, E_FIELD_TOO_LONG);

        let sender = ctx.sender();
        let nft = MtpsNFT {
            id: object::new(ctx),
            title: string::utf8(title),
            description: string::utf8(description),
            image_url: url::new_unsafe_from_bytes(image_url),
        };
        event::emit(NftMinted {
            object_id: object::id(&nft),
            creator: sender,
            title: nft.title,
        });
        transfer::public_transfer(nft, sender);
    }
}
