#[test_only]
module mtps_nft::mtps_nft_tests {
    use mtps_nft::mtps_nft::{Self, MtpsNFT};
    use sui::test_scenario as ts;

    #[test]
    fun mint_nft_transfers_to_caller() {
        let user = @0xC;
        let mut scenario = ts::begin(user);
        mtps_nft::mint_nft(b"Flag", b"A test NFT", b"https://example.com/i.png", scenario.ctx());
        // The caller received the NFT.
        scenario.next_tx(user);
        let nft = scenario.take_from_sender<MtpsNFT>();
        scenario.return_to_sender(nft);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = mtps_nft::E_EMPTY_TITLE)]
    fun mint_nft_aborts_on_empty_title() {
        let user = @0xC;
        let mut scenario = ts::begin(user);
        mtps_nft::mint_nft(b"", b"desc", b"https://example.com/i.png", scenario.ctx());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = mtps_nft::E_EMPTY_IMAGE_URL)]
    fun mint_nft_aborts_on_empty_image_url() {
        let user = @0xC;
        let mut scenario = ts::begin(user);
        mtps_nft::mint_nft(b"Title", b"desc", b"", scenario.ctx());
        scenario.end();
    }
}
