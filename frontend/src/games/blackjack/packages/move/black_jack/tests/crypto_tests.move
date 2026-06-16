

#[test_only]
module black_jack::crypto_tests {
    
    use sui::bls12381;
    use sui::ed25519;

    #[test]
    fun test_signatures() {
        let ed25519PublicKey: vector<u8> = x"fbb43a94aa97d1fea6c00244e27501384934f504b5d0c108af2ea0c71ce8d852";
        let ed25519Signature: vector<u8> = x"0442eaebc2a4cbaf7c38ad7cc8c492b256f740f864db66a6d2ca22168e475e3de1baec5c837204687fbb3f1d75079ebec24c2e82ddbafabf9f0155666952c408";
        let blsKey: vector<u8> = x"b8575116de61bc9d3d9cd12eda5517d0b6151323430eaa0f059a5d44dd387ea47e3a3b290e427dc45b577e183df20ae6";
        let blsSignature: vector<u8> = x"89fb96adfabb6db4331c18f53995be0f44321146859c77e7d256afc6f31c09180ea7b68f507767d537fe0ec494f602180299f21caff321d6f3a26695351aff6a14b16ca6de930afbe5ef627b769ac0fbc862f1ef23295bed119012bff6b5ad78";
        let gameInitData: vector<u8> = x"63d9a65220318469fb169034d8a011eae3f014fed2a1f8c006183e2ece3c39756400000000000000640000000000000002868f05000000000000000000000000000000000000000000000000";
        let _ed25519_verify = ed25519::ed25519_verify(&ed25519Signature, &ed25519PublicKey, &gameInitData);
        // print(&_ed25519_verify);
        let _bls_verify = bls12381::bls12381_min_pk_verify(&blsSignature, &blsKey, &gameInitData);
        // print(&_bls_verify);
    }
}